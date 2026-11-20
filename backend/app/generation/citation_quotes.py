"""
Inserção dos trechos citados na resposta do modelo.

O modelo deveria citar as fontes como `[Source: arquivo.pdf, page 1, chunk 2]`,
mas na prática varia: junta várias fontes em um colchete separadas por `;`
(`[a.pdf, page 1, chunk 1; b.txt, chunk 1]`), omite a palavra `Source:` e lista
vários trechos no mesmo rótulo (`chunk 1, chunk 2` ou `chunks 1 and 2`). Este
módulo entende essas variações e coloca, logo abaixo da linha que contém a
citação, o texto do trecho recuperado como citação em Markdown (`> ...`).
Citações que não correspondem a nenhum trecho recuperado ficam sem citação.
"""

import re

# Citação curta: [S1], [S1, S2], [S1; S2].
_SHORT_BRACKET = re.compile(r"\[\s*S\d+(?:\s*[,;]\s*S\d+)*\s*\]", re.IGNORECASE)

# Qualquer colchete que mencione "chunk" seguido de um número.
_BRACKET = re.compile(r"\[([^\[\]]*chunks?\s*\d[^\[\]]*)\]", re.IGNORECASE)
# Início de uma entrada: "Source:" opcional, o nome do arquivo e, opcionalmente,
# a página, até o primeiro "chunk N".
_ENTRY_HEAD = re.compile(
    r"^\s*(?:source:\s*)?(?P<name>.+?)\s*,\s*(?:page\s*(?P<page>\d+)\s*,\s*)?(?=chunks?\s*\d)",
    re.IGNORECASE,
)


def _bracket_citations(bracket_text: str):
    """Gera `(arquivo, número do trecho, página ou None)` de cada citação do colchete."""
    for entry in bracket_text.split(";"):
        head = _ENTRY_HEAD.match(entry)
        if not head:
            continue
        name = head.group("name").strip()
        page = head.group("page")
        for number in re.findall(r"\d+", entry[head.end():]):
            yield name, int(number), int(page) if page else None


def _citations(line: str):
    """Gera `(arquivo, número do trecho)` de cada citação encontrada na linha."""
    for bracket in _BRACKET.finditer(line):
        for name, number, _ in _bracket_citations(bracket.group(1)):
            yield name, number


def expand_short_ids(answer: str, chunks: list[dict]) -> str:
    """
    Troca citações curtas como `[S2]` pelo rótulo completo do trecho.

    `S1` é o primeiro trecho de `chunks`, `S2` o segundo, e assim por diante
    (a mesma ordem usada ao montar o contexto do prompt). IDs fora do
    intervalo ficam como estão. Vários IDs no mesmo colchete viram vários
    rótulos, separados por espaço.
    """
    def expand(match: re.Match) -> str:
        labels = []
        for number in re.findall(r"\d+", match.group(0)):
            index = int(number) - 1
            if not 0 <= index < len(chunks):
                return match.group(0)
            chunk = chunks[index]
            page = f", page {chunk['page']}" if chunk.get("page") is not None else ""
            labels.append(f"[Source: {chunk['source']}{page}, chunk {chunk['chunk']}]")
        return " ".join(labels)

    return _SHORT_BRACKET.sub(expand, answer)


def insert_chunk_quotes(answer: str, chunks: list[dict]) -> str:
    """
    Adiciona o trecho citado abaixo de cada linha da resposta que o cita.

    O trecho é encontrado por (arquivo, número do trecho), sem diferenciar
    maiúsculas de minúsculas no nome; o número da página do rótulo é ignorado
    porque o número do trecho já é único no documento. O trecho é repetido
    abaixo de todas as linhas que o citam. Várias citações na mesma linha
    geram uma citação por trecho distinto, na ordem em que aparecem.

    Args:
        answer: resposta do modelo, sem a lista final de fontes.
        chunks: trechos recuperados, cada um com `source`, `chunk` e `text`.

    Cada citação começa com um marcador `⟦arquivo|trecho⟧` que a interface usa
    para ligar a citação ao botão da fonte e remove ao exibir ou copiar.

    Returns:
        A resposta com os trechos como citações Markdown, separados por
        linhas em branco. Igual a `answer` se nada corresponder.
    """
    answer = expand_short_ids(answer, chunks)
    lookup = {
        (chunk["source"].casefold(), chunk["chunk"]): (chunk["source"], chunk["text"], chunk.get("page"))
        for chunk in chunks
    }

    def canonical(match: re.Match) -> str:
        # One `[Source: arquivo, page N, chunk K]` per cited chunk, so the
        # interface can show each one as its own button.
        labels = []
        for name, number, written_page in _bracket_citations(match.group(1)):
            entry = lookup.get((name.casefold(), number))
            source, page = (entry[0], entry[2]) if entry else (name, written_page)
            page_label = f", page {page}" if page is not None else ""
            labels.append(f"[Source: {source}{page_label}, chunk {number}]")
        return " ".join(labels) or match.group(0)

    output = []

    for line in answer.split("\n"):
        line = _BRACKET.sub(canonical, line)
        output.append(line)
        quotes = []
        seen_in_line = set()
        for name, number in _citations(line):
            key = (name.casefold(), number)
            entry = lookup.get(key)
            if entry is None or key in seen_in_line:
                continue
            seen_in_line.add(key)
            source, text, _ = entry
            quotes.append(f"> ⟦{source}|{number}⟧ " + " ".join(text.split()))
        for quote in quotes:
            output.extend(["", quote, ""])

    return "\n".join(output)
