"""
Camada de trechos do grafo: relações determinísticas entre chunks.

Complementa `entity_graph.py`, que só extrai relações de Markdown no formato
de registros (`\\-----` e `**Tipo:**`). Esta camada funciona com qualquer
documento, sem chamar modelo de linguagem, e é montada na consulta do grafo a
partir dos trechos e embeddings já guardados no índice.

Nós:
    document: o documento (mesmo ID usado em `entity_graph`, então os dois
        grafos se unem).
    chunk: um trecho, com `document_id`, `chunk` e `page`.
    documento: um ato citado por número no texto, como "Contrato 014/2021",
        "Aditivo 02", "Parecer 118/2024" ou "Nota Técnica 07/2024".

Arestas:
    contains: documento -> trecho.
    mentions: trecho -> referência que aparece no texto dele.
    cites: trecho -> outro documento citado pelo código (por exemplo,
        "ver D18" liga ao arquivo cujo nome começa com `D18`). O próprio
        documento não conta.
    similar_to: trecho <-> trecho de outro documento com significado
        parecido (veja `build_chunk_graph`). Traz `weight`, a similaridade de
        cosseno.

Evidência: cada aresta guarda os trechos de onde veio (`document_id`,
`document_name`, `chunk`, `page` e `excerpt`, um pedaço do texto em volta da
menção). Assim, a interface mostra exatamente o trecho que justifica a
relação.

Funções:
    build_chunk_graph: monta a camada de trechos.
    attach_chunk_evidence: completa com o número do trecho as evidências do
        grafo de `entity_graph`, que só têm o título do item.
"""

import hashlib
import re
from pathlib import Path

import numpy as np

# Cada trecho se liga aos seus vizinhos mais parecidos de outros documentos,
# desde que a similaridade esteja entre as mais altas do grafo. O limite é
# relativo (percentil) porque os valores absolutos de cosseno dependem do
# modelo e do corpus: com `gemini-embedding-001` e os documentos de `data/`, a
# mediana entre documentos diferentes já é cerca de 0,71.
SIMILARITY_NEIGHBORS = 2
SIMILARITY_PERCENTILE = 90
EXCERPT_RADIUS = 90

_REFERENCE_KINDS = {
    "aditivo": "Aditivo",
    "contrato": "Contrato",
    "parecer": "Parecer",
    "nota tecnica": "Nota Técnica",
}
_NUMBER = r"\d{1,4}(?:/\d{4})?"
_NUMBER_MARK = r"(?:n\.?\s?[º°o]\.?)"
# "Aditivo 02", "Contrato nº 014/2021" ou, com até três palavras no meio,
# "Contrato CTMSC nº 014/2021" e "Nota Técnica de Capacidade nº 07/2024". Com
# palavras no meio, o "nº" é obrigatório, para não ler "contrato da Linha 2"
# como "Contrato 2".
_REFERENCE = re.compile(
    rf"\b(?P<kind>termo\s+aditivo|aditivo|contrato|parecer|nota\s+t[ée]cnica)"
    rf"(?:\s+{_NUMBER_MARK}?\s*(?P<number>{_NUMBER})\b"
    rf"|(?:\s+(?:de|do|da|dos|das)?\s*[\wÀ-ÿ]+){{1,3}}?\s+{_NUMBER_MARK}\s*(?P<marked>{_NUMBER})\b)",
    re.IGNORECASE,
)
_DOCUMENT_CODE = re.compile(r"\b(D\d{2,3})\b")
_FILE_CODE = re.compile(r"^(D\d{2,3})(?:[_\-. ]|$)", re.IGNORECASE)


def _stable_id(kind: str, identity: str) -> str:
    digest = hashlib.sha256(identity.encode("utf-8")).hexdigest()[:20]
    return f"{kind}:{digest}"


def _fold(text: str) -> str:
    return " ".join(
        text.casefold()
        .replace("é", "e")
        .replace("ê", "e")
        .split()
    )


