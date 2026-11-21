"""
Armazenamento local de documentos, trechos e embeddings, e busca por similaridade.

Este módulo é a "memória" do sistema. Ele guarda em um banco SQLite
(`backend/data/vectors.sqlite3`) os documentos enviados, os trechos (chunks)
em que cada um foi dividido e o embedding de cada trecho. Na hora da pergunta,
encontra os trechos mais relacionados a ela.

Dois conceitos usados aqui:
    Embedding: lista de números (um vetor) que representa o significado de um
        texto. Textos com significado parecido geram vetores parecidos. Os
        vetores são gerados pelo modelo `gemini-embedding-001`.
    Similaridade de cosseno: medida de quão parecidos são dois vetores, pelo
        ângulo entre eles. Quanto mais próxima de 1, mais parecidos.

Tabelas do banco:
    documents: os documentos como foram recebidos (`id`, `name`, `content`,
        `encoding`). Servem para verificar se o índice está atualizado e para
        reconstruir grafos.
    chunks: cache de embeddings. O `id` é um hash SHA-256 do modelo, do
        documento, do arquivo, da página, da posição e do texto do trecho
        (veja `_chunk_id`). Se qualquer um desses valores mudar, o trecho é
        tratado como novo e recebe um novo embedding; trechos que não mudaram
        nunca são enviados de novo à API, o que economiza cota.
    document_chunks: liga cada documento aos seus trechos, em ordem
        (`ordinal`).
    document_graphs: grafo de relações de cada documento, em JSON, gerado por
        `entity_graph` e usado no modo graphrag.

Formato de um trecho (dicionário):
    document_id: ID do documento. É `repository:<caminho>` para arquivos da
        pasta `data/` e um UUID para arquivos enviados pelo usuário.
    source: nome do arquivo de origem.
    page: número da página, a partir de 1, ou `None` nos formatos sem páginas
        (TXT, MD, CSV e JSON).
    chunk: posição do trecho no documento, em sequência a partir de 1. A
        contagem continua de uma página para a outra.
    text: texto do trecho.
    Os resultados de `retrieve_relevant_chunks` trazem também `score`,
    `keyword_score` e `rank_score`.

Funções públicas:
    persist_documents: indexa documentos (gera os embeddings que faltam e
        grava tudo no banco).
    retrieve_relevant_chunks: devolve os trechos mais parecidos com a pergunta.
    get_indexed_document_graph: devolve o grafo dos documentos indexados.
    delete_indexed_document: remove um documento e os dados ligados a ele.
    MissingIndexedDocumentsError: erro levantado quando um documento pedido
        ainda não foi indexado.
"""

import hashlib
import json
import sqlite3
from contextlib import closing
from pathlib import Path

from google.genai import types
from app.config import client
from app.retrieval.chunk_graph import attach_chunk_evidence, build_chunk_graph
from app.retrieval.entity_graph import merge_document_graphs, serialize_document_graph
from app.retrieval.keyword_search import bm25_scores


EMBEDDING_MODEL = "gemini-embedding-001"
EMBEDDING_BATCH_SIZE = 100
# "hybrid": embeddings + BM25 unidos por Reciprocal Rank Fusion; "dense": só
# embeddings. Ver `retrieve_relevant_chunks`.
RETRIEVAL_STRATEGY = "hybrid"
# Constante usual do RRF: reduz a diferença entre as primeiras posições, para
# que nenhuma das duas listas domine a ordem final.
RRF_K = 60
VECTOR_STORE_PATH = Path(__file__).resolve().parents[2] / "data" / "vectors.sqlite3"


class MissingIndexedDocumentsError(ValueError):
    """
    Algum documento pedido ainda não foi indexado.

    O endpoint correspondente converte este erro em uma resposta HTTP 409.
    """


def embed_content(contents: str | list[str]) -> types.EmbedContentResponse:
    """
    Pede à API do Gemini os embeddings de um texto ou de uma lista de textos.

    É um envoltório fino sobre a API. Dentro do módulo, use `_embed_contents`,
    que divide listas grandes em lotes.

    Returns:
        A resposta bruta da API, com um embedding por texto em `.embeddings`.
    """
    return client.models.embed_content(
        model=EMBEDDING_MODEL,
        contents=contents,
    )


