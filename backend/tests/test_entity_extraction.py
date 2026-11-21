# Testing - Open /backend on terminal: python -m tests.test_entity_extraction
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

os.environ.setdefault("FRONTEND_ORIGIN", "http://localhost:5500")

from app.main import build_relationship_context, graph_relationships_for_chunks
from app.retrieval.chunk_graph import _stable_id, build_chunk_graph, chunk_node_id
from app.retrieval.entity_extraction import (
    build_entity_graph,
    build_prompt,
    extract_missing,
    load_extractions,
    load_schema,
    response_schema,
    validate_extraction,
)
from app.retrieval.entity_graph import merge_document_graphs

SCHEMA = load_schema()


def chunk(document_id: str, number: int, text: str) -> dict:
    return {"document_id": document_id, "source": f"{document_id}.md", "chunk": number, "page": None, "text": text}


def entity(entity_id: str, name: str, entity_type: str, aliases=None) -> dict:
    return {"id": entity_id, "name": name, "type": entity_type, "aliases": aliases or []}


def relation(source: str, relation_type: str, target: str, evidence: str, **qualifiers) -> dict:
    return {"source": source, "type": relation_type, "target": target, "evidence": evidence, "qualifiers": qualifiers}


class PromptTests(unittest.TestCase):
    def test_response_schema_restricts_types_to_the_schema(self):
        schema = response_schema(SCHEMA)
        entity_enum = schema["properties"]["entities"]["items"]["properties"]["type"]["enum"]
        relation_enum = schema["properties"]["relations"]["items"]["properties"]["type"]["enum"]

        self.assertEqual(entity_enum, ["pessoa", "organizacao", "local", "documento", "evento", "ativo"])
        self.assertIn("outra", relation_enum)
        self.assertNotIn("conceito", entity_enum)

    def test_prompt_contains_rules_types_and_the_chunk(self):
        prompt = build_prompt(chunk("d1", 2, "Helena Prado assinou."), SCHEMA)

        self.assertIn("Ricardo Menezes' e 'Ricardo Meneses'", prompt)
        self.assertIn("- ocupa_cargo (pessoa -> organizacao)", prompt)
        self.assertIn("Documento: d1.md, trecho 2", prompt)
        self.assertIn("Helena Prado assinou.", prompt)


