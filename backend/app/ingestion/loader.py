"""
Leitura de PDFs: extrai o texto de cada página.

Os formatos TXT, Markdown, CSV e JSON não passam por aqui: chegam como texto
e são usados diretamente em `main.py`. Este módulo cuida apenas do PDF, que
precisa de uma biblioteca (pypdf) para extrair o texto.

Cada página é devolvida como `{"page": int, "text": str, "source_file": str}`,
com `page` contando a partir de 1. PDFs escaneados (imagens sem texto
selecionável) resultam em texto vazio, porque o projeto não faz OCR.

Funções:
    load_pdf_pages_from_bytes: PDF em memória (usada pela API).
    load_pdf_pages: PDF em disco, uma entrada por página.
    load_pdf_text: PDF em disco, todo o texto em uma única string (usada
        apenas nos testes manuais por linha de comando).

Executado como script (`python loader.py arquivo.pdf`), o módulo imprime os
primeiros 200 caracteres do texto extraído.
"""

import sys
from io import BytesIO
from pathlib import Path
from pypdf import PdfReader

def load_pdf_pages_from_bytes(pdf_content: bytes, source_file: str) -> list[dict]:
    """
    Extrai o texto de cada página de um PDF que está em memória.

    Args:
        pdf_content: bytes do arquivo PDF.
        source_file: nome do arquivo, copiado para cada página (é o nome que
            aparece nas citações).

    Returns:
        Uma entrada por página, com `page` (a partir de 1), `text` e
        `source_file`. `text` é uma string vazia quando a página não tem
        texto extraível.

    Raises:
        pypdf.errors.PdfReadError: se os bytes não formarem um PDF legível.
    """
    reader = PdfReader(BytesIO(pdf_content))

    return [
        {
            "page": page_number,
            "text": page.extract_text() or "",
            "source_file": source_file,
        }
        for page_number, page in enumerate(reader.pages, start=1)
    ]

def load_pdf_text(pdf_path: str) -> str:
    """
    Extrai todo o texto de um PDF em disco como uma única string.

    Páginas sem texto são avisadas com `print` e ignoradas; as demais são
    unidas por quebra de linha.

    Args:
        pdf_path: caminho do arquivo PDF.

    Returns:
        O texto das páginas, unido em uma só string.

    Raises:
        FileNotFoundError: se o arquivo não existir.
    """

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
    """
    Extrai o texto de cada página de um PDF em disco.

    Args:
        pdf_path: caminho do arquivo PDF.

    Returns:
        Uma entrada por página, com `page` (a partir de 1), `text` (vazio se
        a página não tiver texto extraível) e `source_file`, que é apenas o
        nome do arquivo, sem o caminho.

    Raises:
        FileNotFoundError: se o arquivo não existir.
    """

    path = Path(pdf_path)

    if not path.exists():
        raise FileNotFoundError(f"Arquivo não encontrado: {pdf_path}")

    reader = PdfReader(str(path))

    pages = []

    for page_number, page in enumerate(reader.pages, start=1):
        text = page.extract_text() or ""
        pages.append({
            "page": page_number,
            "text": text,
            "source_file": path.name,
        })
    return pages


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Uso: python pdf_loader.py caminho/para/arquivo.pdf")
        sys.exit(1)

    pdf_path = sys.argv[1]
    text = load_pdf_text(pdf_path)

    print(f"Os primeiros 200 caracteres do texto com ({len(text)} caracteres foi extraído:)")
    print("\n --- \n")
    print(text[:200])
    print("\n ---")
