# Skill Shard - RAG com rastreabilidade de fontes e mitigação de alucinações

Autor: Vinícius Machado

[English version](README.en.md)

Trabalho de Conclusão de Curso em 'Engenharia de Software' na universidade UniAcademia.

## Objetivo

Gerar um Sistema de Geração Aumentada por Recuperação (RAG) focado na mitigação de alucinações e a rastreabilidade de fontes na consultas em documentais (ex.: PDFs).

Capacidades:
- Responder perguntas com base em uma coleção de documentos PDF
- Minimizar alucinações
- Apresentar ao usuário as fontes e relações usadas na construção da resposta

## Pré-requisitos

- [Python](https://www.python.org/downloads/)


## Como usar

1. Para evitar conflito de versões das dependências, use `python -m venv venv`
2. Ative o amb. virtual `.\venv\Scripts\Activate`
3. Install the project requirements using `python -m pip install -r requirements.txt`
4. Open the main.py file on terminal and hit `python -m uvicorn main:app --reload` for the backend load

## Arquitetura

backend/ <br>
├── app/ <br>
│ ├── ingestion/ # extração de PDFs, chunking, embeddings <br>

frontend/ <br>
├── index.html <br>
├── style/ <br>
└── script/ <br>

## Stack

- **Frontend:** HTML, CSS e JS vanilla
- **Backend:** Python
- **LLM:** Gemini (API)
- **Banco vetorial:** ...

## Metodologia de Avaliação

Comparação entre três configurações:
1. Sem RAG (baseline)
2. RAG tradicional (busca vetorial)
3. RAG + camada de relações entre entidades

Perguntas-teste **factuais** e **relacionais**, com classificação manual das respostas em:
- Correta e fundamentada
- Correta mas mal fundamentada
- Alucinação
