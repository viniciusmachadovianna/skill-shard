"""
Cliente de geração: envia a pergunta ao modelo Gemini e devolve a resposta.

É a última etapa do fluxo de uma consulta. Recebe a pergunta e, nos modos RAG,
o contexto já montado (trechos recuperados e, no modo graphrag, as relações
entre entidades). O endpoint `/ask` cuida do que vem antes (busca) e do que
vem depois (acrescentar a lista de fontes à resposta).
"""

from app.config import client, llm_model
from app.generation.prompt_builder import build_prompt


def ask_llm(question: str, context: str | None = None) -> str:
    """
    Envia uma pergunta ao modelo e devolve o texto da resposta.

    Com `context`, a pergunta é embrulhada no prompt de RAG (veja
    `prompt_builder.build_prompt`), que instrui o modelo a responder somente
    com as fontes fornecidas. Sem `context` (modo `llm`), a pergunta segue
    sem nenhuma instrução adicional: é a linha de base usada para comparar
    com os modos RAG. Um contexto vazio é tratado como ausente.

    Args:
        question: pergunta do usuário.
        context: fontes formatadas pelo endpoint `/ask`, ou `None` para
            perguntar direto ao modelo.

    Returns:
        O texto da resposta. Pode vir vazio ou `None` quando o modelo não
        retorna texto; quem chama deve tratar esse caso.
    """
    prompt = build_prompt(context, question) if context else question
    answer = client.models.generate_content(
        model=llm_model, contents=prompt
    )
    return answer.text
