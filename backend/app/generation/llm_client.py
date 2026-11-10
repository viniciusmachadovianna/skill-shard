from app.config import client, llm_model

def ask_llm(question: str) -> str:
    answer = client.models.generate_content(
        model=llm_model, contents=question
    )
    return answer.text
