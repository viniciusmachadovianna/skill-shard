"""
Configuração central do backend: variáveis de ambiente e cliente do Gemini.

Ao ser importado, este módulo lê o arquivo `.env` da raiz do repositório e
expõe os valores abaixo. Quando uma variável não está definida, o valor
correspondente fica como `None`.

Variáveis de ambiente lidas:
    LLM_API_KEY: chave da API do Gemini.
    LLM_MODEL_ID: identificador do modelo usado para gerar as respostas.
    FRONTEND_ORIGIN: origens autorizadas a chamar a API (CORS), separadas por
        vírgula. Exemplo: `http://localhost:5500`.

Objetos expostos:
    client: cliente único do Gemini, usado para gerar respostas e embeddings.
        Cada chamada expira após `ASK_TIMEOUT_MS` (45 segundos).
"""

import os

from dotenv import load_dotenv
from google import genai
from google.genai import types

ASK_TIMEOUT_MS = 45_000

load_dotenv()

api_key = os.getenv("LLM_API_KEY")
llm_model = os.getenv("LLM_MODEL_ID")
frontend_origin = os.getenv("FRONTEND_ORIGIN")

client = genai.Client(
    api_key=api_key,
    http_options=types.HttpOptions(timeout=ASK_TIMEOUT_MS),
)