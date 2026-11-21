"""
Avaliação da recuperação de trechos sobre os documentos de `data/`.

Para cada combinação de divisor de trechos (chunker) e estratégia de
recuperação escolhida, o script:
    1. lê os documentos de `data/` como o endpoint `/documents`;
    2. divide e indexa tudo com o código real da aplicação
       (`build_document_chunks` e `persist_documents`), num banco temporário;
    3. faz cada pergunta de `questions.json` com `retrieve_relevant_chunks`;
    4. compara os arquivos dos trechos recuperados com os esperados.

Como usa as funções da aplicação, qualquer mudança na recuperação (limite de
relevância, busca híbrida, `task_type` etc.) passa a ser medida aqui sem
alterar o script.

Divisores disponíveis:
    structured: o divisor atual (`app.ingestion.chunker.chunk_document`).
    baseline: o divisor antigo, janelas de 150 palavras com 20 de
        sobreposição por página, mantido aqui só para comparação.

Estratégias de recuperação (`vector_store.RETRIEVAL_STRATEGY`):
    dense: só embeddings.
    hybrid: embeddings + BM25, unidos por Reciprocal Rank Fusion.
Por padrão, todas as combinações de divisor e estratégia são avaliadas.

Métricas (sobre as perguntas que têm resposta nos documentos):
    Hit@N: fração das perguntas com pelo menos um arquivo esperado entre os
        N primeiros trechos.
    Recall@N: fração dos grupos esperados atendidos nos N primeiros trechos,
        em média por pergunta. Uma pergunta que precisa de três documentos e
        recupera dois tem recall 0,67.
    MRR: média de 1/posição do primeiro trecho de um arquivo esperado.
    Score do 1º trecho: similaridade do melhor trecho, separada entre
        perguntas com resposta e fora do escopo; ajuda a escolher um limite
        de relevância.

Estatística (as configurações respondem às mesmas perguntas, então tudo é
pareado):
    IC 95%: Wilson para Hit@N (proporções); bootstrap percentil sobre as
        perguntas para recall, MRR e para a diferença entre duas
        configurações. Quando todas as perguntas têm o mesmo valor, o
        bootstrap dá intervalo de largura zero, o que não significa certeza.
    Hit@N (0 ou 1 por pergunta): teste exato de McNemar, que só considera
        as perguntas acertadas por uma configuração e não pela outra.
    Recall e MRR: teste de permutação pareado (troca de sinais).
    São comparadas as configurações que diferem num único fator (hybrid x
    dense com o mesmo divisor; structured x baseline com a mesma
    estratégia). Os p-valores não são corrigidos para comparações
    múltiplas. Com poucas perguntas, diferenças de uma ou duas perguntas
    raramente são significativas: um IC que inclui zero significa que os
    dados não distinguem as configurações.

Os embeddings ficam em cache em `evals/.cache/embeddings.sqlite3`, indexados
pelo modelo, pelo texto e pelos demais argumentos da chamada. A primeira
execução chama a API do Gemini; as seguintes só chamam para textos novos.
Se a cota por minuto acabar (erro 429), o script espera o tempo indicado pela
API e continua; na camada gratuita, a primeira execução leva alguns minutos.

Uso (a partir de `backend/`):
    python -m evals.retrieval_eval                      # todas as combinações
    python -m evals.retrieval_eval --chunker structured --retrieval hybrid
    python -m evals.retrieval_eval --details            # todas as perguntas
    python -m evals.retrieval_eval --json resultado.json
"""

import argparse
import hashlib
import json
import math
import os
import re
import sqlite3
import sys
import tempfile
import time
from contextlib import closing
from pathlib import Path
from statistics import mean
from unittest.mock import patch

os.environ.setdefault("FRONTEND_ORIGIN", "http://localhost")

import numpy as np  # noqa: E402
from google.genai import errors as genai_errors  # noqa: E402

from app import main  # noqa: E402
from app.ingestion.chunker import chunk_document  # noqa: E402
from app.retrieval import vector_store  # noqa: E402

EVALS_DIRECTORY = Path(__file__).resolve().parent
QUESTIONS_PATH = EVALS_DIRECTORY / "questions.json"
CACHE_PATH = EVALS_DIRECTORY / ".cache" / "embeddings.sqlite3"
CUTOFFS = (1, 3, 5)
# Na camada gratuita, cada texto de um lote conta como uma requisição (limite
# de 100 por minuto); lotes menores deixam a espera mais previsível.
API_BATCH_SIZE = 25
MAX_QUOTA_RETRIES = 8


