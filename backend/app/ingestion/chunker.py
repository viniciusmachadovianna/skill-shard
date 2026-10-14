import sys
from pathlib import Path

sys.path.append(str(Path(__file__).parent))
from loader import load_pdf_text


def chunk_text(text: str, chunk_size: int = 500, overlap: int = 50) -> list[str]:

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
            chunks.append(chunk)

        start = end - overlap

    return chunks


def chunk_text_by_words(text: str, chunk_size: int = 150, overlap: int = 20) -> list[str]:

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
        chunks.append(" ".join(chunk_words))
        start = end - overlap

    return chunks


if __name__ == "__main__":

    if len(sys.argv) < 2:
        print("Uso: python chunker.py caminho/para/arquivo.pdf")
        sys.exit(1)

    pdf_path = sys.argv[1]
    text = load_pdf_text(pdf_path)

    chunks = chunk_text_by_words(text, chunk_size=100, overlap=15)

    print(f"\nTexto original: {len(text)} caracteres")
    print(f"Total de chunks gerados: {len(chunks)}\n")

    for i, chunk in enumerate(chunks, start=1):
        print(f"--- Chunk {i} ({len(chunk.split())} palavras) ---")
        print(chunk)
        print()