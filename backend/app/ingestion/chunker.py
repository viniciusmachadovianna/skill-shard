"""
Divisão dos documentos em trechos (chunks) que respeitam a estrutura do texto.

Um trecho é um pedaço do documento pequeno o bastante para virar um embedding
e ser comparado com a pergunta do usuário. Em vez de cortar o texto em janelas
fixas de palavras, este módulo primeiro reconhece a estrutura de cada formato
e só depois agrupa as partes em trechos:

    Markdown: front matter (`---`), títulos `#`, registros separados por
        `\\-----` (o mesmo separador usado em `entity_graph.py`), parágrafos,
        tabelas e blocos de código.
    CSV: linhas de comentário iniciais (`#`) como metadados, cabeçalho e
        linhas de dados. O cabeçalho é repetido em todo trecho.
    JSON: campos simples do objeto principal como metadados; cada item de uma
        lista ou de um objeto aninhado vira uma linha. JSON inválido é tratado
        como texto simples.
    TXT e PDF: linha inicial de metadados (`chave: valor | chave: valor`),
        títulos reconhecidos por heurística e parágrafos. Nos PDFs, cabeçalhos
        e rodapés repetidos e números de página são removidos, e palavras
        hifenizadas e linhas quebradas são reunidas.

Regras de agrupamento:
    - Um trecho nunca atravessa dois registros (`\\-----`).
    - Um novo título ou uma nova página fecham o trecho atual se ele já tiver
      pelo menos `min_size` palavras; seções pequenas são agrupadas.
    - Um trecho não termina em um título: o título passa para o trecho
      seguinte, junto com o conteúdo dele.
    - Partes maiores que `max_size` são divididas por linha, depois por frase
      e, por último, em janelas de palavras de tamanho uniforme.
    - Frases vizinhas de um parágrafo dividido compartilham até `overlap`
      palavras.
    - Um trecho final menor que `min_size` é unido ao anterior do mesmo
      registro, se couber.

Contexto: a partir do segundo trecho, cada trecho começa com as linhas que o
situam no documento: os metadados (data, versão, fonte) e o caminho de títulos
(`Título > Seção`). Assim, um trecho como "o prazo é de 30 dias" continua
dizendo de qual documento e seção veio. O primeiro trecho já contém essas
informações no próprio texto.

O tamanho é medido em palavras, mas texto denso (CSV, JSON, números) conta
pelo menos um "palavra" a cada 7 caracteres, para não gerar trechos longos
demais em tokens. Ver `estimate_size`.

Executado como script (`python -m app.ingestion.chunker arquivo...`, a partir
de `backend/`), o módulo imprime os trechos de cada arquivo.
"""

import json
import math
import re
import sys
from dataclasses import dataclass, replace
from glob import glob
from pathlib import Path

MAX_CHUNK_SIZE = 150
MIN_CHUNK_SIZE = 40
OVERLAP_SIZE = 20

# Um trecho pequeno pode ser unido ao anterior se o total não passar disto.
_MERGE_TOLERANCE = 1.25
_CHARS_PER_WORD = 7

_MD_HEADING = re.compile(r"^(#{1,6})\s+(.+?)\s*#*\s*$")
_MD_RECORD_SEPARATOR = re.compile(r"^\\-{5,}\s*$")
_MD_FENCE = re.compile(r"^\s*(```|~~~)")
_MD_TABLE_DIVIDER = re.compile(r"^\s*\|?\s*:?-{3,}")
_METADATA_LINE = re.compile(
    r"^[^\W\d][\w ]*\s*[:=]\s*[^|·]+?(?:\s*[|·]\s*[^\W\d][\w ]*\s*[:=]\s*[^|·]+?)+$"
)
_PAGE_NUMBER = re.compile(
    r"^(?:p(?:á|a)g(?:ina|e)?\.?\s*)?\d+(?:\s*(?:/|de|of)\s*\d+)?$", re.IGNORECASE
)
_SENTENCE_BREAK = re.compile(r"(?<=[.!?…])\s+(?=[\"'“(\[]?[^\W_a-zà-ÿ])")
_HYPHENATED_BREAK = re.compile(r"(?<=[^\W\d_])-\n(?=[a-zà-ÿ])")


