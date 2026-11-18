r"""
Construção do grafo de relações entre entidades de um documento.

O grafo alimenta o modo `graphrag`: além dos trechos recuperados, o modelo
recebe as relações entre itens e entidades (projeto, produto, tags etc.) que
aparecem nesses trechos. A extração usa apenas regras locais sobre metadados
estruturados em Markdown, sem chamar nenhum modelo de linguagem e, portanto,
sem gastar tokens. Texto livre sem esses metadados não gera relações.

Formato esperado do documento (Markdown):
    Cada item de conhecimento é um registro. Os registros são separados por
    uma linha de hífens escapados (`\-----`, com cinco ou mais hífens). Em
    cada registro, a primeira linha com texto é o título e uma linha traz os
    metadados, todos na mesma linha:

        \-----
        ## Título do item
        **Tipo:** Artigo **Projeto:** Skill Shard **Tags:** rag, grafos

    Campos reconhecidos (maiúsculas e minúsculas não importam):
        Tipo: vira um nó `document_type`, ligado pela relação `type`.
        Projeto: nó `project`, relação `project`.
        Produto: nó `product`, relação `product`.
        Hierarquia: nó `topic`, relação `topic`.
        Tags: um nó `tag` para cada valor, separados por vírgula ou ponto e
            vírgula, relação `tag`.
        URL Fonte: não vira nó; fica como `source_url` na evidência.
    Registros sem título, sem uma linha com o campo `**Tipo:**` ou sem nenhum
    campo reconhecido são ignorados.

Estrutura do grafo:
    Nós: `{"id", "label", "type"}`, com `type` entre `document`,
        `knowledge_item`, `document_type`, `project`, `product`, `topic` e
        `tag`.
    Arestas: `{"id", "source", "target", "label", "evidence"}`. A relação
        `contains` liga o documento a cada item; as demais (`type`,
        `project`, `product`, `topic`, `tag`) ligam o item a uma entidade.
    Evidência: cada aresta guarda a lista de itens de onde veio
        (`document_id`, `document_name`, `title` e, se houver, `source_url`).
        É isso que permite mostrar de qual documento cada relação foi tirada.

Os IDs são estáveis: derivam de um hash do tipo e do rótulo (ignorando
maiúsculas e espaços extras). Assim, a mesma entidade recebe o mesmo ID em
documentos diferentes, e é isso que permite unir os grafos de vários
documentos. Documentos que não são texto (PDF, com codificação `base64`)
geram apenas o nó do documento, sem arestas.
"""

import hashlib
import json
import re


_RECORD_SEPARATOR = re.compile(r"(?m)^\\-{5,}\s*$")
_FIELD_MARKER = re.compile(r"\*\*(?P<key>[^*]+):\*\*")
_GRAPH_FIELDS = {
    "tipo": ("document_type", "type"),
    "projeto": ("project", "project"),
    "produto": ("product", "product"),
    "hierarquia": ("topic", "topic"),
    "tags": ("tag", "tag"),
}
_ESCAPED_MARKDOWN = re.compile(r"\\([\\_*|:>])")


def _clean_metadata_value(value: str) -> str:
    value = value.strip().strip("\\|").strip()
    return _ESCAPED_MARKDOWN.sub(r"\1", value)


def _parse_metadata(line: str) -> dict[str, str]:
    """Lê os pares `**Campo:** valor` de uma linha e devolve `{campo: valor}`, com o campo em minúsculas e sem valores vazios."""
    markers = list(_FIELD_MARKER.finditer(line))
    metadata = {}

    for index, marker in enumerate(markers):
        end = markers[index + 1].start() if index + 1 < len(markers) else len(line)
        key = marker.group("key").strip().casefold()
        value = _clean_metadata_value(line[marker.end():end])
        if value:
            metadata[key] = value

    return metadata


def _stable_id(kind: str, identity: str) -> str:
    digest = hashlib.sha256(identity.encode("utf-8")).hexdigest()[:20]
    return f"{kind}:{digest}"


def _graph_node(kind: str, label: str, identity: str | None = None) -> dict:
    node_identity = identity if identity is not None else " ".join(label.casefold().split())
    return {
        "id": _stable_id(kind, node_identity),
        "label": label,
        "type": kind,
    }


