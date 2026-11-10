import logging

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from app.generation.llm_client import ask_llm
from app.config import frontend_origin

logger = logging.getLogger(__name__)

class AskRequest(BaseModel):
    question: str


app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=frontend_origin.split(","),
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type"],
)

@app.post("/ask")
def ask(request: AskRequest):

    try:
        answer = ask_llm(request.question)
    except Exception:
        logger.exception("Gemini request failed.")
        raise HTTPException(
            status_code=502,
            detail="The model request failed. Check its connection and retry.",
        ) from None

    if not answer:
        raise HTTPException(
            status_code=502,
            detail="The model returned an empty response.",
        )
    return answer