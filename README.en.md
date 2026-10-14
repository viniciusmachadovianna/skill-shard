# Skill Shard - Explainable RAG for Hallucination Mitigation

Author: Vinícius Machado

[Versão em português](README.md) \

[EN-US] Codebase and evaluation framework for my Bachelor's Thesis (TCC)

## Objective

Developing a Relational Retrieval-Augmented Generation (RAG) system that combines vector search, cross-document entity linking, and explicit source citation to minimize LLM hallucinations.

Capabilities:
- Answer questions based on a collection of PDF documents.
- Minimize hallucinations.
- Present the sources and relationships used to construct the answer to the user.

## Architecture

backend/
├── app/
│ ├── ingestion/ # PDF extraction, chunking, embeddings

frontend/
├── index.html
├── style/
└── script/

## Stack

- **Frontend:** HTML, CSS e JS vanilla
- **Backend:** Python
- **LLM:** Gemini (API)
- **Vector Database:** ...

## Evaluation Methodology

Comparison of three configurations:
1. No RAG (baseline)
2. Traditional RAG (Vector search)
3. RAG + Entity relationship layer

**Factual** and **relational** test questions, with manual classification of responses in:
- Correct and well-grounded
- Correct but poorly grounded
- Hallucination
