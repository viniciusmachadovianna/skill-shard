# Testing - Open /backend on terminal: python -m tests.test_chunk_graph
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

os.environ.setdefault("FRONTEND_ORIGIN", "http://localhost:5500")

from fastapi.testclient import TestClient

from app.main import app, build_relationship_context, graph_relationships_for_chunks
from app.retrieval.chunk_graph import (
    attach_chunk_evidence,
    build_chunk_graph,
    chunk_node_id,
    find_references,
)


def chunk(document_id: str, number: int, text: str, source: str | None = None, page=None) -> dict:
    return {
        "document_id": document_id,
        "source": source or f"{document_id}.md",
        "chunk": number,
        "page": page,
        "text": text,
    }


def edges_with(graph: dict, label: str) -> list[dict]:
    return [edge for edge in graph["edges"] if edge["label"] == label]


class FindReferencesTests(unittest.TestCase):
    def test_spelling_variants_share_one_identity(self):
        identities = {
            identity
            for text in ("Termo Aditivo nº 02", "o Aditivo 02 ajustou", "aditivo 2", "TERMO ADITIVO N.º 02")
            for identity, *_ in find_references(text)
        }

        self.assertEqual(identities, {"aditivo:2"})

    def test_reads_numbers_with_year_and_words_before_the_number_mark(self):
        found = [
            (identity, label)
            for identity, label, *_ in find_references(
                "Contrato CTMSC nº 014/2021 e a Nota Técnica de Capacidade nº 07/2024; Parecer 118/2024."
            )
        ]

        self.assertEqual(found, [
            ("contrato:14/2021", "Contrato 014/2021"),
            ("nota tecnica:7/2024", "Nota Técnica 07/2024"),
            ("parecer:118/2024", "Parecer 118/2024"),
        ])

    def test_unmarked_numbers_after_other_words_are_ignored(self):
        self.assertEqual(find_references("o valor do contrato da Linha 2 e o parecer do TCE"), [])


class BuildChunkGraphTests(unittest.TestCase):
    def test_documents_contain_their_chunks(self):
        graph = build_chunk_graph([chunk("a", 1, "um"), chunk("a", 2, "dois", page=3)])

        node = next(node for node in graph["nodes"] if node["id"] == chunk_node_id("a", 2))
        self.assertEqual((node["type"], node["chunk"], node["page"]), ("chunk", 2, 3))
        self.assertEqual(
            sorted((edge["source"], edge["target"]) for edge in edges_with(graph, "contains")),
            [("document:a", chunk_node_id("a", 1)), ("document:a", chunk_node_id("a", 2))],
        )

    def test_mentions_link_chunks_from_different_documents_to_one_reference(self):
        graph = build_chunk_graph([
            chunk("a", 1, "O Termo Aditivo nº 02 reduziu a frota."),
            chunk("b", 1, "Frota cancelada pelo Aditivo 02."),
        ])

        references = [node for node in graph["nodes"] if node["type"] == "reference"]
        self.assertEqual([node["label"] for node in references], ["Aditivo 02"])
        mentions = edges_with(graph, "mentions")
        self.assertEqual(len(mentions), 2)
        self.assertEqual({edge["target"] for edge in mentions}, {references[0]["id"]})
        evidence = mentions[0]["evidence"][0]
        self.assertIn("Aditivo", evidence["excerpt"])
        self.assertIn(evidence["chunk"], (1,))

    def test_document_codes_cite_other_files_but_not_the_own_file(self):
        graph = build_chunk_graph([
            chunk("d16", 1, "doc_id: D16. O risco constava no relatório (ver D18).", "D16_auditoria.pdf"),
            chunk("d18", 1, "doc_id: D18. Relatório geotécnico.", "D18_geotecnico.md"),
        ])

        cites = edges_with(graph, "cites")
        self.assertEqual([(edge["source"], edge["target"]) for edge in cites],
                         [(chunk_node_id("d16", 1), "document:d18")])

    def test_similarity_links_top_neighbors_from_other_documents_only(self):
        chunks = [
            chunk("a", 1, "a1"),
            chunk("a", 2, "a2"),
            chunk("b", 1, "b1"),
            chunk("c", 1, "c1"),
        ]
        embeddings = [
            [1.0, 0.0, 0.0],
            [0.99, 0.14, 0.0],   # quase igual a a1, mas do mesmo documento
            [0.95, 0.31, 0.0],   # parecido com a1 e a2
            [0.0, 0.0, 1.0],     # sem relação
        ]

        graph = build_chunk_graph(chunks, embeddings)

        similar = edges_with(graph, "similar_to")
        pairs = {frozenset((edge["source"], edge["target"])) for edge in similar}
        self.assertNotIn(frozenset((chunk_node_id("a", 1), chunk_node_id("a", 2))), pairs)
        self.assertIn(frozenset((chunk_node_id("a", 2), chunk_node_id("b", 1))), pairs)
        self.assertTrue(all(chunk_node_id("c", 1) not in pair for pair in pairs))
        self.assertTrue(all(0 < edge["weight"] <= 1 for edge in similar))
        self.assertTrue(all(len(edge["evidence"]) == 2 for edge in similar))

    def test_without_embeddings_there_is_no_similarity(self):
        graph = build_chunk_graph([chunk("a", 1, "x"), chunk("b", 1, "y")])

        self.assertEqual(edges_with(graph, "similar_to"), [])


