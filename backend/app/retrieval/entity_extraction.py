"""
Extração de entidades e relações com LLM e montagem da camada de entidades do grafo.

Cada trecho indexado é enviado uma vez ao modelo configurado (`LLM_MODEL_ID`)
com as regras e os tipos de `graph_schema.json`. A resposta vem em JSON
restrito por um esquema (`response_json_schema`), então o formato é garantido
pela API; o conteúdo é validado aqui.

Fluxo:
    1. `python -m app.retrieval.entity_extraction` extrai os trechos
       indexados que ainda não estão no cache. A extração é separada do
       `/index` porque, na camada gratuita, dezenas de chamadas levam minutos.
    2. O resultado bruto do modelo fica na tabela `chunk_extractions` do
       mesmo banco SQLite do índice. A chave combina o modelo, uma impressão
       digital do esquema, `PROMPT_VERSION`, o documento e o texto do trecho:
       mudar qualquer um deles invalida só o que mudou.
    3. `/graph` e o modo graphrag só leem o cache (nenhuma chamada ao LLM) e
       validam de novo a cada leitura; mudar uma regra de validação não exige
       extrair outra vez.

Validação (`validate_extraction`): entidades de tipo desconhecido e relações
de tipo desconhecido, com origem ou destino inexistente ou de tipo não
permitido, sem evidência, com evidência que não aparece literalmente no
trecho, ou `outra` sem descrição são descartadas. Os descartes são contados
por motivo, para relatar a qualidade da extração.

Resolução de entidades (`build_entity_graph`): menções do mesmo tipo com o
mesmo nome normalizado (maiúsculas, acentos, espaços e pontuação) são o mesmo
nó; aliases declarados no texto unem nomes diferentes ("CTMSC" e o nome
completo). Atos numerados ("Aditivo 02", "Contrato 014/2021") usam o mesmo nó
da camada de trechos (`chunk_graph.find_references`). Nomes de pessoas com
grafias diferentes nunca se unem por semelhança.
"""

import argparse
import hashlib
import json
import re
import sqlite3
import sys
import time
import unicodedata
from collections import Counter
from contextlib import closing
from functools import lru_cache
from pathlib import Path

from app.retrieval.chunk_graph import _stable_id, chunk_node_id, find_references

SCHEMA_PATH = Path(__file__).with_name("graph_schema.json")
# Mude ao alterar o texto do prompt: invalida o cache de extrações.
PROMPT_VERSION = "2"
MAX_RETRIES = 8


@lru_cache(maxsize=1)
def load_schema() -> dict:
    return json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))


def schema_fingerprint(schema: dict) -> str:
    canonical = json.dumps(schema, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:16]


# Prompt e chamada ao modelo -----------------------------------------------------


def response_schema(schema: dict) -> dict:
    """Esquema JSON da resposta, com os tipos do `graph_schema.json` como `enum`."""
    return {
        "type": "object",
        "properties": {
            "entities": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "id": {"type": "string"},
                        "name": {"type": "string"},
                        "type": {"type": "string", "enum": [item["id"] for item in schema["entity_types"]]},
                        "aliases": {"type": "array", "items": {"type": "string"}},
                    },
                    "required": ["id", "name", "type"],
                },
            },
            "relations": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "source": {"type": "string"},
                        "type": {"type": "string", "enum": [item["id"] for item in schema["relation_types"]]},
                        "target": {"type": "string"},
                        "evidence": {"type": "string"},
                        "qualifiers": {
                            "type": "object",
                            "properties": {key: {"type": "string"} for key in schema["qualifiers"]},
                        },
                    },
                    "required": ["source", "type", "target", "evidence"],
                },
            },
        },
        "required": ["entities", "relations"],
    }