def _excerpt(text: str, start: int = 0, end: int | None = None) -> str:
    """Pedaço do texto em volta de `start:end`, em uma linha só."""
    end = start if end is None else end
    low = max(0, start - EXCERPT_RADIUS)
    high = min(len(text), end + EXCERPT_RADIUS)
    snippet = " ".join(text[low:high].split())
    return f"{'…' if low else ''}{snippet}{'…' if high < len(text) else ''}"


def chunk_node_id(document_id: str, chunk: int) -> str:
    return f"chunk:{document_id}:{chunk}"


def _chunk_label(chunk: dict) -> str:
    stem = Path(chunk["source"]).stem
    code = _FILE_CODE.match(stem)
    name = code.group(1).upper() if code else (stem if len(stem) <= 24 else f"{stem[:23]}…")
    return f"{name} · trecho {chunk['chunk']}"


def _evidence(chunk: dict, excerpt: str | None = None) -> dict:
    evidence = {
        "document_id": chunk["document_id"],
        "document_name": chunk["source"],
        "chunk": chunk["chunk"],
        "page": chunk.get("page"),
    }
    if excerpt:
        evidence["excerpt"] = excerpt
    return evidence


def _add_edge(edges: dict, source: str, target: str, label: str, evidence: dict, weight: float | None = None):
    edge_id = _stable_id("edge", "\0".join((source, label, target)))
    edge = edges.setdefault(
        edge_id,
        {"id": edge_id, "source": source, "target": target, "label": label, "evidence": []},
    )
    if weight is not None:
        edge["weight"] = round(weight, 4)
    key = (evidence["document_id"], evidence["chunk"])
    if all((item["document_id"], item["chunk"]) != key for item in edge["evidence"]):
        edge["evidence"].append(evidence)


def find_references(text: str) -> list[tuple[str, str, int, int]]:
    """
    Encontra atos citados por número no texto.

    Returns:
        `(identidade, rótulo, início, fim)` para cada menção. A identidade
        ignora variações de escrita: "Termo Aditivo nº 02", "Aditivo 02" e
        "aditivo 2" são a mesma referência. O rótulo usa a primeira grafia
        do número encontrada.
    """
    references = []
    for match in _REFERENCE.finditer(text):
        kind = _fold(match.group("kind")).replace("termo ", "")
        number = match.group("number") or match.group("marked")
        head, _, year = number.partition("/")
        identity_number = str(int(head)) + (f"/{year}" if year else "")
        references.append((
            f"{kind}:{identity_number}",
            f"{_REFERENCE_KINDS[kind]} {number}",
            match.start(),
            match.end(),
        ))
    return references


def build_chunk_graph(chunks: list[dict], embeddings: list[list[float]] | None = None) -> dict:
    """
    Monta a camada de trechos do grafo.

    Args:
        chunks: trechos indexados, cada um com `document_id`, `source`,
            `chunk`, `page` e `text`.
        embeddings: um vetor por trecho, na mesma ordem. Sem embeddings, as
            arestas `similar_to` não são criadas.

    Returns:
        `{"nodes": [...], "edges": [...]}`, ordenados por `id`.

    Regra de similaridade: para cada trecho, os `SIMILARITY_NEIGHBORS`
    trechos mais parecidos de outros documentos viram arestas `similar_to`,
    se a similaridade for pelo menos o percentil `SIMILARITY_PERCENTILE` de
    todos os pares de documentos diferentes do grafo. Pares repetidos (A
    vizinho de B e B vizinho de A) viram uma aresta só.
    """
    nodes: dict[str, dict] = {}
    edges: dict[str, dict] = {}
    documents_by_code = {}

    for chunk in chunks:
        document_node = {
            "id": f"document:{chunk['document_id']}",
            "label": chunk["source"],
            "type": "document",
        }
        nodes.setdefault(document_node["id"], document_node)
        code = _FILE_CODE.match(Path(chunk["source"]).name)
        if code:
            documents_by_code.setdefault(code.group(1).upper(), document_node["id"])

    for chunk in chunks:
        node_id = chunk_node_id(chunk["document_id"], chunk["chunk"])
        nodes[node_id] = {
            "id": node_id,
            "label": _chunk_label(chunk),
            "type": "chunk",
            "document_id": chunk["document_id"],
            "chunk": chunk["chunk"],
            "page": chunk.get("page"),
        }
        _add_edge(edges, f"document:{chunk['document_id']}", node_id, "contains",
                  _evidence(chunk, _excerpt(chunk["text"], 0, 2 * EXCERPT_RADIUS)))

        for identity, label, start, end in find_references(chunk["text"]):
            reference_id = _stable_id("reference", identity)
            nodes.setdefault(reference_id, {"id": reference_id, "label": label, "type": "documento"})
            _add_edge(edges, node_id, reference_id, "mentions",
                      _evidence(chunk, _excerpt(chunk["text"], start, end)))

        own_document = f"document:{chunk['document_id']}"
        for match in _DOCUMENT_CODE.finditer(chunk["text"]):
            target = documents_by_code.get(match.group(1).upper())
            if target and target != own_document:
                _add_edge(edges, node_id, target, "cites",
                          _evidence(chunk, _excerpt(chunk["text"], match.start(), match.end())))

    if embeddings is not None and len(chunks) > 1:
        _add_similarity_edges(chunks, embeddings, edges)

    return {
        "nodes": sorted(nodes.values(), key=lambda node: node["id"]),
        "edges": sorted(edges.values(), key=lambda edge: edge["id"]),
    }