class AttachChunkEvidenceTests(unittest.TestCase):
    def test_title_evidence_gets_the_chunk_that_contains_the_title(self):
        graph = {
            "nodes": [],
            "edges": [{
                "id": "e", "source": "x", "target": "y", "label": "project",
                "evidence": [
                    {"document_id": "a", "document_name": "a.md", "title": "Item  dois"},
                    {"document_id": "a", "document_name": "a.md", "title": "Ausente"},
                ],
            }],
        }

        result = attach_chunk_evidence(graph, [
            chunk("a", 1, "## Item um"),
            chunk("a", 2, "Base\n\n## item dois\n\ntexto", page=4),
        ])

        first, missing = result["edges"][0]["evidence"]
        self.assertEqual((first["chunk"], first["page"]), (2, 4))
        self.assertNotIn("chunk", missing)
        self.assertNotIn("chunk", graph["edges"][0]["evidence"][0])


class AnswerSubgraphTests(unittest.TestCase):
    def setUp(self):
        self.graph = build_chunk_graph(
            [
                chunk("a", 1, "Assinado o Aditivo 02."),
                chunk("b", 1, "Outro texto."),
                chunk("c", 1, "Nada a ver."),
            ],
            [[1.0, 0.0], [0.97, 0.24], [0.0, 1.0]],
        )

    def test_keeps_edges_whose_evidence_comes_from_retrieved_chunks(self):
        subgraph = graph_relationships_for_chunks(self.graph, [chunk("a", 1, "Assinado o Aditivo 02.")])

        labels = sorted(edge["label"] for edge in subgraph["edges"])
        self.assertEqual(labels, ["contains", "mentions", "similar_to"])
        similar = edges_with(subgraph, "similar_to")[0]
        self.assertEqual(len(similar["evidence"]), 2)
        self.assertIn(chunk_node_id("b", 1), {node["id"] for node in subgraph["nodes"]})

    def test_prompt_context_skips_structural_edges(self):
        subgraph = graph_relationships_for_chunks(self.graph, [chunk("a", 1, "Assinado o Aditivo 02.")])

        context = build_relationship_context(subgraph)

        self.assertEqual(context.splitlines(), [
            "[Relationship: a · trecho 1 --mentions--> Aditivo 02; item: chunk 1; source: a.md]"
        ])


class GraphEndpointTests(unittest.TestCase):
    def test_graph_endpoint_returns_the_chunk_layer(self):
        client = TestClient(app)
        with tempfile.TemporaryDirectory() as directory, \
                patch("app.retrieval.vector_store.VECTOR_STORE_PATH", Path(directory) / "vectors.sqlite3"), \
                patch("app.retrieval.vector_store._embed_contents",
                      side_effect=lambda texts: [[1.0, float(index)] for index, _ in enumerate(texts)]):
            client.post("/index", json={"documents": [
                {"id": "d1", "name": "D01_a.md", "content": "# A\n\nO Aditivo 02 alterou o prazo (ver D02)."},
                {"id": "d2", "name": "D02_b.txt", "content": "Termo Aditivo nº 02 assinado."},
            ]})
            response = client.get("/graph", params={"document_ids": ["d1", "d2"]})

        self.assertEqual(response.status_code, 200)
        graph = response.json()
        self.assertEqual({node["type"] for node in graph["nodes"]}, {"document", "chunk", "reference"})
        self.assertEqual({edge["label"] for edge in graph["edges"]}, {"contains", "mentions", "cites", "similar_to"})
        mention = next(edge for edge in graph["edges"] if edge["label"] == "mentions")
        self.assertEqual(mention["evidence"][0]["chunk"], 1)


if __name__ == "__main__":
    unittest.main()