def _embed_contents(texts: list[str]) -> list[list[float]]:
    """
    Gera embeddings para uma lista de textos, em lotes de `EMBEDDING_BATCH_SIZE`.

    Os lotes evitam ultrapassar o limite de textos por requisição da API.

    Returns:
        Um vetor por texto, na mesma ordem da entrada.

    Raises:
        RuntimeError: se a API devolver uma quantidade de vetores diferente
            da quantidade de textos.
    """
    embeddings = []

    for start in range(0, len(texts), EMBEDDING_BATCH_SIZE):
        batch = texts[start:start + EMBEDDING_BATCH_SIZE]
        result = embed_content(batch)
        embeddings.extend(embedding.values for embedding in result.embeddings)

    if len(embeddings) != len(texts):
        raise RuntimeError("The embedding service returned an unexpected number of vectors.")

    return embeddings


def _chunk_id(chunk: dict) -> str:
    """
    Calcula o identificador estável de um trecho.

    O ID é o SHA-256 de uma lista com o modelo de embedding, o documento, o
    arquivo, a página, a posição e o texto. O mesmo trecho sempre gera o mesmo
    ID, o que permite reaproveitar o embedding em cache; qualquer alteração
    (inclusive trocar `EMBEDDING_MODEL`) gera um ID novo e um novo embedding.
    """
    identity = json.dumps(
        [
            EMBEDDING_MODEL,
            chunk.get("document_id", chunk["source"]),
            chunk["source"],
            chunk["page"],
            chunk["chunk"],
            chunk["text"],
        ],
        ensure_ascii=False,
        separators=(",", ":"),
    )
    return hashlib.sha256(identity.encode("utf-8")).hexdigest()


def _ensure_store_directory() -> None:
    VECTOR_STORE_PATH.parent.mkdir(parents=True, exist_ok=True)


def _load_cached_embeddings(chunk_ids: list[str]) -> dict[str, list[float]]:
    if not chunk_ids:
        return {}

    if not VECTOR_STORE_PATH.exists():
        return {}

    cached_embeddings = {}
    with closing(sqlite3.connect(VECTOR_STORE_PATH)) as connection:
        for start in range(0, len(chunk_ids), 500):
            batch = chunk_ids[start:start + 500]
            placeholders = ",".join("?" for _ in batch)
            rows = connection.execute(
                f"SELECT id, embedding FROM chunks WHERE id IN ({placeholders})",
                batch,
            )
            cached_embeddings.update(
                (chunk_id, json.loads(embedding))
                for chunk_id, embedding in rows
            )

    return cached_embeddings


def _store_embeddings(chunks: list[dict], embeddings: list[list[float]]) -> None:
    if not chunks:
        return

    _ensure_store_directory()
    with closing(sqlite3.connect(VECTOR_STORE_PATH)) as connection:
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS chunks (
                id TEXT PRIMARY KEY,
                text TEXT NOT NULL,
                source TEXT NOT NULL,
                page INTEGER,
                chunk INTEGER NOT NULL,
                embedding TEXT NOT NULL
            )
            """
        )
        with connection:
            connection.executemany(
                """
                INSERT OR REPLACE INTO chunks (id, text, source, page, chunk, embedding)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                [
                    (
                        _chunk_id(chunk),
                        chunk["text"],
                        chunk["source"],
                        chunk["page"],
                        chunk["chunk"],
                        json.dumps(embedding),
                    )
                    for chunk, embedding in zip(chunks, embeddings)
                ],
            )


def _delete_cached_embeddings(connection: sqlite3.Connection, chunk_ids: set[str]) -> None:
    chunk_ids = list(chunk_ids)
    for start in range(0, len(chunk_ids), 500):
        batch = chunk_ids[start:start + 500]
        placeholders = ",".join("?" for _ in batch)
        connection.execute(
            f"DELETE FROM chunks WHERE id IN ({placeholders})",
            batch,
        )