@dataclass(eq=False)
class _Block:
    """
    Menor unidade de texto considerada no agrupamento.

    `kind` é `preamble` (metadados do documento), `heading`, `text` ou `row`
    (linha de tabela, CSV ou item de JSON). `path` são os títulos que contêm o
    bloco; num título, inclui o próprio título. `separator` vai entre este
    bloco e o anterior quando os dois ficam no mesmo trecho. `prefix` é
    repetido antes do primeiro bloco de cada trecho que o usa (cabeçalho de
    CSV ou de tabela). `overlappable` marca frases de um parágrafo dividido,
    que podem se repetir no início do trecho seguinte.
    """

    text: str
    kind: str = "text"
    page: int | None = None
    path: tuple[str, ...] = ()
    record: int = 0
    separator: str = "\n\n"
    prefix: str = ""
    overlappable: bool = False


def estimate_size(text: str) -> int:
    """
    Estima o tamanho de um texto em "palavras".

    É o maior valor entre o número de palavras e o número de caracteres
    dividido por 7. Em prosa, vale o número de palavras; em texto denso, como
    linhas de CSV ou JSON, o número de caracteres pesa mais, o que aproxima a
    contagem do custo real em tokens.
    """
    return max(len(text.split()), math.ceil(len(text) / _CHARS_PER_WORD))


def chunk_document(
    pages: list[dict],
    source_file: str,
    max_size: int = MAX_CHUNK_SIZE,
    min_size: int = MIN_CHUNK_SIZE,
    overlap: int = OVERLAP_SIZE,
) -> list[dict]:
    """
    Divide um documento em trechos, seguindo a estrutura do seu formato.

    Args:
        pages: páginas do documento, cada uma com `page` (número, ou `None`
            nos formatos sem páginas) e `text`. Formatos de texto chegam como
            uma única página.
        source_file: nome do arquivo; a extensão escolhe o leitor (`.md`,
            `.csv`, `.json`; os demais, inclusive `.pdf`, são texto simples).
        max_size: tamanho máximo de um trecho, em palavras (`estimate_size`).
        min_size: abaixo disso, um trecho é agrupado com o vizinho quando
            possível.
        overlap: palavras que frases vizinhas de um parágrafo dividido podem
            repetir entre trechos.

    Returns:
        Lista de `{"text", "page", "source_file"}`, na ordem do documento.
        `page` é a página onde o trecho começa. Vazia se não houver texto.

    Raises:
        ValueError: se `overlap` não for menor que `max_size`, ou se
            `min_size` for maior que `max_size`.
    """
    if max_size <= overlap:
        raise ValueError("max_size precisa ser maior que overlap")
    if min_size > max_size:
        raise ValueError("min_size não pode ser maior que max_size")

    extension = Path(source_file).suffix.lower()
    text = "\n".join(page["text"] for page in pages)
    blocks = None

    if extension == ".md":
        blocks = _markdown_blocks(text)
    elif extension == ".csv":
        blocks = _csv_blocks(text)
    elif extension == ".json":
        blocks = _json_blocks(text)

    if blocks is None:
        blocks = _plain_blocks(pages)

    blocks = [
        piece
        for block in blocks
        for piece in _split_block(block, max_size, overlap)
    ]
    groups = _pack(blocks, max_size, min_size, overlap)
    groups = _merge_small_groups(groups, max_size, min_size)

    preamble = next((block.text for block in blocks if block.kind == "preamble"), "")
    return [
        {
            "text": _render(group, preamble),
            "page": group[0].page,
            "source_file": source_file,
        }
        for group in groups
    ]


# Leitura de cada formato ----------------------------------------------------


