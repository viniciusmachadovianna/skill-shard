import os
import unittest
from unittest.mock import patch

os.environ.setdefault("FRONTEND_ORIGIN", "http://localhost:5500")

from fastapi.testclient import TestClient

from app.main import app


class AskDocumentsTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app)

    @patch("app.main.ask_llm", return_value="Grounded answer.")
    @patch("app.main.retrieve_relevant_chunks")
    def test_enabled_documents_are_retrieved_and_cited(
        self,
        retrieve_relevant_chunks,
        ask_llm,
    ):
        retrieve_relevant_chunks.return_value = [
            {
                "text": "The project started in 2024.",
                "source": "project.txt",
                "page": None,
                "chunk": 1,
                "score": 1.0,
            }
        ]

        response = self.client.post(
            "/ask",
            json={
                "question": "When did the project start?",
                "documents": [
                    {
                        "name": "project.txt",
                        "content": "The project started in 2024.",
                        "encoding": "text",
                    }
                ],
            },
        )

        self.assertEqual(response.status_code, 200)
        self.assertIn("project.txt", response.json())
        retrieve_relevant_chunks.assert_called_once()
        self.assertIn("The project started in 2024.", ask_llm.call_args.args[1])

    @patch("app.main.ask_llm", return_value="General answer.")
    @patch("app.main.retrieve_relevant_chunks")
    def test_requests_without_documents_keep_plain_llm_behavior(
        self,
        retrieve_relevant_chunks,
        ask_llm,
    ):
        response = self.client.post("/ask", json={"question": "A general question"})

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), "General answer.")
        ask_llm.assert_called_once_with("A general question", None)
        retrieve_relevant_chunks.assert_not_called()

    def test_existing_pdf_records_must_be_added_again(self):
        response = self.client.post(
            "/ask",
            json={
                "question": "What is in this PDF?",
                "documents": [
                    {
                        "name": "report.pdf",
                        "content": "old browser-decoded content",
                    }
                ],
            },
        )

        self.assertEqual(response.status_code, 422)
        self.assertIn("remove and add this PDF again", response.json()["detail"])


if __name__ == "__main__":
    unittest.main()