def baseline_chunk_document(pages: list[dict], source_file: str) -> list[dict]:
    """Divisor antigo: janelas de 150 palavras, 20 de sobreposição, por página."""
    chunk_size, overlap = 150, 20
    chunks = []
    for page in pages:
        words = page["text"].split()
        for start in range(0, len(words), chunk_size - overlap):
            chunks.append({
                "text": " ".join(words[start:start + chunk_size]),
                "page": page["page"],
                "source_file": source_file,
            })
            if start + chunk_size >= len(words):
                break
    return chunks


CHUNKERS = {
    "structured": chunk_document,
    "baseline": baseline_chunk_document,
}
RETRIEVAL_STRATEGIES = ("dense", "hybrid")


class EmbeddingCache:
    """
    Substitui `vector_store._embed_contents`, guardando cada vetor em disco.

    A chave inclui o modelo, o texto e os argumentos extras da chamada, para
    que uma mudança futura (outro modelo, `task_type`) não reaproveite
    vetores errados.
    """

    def __init__(self, path: Path, embed):
        path.parent.mkdir(parents=True, exist_ok=True)
        self.path = path
        self.embed_uncached = embed
        self.api_texts = 0
        self.cached_texts = 0
        with closing(sqlite3.connect(path)) as connection, connection:
            connection.execute(
                "CREATE TABLE IF NOT EXISTS embeddings (key TEXT PRIMARY KEY, embedding TEXT NOT NULL)"
            )

    def _key(self, text: str, args: tuple, kwargs: dict) -> str:
        identity = json.dumps(
            [vector_store.EMBEDDING_MODEL, text, repr(args), repr(sorted(kwargs.items()))],
            ensure_ascii=False,
        )
        return hashlib.sha256(identity.encode("utf-8")).hexdigest()

    def __call__(self, texts: list[str], *args, **kwargs) -> list[list[float]]:
        keys = [self._key(text, args, kwargs) for text in texts]
        with closing(sqlite3.connect(self.path)) as connection:
            found = {}
            for start in range(0, len(keys), 500):
                batch = keys[start:start + 500]
                placeholders = ",".join("?" for _ in batch)
                found.update(
                    (key, json.loads(embedding))
                    for key, embedding in connection.execute(
                        f"SELECT key, embedding FROM embeddings WHERE key IN ({placeholders})",
                        batch,
                    )
                )

        missing = list(dict.fromkeys(
            (key, text) for key, text in zip(keys, texts) if key not in found
        ))
        self.cached_texts += len(texts) - len(missing)

        # Lotes pequenos, gravados um a um: se a cota acabar no meio, o que já
        # foi gerado fica no cache e a próxima execução continua dali.
        for start in range(0, len(missing), API_BATCH_SIZE):
            batch = missing[start:start + API_BATCH_SIZE]
            vectors = self._embed_with_retry([text for _, text in batch], args, kwargs)
            self.api_texts += len(batch)
            with closing(sqlite3.connect(self.path)) as connection, connection:
                connection.executemany(
                    "INSERT OR REPLACE INTO embeddings (key, embedding) VALUES (?, ?)",
                    [(key, json.dumps(vector)) for (key, _), vector in zip(batch, vectors)],
                )
            found.update((key, vector) for (key, _), vector in zip(batch, vectors))

        return [found[key] for key in keys]

    def _embed_with_retry(self, texts: list[str], args: tuple, kwargs: dict) -> list[list[float]]:
        """Chama a API; ao receber 429 (cota), espera o tempo indicado e tenta de novo."""
        for attempt in range(1, MAX_QUOTA_RETRIES + 1):
            try:
                return self.embed_uncached(texts, *args, **kwargs)
            except genai_errors.ClientError as error:
                if error.code != 429 or attempt == MAX_QUOTA_RETRIES:
                    raise
                match = re.search(r"retry in ([\d.]+)s", str(error))
                delay = float(match.group(1)) + 1 if match else 60.0
                print(f"Cota de embeddings esgotada; aguardando {delay:.0f} s "
                      f"(tentativa {attempt}/{MAX_QUOTA_RETRIES})...", flush=True)
                time.sleep(delay)
        raise AssertionError("unreachable")


