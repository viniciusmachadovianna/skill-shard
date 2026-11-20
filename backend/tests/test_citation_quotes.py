# Testing - Open /backend on terminal: python -m tests.test_citation_quotes
import unittest

from app.generation.citation_quotes import insert_chunk_quotes

CHUNKS = [
    {"source": "a.pdf", "page": 1, "chunk": 2, "text": "alpha  beta\ngamma"},
    {"source": "a.pdf", "page": 2, "chunk": 3, "text": "delta"},
    {"source": "notes.md", "page": None, "chunk": 1, "text": "epsilon"},
]


class InsertChunkQuotesTests(unittest.TestCase):
    def test_quote_goes_below_the_cited_line(self):
        answer = "Start.\nFact [Source: a.pdf, page 1, chunk 2].\nEnd."
        self.assertEqual(
            insert_chunk_quotes(answer, CHUNKS),
            "Start.\nFact [Source: a.pdf, page 1, chunk 2].\n\n> ⟦a.pdf|2⟧ alpha beta gamma\n\nEnd.",
        )

    def test_multiple_citations_on_one_line_give_one_quote_each(self):
        answer = "Fact [Source: a.pdf, page 1, chunk 2] [Source: a.pdf, page 2, chunk 3]."
        result = insert_chunk_quotes(answer, CHUNKS)
        self.assertIn("alpha beta gamma", result)
        self.assertIn("delta", result)
        self.assertLess(result.index("alpha"), result.index("delta"))

    def test_chunk_is_quoted_under_every_line_that_cites_it(self):
        answer = "One [Source: a.pdf, page 1, chunk 2].\nTwo [Source: a.pdf, page 1, chunk 2]."
        self.assertEqual(insert_chunk_quotes(answer, CHUNKS).count("alpha"), 2)

    def test_same_chunk_twice_on_one_line_is_quoted_once(self):
        answer = "Fact [Source: a.pdf, chunk 2] and more [Source: a.pdf, page 1, chunk 2]."
        self.assertEqual(insert_chunk_quotes(answer, CHUNKS).count("alpha"), 1)

    def test_citation_without_page_matches(self):
        result = insert_chunk_quotes("Fact [Source: notes.md, chunk 1].", CHUNKS)
        self.assertIn("epsilon", result)

    def test_unmatched_citation_is_left_alone(self):
        answer = "Fact [Source: other.pdf, page 1, chunk 9]."
        self.assertEqual(insert_chunk_quotes(answer, CHUNKS), answer)

    def test_answer_without_citations_is_unchanged(self):
        self.assertEqual(insert_chunk_quotes("No sources here.", CHUNKS), "No sources here.")

    def test_semicolon_separated_sources_without_source_prefix(self):
        answer = "Fact [a.pdf, page 1, chunk 2; notes.md, chunk 1]."
        result = insert_chunk_quotes(answer, CHUNKS)
        self.assertIn("alpha beta gamma", result)
        self.assertIn("epsilon", result)

    def test_several_chunks_in_one_label(self):
        answer = "Fact [Source: a.pdf, page 1, chunk 2, chunk 3]."
        result = insert_chunk_quotes(answer, CHUNKS)
        self.assertIn("alpha beta gamma", result)
        self.assertIn("delta", result)

    def test_chunks_joined_with_and_and_name_case_ignored(self):
        result = insert_chunk_quotes("Fact [A.PDF, chunks 2 and 3].", CHUNKS)
        self.assertIn("alpha", result)
        self.assertIn("delta", result)

    def test_real_world_answer_shape(self):
        answer = "* Item [a.pdf, page 1, chunk 2, chunk 3; notes.md, chunk 1]."
        result = insert_chunk_quotes(answer, CHUNKS)
        for quote in ("alpha beta gamma", "delta", "epsilon"):
            self.assertIn(quote, result)

    def test_short_id_is_expanded_and_quoted(self):
        result = insert_chunk_quotes("Fact [S1].", CHUNKS)
        self.assertIn("[Source: a.pdf, page 1, chunk 2]", result)
        self.assertIn("alpha beta gamma", result)

    def test_short_ids_in_one_bracket_and_adjacent_brackets(self):
        for answer in ("Fact [S2, S3].", "Fact [S2][S3]."):
            result = insert_chunk_quotes(answer, CHUNKS)
            self.assertIn("[Source: a.pdf, page 2, chunk 3]", result)
            self.assertIn("delta", result)
            self.assertIn("epsilon", result)

    def test_short_id_without_page_has_no_page_in_label(self):
        result = insert_chunk_quotes("Fact [S3].", CHUNKS)
        self.assertIn("[Source: notes.md, chunk 1]", result)

    def test_unknown_short_id_is_left_alone(self):
        self.assertEqual(insert_chunk_quotes("Fact [S9].", CHUNKS), "Fact [S9].")

    def test_lowercase_short_id_is_accepted(self):
        self.assertIn("alpha", insert_chunk_quotes("Fact [s1].", CHUNKS))

    def test_multi_source_bracket_is_split_into_one_label_per_chunk(self):
        result = insert_chunk_quotes("Fact [a.pdf, chunk 2, chunk 3; notes.md, chunk 1].", CHUNKS)
        self.assertIn(
            "Fact [Source: a.pdf, page 1, chunk 2] [Source: a.pdf, page 2, chunk 3] "
            "[Source: notes.md, chunk 1].",
            result,
        )

    def test_unmatched_entry_in_bracket_becomes_its_own_label(self):
        result = insert_chunk_quotes("Fact [other.pdf, page 3, chunk 9].", CHUNKS)
        self.assertEqual(result, "Fact [Source: other.pdf, page 3, chunk 9].")


if __name__ == "__main__":
    unittest.main()
