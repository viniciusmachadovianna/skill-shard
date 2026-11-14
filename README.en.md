# Skill Shard - Explainable RAG for Hallucination Mitigation

Author: Vinícius Machado

[Versão em português](README.md)

[EN-US] Codebase and evaluation framework for my Bachelor's Thesis (TCC)

## Objective

Developing a Relational Retrieval-Augmented Generation (RAG) system that combines vector search, cross-document entity linking, and explicit source citation to minimize LLM hallucinations.

Capabilities:
- Answer questions based on TXT, Markdown, CSV, JSON, and PDF documents.
- Automatically list supported documents from `data/` in the knowledge base, disabled by default.
- Minimize hallucinations.
- Present the sources and relationships used to construct the answer to the user.

## Architecture

backend/ <br>
├── app/ <br>
│ ├── ingestion/ # PDF extraction, chunking, embeddings <br>

frontend/ <br>
├── index.html <br>
├── style/ <br>
└── script/ <br>

Document chunks and their embeddings are persisted locally in `backend/data/vectors.sqlite3`. Embeddings for unchanged chunks are reused across questions; generating embeddings and answers still requires the Gemini API.

When the interface loads, it sends enabled documents to the backend for indexing before enabling chat. The status indicator shows this initial loading; use **Retry check** if indexing fails.

## Stack

- **Frontend:** HTML, CSS e JS vanilla
- **Backend:** Python
- **LLM:** Gemini (API)
- **Vector Storage:** Local SQLite (`backend/data/vectors.sqlite3`)

## API endpoints

- `POST /index`: accepts `{"documents": [...]}` using the same document shape as `/ask`, chunks enabled documents, and persists their embeddings before questions. Returns `{"indexed_chunks": n}`; responds with `422` for invalid documents or documents without readable text, and `502` if the embedding API fails. The interface calls it on startup and when the knowledge base changes.

## Evaluation Methodology

Comparison of three configurations:
1. No RAG (baseline)
2. Traditional RAG (Vector search)
3. RAG + Entity relationship layer

**Factual** and **relational** test questions, with manual classification of responses in:
- Correct and well-grounded
- Correct but poorly grounded
- Hallucination