def load_questions(document_names: set[str]) -> list[dict]:
    questions = json.loads(QUESTIONS_PATH.read_text(encoding="utf-8"))["questions"]
    unknown = sorted({
        name
        for question in questions
        for group in question["expected"]
        for name in group
        if name not in document_names
    })
    if unknown:
        raise SystemExit(f"questions.json cita arquivos que não existem em data/: {', '.join(unknown)}")
    problems = [
        f"{question['id']}: {problem}"
        for question in questions
        for problem in question_problems(question)
    ]
    if problems:
        raise SystemExit("questions.json inconsistente:\n  " + "\n  ".join(problems))
    return questions


TAGS = {"conflito", "versao", "temporal", "entidade_ambigua", "parafrase", "secao_pdf"}
UNANSWERABLE_SUBTYPES = {"fora_do_escopo", "ausente"}


def expected_category(question: dict) -> str:
    """A categoria decorre só da estrutura de `expected`, sem julgamento do anotador."""
    groups = len(question["expected"])
    return "sem_resposta" if groups == 0 else "simples" if groups == 1 else "composta"


def question_problems(question: dict) -> list[str]:
    problems = []
    expected = expected_category(question)
    if question["category"] != expected:
        problems.append(f"categoria '{question['category']}', mas `expected` indica '{expected}'")
    if expected == "sem_resposta" and question.get("subtype") not in UNANSWERABLE_SUBTYPES:
        problems.append(f"`subtype` deve ser um de {sorted(UNANSWERABLE_SUBTYPES)}")
    if expected != "sem_resposta" and "subtype" in question:
        problems.append("`subtype` só se aplica a perguntas sem resposta")
    unknown_tags = set(question.get("tags", [])) - TAGS
    if unknown_tags:
        problems.append(f"tags desconhecidas: {', '.join(sorted(unknown_tags))}")
    return problems


def score_question(question: dict, results: list[dict]) -> dict:
    sources = [result["source"] for result in results]
    groups = question["expected"]
    relevant = {name for group in groups for name in group}
    first_hit = next((index for index, source in enumerate(sources) if source in relevant), None)

    row = {
        "id": question["id"],
        "category": question["category"],
        "subtype": question.get("subtype"),
        "tags": question.get("tags", []),
        "question": question["question"],
        "answerable": bool(groups),
        "retrieved": [
            {"source": result["source"], "page": result["page"], "chunk": result["chunk"],
             "score": round(result["score"], 4),
             "keyword_score": round(result.get("keyword_score", 0.0), 4)}
            for result in results
        ],
        "top_score": results[0]["score"] if results else None,
    }
    if groups:
        for cutoff in CUTOFFS:
            found = sum(any(name in sources[:cutoff] for name in group) for group in groups)
            row[f"hit@{cutoff}"] = float(found > 0)
            row[f"recall@{cutoff}"] = found / len(groups)
        row["rr"] = 1 / (first_hit + 1) if first_hit is not None else 0.0
        row["missing"] = [group for group in groups if not any(name in sources for name in group)]
    return row


def run_configuration(
    chunker: str, retrieval: str, questions: list[dict], documents: list[dict], top_k: int
) -> dict:
    with tempfile.TemporaryDirectory() as directory, \
            patch.object(vector_store, "VECTOR_STORE_PATH", Path(directory) / "vectors.sqlite3"), \
            patch.object(vector_store, "RETRIEVAL_STRATEGY", retrieval), \
            patch.object(main, "chunk_document", CHUNKERS[chunker]):
        chunks = main.build_document_chunks([main.IndexDocument(**document) for document in documents])
        vector_store.persist_documents(documents, chunks)
        document_ids = [document["id"] for document in documents]
        rows = [
            score_question(
                question,
                vector_store.retrieve_relevant_chunks(question["question"], document_ids, top_k=top_k),
            )
            for question in questions
        ]

    answerable = [row for row in rows if row["answerable"]]
    summary = {
        "questions": len(answerable),
        "chunks": len(chunks),
        **{
            f"{metric}@{cutoff}": mean(row[f"{metric}@{cutoff}"] for row in answerable)
            for metric in ("hit", "recall")
            for cutoff in CUTOFFS
        },
        "mrr": mean(row["rr"] for row in answerable),
    }
    configuration = {"configuration": f"{chunker}/{retrieval}", "summary": summary, "rows": rows}
    summary["ci95"] = {
        metric: (
            wilson_interval(metric_values(configuration, metric))
            if metric.startswith("hit@")
            else bootstrap_interval(metric_values(configuration, metric))
        )
        for metric in STATISTICS_METRICS
    }
    return configuration


