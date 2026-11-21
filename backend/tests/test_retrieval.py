# Testing - Open /backend on terminal: python -m tests.test_retrieval
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from app.retrieval import vector_store
from app.retrieval.vector_store import (
    delete_indexed_document,
    persist_documents,
    retrieve_relevant_chunks,
)


class RetrieveRelevantChunksTests(unittest.TestCase):
    def setUp(self):
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.vector_store_path = Path(self.temporary_directory.name) / "vectors.sqlite3"
        self.vector_store_path_patch = patch(
            "app.retrieval.vector_store.VECTOR_STORE_PATH",
            self.vector_store_path,
        )
        self.vector_store_path_patch.start()

    def tearDown(self):
        self.vector_store_path_patch.stop()
        self.temporary_directory.cleanup()

    @patch("app.retrieval.vector_store._embed_contents")
    def test_returns_most_similar_chunks_first(self, embed_contents):
        embed_contents.side_effect = [
            [[1.0, 0.0], [0.0, 1.0], [0.8, 0.2]],
            [[1.0, 0.0]],
        ]
        documents = [
            {"id": "a", "name": "a.txt", "content": "first", "encoding": "text"},
            {"id": "b", "name": "b.txt", "content": "second", "encoding": "text"},
            {"id": "c", "name": "c.txt", "content": "third", "encoding": "text"},
        ]
        chunks = [
            {"text": "first", "source": "a.txt", "page": None, "chunk": 1, "document_id": "a"},
            {"text": "second", "source": "b.txt", "page": None, "chunk": 1, "document_id": "b"},
            {"text": "third", "source": "c.txt", "page": None, "chunk": 1, "document_id": "c"},
        ]
        persist_documents(documents, chunks)

        results = retrieve_relevant_chunks("question", ["a", "b", "c"], top_k=2)

        self.assertEqual([chunk["text"] for chunk in results], ["first", "third"])
        self.assertGreater(results[0]["score"], results[1]["score"])

    def _persist_three_documents(self, embed_contents):
        embed_contents.side_effect = [
            [[1.0, 0.0], [0.9, 0.1], [0.5, 0.5]],
            [[1.0, 0.0]],
        ]
        texts = {
            "a": "Cronograma geral da obra",
            "b": "Visão geral do projeto",
            "c": "Termo Aditivo 02 altera o prazo",
        }
        persist_documents(
            [
                {"id": key, "name": f"{key}.txt", "content": text, "encoding": "text"}
                for key, text in texts.items()
            ],
            [
                {"text": text, "source": f"{key}.txt", "page": None, "chunk": 1, "document_id": key}
                for key, text in texts.items()
            ],
        )

    @patch("app.retrieval.vector_store._embed_contents")
    def test_hybrid_search_promotes_exact_keyword_matches(self, embed_contents):
        self._persist_three_documents(embed_contents)

        results = retrieve_relevant_chunks("O que diz o Aditivo 02?", ["a", "b", "c"])

        self.assertEqual([chunk["source"] for chunk in results], ["c.txt", "a.txt", "b.txt"])
        self.assertGreater(results[0]["keyword_score"], 0)
        self.assertEqual(results[1]["keyword_score"], 0)
        self.assertLess(results[0]["score"], results[1]["score"])

    @patch("app.retrieval.vector_store.RETRIEVAL_STRATEGY", "dense")
    @patch("app.retrieval.vector_store._embed_contents")
    def test_dense_strategy_ignores_keywords(self, embed_contents):
        self._persist_three_documents(embed_contents)

        results = retrieve_relevant_chunks("O que diz o Aditivo 02?", ["a", "b", "c"])

        self.assertEqual([chunk["source"] for chunk in results], ["a.txt", "b.txt", "c.txt"])

    @patch("app.retrieval.vector_store._embed_contents")
    def test_empty_chunks_do_not_call_embedding_service(self, embed_contents):
        self.assertEqual(retrieve_relevant_chunks("question", []), [])
        embed_contents.assert_not_called()

    @patch("app.retrieval.vector_store._embed_contents", return_value=[[1.0, 0.0]])
    def test_index_persists_original_document_and_reuses_vector(self, embed_contents):
        documents = [
            {"id": "a", "name": "a.txt", "content": "first", "encoding": "text"},
        ]
        chunks = [
            {
                "text": "first",
                "source": "a.txt",
                "page": None,
                "chunk": 1,
                "document_id": "a",
            },
        ]

        self.assertEqual(persist_documents(documents, chunks), 1)
        self.assertEqual(persist_documents(documents, chunks), 1)
        results = retrieve_relevant_chunks("question", ["a"])

        self.assertEqual(results[0]["text"], "first")
        embed_contents.assert_any_call(["first"])
        self.assertEqual(embed_contents.call_count, 2)

    @patch("app.retrieval.vector_store._embed_contents", return_value=[[1.0, 0.0]])
    def test_unchanged_index_does_not_write_to_sqlite_again(self, embed_contents):
        documents = [
            {"id": "a", "name": "a.txt", "content": "first", "encoding": "text"},
        ]
        chunks = [
            {
                "text": "first",
                "source": "a.txt",
                "page": None,
                "chunk": 1,
                "document_id": "a",
            },
        ]

        with patch(
            "app.retrieval.vector_store._store_embeddings",
            wraps=vector_store._store_embeddings,
        ) as store_embeddings:
            persist_documents(documents, chunks)
            persist_documents(documents, chunks)

        store_embeddings.assert_called_once()
        embed_contents.assert_called_once_with(["first"])

    @patch("app.retrieval.vector_store._embed_contents")
    def test_updates_persisted_document_chunks_and_removes_deleted_documents(self, embed_contents):
        embed_contents.side_effect = [
            [[1.0, 0.0]],
            [[0.0, 1.0]],
            [[1.0, 0.0]],
        ]
        document = {"id": "a", "name": "a.txt", "content": "first version", "encoding": "text"}
        first_chunk = {
            "text": "first version",
            "source": "a.txt",
            "page": None,
            "chunk": 1,
            "document_id": "a",
        }
        updated_document = {**document, "content": "updated version"}
        updated_chunk = {**first_chunk, "text": "updated version"}

        persist_documents([document], [first_chunk])
        persist_documents([document], [first_chunk])
        persist_documents([updated_document], [updated_chunk])
        results = retrieve_relevant_chunks("question", ["a"])
        delete_indexed_document("a")

        self.assertEqual(results[0]["text"], "updated version")
        self.assertEqual(embed_contents.call_count, 3)
        with self.assertRaises(ValueError):
            retrieve_relevant_chunks("question", ["a"])
        self.assertTrue(self.vector_store_path.is_file())


if __name__ == "__main__":
    unittest.main()