def build_prompt(chunk: dict, schema: dict) -> str:
    entity_lines = "\n".join(
        f"- {item['id']}: {item['description']} Exemplos: {', '.join(item['examples'])}."
        for item in schema["entity_types"]
    )
    relation_lines = "\n".join(
        f"- {item['id']} ({' | '.join(item['source'])} -> {' | '.join(item['target'])}): "
        f"{item['label']['pt-BR']}. Exemplo: {item['example']}"
        for item in schema["relation_types"]
    )
    qualifier_lines = "\n".join(f"- {key}: {description}" for key, description in schema["qualifiers"].items())
    rule_lines = "\n".join(f"- {rule}" for rule in schema["rules"])
    page = f", página {chunk['page']}" if chunk.get("page") is not None else ""

    return f"""Você extrai entidades e relações de um trecho de documento para um grafo de conhecimento.

Regras:
{rule_lines}
- Dê a cada entidade um id curto (e1, e2, ...). Em relations, "source" e "target" são esses ids.
- Se o trecho não tiver entidades ou relações, devolva listas vazias.

Tipos de entidade:
{entity_lines}

Tipos de relação (origem -> destino permitidos):
{relation_lines}

Qualificadores possíveis de uma relação:
{qualifier_lines}

Documento: {chunk['source']}, trecho {chunk['chunk']}{page}
Trecho:
\"\"\"
{chunk['text']}
\"\"\"
"""


def call_model(prompt: str, schema: dict) -> dict:
    """Chama o LLM com saída JSON restrita; espera e repete em caso de cota (429) ou sobrecarga (503)."""
    from google.genai import errors, types

    from app.config import client, llm_model

    config = types.GenerateContentConfig(
        response_mime_type="application/json",
        response_json_schema=response_schema(schema),
        temperature=0,
    )
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            response = client.models.generate_content(model=llm_model, contents=prompt, config=config)
            return json.loads(response.text or "{}")
        except errors.APIError as error:
            if error.code not in (429, 500, 503) or attempt == MAX_RETRIES:
                raise
            match = re.search(r"retry in ([\d.]+)s", str(error))
            delay = float(match.group(1)) + 1 if match else min(60.0, 5.0 * attempt)
            print(f"  API {error.code}; aguardando {delay:.0f} s (tentativa {attempt}/{MAX_RETRIES})", flush=True)
            time.sleep(delay)
    raise AssertionError("unreachable")


# Validação ----------------------------------------------------------------------

_TRAILING_ACRONYM = re.compile(r"^(?P<name>.+?)\s*\((?P<acronym>[A-ZÀ-Ý0-9]{2,12})\)$")
# Datas, números e valores soltos ("15/12/2025", "2024-03", "R$ 5,3 bi", "45%").
_DATE_OR_NUMBER = re.compile(r"^(?:r\$\s*)?[\d\s/.,:%-]+(?:\s*(?:bi|mi|milhões|bilhões|km|%))?$", re.IGNORECASE)


def _normalize_text(text: str) -> str:
    """
    Normaliza para comparar a evidência com o trecho: só palavras e números.

    Pontuação, aspas, travessões e marcação Markdown são ignorados, porque o
    modelo às vezes os omite ao copiar (por exemplo, uma aspa de uma linha
    JSON). As palavras e os números continuam tendo de aparecer na mesma
    ordem.
    """
    return " ".join(re.sub(r"[^\w]+", " ", text.casefold()).split())


def _evidence_in_chunk(evidence: str, chunk_text: str) -> bool:
    """A evidência (ou cada parte dela, se o modelo usou reticências) aparece no trecho."""
    text = f" {_normalize_text(chunk_text)} "
    parts = [_normalize_text(part) for part in re.split(r"\.\.\.|…", evidence)]
    parts = [part for part in parts if part]
    return bool(parts) and all(f" {part} " in text for part in parts)


