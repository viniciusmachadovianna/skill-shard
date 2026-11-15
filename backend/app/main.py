import base64
import binascii
import logging
import os
from pathlib import Path
from threading import Lock
from time import monotonic
from typing import Literal

from dotenv import load_dotenv
from google import genai
from google.genai import types
from pypdf.errors import PdfReadError

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from app.generation.llm_client import ask_llm
from app.config import frontend_origin
from app.ingestion.chunker import chunk_text_by_words
from app.ingestion.loader import load_pdf_pages_from_bytes
from app.retrieval.vector_store import (
    MissingIndexedDocumentsError,
    delete_indexed_document,
    get_indexed_document_graph,
    persist_documents,
    retrieve_relevant_chunks,
)


logger = logging.getLogger(__name__)

READY_CACHE_SECONDS = 15
READY_TIMEOUT_MS = 3_000
ASK_TIMEOUT_MS = 45_000
DATA_DIRECTORY = Path(__file__).resolve().parents[2] / "data"
SUPPORTED_REPOSITORY_EXTENSIONS = {".txt", ".md", ".csv", ".json", ".pdf"}

load_dotenv()


class IndexDocument(BaseModel):
    id: str = Field(min_length=1, description="Stable document ID from the knowledge base.")
    name: str = Field(min_length=1, description="Original document filename.")
    content: str = Field(description="Text content or base64-encoded PDF bytes.")
    encoding: Literal["text", "base64"] = Field(
        default="text",
        description="Use base64 for PDF files and text for other supported formats.",
    )


class AskRequest(BaseModel):
    question: str = Field(description="Question to answer.")
    document_ids: list[str] = Field(
        default_factory=list,
        description="IDs of previously indexed enabled documents to search.",
    )
    mode: Literal["llm", "rag", "rag relacional"] = Field(
        default="rag",
        description="Answer directly, use retrieved chunks, or include their entity relationships.",
    )


class IndexRequest(BaseModel):
    documents: list[IndexDocument] = Field(
        default_factory=list,
        description="Enabled knowledge-base documents to index before questions are asked.",
    )


class IndexResponse(BaseModel):
    indexed_chunks: int = Field(ge=0, description="Number of document chunks indexed.")


class GraphNode(BaseModel):
    id: str
    label: str
    type: Literal[
        "document",
        "knowledge_item",
        "document_type",
        "project",
        "product",
        "topic",
        "tag",
    ]


class GraphEvidence(BaseModel):
    document_id: str
    document_name: str
    title: str
    source_url: str | None = None


class GraphEdge(BaseModel):
    id: str
    source: str
    target: str
    label: Literal["contains", "type", "project", "product", "topic", "tag"]
    evidence: list[GraphEvidence]


class GraphResponse(BaseModel):
    nodes: list[GraphNode]
    edges: list[GraphEdge]


class AskResponse(BaseModel):
    mode: Literal["llm", "rag", "rag relacional"]
    answer: str
    graph: GraphResponse | None = None


def graph_relationships_for_chunks(graph: dict, chunks: list[dict]) -> dict:
    matching_items = set()
    normalized_chunks = [
        (
            chunk.get("document_id"),
            " ".join(chunk["text"].casefold().split()),
        )
        for chunk in chunks
    ]

    for edge in graph["edges"]:
        if edge["label"] != "contains":
            continue
        for evidence in edge["evidence"]:
            normalized_title = " ".join(evidence["title"].casefold().split())
            if normalized_title and any(
                document_id == evidence["document_id"] and normalized_title in text
                for document_id, text in normalized_chunks
            ):
                matching_items.add((evidence["document_id"], evidence["title"], edge["target"]))

    matching_titles = {
        (document_id, title)
        for document_id, title, _ in matching_items
    }
    matching_item_ids = {item_id for _, _, item_id in matching_items}
    relevant_edges = []
    for edge in graph["edges"]:
        evidence = [
            item for item in edge["evidence"]
            if (item["document_id"], item["title"]) in matching_titles
        ]
        if evidence and (
            edge["source"] in matching_item_ids
            or edge["target"] in matching_item_ids
        ):
            relevant_edges.append({**edge, "evidence": evidence})

    relevant_node_ids = {
        node_id
        for edge in relevant_edges
        for node_id in (edge["source"], edge["target"])
    }
    return {
        "nodes": [node for node in graph["nodes"] if node["id"] in relevant_node_ids],
        "edges": relevant_edges,
    }


def build_relationship_context(graph: dict) -> str:
    if not graph["edges"]:
        return ""

    nodes_by_id = {node["id"]: node["label"] for node in graph["nodes"]}
    relationships = []
    for edge in graph["edges"]:
        for evidence in edge["evidence"]:
            relationships.append(
                f"[Relationship: {nodes_by_id[edge['source']]} --{edge['label']}--> "
                f"{nodes_by_id[edge['target']]}; item: {evidence['title']}; "
                f"source: {evidence['document_name']}]"
            )
    return "\n".join(dict.fromkeys(relationships))


