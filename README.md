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

- [Python](https://www.python.org/downloads/) // sudo apt install python3 python3-venv python3-pip

## Como usar

1. Para evitar conflito de versões das dependências, use `python3 -m venv venv`
2. (Windows) Ative o amb. virtual `.\venv\Scripts\Activate`
2. (Debian) Ative o amb. virtual `source venv/bin/activate`
3. Install the project requirements using `python3 -m pip install -r requirements.txt`
4. Configure `LLM_API_KEY` and `LLM_MODEL_ID` in a `.env` file at the repository root, there it is a `env.example` for reference.
5. In a terminal at the repository root, start the backend with `python -m uvicorn backend.app.main:app --reload`.
6. In a second terminal, serve the frontend from the `frontend` folder with `python -m http.server 5500`, then open `http://localhost:5500`.
7. The chat sends `POST http://127.0.0.1:8000/ask` with JSON `{ "question": "..." }`; the API returns the answer as a JSON string.
8. When done, to close the virtual Python environment (`venv`) run `deactivate`.

## Endpoints

- `GET /ready` ao iniciar e após falhas nas perguntas. Verifica a configuração e a disponibilidade do modelo, armazena em cache apenas verificações *bem-sucedidas* por 15 segundos e aceita `GET /ready?refresh=true` para ignorar o cache. Em caso negativo, o envio de perguntas é bloqueado até o status ser normalizado.
- `GET /health` verifica se o backend está ativo; chamadas ao modelo expiram após 45 segundos.

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
