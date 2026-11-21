"""
Avaliação da extração de entidades e relações (camada de entidades do grafo).

Lê as extrações já guardadas no índice da aplicação (não chama o LLM) e mede:

    Cobertura (recall): fração das relações de `graph_gold.json` encontradas
        no grafo, com intervalo de Wilson de 95%. Uma relação do gabarito é
        encontrada quando há uma aresta de um dos tipos aceitos cuja origem e
        cujo destino casam com algum dos nomes aceitos. Nomes são comparados
        sem maiúsculas, acentos e pontuação, como palavras inteiras, e um
        pode estar contido no outro ("Aditivo 02" casa com "Termo Aditivo nº
        02"). O rótulo e os aliases do nó contam.
    Identidade: pares que devem ser o mesmo nó (sigla e nome completo) e
        pares que devem ser nós diferentes (Menezes x Meneses).
    Precisão: um gabarito não mede precisão, porque relações corretas que
        não estão nele contariam como erro. Por isso, `--sample N` grava uma
        amostra aleatória de relações extraídas em CSV; depois de preencher a
        coluna `correct` com 1 ou 0, `--precision arquivo.csv` calcula a
        precisão com intervalo de Wilson.
    Resumo: entidades por tipo, relações por tipo, descartes da validação e
        fração de `outra`.

Uso (a partir de `backend/`, depois de `python -m app.retrieval.entity_extraction`):
    python -m evals.graph_eval
    python -m evals.graph_eval --sample 30
    python -m evals.graph_eval --precision evals/graph_precision_sample.csv
"""

import argparse
import csv
import json
import os
import random
import re
import sqlite3
import sys
from collections import Counter
from contextlib import closing
from pathlib import Path

os.environ.setdefault("FRONTEND_ORIGIN", "http://localhost")

from app.retrieval import vector_store  # noqa: E402
from app.retrieval.chunk_graph import _stable_id, find_references  # noqa: E402
from app.retrieval.entity_extraction import _normalize_name, build_entity_graph, load_extractions  # noqa: E402
from evals.retrieval_eval import wilson_interval  # noqa: E402

EVALS_DIRECTORY = Path(__file__).resolve().parent
GOLD_PATH = EVALS_DIRECTORY / "graph_gold.json"
SAMPLE_PATH = EVALS_DIRECTORY / "graph_precision_sample.csv"
SAMPLE_SEED = 2026


def load_graph() -> tuple[dict, list[tuple[dict, dict]]]:
    store = vector_store.VECTOR_STORE_PATH
    if not store.exists():
        raise SystemExit("Nenhum índice encontrado. Abra a aplicação para indexar os documentos.")
    with closing(sqlite3.connect(store)) as connection:
        document_ids = [row[0] for row in connection.execute("SELECT id FROM documents ORDER BY id")]
    chunks, _ = vector_store._load_indexed_chunks(document_ids, require_all=False)
    extractions = load_extractions(store, chunks)
    if not extractions:
        raise SystemExit("Nenhuma extração no cache. Rode: python -m app.retrieval.entity_extraction")
    return build_entity_graph(extractions), extractions


def match_name(name: str) -> str:
    """Nome normalizado para comparação; ignora o marcador "nº" ("no" depois de normalizado)."""
    return re.sub(r"\bn o (?=\d)|\bno (?=\d)", "", _normalize_name(name))


def node_names(node: dict) -> list[str]:
    return [match_name(name) for name in [node["label"], *(node.get("aliases") or [])]]


def names_match(gold: str, node: dict) -> bool:
    # Atos numerados comparam pela identidade ("Contrato 014/2021" só casa com
    # o nó desse contrato), não por trecho do nome: um alias como "Termo
    # Aditivo nº 01 ao Contrato 014/2021" não pode fazer o Aditivo 01 passar
    # pelo contrato.
    references = find_references(gold)
    if len(references) == 1:
        return node["id"] == _stable_id("reference", references[0][0])
    wanted = f" {match_name(gold)} "
    return any(
        wanted in f" {name} " or (len(name) >= 3 and f" {name} " in wanted)
        for name in node_names(node)
    )


def find_gold_relation(gold: dict, graph: dict, nodes_by_id: dict) -> dict | None:
    for edge in graph["edges"]:
        if edge["label"] not in gold["relation"]:
            continue
        source, target = nodes_by_id[edge["source"]], nodes_by_id[edge["target"]]
        if any(names_match(name, source) for name in gold["source"]) and any(
            names_match(name, target) for name in gold["target"]
        ):
            return edge
    return None


def nodes_named(name: str, graph: dict) -> set[str]:
    wanted = match_name(name)
    return {node["id"] for node in graph["nodes"] if wanted in node_names(node)}


def evaluate(graph: dict, gold: dict) -> dict:
    nodes_by_id = {node["id"]: node for node in graph["nodes"]}
    rows = []
    for item in gold["relations"]:
        edge = find_gold_relation(item, graph, nodes_by_id)
        rows.append({
            "id": item["id"],
            "expected": f"{item['source'][0]} --{'|'.join(item['relation'])}--> {item['target'][0]}",
            "found": edge is not None,
            "match": (
                f"{nodes_by_id[edge['source']]['label']} --{edge['label']}--> {nodes_by_id[edge['target']]['label']}"
                if edge else None
            ),
            "documents": sorted({evidence["document_name"] for evidence in edge["evidence"]}) if edge else [],
        })

    checks = []
    for kind, pairs in gold["identity_checks"].items():
        for first, second in pairs:
            first_ids, second_ids = nodes_named(first, graph), nodes_named(second, graph)
            if not first_ids or not second_ids:
                status = "não encontrado"
            elif kind == "same":
                status = "ok" if first_ids & second_ids else "falhou"
            else:
                status = "ok" if not first_ids & second_ids else "falhou"
            checks.append({"kind": kind, "pair": [first, second], "status": status})

    found = [1.0 if row["found"] else 0.0 for row in rows]
    return {
        "recall": sum(found) / len(found),
        "recall_ci95": wilson_interval(found),
        "relations": rows,
        "identity_checks": checks,
    }