def count_document_chunks(document: IndexDocument | dict) -> int:
    
    document_data = document.model_dump() if isinstance(document, IndexDocument) else document
    try:
        return len(build_document_chunks([IndexDocument(**document_data)]))
    except ValueError:
        return 0

def build_document_chunks(documents: list[IndexDocument]) -> list[dict]:
    chunks = []
    supported_extensions = {".txt", ".md", ".csv", ".json", ".pdf"}

    for document in documents:
        extension = Path(document.name).suffix.lower()
        if extension not in supported_extensions:
            raise ValueError(f"{document.name}: file type is not supported.")

        pages = []
        if extension == ".pdf":
            if document.encoding != "base64":
                raise ValueError(
                    f"{document.name}: remove and add this PDF again before using it."
                )
            try:
                pdf_content = base64.b64decode(document.content, validate=True)
                pages = load_pdf_pages_from_bytes(pdf_content, document.name)
            except (binascii.Error, ValueError, PdfReadError) as error:
                raise ValueError(f"{document.name}: could not read this PDF ({error}).") from error
        else:
            if document.encoding != "text":
                raise ValueError(f"{document.name}: invalid text encoding.")
            pages = [{"page": None, "text": document.content, "source_file": document.name}]

        chunk_index = 0
        for page in pages:
            # for text in chunk_text_by_words(page["text"]):
            for piece in chunk_text_by_words(page["text"], page["source_file"]):
                chunk_index += 1
                chunks.append(
                    {
                        # "text": text,
                        "text": piece["text"],
                        "source": document.name,
                        "page": page["page"],
                        "chunk": chunk_index,
                        "document_id": document.id,
                    }
                )

    return chunks


def load_repository_documents(include_chunk_counts: bool = False) -> list[dict]:
    data_directory = DATA_DIRECTORY.resolve()
    documents = []

    for path in sorted(data_directory.rglob("*")):
        if not path.is_file() or path.suffix.lower() not in SUPPORTED_REPOSITORY_EXTENSIONS:
            continue

        resolved_path = path.resolve()
        try:
            relative_path = resolved_path.relative_to(data_directory)
        except ValueError:
            continue

        name = relative_path.as_posix()
        if path.suffix.lower() == ".pdf":
            content = base64.b64encode(resolved_path.read_bytes()).decode("ascii")
            encoding = "base64"
        else:
            content = resolved_path.read_text(encoding="utf-8")
            encoding = "text"

        document = {
            "id": f"repository:{name}",
            "name": name,
            "content": content,
            "encoding": encoding,
        }
        if include_chunk_counts:
            document["chunk_count"] = count_document_chunks(document)
        documents.append(document)

    return documents


app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=frontend_origin.split(","),
    allow_methods=["GET", "POST", "DELETE"],
    allow_headers=["Content-Type"],
)

api_key = os.getenv("LLM_API_KEY")
llm_model = os.getenv("LLM_MODEL_ID")
client = genai.Client(
    api_key=api_key,
    http_options=types.HttpOptions(timeout=ASK_TIMEOUT_MS),
)
readiness_client: genai.Client | None = None
ready_cache_until: float = 0.0
readiness_lock = Lock()

@app.get("/health")
def health():
    return {"status": "ok"}


@app.get("/documents")
def list_repository_documents(include_chunk_counts: bool = Query(default=False)):
    return load_repository_documents(include_chunk_counts=include_chunk_counts)


@app.get(
    "/graph",
    response_model=GraphResponse,
    response_model_exclude_none=True,
)
def get_graph(
    document_ids: list[str] | None = Query(
        default=None,
        description="Optional IDs of indexed documents to include in the graph.",
    ),
) -> GraphResponse:
    if document_ids and any(not document_id.strip() for document_id in document_ids):
        raise HTTPException(status_code=422, detail="Document IDs must not be empty.")

    try:
        return get_indexed_document_graph(document_ids)
    except MissingIndexedDocumentsError as error:
        raise HTTPException(
            status_code=409,
            detail="One or more requested documents are not indexed.",
        ) from error


@app.post("/index")
def index_documents(request: IndexRequest, include_chunk_counts: bool = Query(default=False)):
    document_ids = [document.id for document in request.documents]
    if len(document_ids) != len(set(document_ids)):
        raise HTTPException(status_code=422, detail="Document IDs must be unique.")

    try:
        chunks = build_document_chunks(request.documents)
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error

    if request.documents and not chunks:
        raise HTTPException(
            status_code=422,
            detail="No readable text was found in the enabled documents. Scanned PDFs require OCR.",
        )

    try:
        indexed_chunks = persist_documents(
            [document.model_dump() for document in request.documents],
            chunks,
        )
    except Exception:
        logger.exception("Document indexing failed.")
        raise HTTPException(
            status_code=502,
            detail="Document indexing failed. Check the embedding model connection and retry.",
        ) from None

    response = {"indexed_chunks": indexed_chunks}
    if include_chunk_counts:
        response["chunk_counts"] = {
            document.id: sum(1 for chunk in chunks if chunk["document_id"] == document.id)
            for document in request.documents
        }
    return response


