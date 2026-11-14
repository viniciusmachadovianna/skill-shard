import hashlib
import json
import sqlite3
from contextlib import closing
from pathlib import Path

from sklearn.metrics.pairwise import cosine_similarity
from google.genai import types
from app.config import client


EMBEDDING_MODEL = "gemini-embedding-001"
EMBEDDING_BATCH_SIZE = 100
VECTOR_STORE_PATH = Path(__file__).resolve().parents[2] / "data" / "vectors.sqlite3"


def embed_content(contents: str | list[str]) -> types.EmbedContentResponse:
    return client.models.embed_content(
        model=EMBEDDING_MODEL,
        contents=contents,
    )


def _embed_contents(texts: list[str]) -> list[list[float]]:
    embeddings = []

    for start in range(0, len(texts), EMBEDDING_BATCH_SIZE):
        batch = texts[start:start + EMBEDDING_BATCH_SIZE]
        result = embed_content(batch)
        embeddings.extend(embedding.values for embedding in result.embeddings)

    if len(embeddings) != len(texts):
        raise RuntimeError("The embedding service returned an unexpected number of vectors.")

    return embeddings


def _chunk_id(chunk: dict) -> str:
    identity = json.dumps(
        [
            EMBEDDING_MODEL,
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
    if not chunk_ids or not VECTOR_STORE_PATH.exists():
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


def _get_chunk_embeddings(chunks: list[dict]) -> list[list[float]]:
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


def index_document_chunks(chunks: list[dict]) -> int:
    if not chunks:
        return 0

    _get_chunk_embeddings(chunks)
    return len(chunks)


def retrieve_relevant_chunks(
    question: str,
    chunks: list[dict],
    top_k: int = 5,
) -> list[dict]:
    if not chunks or top_k <= 0:
        return []

    chunk_embeddings = _get_chunk_embeddings(chunks)
    question_embedding = _embed_contents([question])[0]
    similarities = cosine_similarity([question_embedding], chunk_embeddings)[0]
    ranked_indices = sorted(
        range(len(chunks)),
        key=lambda index: (similarities[index], -index),
        reverse=True,
    )[:top_k]

    return [
        {**chunks[index], "score": float(similarities[index])}
        for index in ranked_indices
    ]