# Estatística ------------------------------------------------------------------
#
# Todas as configurações respondem às mesmas perguntas, então as comparações
# são pareadas: o que importa é como cada pergunta muda de uma configuração
# para a outra, não as médias isoladas. As reamostragens usam semente fixa
# para que o relatório seja igual a cada execução.

STATISTICS_METRICS = ("hit@1", "hit@3", "hit@5", "recall@5", "mrr")
BOOTSTRAP_SAMPLES = 10_000
PERMUTATION_SAMPLES = 10_000
RANDOM_SEED = 2026


def metric_values(configuration: dict, metric: str) -> list[float]:
    """Valor da métrica em cada pergunta com resposta, na ordem do arquivo."""
    key = "rr" if metric == "mrr" else metric
    return [row[key] for row in configuration["rows"] if row["answerable"]]


def wilson_interval(values: list[float], z: float = 1.959964) -> list[float]:
    """
    Intervalo de confiança de Wilson para uma proporção (métricas de acerto).

    Ao contrário do bootstrap, continua informativo nos extremos: 39 acertos
    em 39 perguntas dão cerca de [0,91; 1,00], e não um intervalo de largura
    zero.
    """
    n = len(values)
    proportion = sum(values) / n
    center = (proportion + z * z / (2 * n)) / (1 + z * z / n)
    margin = z * math.sqrt(proportion * (1 - proportion) / n + z * z / (4 * n * n)) / (1 + z * z / n)
    return [max(0.0, center - margin), min(1.0, center + margin)]


def bootstrap_interval(values: list[float], confidence: float = 0.95) -> list[float]:
    """
    Intervalo de confiança da média por bootstrap percentil.

    As perguntas são sorteadas com reposição `BOOTSTRAP_SAMPLES` vezes; o
    intervalo vai dos percentis 2,5% a 97,5% das médias obtidas. Serve tanto
    para uma métrica quanto para a diferença pareada entre duas.
    """
    data = np.asarray(values, dtype=float)
    rng = np.random.default_rng(RANDOM_SEED)
    samples = data[rng.integers(0, len(data), size=(BOOTSTRAP_SAMPLES, len(data)))].mean(axis=1)
    tail = (1 - confidence) / 2 * 100
    low, high = np.percentile(samples, [tail, 100 - tail])
    return [float(low), float(high)]


def mcnemar_exact(a: list[float], b: list[float]) -> tuple[float, int, int]:
    """
    Teste exato de McNemar para métricas de acerto (0 ou 1) pareadas.

    Só contam as perguntas discordantes: `only_a` acertadas só por A e
    `only_b` só por B. Sem diferença real, cada discordância cairia para um
    lado com probabilidade 1/2; o p-valor bilateral é a chance binomial de um
    desequilíbrio igual ou maior que o observado.
    """
    only_a = sum(1 for x, y in zip(a, b) if x and not y)
    only_b = sum(1 for x, y in zip(a, b) if y and not x)
    discordant = only_a + only_b
    if discordant == 0:
        return 1.0, 0, 0
    tail = sum(math.comb(discordant, k) for k in range(min(only_a, only_b) + 1)) / 2 ** discordant
    return min(1.0, 2 * tail), only_a, only_b


def paired_permutation_test(a: list[float], b: list[float]) -> float:
    """
    Teste de permutação pareado (troca de sinais) para métricas contínuas.

    Sem diferença real, trocar A e B numa pergunta não mudaria nada; então o
    sinal de cada diferença é sorteado e conta-se quantas vezes a média
    sorteada fica tão longe de zero quanto a observada.
    """
    differences = np.asarray(a, dtype=float) - np.asarray(b, dtype=float)
    observed = abs(differences.mean())
    if observed == 0:
        return 1.0
    rng = np.random.default_rng(RANDOM_SEED)
    signs = rng.choice((-1.0, 1.0), size=(PERMUTATION_SAMPLES, len(differences)))
    extreme = np.sum(np.abs((signs * differences).mean(axis=1)) >= observed - 1e-12)
    return float((extreme + 1) / (PERMUTATION_SAMPLES + 1))


