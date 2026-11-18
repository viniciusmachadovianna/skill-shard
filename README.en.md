# Skill Shard - RAG with Source Traceability and Hallucination Mitigation

**Author:** Vinícius Machado

[Versão em português](README.md)

Final undergraduate thesis (TCC) in Software Engineering at UniAcademia.

## Objective

Develop a Retrieval-Augmented Generation (RAG) system to reduce hallucinations and enable source traceability in document queries.

The system allows you to:

- Answer questions based on TXT, Markdown, CSV, JSON, and PDF documents;
- Automatically list supported documents from `data/` in the knowledge base, disabled by default;
- Reduce the occurrence of hallucinations;
- Present the sources used to build the answers;
- Visualize metadata relationships between the documents enabled in the knowledge base.

## Prerequisites

- [Python](https://www.python.org/downloads/)
- On Debian or Ubuntu, install Python and other tools with `sudo apt install python3 python3-venv python3-pip`.

## How to use

1. To avoid conflicts between dependency versions, create a virtual environment with `python3 -m venv venv`.
2. On Windows, activate the virtual environment with `.\venv\Scripts\Activate`.
3. On Debian or Ubuntu, activate the virtual environment with `source venv/bin/activate`.
4. Install the project dependencies with `python3 -m pip install -r requirements.txt`.
5. In the repository root, set `LLM_API_KEY` and `LLM_MODEL_ID` in the `.env` file. Use `.env.example` as a reference. [See the Gemini API keys](https://aistudio.google.com/api-keys)
6. In a terminal at the repository root, enter the `backend` folder with `cd backend` and start the backend with `python -m uvicorn app.main:app --reload`. The `app.main:app` path is required because the backend modules import from `app`.
7. In another terminal, start the interface server from the `frontend` folder with `python -m http.server 5500` and open `http://localhost:5500` in your browser.
8. When the interface loads, the enabled documents are synchronized with the backend for storage and indexing. The mode selector offers: **LLM**, which sends only the question; **RAG**, which retrieves chunks by embeddings; and **graphrag**, which also gives the model the entity relationships found in the retrieved chunks and displays those relationships in the graph.
9. When you are done, leave the virtual environment with `deactivate`.

When the interface loads, the enabled documents are synchronized and indexed before the chat is unlocked. The local backend persists the original content, chunks, and embeddings in `backend/data/vectors.sqlite3`. Live Server must ignore the `backend/` folder so that database changes do not reload the page. In the RAG modes, the chat sends document IDs, never the full content; in LLM mode, it sends no IDs. The status shows loading progress; if it fails, use **RETRY CHECK**. Generating embeddings and answers still depends on the Gemini API.

After enabling and indexing documents, open **Knowledge base → VIEW ENTITY GRAPH**. Select a node or a link to see its source evidence.

It is very important that documents are not too large, so that the API quota limits are not exceeded. The embedding process makes several requests per minute, which can easily reach the Gemini API limit. [See the limits in the official docs](https://aistudio.google.com/docs/rate-limits)

## Endpoints

- `GET /ready`: checks the configuration and the model's availability at startup and after failed questions. Only *successful* checks are cached, for 15 seconds. Use `GET /ready?refresh=true` to bypass the cache. If the model is unavailable, sending questions is blocked until the connection is restored.
- `GET /health`: checks that the backend is running. Model calls time out after 45 seconds.
- `POST /index`: accepts `{"documents": [{"id": "...", "name": "...", "content": "...", "encoding": "text"}]}`, splits the enabled documents into chunks, and persists originals, chunks, and embeddings. Returns `{"indexed_chunks": n}`; responds with `422` for invalid documents or documents without readable text, and `502` if the embedding API fails. The interface calls this endpoint on startup and when the knowledge base changes.
- `GET /graph`: returns `{"nodes": [...], "edges": [...]}` for the indexed documents. Nodes have `id`, `label`, and `type`; edges have `id`, `source`, `target`, `label`, and `evidence` (document ID/name, item title, and optional source URL). Repeat `document_ids` to filter, for example `/graph?document_ids=id-1&document_ids=id-2`; without a filter, it returns all indexed documents. The local, token-free rules read the structured Markdown metadata (`Tipo`, `Projeto`, `Produto`, `Hierarquia`, and `Tags`) and store the result during indexing. This first version does not infer entities from free text. Returns `409` if a requested document is not indexed.
- `POST /ask`: accepts `{"question": "...", "mode": "llm|rag|graphrag", "document_ids": [...]}`; `mode` is optional and defaults to `rag`. `llm` ignores the documents; `rag` uses only chunks retrieved by embeddings; `graphrag` also includes, in the context sent to the model, the metadata relationships of the items present in the retrieved chunks, and returns that subgraph for display. The `rag` and `graphrag` modes require at least one enabled document. Returns `{"mode": "...", "answer": "...", "graph": null|{"nodes": [...], "edges": [...]}}`; in LLM and RAG modes, `graph` is `null`. Nonexistent or unindexed IDs result in `409`.
- `DELETE /documents?document_id=...`: removes the document, its chunks, and its associated vectors from the local database.

## Architecture

Planned structure for the backend. Files marked **[planned]** do not exist yet and are part of the upcoming refactor; the comments describe each module's planned responsibility.

backend/ <br>
├── app/ <br>
│   ├── main.py              # FastAPI app + routes only <br>
│   ├── config.py            # all env vars, constants (models, top_k, timeouts), one client <br>
│   ├── schemas.py           # [planned] Pydantic request/response models <br>
│   ├── pipeline.py          # [planned] answer_llm / answer_rag / answer_graphrag: one function per mode <br>
│   ├── ingestion/ <br>
│   │   ├── loader.py <br>
│   │   ├── chunker.py <br>
│   │   └── documents.py     # [planned] build_document_chunks, load_repository_documents <br>
│   ├── storage/             # [planned] <br>
│   │   └── database.py      # [planned] connection + schema creation in one place <br>
│   ├── retrieval/ <br>
│   │   ├── embeddings.py    # [planned] Gemini embedding calls + caching <br>
│   │   ├── vector_store.py  # persist/load/delete chunks <br>
│   │   ├── search.py        # [planned] similarity ranking (top_k, future threshold) <br>
│   │   └── entity_graph.py  # graph extraction + filtering to retrieved chunks <br>
│   └── generation/ <br>
│       ├── llm_client.py <br>
│       └── prompt_builder.py  # all context formatting: chunks, relationships, citations <br>
├── tests/ <br>
└── data/

## Technologies

- **Interface:** plain HTML, CSS, and JavaScript
- **Backend:** Python, [Uvicorn ASGI server](https://uvicorn.dev/)
- **LLM:** [Gemini API](https://aistudio.google.com/docs), [Python genai](https://googleapis.github.io/python-genai/)
- **Vector storage:** local SQLite (`backend/data/vectors.sqlite3`)
- **Cosine similarity calculation:** [Scikit-learn](https://scikit-learn.org/stable/modules/generated/sklearn.metrics.pairwise.cosine_similarity.html)
- **Graph visualization:** locally bundled vis-network 10.1.5

### Visual resources

[Material Icons](https://fonts.google.com/icons?icon.size=24&icon.color=%23EEE&icon.style=Sharp)

## Evaluation Methodology

Comparison of three configurations:

1. Model without RAG (baseline);
2. Traditional RAG, with vector search;
3. RAG with an entity relationship layer.

The test questions will be **factual** and **relational**. Answers will be classified manually as:

- Correct and well-grounded;
- Correct but poorly grounded;
- Hallucination.
