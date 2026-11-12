from app.config import client, llm_model
from app.generation.prompt_builder import build_prompt


def ask_llm(question: str, context: str | None = None) -> str:
    prompt = build_prompt(context, question) if context else question
    answer = client.models.generate_content(
        model=llm_model, contents=prompt
    )
    return answer.text