def _ensure_document_graphs_table(connection: sqlite3.Connection) -> None:
    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS document_graphs (
            document_id TEXT PRIMARY KEY,
            graph_json TEXT NOT NULL
        )
        """
    )


def _store_document_graphs(
    connection: sqlite3.Connection,
    documents: list[dict],
) -> None:
    _ensure_document_graphs_table(connection)
    connection.executemany(
        """
        INSERT OR REPLACE INTO document_graphs (document_id, graph_json)
        VALUES (?, ?)
        """,
        [
            (document["id"], serialize_document_graph(document))
            for document in documents
        ],
    )


def _index_is_current(
    documents: list[dict],
    chunks: list[dict],
    chunk_ids: list[str],
) -> bool:
    """
    Informa se o banco já contém exatamente estes documentos e estes trechos.

    Compara nome, conteúdo e codificação de cada documento e também os
    vínculos entre documentos e trechos. Quando tudo coincide, não há o que
    reindexar.
    """
    if not VECTOR_STORE_PATH.exists():
        return False

    document_ids = [document["id"] for document in documents]
    with closing(sqlite3.connect(VECTOR_STORE_PATH)) as connection:
        tables = {
            row[0]
            for row in connection.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table'"
            )
        }
        if not {"chunks", "documents", "document_chunks"}.issubset(tables):
            return False

        stored_documents = {}
        for start in range(0, len(document_ids), 500):
            batch = document_ids[start:start + 500]
            placeholders = ",".join("?" for _ in batch)
            stored_documents.update(
                (row[0], row[1:])
                for row in connection.execute(
                    f"""
                    SELECT id, name, content, encoding
                    FROM documents
                    WHERE id IN ({placeholders})
                    """,
                    batch,
                )
            )

        if any(
            stored_documents.get(document["id"])
            != (document["name"], document["content"], document["encoding"])
            for document in documents
        ):
            return False

        stored_chunks = []
        for start in range(0, len(document_ids), 500):
            batch = document_ids[start:start + 500]
            placeholders = ",".join("?" for _ in batch)
            stored_chunks.extend(
                connection.execute(
                    f"""
                    SELECT dc.document_id, dc.chunk_id, dc.ordinal
                    FROM document_chunks AS dc
                    JOIN chunks AS c ON c.id = dc.chunk_id
                    WHERE dc.document_id IN ({placeholders})
                    """,
                    batch,
                ).fetchall()
            )

    expected_chunks = sorted(
        (chunk["document_id"], chunk_id, ordinal)
        for ordinal, (chunk, chunk_id) in enumerate(zip(chunks, chunk_ids))
    )
    return sorted(stored_chunks) == expected_chunks


def _get_chunk_embeddings(chunks: list[dict]) -> list[list[float]]:
    """
    Devolve o embedding de cada trecho, na mesma ordem da entrada.

    Lê primeiro do cache (tabela `chunks`) e chama a API apenas para os
    trechos que ainda não têm embedding, guardando os novos no cache.
    """
    chunk_ids = [_chunk_id(chunk) for chunk in chunks]
    cached_embeddings = _load_cached_embeddings(chunk_ids)
    missing_chunks = [
        chunk for chunk, chunk_id in zip(chunks, chunk_ids)
        if chunk_id not in cached_embeddings
    ]

    if missing_chunks:
        new_embeddings = _embed_contents([chunk["text"] for chunk in missing_chunks])
        _store_embeddings(missing_chunks, new_embeddings)
        cached_embeddings.update(
            (_chunk_id(chunk), embedding)
            for chunk, embedding in zip(missing_chunks, new_embeddings)
        )

    return [cached_embeddings[chunk_id] for chunk_id in chunk_ids]


def persist_documents(documents: list[dict], chunks: list[dict]) -> int:
    """
    Indexa documentos: garante os embeddings dos trechos e grava tudo no banco.

    Passo a passo:
        1. Gera embeddings apenas para os trechos que ainda não estão no
           cache.
        2. Se o banco já contém exatamente estes documentos e trechos (veja
           `_index_is_current`), só atualiza os grafos.
        3. Caso contrário, substitui os documentos e os vínculos com seus
           trechos e remove os embeddings de trechos que deixaram de existir.

    Args:
        documents: dicionários com `id`, `name`, `content` e `encoding`.
        chunks: trechos desses documentos, no formato descrito no módulo.

    Returns:
        A quantidade de trechos indexados. Retorna 0, sem alterar o banco,
        quando `documents` ou `chunks` está vazio; para remover documentos,
        use `delete_indexed_document`.

    Raises:
        Exception: falhas da API de embeddings ou do SQLite não são tratadas
            aqui; o endpoint `/index` as converte em erro 502.
    """
    if not documents or not chunks:
        return 0

    chunk_ids = [_chunk_id(chunk) for chunk in chunks]
    _get_chunk_embeddings(chunks)
    if _index_is_current(documents, chunks, chunk_ids):
        with closing(sqlite3.connect(VECTOR_STORE_PATH)) as connection:
            with connection:
                _store_document_graphs(connection, documents)
        return len(chunks)

    _ensure_store_directory()

    with closing(sqlite3.connect(VECTOR_STORE_PATH)) as connection:
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS documents (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                content TEXT NOT NULL,
                encoding TEXT NOT NULL
            )
            """
        )
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS document_chunks (
                document_id TEXT NOT NULL,
                chunk_id TEXT NOT NULL,
                ordinal INTEGER NOT NULL,
                PRIMARY KEY (document_id, ordinal),
                FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
            )
            """
        )
        _ensure_document_graphs_table(connection)

        with connection:
            previous_chunk_ids = set()
            for document in documents:
                previous_chunk_ids.update(
                    row[0]
                    for row in connection.execute(
                        "SELECT chunk_id FROM document_chunks WHERE document_id = ?",
                        (document["id"],),
                    )
                )
                connection.execute(
                    """
                    INSERT OR REPLACE INTO documents (id, name, content, encoding)
                    VALUES (?, ?, ?, ?)
                    """,
                    (
                        document["id"],
                        document["name"],
                        document["content"],
                        document["encoding"],
                    ),
                )
                connection.execute(
                    "DELETE FROM document_chunks WHERE document_id = ?",
                    (document["id"],),
                )
            _store_document_graphs(connection, documents)

            new_chunk_ids = set()
            connection.executemany(
                """
                INSERT INTO document_chunks (document_id, chunk_id, ordinal)
                VALUES (?, ?, ?)
                """,
                [
                    (chunk["document_id"], chunk_id, ordinal)
                    for ordinal, (chunk, chunk_id) in enumerate(zip(chunks, chunk_ids))
                ],
            )
            new_chunk_ids.update(chunk_ids)
            stale_chunk_ids = previous_chunk_ids - new_chunk_ids
            if stale_chunk_ids:
                _delete_cached_embeddings(connection, stale_chunk_ids)

    return len(chunks)


def delete_indexed_document(document_id: str) -> None:
    """
    Remove um documento do banco, com seus vínculos, embeddings e grafo.

    Não faz nada se o banco ainda não existe ou se o ID não está indexado.

    Args:
        document_id: ID do documento a remover.
    """
    if not VECTOR_STORE_PATH.exists():
        return

    with closing(sqlite3.connect(VECTOR_STORE_PATH)) as connection:
        tables = {
            row[0]
            for row in connection.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table'"
            )
        }
        if not {"documents", "document_chunks"}.issubset(tables):
            return

        chunk_ids = [
            row[0]
            for row in connection.execute(
                "SELECT chunk_id FROM document_chunks WHERE document_id = ?",
                (document_id,),
            )
        ]
        with connection:
            if "document_graphs" in tables:
                connection.execute(
                    "DELETE FROM document_graphs WHERE document_id = ?",
                    (document_id,),
                )
            connection.execute(
                "DELETE FROM document_chunks WHERE document_id = ?",
                (document_id,),
            )
            connection.execute("DELETE FROM documents WHERE id = ?", (document_id,))
            if chunk_ids:
                _delete_cached_embeddings(connection, set(chunk_ids))


def get_indexed_document_graph(document_ids: list[str] | None = None) -> dict:
    """
    Devolve o grafo de relações dos documentos indexados, já unido em um só.

    Se o grafo de algum documento não estiver guardado, ele é reconstruído a
    partir do conteúdo original e guardado para as próximas consultas.

    Args:
        document_ids: documentos a incluir. Com `None` ou lista vazia, inclui
            todos os documentos indexados.

    Returns:
        `{"nodes": [...], "edges": [...]}`. O grafo vem vazio quando nenhum
        documento está indexado e nenhum ID foi pedido.

    Raises:
        MissingIndexedDocumentsError: se algum ID pedido não estiver indexado.
    """
    if not VECTOR_STORE_PATH.exists():
        if document_ids:
            raise MissingIndexedDocumentsError("One or more documents have not been indexed.")
        return {"nodes": [], "edges": []}

    requested_ids = list(dict.fromkeys(document_ids or []))
    with closing(sqlite3.connect(VECTOR_STORE_PATH)) as connection:
        tables = {
            row[0]
            for row in connection.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table'"
            )
        }
        if "documents" not in tables:
            if requested_ids:
                raise MissingIndexedDocumentsError("One or more documents have not been indexed.")
            return {"nodes": [], "edges": []}

        if requested_ids:
            document_rows = []
            for start in range(0, len(requested_ids), 500):
                batch = requested_ids[start:start + 500]
                placeholders = ",".join("?" for _ in batch)
                document_rows.extend(
                    connection.execute(
                        f"SELECT id, name FROM documents WHERE id IN ({placeholders})",
                        batch,
                    ).fetchall()
                )
            document_ids_to_load = requested_ids
            found_ids = {row[0] for row in document_rows}
            if found_ids != set(requested_ids):
                raise MissingIndexedDocumentsError("One or more documents have not been indexed.")
        else:
            document_rows = connection.execute(
                "SELECT id, name FROM documents ORDER BY id"
            ).fetchall()
            document_ids_to_load = [row[0] for row in document_rows]

        if not document_ids_to_load:
            return {"nodes": [], "edges": []}

        _ensure_document_graphs_table(connection)
        graph_rows = []
        for start in range(0, len(document_ids_to_load), 500):
            batch = document_ids_to_load[start:start + 500]
            placeholders = ",".join("?" for _ in batch)
            graph_rows.extend(
                connection.execute(
                    f"""
                    SELECT document_id, graph_json
                    FROM document_graphs
                    WHERE document_id IN ({placeholders})
                    """,
                    batch,
                ).fetchall()
            )

        cached_ids = {row[0] for row in graph_rows}
        missing_ids = [
            document_id
            for document_id in document_ids_to_load
            if document_id not in cached_ids
        ]
        if missing_ids:
            missing_documents = []
            for start in range(0, len(missing_ids), 500):
                batch = missing_ids[start:start + 500]
                placeholders = ",".join("?" for _ in batch)
                missing_documents.extend(
                    connection.execute(
                        f"""
                        SELECT id, name, content, encoding
                        FROM documents
                        WHERE id IN ({placeholders})
                        """,
                        batch,
                    ).fetchall()
                )
            documents_by_id = {
                row[0]: {
                    "id": row[0],
                    "name": row[1],
                    "content": row[2],
                    "encoding": row[3],
                }
                for row in missing_documents
            }
            with connection:
                _store_document_graphs(
                    connection,
                    [documents_by_id[document_id] for document_id in missing_ids],
                )
            graph_rows.extend(
                (
                    document_id,
                    serialize_document_graph(documents_by_id[document_id]),
                )
                for document_id in missing_ids
            )

    graph_rows.sort(key=lambda row: row[0])
    metadata_graph = merge_document_graphs(
        [json.loads(graph_json) for _, graph_json in graph_rows]
    )
    chunks, embeddings = _load_indexed_chunks(document_ids_to_load, require_all=False)
    return merge_document_graphs([
        attach_chunk_evidence(metadata_graph, chunks),
        build_chunk_graph(chunks, embeddings),
    ])


def _load_indexed_chunks(
    document_ids: list[str],
    require_all: bool = True,
) -> tuple[list[dict], list[list[float]]]:
    """
    Carrega do banco os trechos e os embeddings dos documentos pedidos.

    Args:
        document_ids: documentos a carregar.
        require_all: se `True`, todo documento pedido precisa ter trechos
            indexados. O grafo usa `False`, porque um documento indexado sem
            texto (um PDF escaneado, por exemplo) não tem trechos, mas ainda
            aparece como nó.

    Returns:
        Uma tupla `(trechos, embeddings)`, com um embedding por trecho, na
        mesma ordem, agrupados por documento e ordenados pela posição.

    Raises:
        MissingIndexedDocumentsError: se `require_all` for `True` e algum
            documento não estiver indexado.
    """
    if not document_ids:
        return [], []

    def missing() -> tuple[list[dict], list[list[float]]]:
        if require_all:
            raise MissingIndexedDocumentsError("One or more documents have not been indexed.")
        return [], []

    if not VECTOR_STORE_PATH.exists():
        return missing()

    with closing(sqlite3.connect(VECTOR_STORE_PATH)) as connection:
        tables = {
            row[0]
            for row in connection.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table'"
            )
        }
        if not {"chunks", "documents", "document_chunks"}.issubset(tables):
            return missing()

        rows = []
        found_document_ids = set()
        for start in range(0, len(document_ids), 500):
            batch = document_ids[start:start + 500]
            placeholders = ",".join("?" for _ in batch)
            batch_rows = connection.execute(
                f"""
                SELECT dc.document_id, c.text, c.source, c.page, c.chunk, c.embedding
                FROM document_chunks AS dc
                JOIN documents AS d ON d.id = dc.document_id
                JOIN chunks AS c ON c.id = dc.chunk_id
                WHERE dc.document_id IN ({placeholders})
                ORDER BY dc.document_id, dc.ordinal
                """,
                batch,
            ).fetchall()
            rows.extend(batch_rows)
            found_document_ids.update(row[0] for row in batch_rows)

    missing_document_ids = set(document_ids) - found_document_ids
    if missing_document_ids and require_all:
        raise MissingIndexedDocumentsError("One or more documents have not been indexed.")

    chunks = [
        {
            "document_id": document_id,
            "text": text,
            "source": source,
            "page": page,
            "chunk": chunk_number,
        }
        for document_id, text, source, page, chunk_number, _ in rows
    ]
    embeddings = [json.loads(row[5]) for row in rows]
    return chunks, embeddings


def retrieve_relevant_chunks(
    question: str,
    document_ids: list[str],
    top_k: int = 5,
) -> list[dict]:
    """
    Encontra os trechos mais relevantes para a pergunta, entre os documentos dados.

    Duas buscas são feitas sobre os trechos dos documentos:
        - por significado: o embedding da pergunta (uma chamada à API do
          Gemini) é comparado com o de cada trecho por similaridade de
          cosseno;
        - por palavras-chave: BM25 (`keyword_search.bm25_scores`), que acerta
          termos exatos como números, códigos e nomes.

    Com `RETRIEVAL_STRATEGY = "hybrid"` (padrão), as duas classificações são
    unidas por Reciprocal Rank Fusion: cada trecho soma `1 / (RRF_K +
    posição)` em cada lista onde aparece (na do BM25, só se tiver algum termo
    da pergunta). Com `"dense"`, vale só a similaridade de cosseno. Em caso de
    empate, vem primeiro o trecho que aparece antes.

    Args:
        question: pergunta do usuário.
        document_ids: documentos em que buscar.
        top_k: quantos trechos devolver.

    Returns:
        Até `top_k` trechos, do mais para o menos relevante. Cada um segue o
        formato descrito no módulo e traz também `score` (similaridade de
        cosseno), `keyword_score` (BM25; 0 sem termos em comum) e
        `rank_score` (a pontuação usada na ordenação). Retorna lista vazia se
        `document_ids` estiver vazio ou se `top_k` for zero ou negativo.

    Raises:
        MissingIndexedDocumentsError: se algum documento não estiver
            indexado.
    """
    if not document_ids or top_k <= 0:
        return []

    # Importado aqui para não pagar cerca de 1 s de importação do scikit-learn
    # a cada inicialização do servidor.
    from sklearn.metrics.pairwise import cosine_similarity

    chunks, chunk_embeddings = _load_indexed_chunks(document_ids)
    question_embedding = _embed_contents([question])[0]
    similarities = [float(value) for value in cosine_similarity([question_embedding], chunk_embeddings)[0]]
    keyword_scores = bm25_scores(question, [chunk["text"] for chunk in chunks])

    if RETRIEVAL_STRATEGY == "dense":
        rank_scores = similarities
    else:
        rank_scores = [0.0] * len(chunks)
        for scores in (similarities, keyword_scores):
            ranked = sorted(range(len(chunks)), key=lambda index: (-scores[index], index))
            for position, index in enumerate(ranked, start=1):
                if scores is keyword_scores and scores[index] <= 0:
                    break
                rank_scores[index] += 1 / (RRF_K + position)

    ranked_indices = sorted(
        range(len(chunks)),
        key=lambda index: (-rank_scores[index], -similarities[index], index),
    )[:top_k]

    return [
        {
            **chunks[index],
            "score": similarities[index],
            "keyword_score": keyword_scores[index],
            "rank_score": rank_scores[index],
        }
        for index in ranked_indices
    ]
