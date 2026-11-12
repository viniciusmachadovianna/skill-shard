import unittest
from unittest.mock import patch

from app.retrieval.vector_store import retrieve_relevant_chunks


class RetrieveRelevantChunksTests(unittest.TestCase):
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


if __name__ == "__main__":
    unittest.main()