def _markdown_blocks(text: str) -> list[_Block]:
    lines = text.splitlines()
    blocks = []
    start = 0

    if lines and lines[0].strip() == "---":
        for index in range(1, len(lines)):
            if lines[index].strip() == "---":
                metadata = [line.strip() for line in lines[1:index] if line.strip()]
                if metadata:
                    blocks.append(_Block(" | ".join(metadata), kind="preamble"))
                start = index + 1
                break

    headings: list[tuple[int, str]] = []
    paragraph: list[str] = []
    record = 0
    in_fence = False

    def flush_paragraph() -> None:
        if paragraph:
            path = tuple(title for _, title in headings)
            blocks.extend(_paragraph_blocks(paragraph, path, record))
            paragraph.clear()

    for line in lines[start:]:
        if in_fence or _MD_FENCE.match(line):
            if _MD_FENCE.match(line):
                in_fence = not in_fence
            paragraph.append(line.rstrip())
            continue
        if _MD_RECORD_SEPARATOR.match(line):
            flush_paragraph()
            record += 1
            continue
        heading = _MD_HEADING.match(line)
        if heading:
            flush_paragraph()
            level = len(heading.group(1))
            while headings and headings[-1][0] >= level:
                headings.pop()
            headings.append((level, heading.group(2).strip()))
            blocks.append(
                _Block(
                    line.strip(),
                    kind="heading",
                    path=tuple(title for _, title in headings),
                    record=record,
                )
            )
            continue
        if not line.strip():
            flush_paragraph()
            continue
        paragraph.append(line.rstrip())

    flush_paragraph()
    return blocks


def _paragraph_blocks(
    lines: list[str], path: tuple[str, ...], record: int, page: int | None = None
) -> list[_Block]:
    """Um parágrafo vira um bloco; uma tabela Markdown vira uma linha por bloco."""
    is_table = (
        len(lines) >= 3
        and all(line.lstrip().startswith("|") for line in lines)
        and _MD_TABLE_DIVIDER.match(lines[1])
    )
    if is_table:
        prefix = "\n".join(lines[:2])
        return [
            _Block(line, kind="row", page=page, path=path, record=record,
                   separator="\n", prefix=prefix)
            for line in lines[2:]
        ]
    return [_Block("\n".join(lines), page=page, path=path, record=record)]


def _csv_blocks(text: str) -> list[_Block]:
    preamble = []
    header = None
    rows = []

    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        if header is None and line.startswith("#"):
            preamble.append(line.lstrip("#").strip())
        elif header is None:
            header = line
        else:
            rows.append(_Block(line, kind="row", separator="\n", prefix=header))

    blocks = []
    if preamble:
        blocks.append(_Block(" | ".join(preamble), kind="preamble"))
    if header is not None and not rows:
        blocks.append(_Block(header))
    return blocks + rows


def _json_blocks(text: str) -> list[_Block] | None:
    try:
        data = json.loads(text)
    except ValueError:
        return None

    def render(value) -> str:
        return value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)

    def is_scalar(value) -> bool:
        return not isinstance(value, (dict, list)) or not value

    def rows(value, path: tuple[str, ...]) -> list[_Block]:
        items = (
            [render(item) for item in value]
            if isinstance(value, list)
            else [f"{key}: {render(item)}" for key, item in value.items()]
        )
        return [_Block(item, kind="row", path=path, separator="\n") for item in items]

    if is_scalar(data):
        return [_Block(render(data))] if render(data).strip() else []
    if isinstance(data, list):
        return rows(data, ())

    blocks = []
    scalars = [f"{key}: {render(value)}" for key, value in data.items() if is_scalar(value)]
    if scalars:
        blocks.append(_Block(" | ".join(scalars), kind="preamble"))
    for key, value in data.items():
        if is_scalar(value):
            continue
        blocks.append(_Block(f"{key}:", kind="heading", path=(key,)))
        blocks.extend(rows(value, (key,)))
    return blocks


