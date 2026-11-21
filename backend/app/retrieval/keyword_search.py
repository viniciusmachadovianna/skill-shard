"""
Busca por palavras-chave com BM25, usada junto com a busca por embeddings.

Embeddings comparam significado e falham em termos exatos: números, códigos
e nomes próprios ("Aditivo 02", "D16", "014/2021", "v3") quase não têm
"significado" para o modelo. O BM25 faz o contrário: só conta palavras em
comum, mas dá muito peso às raras. As duas listas são combinadas em
`vector_store.retrieve_relevant_chunks` (busca híbrida).

BM25 (Best Matching 25), para cada trecho:
    soma, para cada termo da pergunta presente no trecho,
        IDF(termo) * tf * (k1 + 1) / (tf + k1 * (1 - b + b * tamanho / tamanho_médio))
    tf: quantas vezes o termo aparece no trecho. A fração cresce com tf, mas
        satura: repetir um termo ajuda cada vez menos.
    IDF: ln(1 + (N - df + 0.5) / (df + 0.5)), com N trechos e df trechos
        que contêm o termo. Termos raros pesam mais.
    b: quanto o tamanho do trecho é descontado (trechos longos não ganham só
        por ter mais palavras).

Normalização dos termos (`tokenize`): minúsculas, sem acentos, só letras e
números, sem palavras muito comuns (stopwords) e com uma redução simples de
plural ("estações" -> "estacao", "trens" -> "trem"). A mesma normalização vale
para a pergunta e para os trechos.

Funções:
    tokenize: transforma um texto em lista de termos.
    bm25_scores: pontua uma lista de textos para uma pergunta.
"""

import math
import re
import unicodedata
from collections import Counter

K1 = 1.5
B = 0.75

_TOKEN = re.compile(r"[a-z0-9]+")

# Palavras frequentes demais para distinguir trechos (português e inglês).
_STOPWORDS = frozenset(
    """
    a ao aos as ate com como da das de do dos e ela ele em entre era essa esse
    esta este foi for ha isso ja la mais mas me na nas nao no nos o os ou para
    pela pelo por qual quais quando que quem se sem ser seu sua sao so sobre
    tem um uma umas uns vai
    an and are as at be by for from has have how in is it of on or that the
    this to was what when where which who will with
    """.split()
)


def _strip_accents(text: str) -> str:
    decomposed = unicodedata.normalize("NFKD", text)
    return "".join(character for character in decomposed if not unicodedata.combining(character))


def _stem(token: str) -> str:
    """Reduz plurais comuns do português; números e termos curtos ficam iguais."""
    if len(token) <= 3 or token.isdigit():
        return token
    for suffix, replacement in (("oes", "ao"), ("aes", "ao"), ("ns", "m")):
        if token.endswith(suffix) and len(token) > len(suffix) + 2:
            return token[: -len(suffix)] + replacement
    if token.endswith("s") and not token.endswith("ss"):
        return token[:-1]
    return token


def tokenize(text: str) -> list[str]:
    """
    Divide um texto em termos normalizados para o BM25.

    Exemplo: "Estações da Linha 2" -> ["estacao", "linha", "2"].
    """
    words = _TOKEN.findall(_strip_accents(text.casefold()))
    return [_stem(word) for word in words if word not in _STOPWORDS]


def bm25_scores(query: str, texts: list[str], k1: float = K1, b: float = B) -> list[float]:
    """
    Pontua cada texto para a pergunta com BM25.

    Os textos formam o próprio "corpus" das estatísticas (IDF e tamanho
    médio), então a pontuação de um trecho depende dos demais trechos
    pesquisados junto com ele.

    Args:
        query: pergunta do usuário.
        texts: textos dos trechos.

    Returns:
        Uma pontuação por texto, na mesma ordem. Zero quando o texto não tem
        nenhum termo da pergunta; lista de zeros se a pergunta não tiver
        termos depois da normalização.
    """
    documents = [tokenize(text) for text in texts]
    query_terms = set(tokenize(query))
    if not documents or not query_terms:
        return [0.0] * len(texts)

    count = len(documents)
    average_length = sum(len(document) for document in documents) / count or 1.0
    document_frequency = Counter(
        term for document in documents for term in set(document) if term in query_terms
    )
    idf = {
        term: math.log(1 + (count - frequency + 0.5) / (frequency + 0.5))
        for term, frequency in document_frequency.items()
    }

    scores = []
    for document in documents:
        frequencies = Counter(document)
        length_factor = k1 * (1 - b + b * len(document) / average_length)
        scores.append(sum(
            idf[term] * frequencies[term] * (k1 + 1) / (frequencies[term] + length_factor)
            for term in idf
            if frequencies[term]
        ))
    return scores
