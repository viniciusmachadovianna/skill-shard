import base64
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

os.environ.setdefault("FRONTEND_ORIGIN", "http://localhost:5500")

from fastapi.testclient import TestClient

from app.main import app


class AskDocumentsTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app)

    def test_repository_documents_are_listed_recursively_with_supported_encodings(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            data_directory = Path(temporary_directory)
            (data_directory / "guide.md").write_text("# Guide", encoding="utf-8")
            (data_directory / "nested").mkdir()
            pdf_content = b"%PDF-1.7"
            (data_directory / "nested" / "report.pdf").write_bytes(pdf_content)
            (data_directory / "ignored.bin").write_bytes(b"not a supported document")

            with patch("app.main.DATA_DIRECTORY", data_directory):
                response = self.client.get("/documents")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            response.json(),
            [
                {
                    "id": "repository:guide.md",
                    "name": "guide.md",
                    "content": "# Guide",
                    "encoding": "text",
                },
                {
                    "id": "repository:nested/report.pdf",
                    "name": "nested/report.pdf",
                    "content": base64.b64encode(pdf_content).decode("ascii"),
                    "encoding": "base64",
                },
            ],
        )

    @patch("app.main.index_document_chunks", return_value=2)
    def test_index_endpoint_precomputes_enabled_document_chunks(self, index_document_chunks):
        response = self.client.post(
            "/index",
            json={
                "documents": [
                    {
                        "name": "guide.md",
                        "content": " ".join(f"word{index}" for index in range(160)),
                    }
                ]
            },
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"indexed_chunks": 2})
        chunks = index_document_chunks.call_args.args[0]
        self.assertEqual(len(chunks), 2)
        self.assertEqual(chunks[0]["source"], "guide.md")

    def test_index_endpoint_rejects_documents_without_readable_text(self):
        response = self.client.post(
            "/index",
            json={"documents": [{"name": "empty.md", "content": "   "}]},
        )

        self.assertEqual(response.status_code, 422)
        self.assertIn("No readable text", response.json()["detail"])

    @patch("app.main.index_document_chunks", side_effect=RuntimeError("embedding unavailable"))
    def test_index_endpoint_reports_embedding_failures(self, index_document_chunks):
        response = self.client.post(
            "/index",
            json={"documents": [{"name": "guide.md", "content": "some readable text"}]},
        )

        self.assertEqual(response.status_code, 502)
        self.assertIn("Document indexing failed", response.json()["detail"])

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