def _plain_blocks(pages: list[dict]) -> list[_Block]:
    """
    Lê TXT e PDF. Sem marcação, os títulos são reconhecidos por heurística
    (`_looks_like_heading`): o primeiro título, se vier antes de qualquer
    parágrafo, é o título do documento (nível 1); os demais são seções.
    """
    if any(page["page"] is not None for page in pages):
        pages = _strip_page_furniture(pages)

    blocks = []
    headings: list[tuple[int, str]] = []
    seen_content = False

    for page_index, page in enumerate(pages):
        lines = [line.strip() for line in _unwrap(page["text"]).splitlines()]
        paragraph: list[str] = []

        if page_index == 0:
            # A linha de metadados pode vir depois de um cabeçalho de página
            # que não foi removido (PDF de uma página só): os dois viram o
            # preâmbulo.
            filled = [index for index, line in enumerate(lines) if line][:3]
            metadata_index = next(
                (index for index in filled if _METADATA_LINE.match(lines[index])), None
            )
            if metadata_index is not None:
                preamble = [line for line in lines[:metadata_index + 1] if line]
                blocks.append(_Block(" · ".join(preamble), kind="preamble", page=page["page"]))
                lines = lines[metadata_index + 1:]

        def flush_paragraph() -> None:
            if paragraph:
                path = tuple(title for _, title in headings)
                blocks.extend(_paragraph_blocks(paragraph, path, 0, page["page"]))
                paragraph.clear()

        for index, line in enumerate(lines):
            if not line:
                flush_paragraph()
                continue
            next_line = next((later for later in lines[index + 1:] if later), None)
            is_title = not seen_content and not headings and _looks_like_title(line, next_line)
            if is_title or _looks_like_heading(line, next_line):
                flush_paragraph()
                level = 1 if is_title else 2
                while headings and headings[-1][0] >= level:
                    headings.pop()
                headings.append((level, line))
                blocks.append(
                    _Block(line, kind="heading", page=page["page"],
                           path=tuple(title for _, title in headings))
                )
                continue
            seen_content = True
            paragraph.append(line)

        flush_paragraph()

    return blocks


def _looks_like_title(line: str, next_line: str | None) -> bool:
    """Primeira linha do documento: até 12 palavras, com letras, sem pontuação final."""
    return (
        next_line is not None
        and 1 <= len(line.split()) <= 12
        and line[-1] not in ".,;:!?)…"
        and any(character.isalpha() for character in line)
    )


def _looks_like_heading(line: str, next_line: str | None) -> bool:
    """
    Linha curta, sem pontuação final, iniciada por maiúscula ou número,
    seguida de uma linha maior (pelo menos 5 palavras e 2 a mais que o
    título). A exigência sobre a linha seguinte evita tratar células de
    tabela, extraídas uma por linha, como títulos.
    """
    words = line.split()
    return (
        next_line is not None
        and 1 <= len(words) <= 8
        and line[-1] not in ".,;:!?)…"
        and (line[0].isupper() or line[0].isdigit())
        and any(character.isalpha() for character in line)
        and len(next_line.split()) >= max(5, len(words) + 2)
    )


def _unwrap(text: str) -> str:
    """
    Reúne palavras hifenizadas e linhas quebradas no meio de uma frase.

    Uma linha que começa com minúscula continua a anterior, exceto se for
    uma linha de metadados (`doc_id: ...`).
    """
    lines: list[str] = []
    for line in _HYPHENATED_BREAK.sub("", text).split("\n"):
        stripped = line.strip()
        if (
            lines
            and lines[-1].strip()
            and stripped[:1].islower()
            and not _METADATA_LINE.match(stripped)
        ):
            lines[-1] = f"{lines[-1].rstrip()} {stripped}"
        else:
            lines.append(line)
    return "\n".join(lines)


