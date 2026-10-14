import sys
from pathlib import Path
from pypdf import PdfReader


def load_pdf_text(pdf_path: str) -> str:

    path = Path(pdf_path)

    if not path.exists():
        raise FileNotFoundError(f"Arquivo não encontrado: {pdf_path}")

    reader = PdfReader(str(path))

    full_text = []
    for page_number, page in enumerate(reader.pages, start=1):
        text = page.extract_text()
        if text:
            full_text.append(text)
        else:
            print(f"<!> Página {page_number} não retornou texto")

    return "\n".join(full_text)


def load_pdf_pages(pdf_path: str) -> list[dict]:

    path = Path(pdf_path)

    if not path.exists():
        raise FileNotFoundError(f"Arquivo não encontrado: {pdf_path}")

    reader = PdfReader(str(path))

    pages = []
    for page_number, page in enumerate(reader.pages, start=1):
        text = page.extract_text() or ""
        pages.append({"page": page_number, "text": text})

    return pages


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Uso: python pdf_loader.py caminho/para/arquivo.pdf")
        sys.exit(1)

    pdf_path = sys.argv[1]
    text = load_pdf_text(pdf_path)

    print(f"Os primeiros 200 caracteres do texto com ({len(text)} caracteres foi extraído:)")
    print("\n --- \n")
    print(text[:200])  # mostra só os primeiros 1000 caracteres como preview
    print("\n ---")
