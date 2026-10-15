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