def validate_extraction(raw: dict, chunk: dict, schema: dict) -> dict:
    """
    Filtra a resposta do modelo pelas regras do esquema.

    Returns:
        `{"entities": [...], "relations": [...], "dropped": {motivo: n}}`.
        Entidades: `id`, `name`, `type`, `aliases`. Relações: `source`,
        `target` (ids de entidades), `type`, `evidence`, `qualifiers`.
    """
    entity_types = {item["id"] for item in schema["entity_types"]}
    relation_types = {item["id"]: item for item in schema["relation_types"]}
    allowed_qualifiers = set(schema["qualifiers"])
    dropped: Counter = Counter()

    entities = {}
    for item in raw.get("entities") or []:
        name = " ".join(str(item.get("name") or "").split())
        aliases = [str(alias) for alias in item.get("aliases") or []]
        # "Companhia ... (CTMSC)" -> nome "Companhia ...", alias "CTMSC".
        acronym = _TRAILING_ACRONYM.match(name)
        if acronym:
            name, aliases = acronym.group("name"), [*aliases, acronym.group("acronym")]
        if not name or item.get("type") not in entity_types:
            dropped["entity_invalid_type_or_name"] += 1
            continue
        if _DATE_OR_NUMBER.match(name):
            dropped["entity_date_or_number"] += 1
            continue
        if item.get("id") in entities:
            dropped["entity_duplicate_id"] += 1
            continue
        aliases = sorted({
            " ".join(alias.split())
            for alias in aliases
            if alias.strip() and _normalize_name(alias) != _normalize_name(name)
        })
        entities[item.get("id")] = {"id": item.get("id"), "name": name, "type": item["type"], "aliases": aliases}

    relations = []
    for item in raw.get("relations") or []:
        definition = relation_types.get(item.get("type"))
        source, target = entities.get(item.get("source")), entities.get(item.get("target"))
        qualifiers = {
            key: " ".join(str(value).split())
            for key, value in (item.get("qualifiers") or {}).items()
            if key in allowed_qualifiers and str(value).strip()
        }
        evidence = " ".join(str(item.get("evidence") or "").split())

        if definition is None:
            reason = "relation_unknown_type"
        elif source is None or target is None:
            reason = "relation_unknown_entity"
        elif source is target:
            reason = "relation_self_loop"
        elif not (
            ("*" in definition["source"] or source["type"] in definition["source"])
            and ("*" in definition["target"] or target["type"] in definition["target"])
        ):
            reason = "relation_type_constraint"
        elif not evidence:
            reason = "relation_missing_evidence"
        elif not _evidence_in_chunk(evidence, chunk["text"]):
            reason = "relation_evidence_not_in_chunk"
        elif definition["id"] == "outra" and not qualifiers.get("descricao"):
            reason = "relation_other_without_description"
        else:
            relations.append({
                "source": source["id"],
                "target": target["id"],
                "type": definition["id"],
                "evidence": evidence,
                "qualifiers": qualifiers,
            })
            continue
        dropped[reason] += 1

    return {"entities": list(entities.values()), "relations": relations, "dropped": dict(dropped)}


# Cache ----------------------------------------------------------------------------


def extraction_key(chunk: dict, schema: dict, model: str) -> str:
    identity = json.dumps(
        [model, schema_fingerprint(schema), PROMPT_VERSION, chunk["document_id"], chunk["text"]],
        ensure_ascii=False,
        separators=(",", ":"),
    )
    return hashlib.sha256(identity.encode("utf-8")).hexdigest()