class ValidateExtractionTests(unittest.TestCase):
    text = (
        "Presidente da CTMSC de janeiro de 2021 a 15 de março de 2024. "
        "Assinado por **Helena Prado** (CTMSC) e Marcos Teixeira – TransAurora."
    )

    def validate(self, relations, entities=None):
        raw = {
            "entities": entities or [
                entity("e1", "Helena Prado", "pessoa"),
                entity("e2", "CTMSC", "organizacao"),
                entity("e3", "Aditivo 01", "documento"),
            ],
            "relations": relations,
        }
        return validate_extraction(raw, chunk("d", 1, self.text), SCHEMA)

    def test_accepts_a_grounded_relation_and_keeps_allowed_qualifiers(self):
        result = self.validate([
            relation("e1", "ocupa_cargo", "e2", "Presidente da CTMSC de janeiro de 2021",
                     cargo="presidente", fim="2024-03-15", inventado="x"),
        ])

        self.assertEqual(result["dropped"], {})
        self.assertEqual(result["relations"][0]["qualifiers"], {"cargo": "presidente", "fim": "2024-03-15"})

    def test_evidence_matching_ignores_markdown_case_quotes_and_dashes(self):
        result = self.validate([
            relation("e1", "assina", "e3", 'assinado por helena prado (ctmsc) e marcos teixeira - transaurora'),
            relation("e1", "assina", "e3", "Assinado por Helena Prado ... Marcos Teixeira"),
        ])

        self.assertEqual(len(result["relations"]), 2)

    def test_drops_invalid_relations_and_counts_each_reason(self):
        result = self.validate([
            relation("e1", "ocupa_cargo", "e2", "texto que não está no trecho"),
            relation("e1", "ocupa_cargo", "e9", "Presidente da CTMSC"),
            relation("e2", "ocupa_cargo", "e1", "Presidente da CTMSC"),
            relation("e1", "voa_para", "e2", "Presidente da CTMSC"),
            relation("e1", "ocupa_cargo", "e2", ""),
            relation("e1", "outra", "e2", "Presidente da CTMSC"),
            relation("e1", "ocupa_cargo", "e1", "Presidente da CTMSC"),
        ])

        self.assertEqual(result["relations"], [])
        self.assertEqual(result["dropped"], {
            "relation_evidence_not_in_chunk": 1,
            "relation_unknown_entity": 1,
            "relation_type_constraint": 1,
            "relation_unknown_type": 1,
            "relation_missing_evidence": 1,
            "relation_other_without_description": 1,
            "relation_self_loop": 1,
        })

    def test_drops_entities_with_unknown_type_or_repeated_id(self):
        result = self.validate([], entities=[
            entity("e1", "Helena Prado", "pessoa"),
            entity("e1", "Outra", "pessoa"),
            entity("e2", "headway", "conceito"),
            entity("e3", "  ", "local"),
        ])

        self.assertEqual([item["name"] for item in result["entities"]], ["Helena Prado"])
        self.assertEqual(result["dropped"], {"entity_duplicate_id": 1, "entity_invalid_type_or_name": 2})

    def test_dates_and_values_are_not_entities(self):
        result = self.validate([], entities=[
            entity("e1", "15/12/2025", "evento"),
            entity("e2", "R$ 5,3 bi", "documento"),
            entity("e3", "incidente de 14/08/2023", "evento"),
        ])

        self.assertEqual([item["name"] for item in result["entities"]], ["incidente de 14/08/2023"])
        self.assertEqual(result["dropped"], {"entity_date_or_number": 2})

    def test_acronym_in_parentheses_becomes_an_alias(self):
        result = self.validate([], entities=[
            entity("e1", "Companhia de Transportes Metropolitanos de Serra Clara (CTMSC)", "organizacao"),
        ])

        self.assertEqual(
            (result["entities"][0]["name"], result["entities"][0]["aliases"]),
            ("Companhia de Transportes Metropolitanos de Serra Clara", ["CTMSC"]),
        )


