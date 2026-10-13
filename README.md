# TCC RAG — Explainable RAG for Hallucination Mitigation

Autor: Vinícius Machado - Engenharia de Software - UniAcademia

Sistema de Geração Aumentada por Recuperação (RAG) voltado à mitigação de alucinações e à rastreabilidade de fontes em consultas sobre bases documentais (PDFs), com uma camada opcional de extração de relações entre entidades (inspirada em GraphRAG) para responder perguntas que cruzam informações entre documentos.


## Objetivo

Desenvolver e avaliar um sistema RAG capaz de:
- Responder perguntas com base em uma coleção de documentos PDF
- Minimizar alucinações
- Apresentar ao usuário as fontes e relações usadas na construção da resposta

## Arquitetura

...

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
