# Testing - Open /backend on terminal:
# python -m app.tests.test_vector_store
from app.retrieval.vector_store import embed_content
from app.config import client

from sklearn.metrics.pairwise import cosine_similarity

texts = [
  "What is SYDLE ONE?",
  "What is the purpose of SYDLE ONE?",
  "What can I do with SYDLE ONE?",
]

result = client.models.embed_content(
    model="gemini-embedding-001",
    contents=texts,
)
vetores = [embedding.values for embedding in result.embeddings]

similarity_matrix = cosine_similarity(vetores)

print("\n--- Matriz de similaridade ---\n")
for i, text_i in enumerate(texts):
    for j, text_j in enumerate(texts):
        if i < j:
            print(f"'{text_i}' vs '{text_j}': {similarity_matrix[i][j]:.4f}")