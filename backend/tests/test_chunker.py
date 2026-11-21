# Testing - Open /backend on terminal: python -m tests.test_chunker
import json
import unittest

from app.ingestion.chunker import chunk_document, estimate_size


def words(prefix: str, count: int) -> str:
    return " ".join(f"{prefix}{index}" for index in range(count))


def sentences(prefix: str, count: int, length: int = 10) -> str:
    return " ".join(
        f"{words(f'{prefix}{index}x', length).capitalize()}." for index in range(count)
    )


def text_document(content: str) -> list[dict]:
    return [{"page": None, "text": content}]


class MarkdownChunkingTests(unittest.TestCase):
    def test_sections_become_chunks_with_metadata_and_heading_context(self):
        content = (
            "---\ndoc_id: D1\ndata: 2024-01-01\n---\n"
            "# Título\n\n"
            f"## Seção A\n\n{sentences('a', 9)}\n\n"
            f"## Seção B\n\n{sentences('b', 9)}\n"
        )

        chunks = chunk_document(text_document(content), "doc.md")

        self.assertEqual(len(chunks), 2)
        self.assertTrue(chunks[0]["text"].startswith("doc_id: D1 | data: 2024-01-01\n\n# Título"))
        self.assertIn("## Seção A", chunks[0]["text"])
        self.assertEqual(
            chunks[1]["text"].split("\n\n")[:2],
            ["doc_id: D1 | data: 2024-01-01\nTítulo", "## Seção B"],
        )
        self.assertNotIn("Seção A", chunks[1]["text"])

    def test_small_sections_are_grouped_and_newlines_are_kept(self):
        content = "# Título\n\n## A\n\n- item um\n- item dois\n\n## B\n\nTexto curto.\n"

        chunks = chunk_document(text_document(content), "doc.md")

        self.assertEqual(len(chunks), 1)
        self.assertIn("- item um\n- item dois", chunks[0]["text"])
        self.assertIn("## B\n\nTexto curto.", chunks[0]["text"])

    def test_records_never_share_a_chunk(self):
        content = (
            "# Base\n\n\\-----\n## Item um\n**Tipo:** Artigo\n\nCurto.\n"
            "\\-----\n## Item dois\n**Tipo:** Nota\n\nTambém curto.\n"
        )

        chunks = chunk_document(text_document(content), "base.md")

        self.assertEqual(len(chunks), 2)
        self.assertIn("## Item um", chunks[0]["text"])
        self.assertNotIn("Item dois", chunks[0]["text"])
        self.assertTrue(chunks[1]["text"].startswith("Base\n\n## Item dois"))
        self.assertNotIn("\\-----", "".join(chunk["text"] for chunk in chunks))

    def test_continuation_of_a_long_record_keeps_its_title(self):
        content = f"\\-----\n## Item longo\n**Tipo:** Artigo\n\n{sentences('p', 30)}\n"

        chunks = chunk_document(text_document(content), "base.md")

        self.assertGreater(len(chunks), 1)
        for chunk in chunks:
            self.assertIn("Item longo", chunk["text"])

    def test_markdown_table_header_is_repeated(self):
        rows = "\n".join(f"| linha {index} | {words('v', 6)} |" for index in range(40))
        content = f"## Tabela\n\n| nome | valor |\n| --- | --- |\n{rows}\n"

        chunks = chunk_document(text_document(content), "tabela.md")

        self.assertGreater(len(chunks), 1)
        for chunk in chunks:
            self.assertIn("| nome | valor |\n| --- | --- |\n| linha", chunk["text"])


class StructuredDataChunkingTests(unittest.TestCase):
    def test_csv_rows_are_grouped_under_the_repeated_header(self):
        rows = "\n".join(f"{index},nome {index},bairro {index}" for index in range(120))
        content = f"# doc_id=D5 | versao=v1\nid,nome,bairro\n{rows}\n"

        chunks = chunk_document(text_document(content), "dados.csv")

        self.assertGreater(len(chunks), 1)
        for chunk in chunks:
            self.assertTrue(chunk["text"].startswith("doc_id=D5 | versao=v1\n\nid,nome,bairro\n"))
            self.assertLessEqual(estimate_size(chunk["text"]), 150 * 1.25)
        all_rows = [
            line for chunk in chunks for line in chunk["text"].splitlines()[3:]
        ]
        self.assertEqual(len(all_rows), 120)

    def test_json_scalars_become_metadata_and_items_become_lines(self):
        content = json.dumps(
            {
                "doc_id": "D7",
                "versao": "v3",
                "marcos": [{"nome": "Inauguração", "data": "2027-03-02"}],
                "termos": {"TBM": "Tuneladora"},
            },
            ensure_ascii=False,
        )

        chunks = chunk_document(text_document(content), "dados.json")

        self.assertEqual(
            chunks[0]["text"],
            "doc_id: D7 | versao: v3\n\n"
            "marcos:\n"
            '{"nome": "Inauguração", "data": "2027-03-02"}\n\n'
            "termos:\n"
            "TBM: Tuneladora",
        )

    def test_invalid_json_is_chunked_as_text(self):
        chunks = chunk_document(text_document("{ não é json"), "quebrado.json")

        self.assertEqual(chunks[0]["text"], "{ não é json")


