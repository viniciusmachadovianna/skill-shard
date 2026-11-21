# Testing - Open /backend on terminal: python -m tests.test_keyword_search
import unittest

from app.retrieval.keyword_search import bm25_scores, tokenize


class TokenizeTests(unittest.TestCase):
    def test_normalizes_case_accents_stopwords_and_plurals(self):
        self.assertEqual(
            tokenize("As Estações da Linha 2 e os trens"),
            ["estacao", "linha", "2", "trem"],
        )

    def test_keeps_numbers_and_codes(self):
        # "nº" vira "no" na remoção de acentos (NFKD) e cai como stopword.
        self.assertEqual(tokenize("Aditivo nº 02, contrato 014/2021"), ["aditivo", "02", "contrato", "014", "2021"])

    def test_singular_and_plural_match(self):
        self.assertEqual(tokenize("estação"), tokenize("estações"))


class Bm25ScoresTests(unittest.TestCase):
    def test_text_without_query_terms_scores_zero(self):
        self.assertEqual(bm25_scores("tarifa", ["valor do contrato", "tarifa de R$ 6,40"])[0], 0)

    def test_rare_terms_weigh_more_than_common_ones(self):
        texts = [
            "linha linha obra",
            "linha aditivo obra",
            "linha obra prazo",
            "linha obra valor",
        ]

        scores = bm25_scores("linha aditivo", texts)

        self.assertEqual(max(range(len(texts)), key=scores.__getitem__), 1)

    def test_repetition_has_diminishing_returns(self):
        once, twice, many = bm25_scores(
            "tarifa", ["tarifa a b c", "tarifa tarifa a b", "tarifa tarifa tarifa tarifa", "a b c d"]
        )[:3]

        self.assertLess(twice - once, once)
        self.assertLess(many, 4 * once)

    def test_query_without_terms_scores_everything_zero(self):
        self.assertEqual(bm25_scores("o que é?", ["texto um", "texto dois"]), [0.0, 0.0])

    def test_empty_corpus(self):
        self.assertEqual(bm25_scores("tarifa", []), [])


if __name__ == "__main__":
    unittest.main()
