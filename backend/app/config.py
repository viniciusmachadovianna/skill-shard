# API key, paths, params

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