class PlainTextChunkingTests(unittest.TestCase):
    def test_pdf_page_furniture_is_removed_and_lines_are_rejoined(self):
        pages = [
            {
                "page": 1,
                "text": (
                    "Relatório X · Contrato 1\nPágina 1\n"
                    "doc_id: D16 · data: 2023-11-30\n"
                    "Relatório de auditoria\n"
                    "Resumo\n"
                    "O incidente ocorreu durante a escava-\nção, sem feridos graves e\nsem óbitos.\n"
                ),
            },
            {
                "page": 2,
                "text": (
                    "Relatório X · Contrato 1\nPágina 2\n"
                    "Causa\n"
                    "Infiltração de água no maciço e tratamento de solo subdimensionado.\n"
                ),
            },
        ]

        chunks = chunk_document(pages, "relatorio.pdf")
        text = "\n".join(chunk["text"] for chunk in chunks)

        self.assertNotIn("Página", text)
        self.assertNotIn("Relatório X", text)
        self.assertIn("durante a escavação, sem feridos graves e sem óbitos.", text)
        self.assertTrue(chunks[0]["text"].startswith("doc_id: D16 · data: 2023-11-30"))
        self.assertEqual(chunks[0]["page"], 1)

    def test_page_change_starts_a_new_chunk_once_the_current_one_is_big_enough(self):
        pages = [
            {"page": 1, "text": sentences("a", 6)},
            {"page": 2, "text": sentences("b", 6)},
        ]

        chunks = chunk_document(pages, "doc.pdf")

        self.assertEqual([chunk["page"] for chunk in chunks], [1, 2])

    def test_short_pages_are_grouped_and_keep_the_first_page(self):
        pages = [
            {"page": 1, "text": "Primeira página curta."},
            {"page": 2, "text": "Segunda página curta."},
        ]

        chunks = chunk_document(pages, "doc.pdf")

        self.assertEqual(len(chunks), 1)
        self.assertEqual(chunks[0]["page"], 1)
        self.assertIn("Segunda página curta.", chunks[0]["text"])

    def test_text_metadata_line_is_repeated_in_later_chunks(self):
        content = f"doc_id: D13 | data: 2024-04-01\n\n{sentences('p', 30)}\n"

        chunks = chunk_document(text_document(content), "perfil.txt")

        self.assertGreater(len(chunks), 1)
        for chunk in chunks:
            self.assertTrue(chunk["text"].startswith("doc_id: D13 | data: 2024-04-01\n\n"))

    def test_long_paragraph_is_split_by_sentence_with_overlap(self):
        content = sentences("s", 40, length=8)

        chunks = chunk_document(text_document(content), "texto.txt", overlap=10)

        self.assertGreater(len(chunks), 1)
        for previous, current in zip(chunks, chunks[1:]):
            last_sentence = previous["text"].rsplit(". ", 1)[-1]
            self.assertTrue(current["text"].startswith(last_sentence.rstrip(".")))
        for chunk in chunks:
            self.assertTrue(chunk["text"].endswith("."))

    def test_unbroken_text_is_split_into_even_word_windows(self):
        chunks = chunk_document(text_document(words("w", 160)), "texto.txt")

        self.assertEqual([len(chunk["text"].split()) for chunk in chunks], [90, 90])
        self.assertEqual(chunks[0]["text"].split()[-20:], chunks[1]["text"].split()[:20])


class ChunkDocumentContractTests(unittest.TestCase):
    def test_empty_document_has_no_chunks(self):
        self.assertEqual(chunk_document(text_document("  \n "), "vazio.txt"), [])

    def test_metadata_alone_never_becomes_a_chunk(self):
        content = f"doc_id: D4 | data: 2024-04-22\n\nTÍTULO\n\n{words('w', 140)}\n"

        chunks = chunk_document(text_document(content), "aditivo.txt")

        self.assertEqual(len(chunks), 1)
        self.assertIn("TÍTULO", chunks[0]["text"])

    def test_every_chunk_names_its_source_file(self):
        chunks = chunk_document(text_document(sentences("p", 40)), "fonte.txt")

        self.assertTrue(all(chunk["source_file"] == "fonte.txt" for chunk in chunks))

    def test_invalid_sizes_are_rejected(self):
        with self.assertRaises(ValueError):
            chunk_document(text_document("texto"), "a.txt", max_size=20, overlap=20)
        with self.assertRaises(ValueError):
            chunk_document(text_document("texto"), "a.txt", max_size=20, min_size=30)


if __name__ == "__main__":
    unittest.main()
