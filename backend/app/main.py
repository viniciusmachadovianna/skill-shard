import logging
import os
from threading import Lock
from time import monotonic

from dotenv import load_dotenv
from google import genai
from google.genai import types

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

logger = logging.getLogger(__name__)

READY_CACHE_SECONDS = 15
READY_TIMEOUT_MS = 3_000
ASK_TIMEOUT_MS = 45_000

load_dotenv()

api_key = os.getenv("LLM_API_KEY")
llm_model = os.getenv("LLM_MODEL_ID")
client = genai.Client(
    api_key=api_key,
    http_options=types.HttpOptions(timeout=ASK_TIMEOUT_MS),
)
readiness_client: genai.Client | None = None
ready_cache_until: float = 0.0
readiness_lock = Lock()


class AskRequest(BaseModel):
    question: str


app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5500", "http://127.0.0.1:5500"],
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type"],
)


@app.get("/health")
def health():
    return {"status": "ok"}


@app.get("/ready")
def ready(refresh: bool = False):
    global readiness_client, ready_cache_until

    if not api_key or not llm_model:
        raise HTTPException(
            status_code=503,
            detail={"ready": False, "reason": "configuration_missing"},
        )

    with readiness_lock:
        if not refresh and ready_cache_until > monotonic():
            return {"ready": True, "cached": True}

        try:
            if readiness_client is None:
                readiness_client = genai.Client(
                    api_key=api_key,
                    http_options=types.HttpOptions(timeout=READY_TIMEOUT_MS),
                )
            readiness_client.models.get(model=llm_model)
        except Exception:
            ready_cache_until = 0.0
            logger.exception("Gemini readiness check failed.")
            raise HTTPException(
                status_code=503,
                detail={"ready": False, "reason": "model_unavailable"},
            ) from None

        ready_cache_until = monotonic() + READY_CACHE_SECONDS
        return {"ready": True, "cached": False}


@app.post("/ask")
def ask(request: AskRequest):
    global ready_cache_until

    try:
        response = client.models.generate_content(
            model=llm_model, contents=request.question
        )
    except Exception:
        with readiness_lock:
            ready_cache_until = 0.0
        logger.exception("Gemini request failed.")
        raise HTTPException(
            status_code=502,
            detail="The model request failed. Check its connection and retry.",
        ) from None

    if not response.text:
        raise HTTPException(
            status_code=502,
            detail="The model returned an empty response.",
        )
    return response.text