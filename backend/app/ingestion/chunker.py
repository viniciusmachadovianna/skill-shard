"""
Divisão de textos em trechos (chunks) com sobreposição.

Um trecho é um pedaço do texto original, pequeno o bastante para virar um
embedding e ser comparado com a pergunta do usuário. Um documento inteiro
seria longo demais e diluiria o significado; por isso o texto é cortado em
janelas de tamanho fixo.

Janelas vizinhas compartilham `overlap` unidades (caracteres ou palavras).
Essa sobreposição evita que uma frase cortada na fronteira entre dois trechos
fique incompleta nos dois: ela aparece inteira em pelo menos um deles.

Funções:
    chunk_text: divide por caracteres.
    chunk_text_by_words: divide por palavras (é a usada na indexação).

Cada trecho devolvido é um dicionário `{"text": str, "source_file": str}`. O
restante dos metadados (documento, página, posição) é acrescentado depois,
quando os documentos são preparados para a indexação.

Executado como script (`python chunker.py arquivo.pdf`), o módulo imprime os
trechos de um PDF, o que ajuda a inspecionar o resultado da divisão.
"""

import sys
from pathlib import Path


def chunk_text(
    text: str, source_file: str, chunk_size: int = 500, overlap: int = 50
) -> list[dict]:
    """
    Divide o texto em trechos de tamanho fixo, medido em caracteres.

    Cada trecho tem até `chunk_size` caracteres e repete os últimos `overlap`
    caracteres do trecho anterior. Espaços nas pontas de cada trecho são
    removidos e trechos que ficariam vazios são descartados.

    Args:
        text: texto completo a dividir.
        source_file: nome do arquivo de origem, copiado para cada trecho.
        chunk_size: tamanho máximo de cada trecho, em caracteres.
        overlap: caracteres repetidos entre trechos vizinhos.

    Returns:
        Lista de `{"text", "source_file"}`; vazia se o texto não tiver
        conteúdo.

    Raises:
        ValueError: se `chunk_size` não for maior que `overlap`.
    """

    if chunk_size <= overlap:
        raise ValueError("chunk_size precisa ser maior que overlap")

    text = text.strip()
    if not text:
        return []

    chunks = []
    start = 0
    text_length = len(text)

    while start < text_length:
        end = start + chunk_size
        chunk = text[start:end].strip()

        if chunk:
            chunks.append({"text": chunk, "source_file": source_file})

        start = end - overlap

    return chunks


def chunk_text_by_words(
    text: str, source_file: str, chunk_size: int = 150, overlap: int = 20
) -> list[dict]:
    """
    Divide o texto em trechos de tamanho fixo, medido em palavras.

    É o método usado na indexação dos documentos. As palavras são separadas
    por qualquer espaço em branco e cada trecho é remontado com espaços
    simples, então quebras de linha e espaços repetidos do original não são
    preservados. Cada trecho tem até `chunk_size` palavras e repete as
    últimas `overlap` palavras do trecho anterior; o último pode ser menor.

    Args:
        text: texto completo a dividir.
        source_file: nome do arquivo de origem, copiado para cada trecho.
        chunk_size: tamanho máximo de cada trecho, em palavras.
        overlap: palavras repetidas entre trechos vizinhos.

    Returns:
        Lista de `{"text", "source_file"}`; vazia se o texto não tiver
        palavras.

    Raises:
        ValueError: se `chunk_size` não for maior que `overlap`.
    """

    if chunk_size <= overlap:
        raise ValueError("chunk_size precisa ser maior que overlap")

    words = text.split()
    if not words:
        return []

    chunks = []
    start = 0

    while start < len(words):
        end = start + chunk_size
        chunk_words = words[start:end]
        chunks.append({
            "text": " ".join(chunk_words),
            "source_file": source_file,
        })
        start = end - overlap

    return chunks


if __name__ == "__main__":
    # Só para a execução direta: no topo do módulo, isto carregaria um segundo
    # módulo "loader" dentro do servidor.
    sys.path.append(str(Path(__file__).parent))
    from loader import load_pdf_text

    if len(sys.argv) < 2:
        print("Uso: python chunker.py caminho/para/arquivo.pdf")
        sys.exit(1)

    pdf_path = sys.argv[1]
    source_file = Path(pdf_path).name
    text = load_pdf_text(pdf_path)

    chunks = chunk_text_by_words(text, source_file, chunk_size=100, overlap=15)

    print(f"\nTexto original: {len(text)} caracteres")
    print(f"Arquivo-fonte: {source_file}")
    print(f"Total de chunks gerados: {len(chunks)}\n")

    for i, chunk in enumerate(chunks, start=1):
        print(f"--- Chunk {i} ({len(chunk['text'].split())} palavras) — fonte: {chunk['source_file']} ---")
        print(chunk["text"])
        print()