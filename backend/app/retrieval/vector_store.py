# guarda embeddings na memória
# ai.google.dev/gemini-api/docs/embeddings

from app.config import client

def embed_content(contents: str) -> list:
    result = client.models.embed_content(
        model="gemini-embedding-2",
        contents=contents
    )
    return result