def _add_similarity_edges(chunks: list[dict], embeddings: list[list[float]], edges: dict) -> None:
    vectors = np.asarray(embeddings, dtype=float)
    norms = np.linalg.norm(vectors, axis=1, keepdims=True)
    vectors = vectors / np.where(norms == 0, 1, norms)
    similarities = vectors @ vectors.T

    documents = np.array([chunk["document_id"] for chunk in chunks])
    cross_document = documents[:, None] != documents[None, :]
    upper = np.triu(cross_document, k=1)
    if not upper.any():
        return
    threshold = float(np.percentile(similarities[upper], SIMILARITY_PERCENTILE))

    for index, chunk in enumerate(chunks):
        candidates = np.where(cross_document[index])[0]
        best = candidates[np.argsort(-similarities[index, candidates], kind="stable")][:SIMILARITY_NEIGHBORS]
        for other in best:
            score = float(similarities[index, other])
            if score < threshold:
                continue
            first, second = sorted((index, int(other)))
            source = chunk_node_id(chunks[first]["document_id"], chunks[first]["chunk"])
            target = chunk_node_id(chunks[second]["document_id"], chunks[second]["chunk"])
            for side in (chunks[first], chunks[second]):
                _add_edge(edges, source, target, "similar_to",
                          _evidence(side, _excerpt(side["text"], 0, 2 * EXCERPT_RADIUS)), score)


def attach_chunk_evidence(graph: dict, chunks: list[dict]) -> dict:
    """
    Liga as evidências do grafo de `entity_graph` aos trechos indexados.

    Essas evidências só têm `document_id` e o título do item. Cada uma
    recebe `chunk` e `page` do primeiro trecho do mesmo documento que contém
    o título (sem diferenciar maiúsculas nem espaços). Com o divisor atual, o
    título aparece em todo trecho do item, porque é repetido como contexto.
    Evidências cujo título não aparece em nenhum trecho ficam como estavam.

    Returns:
        Um novo grafo; o original não é alterado.
    """
    texts_by_document: dict[str, list[tuple[dict, str]]] = {}
    for chunk in chunks:
        texts_by_document.setdefault(chunk["document_id"], []).append(
            (chunk, " ".join(chunk["text"].casefold().split()))
        )

    def with_chunk(evidence: dict) -> dict:
        if "chunk" in evidence or not evidence.get("title"):
            return evidence
        title = " ".join(evidence["title"].casefold().split())
        for chunk, text in texts_by_document.get(evidence["document_id"], []):
            if title in text:
                return {**evidence, "chunk": chunk["chunk"], "page": chunk.get("page")}
        return evidence

    return {
        "nodes": graph["nodes"],
        "edges": [
            {**edge, "evidence": [with_chunk(item) for item in edge["evidence"]]}
            for edge in graph["edges"]
        ],
    }
