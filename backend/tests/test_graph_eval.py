# Testing - Open /backend on terminal: python -m tests.test_graph_eval
import unittest

from app.retrieval.chunk_graph import _stable_id
from evals.graph_eval import evaluate, names_match, relation_instances

ADITIVO_01 = _stable_id("reference", "aditivo:1")
ADITIVO_02 = _stable_id("reference", "aditivo:2")
CONTRATO = _stable_id("reference", "contrato:14/2021")


def node(node_id: str, label: str, node_type: str, aliases=()) -> dict:
    return {"id": node_id, "label": label, "type": node_type, "aliases": list(aliases)}


def edge(source: str, label: str, target: str, document: str = "D1.md") -> dict:
    return {
        "id": f"{source}-{label}-{target}",
        "source": source,
        "target": target,
        "label": label,
        "evidence": [{"document_id": document, "document_name": document, "chunk": 1, "excerpt": "x"}],
    }


GRAPH = {
    "nodes": [
        node("ctmsc", "Companhia de Transportes Metropolitanos de Serra Clara", "organizacao", ["CTMSC"]),
        node("helena", "Helena Prado", "pessoa"),
        node("menezes", "Ricardo Menezes", "pessoa"),
        node("meneses", "Ricardo Meneses", "pessoa"),
        node(ADITIVO_02, "Termo Aditivo nº 02", "documento"),
        node(CONTRATO, "Contrato CTMSC nº 014/2021", "documento"),
        node(ADITIVO_01, "Aditivo 01", "documento", ["Termo Aditivo nº 01 ao Contrato 014/2021"]),
    ],
    "edges": [
        edge("helena", "ocupa_cargo", "ctmsc"),
        edge(ADITIVO_02, "altera", CONTRATO),
        edge("helena", "mentions", "ctmsc"),
        edge("helena", "assina", ADITIVO_01),
    ],
}


class NamesMatchTests(unittest.TestCase):
    def test_matches_aliases_and_contained_names_as_whole_words(self):
        self.assertTrue(names_match("CTMSC", GRAPH["nodes"][0]))
        self.assertTrue(names_match("Aditivo 02", GRAPH["nodes"][4]))
        self.assertTrue(names_match("Aditivo 2", GRAPH["nodes"][4]))
        self.assertTrue(names_match("contrato 014/2021", GRAPH["nodes"][5]))

    def test_does_not_match_partial_words_or_other_spellings(self):
        self.assertFalse(names_match("Ricardo Menezes", GRAPH["nodes"][3]))
        self.assertFalse(names_match("Prado", node("x", "Pradoso", "pessoa")))

    def test_numbered_acts_match_by_identity_not_by_alias_text(self):
        # O alias do Aditivo 01 contém "Contrato 014/2021", mas não é o contrato.
        self.assertFalse(names_match("Contrato 014/2021", GRAPH["nodes"][6]))
        self.assertFalse(names_match("Aditivo 02", GRAPH["nodes"][6]))


class EvaluateTests(unittest.TestCase):
    def test_recall_requires_relation_type_and_both_ends(self):
        gold = {
            "relations": [
                {"id": "g1", "source": ["Helena Prado"], "relation": ["ocupa_cargo"], "target": ["CTMSC"]},
                {"id": "g2", "source": ["Aditivo 02"], "relation": ["altera"], "target": ["Contrato 014/2021"]},
                {"id": "g3", "source": ["Helena Prado"], "relation": ["assina"], "target": ["CTMSC"]},
                {"id": "g4", "source": ["Contrato 014/2021"], "relation": ["altera"], "target": ["Aditivo 02"]},
                {"id": "g5", "source": ["Helena Prado"], "relation": ["assina"], "target": ["Contrato 014/2021"]},
            ],
            "identity_checks": {
                "same": [["CTMSC", "Companhia de Transportes Metropolitanos de Serra Clara"], ["Helena Prado", "CTMSC"]],
                "different": [["Ricardo Menezes", "Ricardo Meneses"], ["Fulano", "CTMSC"]],
            },
        }

        result = evaluate(GRAPH, gold)

        self.assertEqual([row["found"] for row in result["relations"]], [True, True, False, False, False])
        self.assertEqual(result["recall"], 0.4)
        self.assertEqual(
            [check["status"] for check in result["identity_checks"]],
            ["ok", "falhou", "ok", "não encontrado"],
        )

    def test_precision_sample_skips_structural_mentions(self):
        instances = relation_instances(GRAPH)

        self.assertEqual(sorted(item["relation"] for item in instances), ["altera", "assina", "ocupa_cargo"])
        self.assertTrue(all(item["correct"] == "" for item in instances))


if __name__ == "__main__":
    unittest.main()
