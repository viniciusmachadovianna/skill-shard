export const API_BASE_URL = 'http://127.0.0.1:8000';

export class ApiError extends Error {
    constructor(status, detail) {
        super(typeof detail === 'string' ? detail : `Response status: ${status}`);
        this.name = 'ApiError';
        this.status = status;
        this.detail = detail;
    }
}

async function fetchJson(path, options) {
    const response = await fetch(`${API_BASE_URL}${path}`, options);
    return { response, result: await response.json() };
}

async function request(path, options) {
    const { response, result } = await fetchJson(path, options);
    if (!response.ok) throw new ApiError(response.status, result.detail);
    return result;
}

export function askQuestion({ question, mode, documentIds, signal }) {
    return request('/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question, mode, document_ids: documentIds }),
        signal
    });
}

export async function fetchReadiness({ refresh = false, signal } = {}) {
    const { response, result } = await fetchJson(
        `/ready${refresh ? '?refresh=true' : ''}`,
        { cache: 'no-store', signal }
    );
    return { ok: response.ok, result };
}

export function listRepositoryDocuments() {
    return request('/documents?include_chunk_counts=true');
}

export function indexDocuments(documents) {
    return request('/index?include_chunk_counts=true', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ documents })
    });
}

export function deleteDocument(id) {
    return request(`/documents?document_id=${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export function getGraph(documentIds = []) {
    const params = new URLSearchParams();
    documentIds.forEach((documentId) => params.append('document_ids', documentId));
    const query = params.toString();
    return request(`/graph${query ? `?${query}` : ''}`);
}
