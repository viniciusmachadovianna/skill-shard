# Skill Shard - RAG com rastreabilidade de fontes e mitigação de alucinações

**Autor:** Vinícius Machado

[English version](README.en.md)

Trabalho de Conclusão de Curso em Engenharia de Software na UniAcademia.

## Objetivo

Desenvolver um Sistema de Geração Aumentada por Recuperação (RAG) para reduzir alucinações e permitir a rastreabilidade das fontes em consultas a documentos.

O sistema permite:

- Responder a perguntas com base em documentos TXT, Markdown, CSV, JSON e PDF;
- Listar automaticamente os documentos compatíveis de `data/` na base de conhecimento, desativados por padrão;
- Reduzir a ocorrência de alucinações;
- Apresentar as fontes usadas na elaboração das respostas.

## Pré-requisitos

- [Python](https://www.python.org/downloads/)
- No Debian ou Ubuntu, instale o Python e outras ferramentas usando `sudo apt install python3 python3-venv python3-pip`.

## Como usar

1. Para evitar conflitos entre versões das dependências, crie um ambiente virtual com `python3 -m venv venv`.
2. No Windows, ative o ambiente virtual com `.\venv\Scripts\Activate`.
3. No Debian ou Ubuntu, ative o ambiente virtual com `source venv/bin/activate`.
4. Instale as dependências do projeto com `python3 -m pip install -r requirements.txt`.
5. Na raiz do repositório, configure `LLM_API_KEY` e `LLM_MODEL_ID` no arquivo `.env`. Use o arquivo `env.example` como referência.
6. Em um terminal na raiz do repositório, entre na pasta `backend` com `cd backend` e inicie o backend com `python -m uvicorn app.main:app --reload`. O caminho `app.main:app` é necessário porque os módulos do backend importam a partir de `app`.
7. Em outro terminal, inicie o servidor da interface na pasta `frontend` com `python -m http.server 5500` e abra `http://localhost:5500` no navegador.
8. O chat envia uma requisição `POST` para `http://127.0.0.1:8000/ask` com a pergunta e os documentos habilitados na base de conhecimento. A API retorna a resposta como uma string JSON.
9. Ao terminar, encerre o ambiente virtual com `deactivate`.

Ao carregar a interface, os documentos habilitados são enviados ao backend e indexados antes de liberar o chat. O status mostra esse carregamento; se falhar, use **Verificar novamente**. Os trechos e embeddings ficam armazenados localmente em `backend/data/vectors.sqlite3`. Trechos inalterados reutilizam os vetores existentes; a geração de embeddings e respostas continua dependendo da API Gemini.

## Endpoints

- `GET /ready`: verifica a configuração e a disponibilidade do modelo ao iniciar e após falhas nas perguntas. Apenas verificações *bem-sucedidas* ficam em cache por 15 segundos. Use `GET /ready?refresh=true` para ignorar o cache. Se o modelo estiver indisponível, o envio de perguntas é bloqueado até a conexão ser restabelecida.
- `GET /health`: verifica se o backend está ativo. As chamadas ao modelo expiram após 45 segundos.
- `POST /index`: recebe `{"documents": [...]}` no mesmo formato de `/ask`, divide os documentos habilitados em trechos e persiste os embeddings antes das perguntas. Retorna `{"indexed_chunks": n}`; responde `422` para documentos inválidos ou sem texto legível e `502` se a API de embeddings falhar. A interface chama esse endpoint ao iniciar e quando a base é alterada.

## Arquitetura

backend/ <br>
├── app/ <br>
│ ├── ingestion/ # extração de documentos, divisão em trechos e embeddings <br>

frontend/ <br>
├── index.html <br>
├── style/ <br>
└── script/ <br>

## Tecnologias

- **Interface:** HTML, CSS e JavaScript puro
- **Backend:** Python
- **LLM:** Gemini (API)
- **Armazenamento vetorial:** SQLite local (`backend/data/vectors.sqlite3`)

### Recursos visuais

[Material Icons](https://fonts.google.com/icons?icon.size=24&icon.color=%23EEE&icon.style=Sharp)

## Metodologia de Avaliação

Comparação de três configurações:

1. Modelo sem RAG (linha de base);
2. RAG tradicional, com busca vetorial;
3. RAG com uma camada de relações entre entidades.

As perguntas de teste serão **factuais** e **relacionais**. As respostas serão classificadas manualmente como:

- Correta e fundamentada;
- Correta, mas mal fundamentada;
- Alucinação.