def _ensure_table(connection: sqlite3.Connection) -> None:
    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS chunk_extractions (
            key TEXT PRIMARY KEY,
            document_id TEXT NOT NULL,
            chunk INTEGER NOT NULL,
            model TEXT NOT NULL,
            schema_version TEXT NOT NULL,
            raw_json TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
        """
    )


def load_extractions(store_path: Path, chunks: list[dict]) -> list[tuple[dict, dict]]:
    """
    Lê do cache as extrações dos trechos e as valida.

    Returns:
        `(trecho, extração validada)` para cada trecho que já foi extraído
        com o modelo, o esquema e o prompt atuais. Trechos sem extração ficam
        de fora. Não chama o LLM.
    """
    if not chunks or not store_path.exists():
        return []
    from app.config import llm_model

    schema = load_schema()
    keys = {extraction_key(chunk, schema, llm_model or ""): chunk for chunk in chunks}
    with closing(sqlite3.connect(store_path)) as connection:
        _ensure_table(connection)
        rows = []
        key_list = list(keys)
        for start in range(0, len(key_list), 500):
            batch = key_list[start:start + 500]
            placeholders = ",".join("?" for _ in batch)
            rows.extend(connection.execute(
                f"SELECT key, raw_json FROM chunk_extractions WHERE key IN ({placeholders})", batch
            ).fetchall())
    raw_by_key = dict(rows)
    return [
        (chunk, validate_extraction(json.loads(raw_by_key[key]), chunk, schema))
        for key, chunk in keys.items()
        if key in raw_by_key
    ]


def extract_missing(store_path: Path, chunks: list[dict], log=print) -> int:
    """
    Extrai e guarda os trechos que ainda não estão no cache.

    Cada resposta é gravada logo que chega: se a cota acabar, a próxima
    execução continua de onde parou.

    Returns:
        Quantos trechos foram enviados ao modelo.
    """
    from app.config import llm_model

    schema = load_schema()
    with closing(sqlite3.connect(store_path)) as connection:
        _ensure_table(connection)
        existing = {row[0] for row in connection.execute("SELECT key FROM chunk_extractions")}

    pending = [chunk for chunk in chunks if extraction_key(chunk, schema, llm_model or "") not in existing]
    for number, chunk in enumerate(pending, start=1):
        log(f"[{number}/{len(pending)}] {chunk['source']} · trecho {chunk['chunk']}")
        raw = call_model(build_prompt(chunk, schema), schema)
        with closing(sqlite3.connect(store_path)) as connection, connection:
            _ensure_table(connection)
            connection.execute(
                "INSERT OR REPLACE INTO chunk_extractions (key, document_id, chunk, model, schema_version, raw_json) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (
                    extraction_key(chunk, schema, llm_model or ""),
                    chunk["document_id"],
                    chunk["chunk"],
                    llm_model or "",
                    schema["version"],
                    json.dumps(raw, ensure_ascii=False),
                ),
            )
    return len(pending)


# Camada de entidades do grafo ------------------------------------------------------


def _normalize_name(name: str) -> str:
    decomposed = unicodedata.normalize("NFKD", name.casefold())
    without_accents = "".join(character for character in decomposed if not unicodedata.combining(character))
    return " ".join(re.sub(r"[^\w/]+", " ", without_accents).split())


def _reference_identity(name: str) -> str | None:
    """
    Identidade do ato numerado que o nome designa, ou `None`.

    O nome só é o ato quando quase não tem mais nada além dele: "Termo
    Aditivo nº 02" e "Contrato CTMSC nº 014/2021" são atos; "Plano Diretor de
    Obras (revisão pós Aditivo 01)" apenas cita um, e "Termo Aditivo nº 01 ao
    Contrato 014/2021" cita dois.
    """
    references = find_references(name)
    if len(references) != 1:
        return None
    identity, _, start, end = references[0]
    leftover_words = re.findall(r"[^\W\d_]+", name[:start] + name[end:])
    return identity if len(leftover_words) <= 2 else None


def build_entity_graph(extractions: list[tuple[dict, dict]]) -> dict:
    """
    Monta a camada de entidades a partir das extrações validadas.

    Nós: uma entidade por grupo de menções resolvidas (veja o módulo), com
    `type` do esquema e `aliases`. Arestas: as relações extraídas, com a
    evidência de cada trecho (texto literal e qualificadores), e `mentions`
    de cada trecho para as entidades que ele cita.
    """
    parent: dict[tuple, tuple] = {}

    def find(key: tuple) -> tuple:
        parent.setdefault(key, key)
        while parent[key] != key:
            parent[key] = parent[parent[key]]
            key = parent[key]
        return key

    def union(first: tuple, second: tuple) -> None:
        parent[find(first)] = find(second)

    def mention_keys(entity: dict) -> list[tuple]:
        keys = []
        for name in [entity["name"], *entity["aliases"]]:
            keys.append(("name", entity["type"], _normalize_name(name)))
            if entity["type"] == "documento" and (identity := _reference_identity(name)):
                keys.append(("reference", identity))
        return keys

    for _, extraction in extractions:
        for entity in extraction["entities"]:
            keys = mention_keys(entity)
            find(keys[0])
            for key in keys[1:]:
                union(keys[0], key)

    groups: dict[tuple, list[tuple]] = {}
    for key in list(parent):
        groups.setdefault(find(key), []).append(key)

    names_by_root: dict[tuple, Counter] = {}
    type_by_root: dict[tuple, str] = {}
    for _, extraction in extractions:
        for entity in extraction["entities"]:
            root = find(mention_keys(entity)[0])
            names_by_root.setdefault(root, Counter())[entity["name"]] += 1
            for alias in entity["aliases"]:
                names_by_root[root][alias] += 0
            type_by_root[root] = entity["type"]

    node_id_by_root = {}
    nodes: dict[str, dict] = {}
    for root, names in names_by_root.items():
        keys = sorted(groups[root])
        references = [key[1] for key in keys if key[0] == "reference"]
        node_id = (
            _stable_id("reference", references[0])
            if references
            else _stable_id("entity", f"{type_by_root[root]}:{keys[0][2]}")
        )
        ranked = sorted(names, key=lambda name: (-names[name], -len(name), name))
        node_id_by_root[root] = node_id
        nodes[node_id] = {
            "id": node_id,
            "label": ranked[0],
            "type": type_by_root[root],
            "aliases": ranked[1:],
        }

    edges: dict[str, dict] = {}

    def add_edge(source: str, target: str, label: str, evidence: dict) -> None:
        edge_id = _stable_id("edge", "\0".join((source, label, target)))
        edge = edges.setdefault(
            edge_id, {"id": edge_id, "source": source, "target": target, "label": label, "evidence": []}
        )
        if evidence not in edge["evidence"]:
            edge["evidence"].append(evidence)

    for chunk, extraction in extractions:
        node_by_entity = {
            entity["id"]: node_id_by_root[find(mention_keys(entity)[0])]
            for entity in extraction["entities"]
        }
        base = {
            "document_id": chunk["document_id"],
            "document_name": chunk["source"],
            "chunk": chunk["chunk"],
            "page": chunk.get("page"),
        }
        chunk_id = chunk_node_id(chunk["document_id"], chunk["chunk"])
        for entity in extraction["entities"]:
            add_edge(chunk_id, node_by_entity[entity["id"]], "mentions", dict(base))
        for relation in extraction["relations"]:
            evidence = {**base, "excerpt": relation["evidence"]}
            if relation["qualifiers"]:
                evidence["qualifiers"] = relation["qualifiers"]
            add_edge(node_by_entity[relation["source"]], node_by_entity[relation["target"]], relation["type"], evidence)

    return {
        "nodes": sorted(nodes.values(), key=lambda node: node["id"]),
        "edges": sorted(edges.values(), key=lambda edge: edge["id"]),
    }


# Linha de comando ------------------------------------------------------------------


def _report(extractions: list[tuple[dict, dict]]) -> None:
    graph = build_entity_graph(extractions)
    relations = [edge for edge in graph["edges"] if edge["label"] != "mentions"]
    dropped: Counter = Counter()
    extracted = 0
    for _, extraction in extractions:
        dropped.update(extraction["dropped"])
        extracted += len(extraction["relations"])
    total = extracted + sum(value for key, value in dropped.items() if key.startswith("relation_"))

    print(f"\nTrechos extraídos: {len(extractions)}")
    print("Entidades (após resolução) por tipo:",
          dict(Counter(node["type"] for node in graph["nodes"]).most_common()))
    print("Relações (arestas distintas) por tipo:", dict(Counter(edge["label"] for edge in relations).most_common()))
    print(f"Relações aceitas: {extracted} de {total} propostas pelo modelo")
    if dropped:
        print("Descartes por motivo:", dict(dropped.most_common()))
    other = sum(1 for edge in relations if edge["label"] == "outra")
    if relations:
        print(f"Arestas 'outra': {other} de {len(relations)} ({other / len(relations):.0%})")


def main_cli() -> None:
    from app.retrieval import vector_store

    parser = argparse.ArgumentParser(description="Extrai entidades e relações dos trechos indexados.")
    parser.add_argument("--report-only", action="store_true", help="não chama o LLM; só resume o cache")
    parser.add_argument("--limit", type=int, help="extrai no máximo N trechos (para testar)")
    args = parser.parse_args()

    store = vector_store.VECTOR_STORE_PATH
    if not store.exists():
        raise SystemExit("Nenhum índice encontrado. Abra a aplicação para indexar os documentos primeiro.")
    with closing(sqlite3.connect(store)) as connection:
        document_ids = [row[0] for row in connection.execute("SELECT id FROM documents ORDER BY id")]
    chunks, _ = vector_store._load_indexed_chunks(document_ids, require_all=False)
    print(f"{len(chunks)} trechos indexados em {len(document_ids)} documentos.")

    if not args.report_only:
        pending = chunks[: args.limit] if args.limit else chunks
        sent = extract_missing(store, pending)
        print(f"{sent} trecho(s) enviados ao modelo.")

    _report(load_extractions(store, chunks))


if __name__ == "__main__":
    sys.exit(main_cli())