def build_document_graph(document: dict) -> dict:
    """
    Constrói o grafo de um documento a partir dos seus metadados.

    Args:
        document: dicionário com `id`, `name` e, opcionalmente, `content` e
            `encoding` (padrão `"text"`).

    Returns:
        `{"nodes": [...], "edges": [...]}`, ordenados por `id` para que a
        mesma entrada gere sempre o mesmo resultado. O nó do documento está
        sempre presente, mesmo quando não há nenhuma aresta.
    """
    document_id = document["id"]
    document_name = document["name"]
    document_node = {
        "id": f"document:{document_id}",
        "label": document_name,
        "type": "document",
    }
    nodes = {document_node["id"]: document_node}
    edges = {}
    content = document.get("content", "")

    if document.get("encoding", "text") != "text":
        return {"nodes": list(nodes.values()), "edges": []}

    for ordinal, record in enumerate(_RECORD_SEPARATOR.split(content)):
        lines = record.splitlines()
        metadata_index = next(
            (index for index, line in enumerate(lines) if "**Tipo:**" in line),
            None,
        )
        if metadata_index is None:
            continue

        title = next(
            (
                line.strip().lstrip("#").strip()
                for line in lines[:metadata_index]
                if line.strip()
            ),
            "",
        )
        metadata = _parse_metadata(lines[metadata_index])
        if not title or not any(field in metadata for field in _GRAPH_FIELDS):
            continue

        source_url = metadata.get("url fonte", "")
        item_identity = "\0".join((document_id, str(ordinal), title, source_url))
        item_node = _graph_node(
            "knowledge_item",
            title,
            item_identity,
        )
        nodes[item_node["id"]] = item_node
        evidence = {
            "document_id": document_id,
            "document_name": document_name,
            "title": title,
        }
        if source_url:
            evidence["source_url"] = source_url

        _add_edge(edges, document_node["id"], item_node["id"], "contains", evidence)

        for field, (node_type, relation) in _GRAPH_FIELDS.items():
            value = metadata.get(field)
            if not value:
                continue
            values = (
                [tag.strip() for tag in re.split(r"[,;]", value) if tag.strip()]
                if field == "tags"
                else [value]
            )
            for entity in values:
                entity_node = _graph_node(node_type, entity)
                nodes[entity_node["id"]] = entity_node
                _add_edge(edges, item_node["id"], entity_node["id"], relation, evidence)

    return {
        "nodes": sorted(nodes.values(), key=lambda node: node["id"]),
        "edges": sorted(edges.values(), key=lambda edge: edge["id"]),
    }


def _add_edge(
    edges: dict[str, dict],
    source: str,
    target: str,
    label: str,
    evidence: dict,
) -> None:
    edge_id = _stable_id("edge", "\0".join((source, label, target)))
    edge = edges.setdefault(
        edge_id,
        {
            "id": edge_id,
            "source": source,
            "target": target,
            "label": label,
            "evidence": [],
        },
    )
    if evidence not in edge["evidence"]:
        edge["evidence"].append(evidence)


def merge_document_graphs(graphs: list[dict]) -> dict:
    """
    Une os grafos de vários documentos em um só.

    Nós com o mesmo `id` aparecem uma única vez. Arestas com o mesmo `id` são
    unificadas e suas evidências são somadas, sem repetição.

    Args:
        graphs: resultados de `build_document_graph`.

    Returns:
        O grafo unido, com nós e arestas ordenados por `id`.
    """
    nodes = {}
    edges = {}

    for graph in graphs:
        for node in graph["nodes"]:
            nodes.setdefault(node["id"], node)
        for graph_edge in graph["edges"]:
            edge = edges.setdefault(graph_edge["id"], {**graph_edge, "evidence": []})
            for evidence in graph_edge["evidence"]:
                if evidence not in edge["evidence"]:
                    edge["evidence"].append(evidence)

    return {
        "nodes": sorted(nodes.values(), key=lambda node: node["id"]),
        "edges": sorted(edges.values(), key=lambda edge: edge["id"]),
    }


def serialize_document_graph(document: dict) -> str:
    """
    Gera o grafo do documento já em JSON compacto, pronto para guardar no banco.

    O resultado é gravado na tabela `document_graphs` durante a indexação.

    Args:
        document: mesmo formato aceito por `build_document_graph`.

    Returns:
        O grafo serializado como texto JSON, sem espaços extras e mantendo
        os acentos.
    """
    return json.dumps(
        build_document_graph(document),
        ensure_ascii=False,
        separators=(",", ":"),
    )