class EntityGraphTests(unittest.TestCase):
    def extraction(self, entities, relations=()):
        return {"entities": entities, "relations": list(relations), "dropped": {}}

    def test_declared_alias_merges_names_across_chunks(self):
        graph = build_entity_graph([
            (chunk("d1", 1, "x"), self.extraction([
                entity("e1", "Companhia de Transportes Metropolitanos de Serra Clara", "organizacao", ["CTMSC"]),
            ])),
            (chunk("d2", 1, "y"), self.extraction([entity("e1", "CTMSC", "organizacao")])),
        ])

        organizations = [node for node in graph["nodes"] if node["type"] == "organizacao"]
        self.assertEqual(len(organizations), 1)
        self.assertEqual(
            {organizations[0]["label"], *organizations[0]["aliases"]},
            {"CTMSC", "Companhia de Transportes Metropolitanos de Serra Clara"},
        )

    def test_similar_person_names_stay_separate(self):
        graph = build_entity_graph([
            (chunk("d13", 1, "x"), self.extraction([entity("e1", "Ricardo Menezes", "pessoa")])),
            (chunk("d26", 1, "y"), self.extraction([entity("e1", "Ricardo Meneses", "pessoa")])),
            (chunk("d11", 1, "z"), self.extraction([entity("e1", "ricardo  MENEZES", "pessoa")])),
        ])

        people = sorted(node["label"] for node in graph["nodes"] if node["type"] == "pessoa")
        self.assertEqual(len(people), 2)
        self.assertIn("Ricardo Meneses", people)

    def test_numbered_acts_share_the_node_found_by_the_chunk_layer(self):
        chunks = [chunk("d4", 1, "Termo Aditivo nº 02 assinado.")]
        entity_graph = build_entity_graph([
            (chunks[0], self.extraction([entity("e1", "Termo Aditivo nº 02", "documento")])),
        ])
        merged = merge_document_graphs([build_chunk_graph(chunks), entity_graph])

        acts = [node for node in merged["nodes"] if node["type"] == "documento"]
        self.assertEqual([(node["id"], node["label"]) for node in acts],
                         [(_stable_id("reference", "aditivo:2"), "Aditivo 02")])

    def test_names_that_only_cite_an_act_do_not_become_the_act(self):
        graph = build_entity_graph([
            (chunk("d6", 1, "x"), self.extraction([
                entity("e1", "Plano Diretor de Obras (revisão pós Aditivo 01)", "documento"),
                entity("e2", "Termo Aditivo nº 01 ao Contrato 014/2021", "documento"),
                entity("e3", "Aditivo 01", "documento"),
            ])),
        ])

        act = _stable_id("reference", "aditivo:1")
        self.assertEqual(
            sorted(node["label"] for node in graph["nodes"] if node["id"] == act),
            ["Aditivo 01"],
        )
        self.assertEqual(len(graph["nodes"]), 3)

    def test_relations_keep_qualifiers_per_source_document(self):
        incident = entity("e1", "incidente de 14/08/2023", "evento")
        tbm = entity("e2", "TBM Tatuí", "ativo")
        graph = build_entity_graph([
            (chunk("d15", 1, "x"), self.extraction([incident, tbm], [
                relation("e1", "afeta", "e2", "paralisada", valor="poucas semanas", segundo="CTMSC")])),
            (chunk("d16", 2, "y"), self.extraction([incident, tbm], [
                relation("e1", "afeta", "e2", "paralisada por 74 dias", valor="74 dias")])),
        ])

        affects = [edge for edge in graph["edges"] if edge["label"] == "afeta"]
        self.assertEqual(len(affects), 1)
        self.assertEqual(
            [(item["document_id"], item["qualifiers"]["valor"]) for item in affects[0]["evidence"]],
            [("d15", "poucas semanas"), ("d16", "74 dias")],
        )
        mentions = [edge for edge in graph["edges"] if edge["label"] == "mentions"]
        self.assertIn(chunk_node_id("d16", 2), {edge["source"] for edge in mentions})

    def test_prompt_context_lists_relations_from_retrieved_chunks_with_qualifiers(self):
        retrieved = chunk("d12", 1, "Presidente da CTMSC")
        graph = build_entity_graph([
            (retrieved, self.extraction(
                [entity("e1", "Helena Prado", "pessoa"), entity("e2", "CTMSC", "organizacao")],
                [relation("e1", "ocupa_cargo", "e2", "Presidente da CTMSC", cargo="presidente", fim="2024-03-15")],
            )),
            (chunk("d99", 1, "outro"), self.extraction(
                [entity("e1", "Fulano", "pessoa"), entity("e2", "CTMSC", "organizacao")],
                [relation("e1", "ocupa_cargo", "e2", "outro")],
            )),
        ])

        context = build_relationship_context(graph_relationships_for_chunks(graph, [retrieved]))

        self.assertEqual(context.splitlines(), [
            "[Relationship: Helena Prado --ocupa_cargo--> CTMSC; cargo: presidente; fim: 2024-03-15; "
            "item: chunk 1; source: d12.md]"
        ])


class CacheTests(unittest.TestCase):
    def test_extracts_once_and_validates_on_every_read(self):
        chunks = [chunk("d1", 1, "Helena Prado preside a CTMSC.")]
        raw = {
            "entities": [entity("e1", "Helena Prado", "pessoa"), entity("e2", "CTMSC", "organizacao")],
            "relations": [relation("e1", "ocupa_cargo", "e2", "Helena Prado preside a CTMSC")],
        }
        with tempfile.TemporaryDirectory() as directory, \
                patch("app.config.llm_model", "test-model"), \
                patch("app.retrieval.entity_extraction.call_model", return_value=raw) as call_model:
            store = Path(directory) / "vectors.sqlite3"
            first = extract_missing(store, chunks, log=lambda *_: None)
            second = extract_missing(store, chunks, log=lambda *_: None)
            loaded = load_extractions(store, chunks)
            with patch("app.config.llm_model", "other-model"):
                other_model = load_extractions(store, chunks)

        self.assertEqual((first, second), (1, 0))
        self.assertEqual(call_model.call_count, 1)
        self.assertEqual(len(loaded), 1)
        self.assertEqual(loaded[0][1]["relations"][0]["type"], "ocupa_cargo")
        self.assertEqual(other_model, [])


if __name__ == "__main__":
    unittest.main()
