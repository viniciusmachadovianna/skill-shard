def build_prompt(context: str, question: str) -> str:
    return f"""Baseado no texto abaixo, responda a pergunta de forma objetiva.

Texto: {context}
Pergunta: {question}
Resposta:
"""