def paired_comparisons(results: list[dict]) -> list[dict]:
    """
    Compara configurações que diferem em um único fator.

    Para cada divisor, `hybrid` contra `dense`; para cada estratégia,
    `structured` contra `baseline`. A diferença é sempre A − B. Os p-valores
    não são corrigidos para comparações múltiplas.
    """
    by_name = {result["configuration"]: result for result in results}
    pairs = [
        (f"{chunker}/hybrid", f"{chunker}/dense") for chunker in CHUNKERS
    ] + [
        (f"structured/{retrieval}", f"baseline/{retrieval}") for retrieval in RETRIEVAL_STRATEGIES
    ]

    comparisons = []
    for name_a, name_b in pairs:
        if name_a not in by_name or name_b not in by_name:
            continue
        metrics = {}
        for metric in STATISTICS_METRICS:
            a = metric_values(by_name[name_a], metric)
            b = metric_values(by_name[name_b], metric)
            entry = {
                "difference": mean(a) - mean(b),
                "ci95": bootstrap_interval([x - y for x, y in zip(a, b)]),
            }
            if metric.startswith("hit@"):
                entry["p_value"], entry["only_a"], entry["only_b"] = mcnemar_exact(a, b)
                entry["test"] = "McNemar exato"
            else:
                entry["p_value"] = paired_permutation_test(a, b)
                entry["test"] = "permutação pareada"
            metrics[metric] = entry
        comparisons.append({"a": name_a, "b": name_b, "metrics": metrics})
    return comparisons


def print_statistics(results: list[dict], comparisons: list[dict]) -> None:
    questions = results[0]["summary"]["questions"]
    samples = f"{BOOTSTRAP_SAMPLES:,}".replace(",", ".")
    print(f"\nIntervalos de confiança de 95% sobre {questions} perguntas (hit@N: Wilson; "
          f"recall e MRR: bootstrap percentil, {samples} reamostragens)")
    print(f"{'configuração':<20}" + "".join(f"{metric:>21}" for metric in STATISTICS_METRICS))
    for result in results:
        summary = result["summary"]
        cells = [
            f"{summary[metric]:.3f} [{summary['ci95'][metric][0]:.2f}, {summary['ci95'][metric][1]:.2f}]"
            for metric in STATISTICS_METRICS
        ]
        print(f"{result['configuration']:<20}" + "".join(f"{cell:>21}" for cell in cells))

    if not comparisons:
        return
    print("\nComparações pareadas (diferença = A − B, IC 95% por bootstrap pareado; "
          "p-valores sem correção para comparações múltiplas)")
    for comparison in comparisons:
        print(f"\n  A = {comparison['a']}   B = {comparison['b']}")
        for metric, entry in comparison["metrics"].items():
            low, high = entry["ci95"]
            line = (f"    {metric:<9} {entry['difference']:+.3f}  [{low:+.3f}, {high:+.3f}]  "
                    f"{entry['test']}: p = {entry['p_value']:.3f}")
            if "only_a" in entry:
                line += f" ({entry['only_a']} acertadas só por A, {entry['only_b']} só por B)"
            print(line)


