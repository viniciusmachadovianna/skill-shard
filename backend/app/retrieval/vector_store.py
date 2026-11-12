from sklearn.metrics.pairwise import cosine_similarity
from google.genai import types
from app.config import client


EMBEDDING_MODEL = "gemini-embedding-001"
EMBEDDING_BATCH_SIZE = 100


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

    return embeddings


def retrieve_relevant_chunks(
    question: str,
    chunks: list[dict],
    top_k: int = 5,
) -> list[dict]:
    if not chunks or top_k <= 0:
        return []

    chunk_embeddings = _embed_contents([chunk["text"] for chunk in chunks])
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