def _strip_page_furniture(pages: list[dict]) -> list[dict]:
    """
    Remove dos PDFs números de página e cabeçalhos ou rodapés repetidos.

    Só as três primeiras e as três últimas linhas de cada página são
    examinadas. Uma linha é considerada repetida quando, com os números
    trocados por `#`, aparece nessas posições em pelo menos 60% das páginas
    (e em no mínimo duas).
    """
    def normalize(line: str) -> str:
        return re.sub(r"\d+", "#", " ".join(line.casefold().split()))

    def edge_indexes(lines: list[str]) -> set[int]:
        filled = [index for index, line in enumerate(lines) if line.strip()]
        return set(filled[:3] + filled[-3:])

    page_lines = [page["text"].splitlines() for page in pages]
    counts: dict[str, int] = {}
    for lines in page_lines:
        for key in {normalize(lines[index]) for index in edge_indexes(lines)}:
            counts[key] = counts.get(key, 0) + 1

    threshold = max(2, math.ceil(0.6 * len(pages)))
    repeated = {key for key, count in counts.items() if count >= threshold}

    cleaned = []
    for page, lines in zip(pages, page_lines):
        edges = edge_indexes(lines)
        kept = [
            line
            for index, line in enumerate(lines)
            if index not in edges
            or not (normalize(line) in repeated or _PAGE_NUMBER.match(line.strip()))
        ]
        cleaned.append({**page, "text": "\n".join(kept)})
    return cleaned


# Agrupamento ------------------------------------------------------------------


def _split_block(block: _Block, max_size: int, overlap: int) -> list[_Block]:
    """Divide um bloco grande por linha, depois por frase e, por fim, por palavras."""
    if estimate_size(block.text) <= max_size:
        return [block]

    lines = [line for line in block.text.split("\n") if line.strip()]
    sentences = _SENTENCE_BREAK.split(block.text)

    if len(lines) > 1:
        pieces = [replace(block, text=line, separator="\n") for line in lines]
    elif len(sentences) > 1:
        pieces = [
            replace(block, text=sentence, separator=" ", overlappable=True)
            for sentence in sentences
        ]
    else:
        words = block.text.split()
        ratio = len(words) / estimate_size(block.text)
        limit = max(1, int(max_size * ratio))
        window_overlap = min(int(overlap * ratio), limit - 1)
        return [
            replace(block, text=" ".join(window), separator="\n" if index else block.separator)
            for index, window in enumerate(_word_windows(words, limit, window_overlap))
        ]

    pieces[0] = replace(pieces[0], separator=block.separator)
    return [
        part
        for piece in pieces
        for part in _split_block(piece, max_size, overlap)
    ]


def _word_windows(words: list[str], limit: int, overlap: int) -> list[list[str]]:
    """
    Divide uma lista de palavras em janelas de tamanho uniforme.

    Usa o menor número de janelas de até `limit` palavras e distribui as
    palavras igualmente entre elas, para que a última não fique minúscula.
    Janelas vizinhas repetem `overlap` palavras.
    """
    if len(words) <= limit:
        return [words]

    count = math.ceil((len(words) - overlap) / (limit - overlap))
    size = math.ceil((len(words) + (count - 1) * overlap) / count)
    windows = []
    start = 0
    while True:
        end = min(start + size, len(words))
        windows.append(words[start:end])
        if end >= len(words):
            return windows
        start = end - overlap


def _pack(
    blocks: list[_Block], max_size: int, min_size: int, overlap: int
) -> list[list[_Block]]:
    groups: list[list[_Block]] = []
    current: list[_Block] = []
    size = 0

    for block in blocks:
        block_size = estimate_size(block.text)
        if current:
            last = current[-1]
            new_record = block.record != last.record
            new_section = (
                (block.kind == "heading" or block.page != last.page)
                and size >= min_size
            )
            full = size + block_size > max_size

            if new_record or new_section or full:
                carried = []
                if not new_record:
                    while len(current) > 1 and current[-1].kind == "heading":
                        carried.insert(0, current.pop())
                if (
                    not carried
                    and full
                    and not new_section
                    and last.overlappable
                    and block.overlappable
                    and estimate_size(last.text) <= overlap
                ):
                    carried = [last]
                groups.append(current)
                current = carried
                size = sum(estimate_size(item.text) for item in current)

        current.append(block)
        size += block_size

    if current:
        groups.append(current)
    return groups