def print_report(results: list[dict], details: bool) -> None:
    columns = ["chunks", *(f"hit@{c}" for c in CUTOFFS), *(f"recall@{c}" for c in CUTOFFS), "mrr"]
    print(f"\n{'configuração':<20}" + "".join(f"{column:>11}" for column in columns))
    for result in results:
        summary = result["summary"]
        cells = [
            f"{summary[column]:>11}" if column == "chunks" else f"{summary[column]:>11.3f}"
            for column in columns
        ]
        print(f"{result['configuration']:<20}" + "".join(cells))

    def print_breakdown(title: str, label: str, groups: list[str], belongs) -> None:
        print(f"\n{title}\n{label:<18}" + "".join(f"{result['configuration']:>20}" for result in results))
        for group in groups:
            cells = []
            for result in results:
                rows = [row for row in result["rows"] if row["answerable"] and belongs(row, group)]
                cells.append(f"{mean(row['recall@5'] for row in rows):.3f} ({len(rows)})")
            print(f"{group:<18}" + "".join(f"{cell:>20}" for cell in cells))

    answerable_rows = [row for row in results[0]["rows"] if row["answerable"]]
    print_breakdown(
        "Recall@5 por categoria (n entre parênteses)", "categoria",
        [c for c in ("simples", "composta") if any(row["category"] == c for row in answerable_rows)],
        lambda row, category: row["category"] == category,
    )
    print_breakdown(
        "Recall@5 por tag — as tags se sobrepõem e têm n pequeno: use para análise de erros, "
        "não para comparar configurações", "tag",
        sorted({tag for row in answerable_rows for tag in row["tags"]}),
        lambda row, tag: tag in row["tags"],
    )

    unanswerable_categories = sorted({
        row["subtype"] for row in results[0]["rows"] if not row["answerable"]
    })
    print("\nSimilaridade do 1º trecho: um limite de relevância só separa os grupos se o "
          "mínimo das perguntas com resposta ficar acima do máximo das sem resposta")
    for result in results:
        answered = [row["top_score"] for row in result["rows"] if row["answerable"]]
        line = f"  {result['configuration']:<20} com resposta: média {mean(answered):.3f}, mín {min(answered):.3f}"
        for category in unanswerable_categories:
            scores = [
                row["top_score"] for row in result["rows"]
                if not row["answerable"] and row["subtype"] == category
            ]
            line += f" | {category}: média {mean(scores):.3f}, máx {max(scores):.3f}"
        print(line)

    for result in results:
        rows = [
            row for row in result["rows"]
            if details or (row["answerable"] and row["recall@5"] < 1)
        ]
        title = "Todas as perguntas" if details else "Perguntas com documento esperado faltando"
        print(f"\n{title} — {result['configuration']}")
        if not rows:
            print("  nenhuma")
        for row in rows:
            status = f"recall@5 {row['recall@5']:.2f}" if row["answerable"] else row["subtype"]
            tags = f", {'/'.join(row['tags'])}" if row["tags"] else ""
            print(f"  {row['id']} [{row['category']}{tags}, {status}] {row['question']}")
            for missing in row.get("missing", []):
                print(f"      faltou: {' ou '.join(missing)}")
            retrieved = ", ".join(
                f"{item['source']}#{item['chunk']} (cos {item['score']:.3f}, bm25 {item['keyword_score']:.1f})"
                for item in row["retrieved"]
            )
            print(f"      recuperados: {retrieved}")


def main_cli() -> None:
    parser = argparse.ArgumentParser(description="Avalia a recuperação de trechos sobre data/.")
    parser.add_argument("--chunker", choices=[*CHUNKERS, "all"], default="all")
    parser.add_argument("--retrieval", choices=[*RETRIEVAL_STRATEGIES, "all"], default="all")
    parser.add_argument("--top-k", type=int, default=5, help="trechos recuperados por pergunta (mínimo 5)")
    parser.add_argument("--details", action="store_true", help="mostra todas as perguntas, não só as falhas")
    parser.add_argument("--json", type=Path, help="grava o resultado completo neste arquivo")
    args = parser.parse_args()

    documents = main.load_repository_documents()
    questions = load_questions({document["name"] for document in documents})
    chunkers = list(CHUNKERS) if args.chunker == "all" else [args.chunker]
    strategies = list(RETRIEVAL_STRATEGIES) if args.retrieval == "all" else [args.retrieval]
    cache = EmbeddingCache(CACHE_PATH, vector_store._embed_contents)

    with patch.object(vector_store, "_embed_contents", cache):
        results = [
            run_configuration(chunker, retrieval, questions, documents, max(args.top_k, max(CUTOFFS)))
            for chunker in chunkers
            for retrieval in strategies
        ]

    comparisons = paired_comparisons(results)
    print_report(results, args.details)
    print_statistics(results, comparisons)
    print(f"\nEmbeddings: {cache.api_texts} textos pedidos à API, {cache.cached_texts} vindos do cache.")

    if args.json:
        output = {"configurations": results, "comparisons": comparisons}
        args.json.write_text(json.dumps(output, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"Resultado gravado em {args.json}")


if __name__ == "__main__":
    sys.exit(main_cli())
