import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from app.retrieval.vector_store import index_document_chunks, retrieve_relevant_chunks


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
        chunks = [
            {"text": "first", "source": "a.txt", "page": None, "chunk": 1},
            {"text": "second", "source": "b.txt", "page": None, "chunk": 1},
            {"text": "third", "source": "c.txt", "page": None, "chunk": 1},
        ]

        results = retrieve_relevant_chunks("question", chunks, top_k=2)

        self.assertEqual([chunk["text"] for chunk in results], ["first", "third"])
        self.assertGreater(results[0]["score"], results[1]["score"])

    @patch("app.retrieval.vector_store._embed_contents")
    def test_empty_chunks_do_not_call_embedding_service(self, embed_contents):
        self.assertEqual(retrieve_relevant_chunks("question", []), [])
        embed_contents.assert_not_called()

    @patch("app.retrieval.vector_store._embed_contents", return_value=[[1.0, 0.0]])
    def test_index_persists_vectors_without_embedding_a_question(self, embed_contents):
        chunks = [
            {"text": "first", "source": "a.txt", "page": None, "chunk": 1},
        ]

        self.assertEqual(index_document_chunks(chunks), 1)
        self.assertEqual(index_document_chunks(chunks), 1)

        embed_contents.assert_called_once_with(["first"])

    @patch("app.retrieval.vector_store._embed_contents")
    def test_reuses_persisted_embeddings_and_reembeds_changed_chunks(self, embed_contents):
        embed_contents.side_effect = [
            [[1.0, 0.0]],
            [[1.0, 0.0]],
            [[0.0, 1.0]],
            [[1.0, 0.0]],
            [[1.0, 0.0]],
        ]
        chunks = [
            {"text": "first version", "source": "a.txt", "page": None, "chunk": 1},
        ]

        retrieve_relevant_chunks("question", chunks)
        retrieve_relevant_chunks("question", chunks)
        updated_chunks = [{**chunks[0], "text": "updated version"}]
        retrieve_relevant_chunks("question", updated_chunks)

        self.assertEqual(embed_contents.call_count, 5)
        self.assertTrue(self.vector_store_path.is_file())


if __name__ == "__main__":
    unittest.main()