def _merge_small_groups(
    groups: list[list[_Block]], max_size: int, min_size: int
) -> list[list[_Block]]:
    """
    Une trechos pequenos dentro do mesmo registro.

    Um trecho só com metadados e títulos não tem conteúdo próprio: é juntado
    ao seguinte, ou descartado se o seguinte for de outro registro (que já
    os repete como contexto). Depois, dois trechos vizinhos são unidos
    quando um deles é menor que `min_size` e o total cabe na tolerância.
    """
    pending: list[_Block] = []
    groups_with_content: list[list[_Block]] = []
    for index, group in enumerate(groups):
        group = pending + group
        pending = []
        next_group = groups[index + 1] if index + 1 < len(groups) else None
        only_labels = all(block.kind in ("preamble", "heading") for block in group)
        if only_labels and next_group:
            # No mesmo registro, os rótulos passam para o trecho seguinte. Em
            # outro registro, são descartados: os trechos seguintes já os
            # repetem como contexto (metadados e caminho de títulos).
            if next_group[0].record == group[-1].record:
                pending = group
            continue
        groups_with_content.append(group)

    merged: list[list[_Block]] = []
    for group in groups_with_content:
        if merged:
            previous = merged[-1]
            new_blocks = [block for block in group if not any(block is item for item in previous)]
            previous_size = sum(estimate_size(block.text) for block in previous)
            group_size = sum(estimate_size(block.text) for block in new_blocks)
            if (
                min(previous_size, group_size) < min_size
                and previous[-1].record == group[0].record
                and previous_size + group_size <= max_size * _MERGE_TOLERANCE
            ):
                previous.extend(new_blocks)
                continue
        merged.append(group)

    return merged


def _render(group: list[_Block], preamble: str) -> str:
    context = []
    if preamble and not any(block.kind == "preamble" for block in group):
        context.append(preamble)

    first = next((block for block in group if block.kind != "preamble"), None)
    if first is not None:
        path = first.path[:-1] if first.kind == "heading" else first.path
        if path:
            context.append(" > ".join(path))

    body = ""
    current_prefix = ""
    for block in group:
        text = block.text
        separator = block.separator
        if block.prefix and block.prefix != current_prefix:
            text = f"{block.prefix}\n{text}"
            separator = "\n\n"
        current_prefix = block.prefix
        body = f"{body}{separator}{text}" if body else text

    return "\n".join(context) + "\n\n" + body if context else body


if __name__ == "__main__":
    # Só para a execução direta: no topo do módulo, isto carregaria um segundo
    # módulo "loader" dentro do servidor.
    sys.path.append(str(Path(__file__).parent))
    from loader import load_pdf_pages

    if len(sys.argv) < 2:
        print("Uso: python -m app.ingestion.chunker arquivo|pasta|padrão [...]")
        sys.exit(1)

    # PowerShell e cmd não expandem `*`, então os padrões são expandidos aqui.
    # Uma pasta vale por todos os arquivos dentro dela.
    paths = []
    for argument in sys.argv[1:]:
        matches = [Path(match) for match in sorted(glob(argument))] or [Path(argument)]
        for match in matches:
            paths.extend(sorted(item for item in match.iterdir() if item.is_file()) if match.is_dir() else [match])

    for path in paths:
        if not path.is_file():
            print(f"\n===== {path}: arquivo não encontrado")
            continue
        if path.suffix.lower() == ".pdf":
            pages = load_pdf_pages(str(path))
        else:
            pages = [{"page": None, "text": path.read_text(encoding="utf-8")}]

        chunks = chunk_document(pages, path.name)
        print(f"\n===== {path.name}: {len(chunks)} trecho(s)")
        for number, chunk in enumerate(chunks, start=1):
            page = f", página {chunk['page']}" if chunk["page"] is not None else ""
            print(f"--- Trecho {number} (~{estimate_size(chunk['text'])} palavras{page})")
            print(chunk["text"])