def relation_instances(graph: dict) -> list[dict]:
    """Uma linha por relação extraída de um trecho (aresta + evidência)."""
    nodes_by_id = {node["id"]: node for node in graph["nodes"]}
    instances = []
    for edge in graph["edges"]:
        if edge["label"] == "mentions":
            continue
        for evidence in edge["evidence"]:
            instances.append({
                "id": f"{edge['id']}|{evidence['document_id']}|{evidence['chunk']}",
                "source": nodes_by_id[edge["source"]]["label"],
                "relation": edge["label"],
                "target": nodes_by_id[edge["target"]]["label"],
                "qualifiers": json.dumps(evidence.get("qualifiers") or {}, ensure_ascii=False),
                "evidence": evidence.get("excerpt", ""),
                "document": evidence["document_name"],
                "chunk": evidence["chunk"],
                "correct": "",
            })
    return sorted(instances, key=lambda item: item["id"])


def print_summary(graph: dict, extractions: list[tuple[dict, dict]]) -> None:
    relations = [edge for edge in graph["edges"] if edge["label"] != "mentions"]
    instances = relation_instances(graph)
    dropped: Counter = Counter()
    for _, extraction in extractions:
        dropped.update(extraction["dropped"])
    relation_drops = sum(value for key, value in dropped.items() if key.startswith("relation_"))
    other = sum(1 for item in instances if item["relation"] == "outra")

    print(f"Trechos com extração: {len(extractions)}")
    print(f"Entidades (nós, após resolução): {len(graph['nodes'])}",
          dict(Counter(node["type"] for node in graph["nodes"]).most_common()))
    print(f"Relações: {len(relations)} arestas distintas, {len(instances)} ocorrências",
          dict(Counter(item["relation"] for item in instances).most_common()))
    print(f"Ocorrências 'outra': {other} de {len(instances)} ({other / max(1, len(instances)):.0%})")
    print(f"Propostas pelo modelo e descartadas na validação: {relation_drops} de "
          f"{relation_drops + len(instances)} relações", dict(dropped.most_common()))


def main_cli() -> None:
    parser = argparse.ArgumentParser(description="Avalia a extração de entidades e relações.")
    parser.add_argument("--sample", type=int, help="grava N relações aleatórias para rotular a precisão")
    parser.add_argument("--precision", type=Path, help="CSV rotulado (coluna correct = 1 ou 0)")
    parser.add_argument("--json", type=Path, help="grava o resultado completo neste arquivo")
    args = parser.parse_args()

    if args.precision:
        with args.precision.open(encoding="utf-8-sig", newline="") as file:
            labels = [row["correct"].strip() for row in csv.DictReader(file)]
        values = [1.0 if label == "1" else 0.0 for label in labels if label in ("0", "1")]
        if not values:
            raise SystemExit("Nenhuma linha rotulada: preencha a coluna 'correct' com 1 ou 0.")
        low, high = wilson_interval(values)
        print(f"Precisão: {sum(values):.0f}/{len(values)} = {sum(values) / len(values):.3f} "
              f"[IC 95% Wilson: {low:.2f}, {high:.2f}]"
              + (f" ({len(labels) - len(values)} linha(s) sem rótulo ignorada(s))" if len(values) < len(labels) else ""))
        return

    graph, extractions = load_graph()
    print_summary(graph, extractions)

    if args.sample:
        instances = relation_instances(graph)
        sample = random.Random(SAMPLE_SEED).sample(instances, min(args.sample, len(instances)))
        with SAMPLE_PATH.open("w", encoding="utf-8-sig", newline="") as file:
            writer = csv.DictWriter(file, fieldnames=list(sample[0]))
            writer.writeheader()
            writer.writerows(sample)
        print(f"\nAmostra de {len(sample)} relações gravada em {SAMPLE_PATH}. "
              "Preencha 'correct' com 1 (correta segundo a evidência) ou 0.")
        return

    result = evaluate(graph, json.loads(GOLD_PATH.read_text(encoding="utf-8")))
    found = sum(row["found"] for row in result["relations"])
    low, high = result["recall_ci95"]
    print(f"\nCobertura do gabarito: {found}/{len(result['relations'])} = {result['recall']:.3f} "
          f"[IC 95% Wilson: {low:.2f}, {high:.2f}]")
    for row in result["relations"]:
        mark = "ok " if row["found"] else "-- "
        detail = f"  ->  {row['match']}  {row['documents']}" if row["found"] else ""
        print(f"  {mark}{row['id']} {row['expected']}{detail}")
    print("\nIdentidade de entidades")
    for check in result["identity_checks"]:
        relation = "mesmo nó" if check["kind"] == "same" else "nós diferentes"
        print(f"  {check['status']:<15} {check['pair'][0]} / {check['pair'][1]} ({relation})")

    if args.json:
        args.json.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")


if __name__ == "__main__":
    sys.exit(main_cli())