@app.delete("/documents")
def delete_document(document_id: str = Query(min_length=1)):
    try:
        delete_indexed_document(document_id)
    except Exception:
        logger.exception("Document deletion failed.")
        raise HTTPException(
            status_code=500,
            detail="Document deletion failed. Check the local document database and retry.",
        ) from None

    return {"deleted": True}


@app.get("/ready")
def ready(refresh: bool = False):
    global readiness_client, ready_cache_until

    if not api_key or not llm_model:
        raise HTTPException(
            status_code=503,
            detail={"ready": False, "reason": "configuration_missing"},
        )

    with readiness_lock:
        if not refresh and ready_cache_until > monotonic():
            return {"ready": True, "cached": True}

        try:
            if readiness_client is None:
                readiness_client = genai.Client(
                    api_key=api_key,
                    http_options=types.HttpOptions(timeout=READY_TIMEOUT_MS),
                )
            readiness_client.models.get(model=llm_model)
        except Exception:
            ready_cache_until = 0.0
            logger.exception("Gemini readiness check failed.")
            raise HTTPException(
                status_code=503,
                detail={"ready": False, "reason": "model_unavailable"},
            ) from None

        ready_cache_until = monotonic() + READY_CACHE_SECONDS
        return {"ready": True, "cached": False}

@app.post("/ask", response_model=AskResponse)
def ask(request: AskRequest) -> AskResponse:
    context = None
    sources = []
    graph = None

    if request.mode != "llm":
        if not request.document_ids:
            raise HTTPException(
                status_code=422,
                detail="Enable at least one document for RAG modes.",
            )
        try:
            relevant_chunks = retrieve_relevant_chunks(request.question, request.document_ids)
        except MissingIndexedDocumentsError as error:
            raise HTTPException(
                status_code=409,
                detail="One or more enabled documents are not indexed. Reopen the app to index them and retry.",
            ) from error
        except Exception:
            logger.exception("Document retrieval failed.")
            raise HTTPException(
                status_code=502,
                detail="Document search failed. Check the embedding model connection and retry.",
            ) from None

        if not relevant_chunks:
            raise HTTPException(
                status_code=409,
                detail="No indexed chunks are available for the enabled documents.",
            )

        context_parts = []
        for chunk in relevant_chunks:
            page_label = f", page {chunk['page']}" if chunk["page"] is not None else ""
            context_parts.append(
                f"[Source: {chunk['source']}{page_label}, chunk {chunk['chunk']}]\n"
                f"{chunk['text']}"
            )
        context = "\n\n".join(context_parts)
        sources = list(dict.fromkeys(
            (chunk["source"], chunk["page"])
            for chunk in relevant_chunks
        ))

        if request.mode == "rag relacional":
            relevant_document_ids = list(dict.fromkeys(
                chunk["document_id"]
                for chunk in relevant_chunks
                if chunk.get("document_id")
            ))
            if relevant_document_ids:
                try:
                    indexed_graph = get_indexed_document_graph(relevant_document_ids)
                except MissingIndexedDocumentsError as error:
                    raise HTTPException(
                        status_code=409,
                        detail="One or more retrieved documents are not indexed.",
                    ) from error
                except Exception:
                    logger.exception("Entity relationship retrieval failed.")
                    raise HTTPException(
                        status_code=502,
                        detail="Entity relationship search failed. Check the local document database and retry.",
                    ) from None

                graph = graph_relationships_for_chunks(indexed_graph, relevant_chunks)
            else:
                graph = {"nodes": [], "edges": []}
            relationship_context = build_relationship_context(graph)
            if relationship_context:
                context = f"{context}\n\nRelevant entity relationships:\n{relationship_context}"

    try:
        answer = ask_llm(request.question, context)
    except Exception:
        logger.exception("Gemini request failed.")
        raise HTTPException(
            status_code=502,
            detail="The model request failed. Check its connection and retry.",
        ) from None

    if not answer:
        raise HTTPException(
            status_code=502,
            detail="The model returned an empty response.",
        )

    if sources:
        citations = [
            f"- {name}" if page is None else f"- {name}, page {page}"
            for name, page in sources
        ]
        answer = f"{answer}\n\nSources consulted / Fontes consultadas:\n" + "\n".join(citations)

    return AskResponse(mode=request.mode, answer=answer, graph=graph)