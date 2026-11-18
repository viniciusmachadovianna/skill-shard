/**
 * @file Acesso ao backend: todas as chamadas HTTP do frontend passam por este módulo.
 *
 * A URL base e o tratamento de erros HTTP ficam centralizados aqui. O módulo só
 * transporta dados: quem chama valida o conteúdo das respostas.
 */

/**
 * Modo de resposta aceito por `/ask`: `llm` (sem documentos), `rag` (trechos
 * recuperados) ou `graphrag` (trechos mais as relações entre entidades).
 * @typedef {'llm' | 'rag' | 'graphrag'} RetrievalMode
 */

/**
 * Documento enviado para indexação.
 * @typedef {Object} IndexDocument
 * @property {string} id Identificador estável do documento.
 * @property {string} name Nome do arquivo.
 * @property {string} content Texto do arquivo ou, no caso de PDF, os bytes em base64.
 * @property {'text' | 'base64'} encoding Formato de `content`.
 */

/** URL base do backend (servidor local iniciado com `uvicorn`). */
export const API_BASE_URL = 'http://127.0.0.1:8000';

/**
 * Erro lançado quando o backend responde com um status de falha (4xx ou 5xx).
 *
 * A mensagem é o campo `detail` da resposta quando ele é um texto; caso
 * contrário, `Response status: <código>`.
 */
export class ApiError extends Error {
    /**
     * @param {number} status Código HTTP da resposta.
     * @param {unknown} detail Campo `detail` do corpo da resposta (texto, objeto ou lista).
     */
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

/**
 * Envia uma pergunta ao endpoint `POST /ask`.
 *
 * @param {Object} options
 * @param {string} options.question Pergunta do usuário.
 * @param {RetrievalMode} options.mode Modo de resposta.
 * @param {string[]} options.documentIds IDs dos documentos ativados (vazio no modo `llm`).
 * @param {AbortSignal} [options.signal] Permite cancelar a requisição.
 * @returns {Promise<{mode: RetrievalMode, answer: string, graph: (Object | null)}>}
 *     Resposta do modelo; `graph` só vem preenchido no modo `graphrag`.
 * @throws {ApiError} Se o backend responder com erro.
 */
export function askQuestion({ question, mode, documentIds, signal }) {
    return request('/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question, mode, document_ids: documentIds }),
        signal
    });
}

/**
 * Consulta `GET /ready` para saber se o backend consegue responder perguntas.
 *
 * Diferente das outras funções, não lança erro quando o backend responde 503:
 * o corpo da resposta traz o motivo (`configuration_missing` ou
 * `model_unavailable`) e quem chama precisa dele. A resposta nunca vem do
 * cache do navegador. Falhas de rede e cancelamentos continuam sendo lançados.
 *
 * @param {Object} [options]
 * @param {boolean} [options.refresh=false] Ignora o cache de 15 segundos do backend.
 * @param {AbortSignal} [options.signal] Permite cancelar a requisição.
 * @returns {Promise<{ok: boolean, result: any}>} `ok` indica status HTTP de
 *     sucesso; `result` é o corpo da resposta já convertido de JSON.
 */
export async function fetchReadiness({ refresh = false, signal } = {}) {
    const { response, result } = await fetchJson(
        `/ready${refresh ? '?refresh=true' : ''}`,
        { cache: 'no-store', signal }
    );
    return { ok: response.ok, result };
}

/**
 * Lista os documentos da pasta `data/` do repositório (`GET /documents`).
 *
 * @returns {Promise<Array<IndexDocument & {chunk_count: number}>>} Documentos
 *     com a quantidade de trechos em que cada um seria dividido.
 * @throws {ApiError} Se o backend responder com erro.
 */
export function listRepositoryDocuments() {
    return request('/documents?include_chunk_counts=true');
}

/**
 * Envia documentos para indexação (`POST /index`).
 *
 * @param {IndexDocument[]} documents Documentos ativados na base de conhecimento.
 * @returns {Promise<{indexed_chunks: number, chunk_counts: Record<string, number>}>}
 *     Total de trechos indexados e a contagem por documento (chave: ID).
 * @throws {ApiError} 422 se um documento for inválido ou não tiver texto
 *     legível; 502 se a geração de embeddings falhar.
 */
export function indexDocuments(documents) {
    return request('/index?include_chunk_counts=true', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ documents })
    });
}

/**
 * Pede os trechos em que um documento é dividido na indexação (`POST /chunks`).
 *
 * @param {IndexDocument} document Documento a dividir.
 * @returns {Promise<{chunks: Array<{chunk: number, page: (number | null), text: string}>}>}
 * @throws {ApiError} 422 se o documento for inválido.
 */
export function getDocumentChunks({ id, name, content, encoding }) {
    return request('/chunks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, name, content, encoding: encoding ?? 'text' })
    });
}

/**
 * Remove um documento indexado do backend (`DELETE /documents`).
 *
 * @param {string} id ID do documento.
 * @returns {Promise<{deleted: boolean}>}
 * @throws {ApiError} Se o backend responder com erro.
 */
export function deleteDocument(id) {
    return request(`/documents?document_id=${encodeURIComponent(id)}`, { method: 'DELETE' });
}

/**
 * Busca o grafo de relações entre entidades (`GET /graph`).
 *
 * @param {string[]} [documentIds=[]] Documentos a incluir; vazio inclui todos os indexados.
 * @returns {Promise<{nodes: Object[], edges: Object[]}>} O grafo; o formato
 *     completo está no tipo `Graph`, em `entity-graph.js`.
 * @throws {ApiError} 409 se algum documento pedido não estiver indexado.
 */
export function getGraph(documentIds = []) {
    const params = new URLSearchParams();
    documentIds.forEach((documentId) => params.append('document_ids', documentId));
    const query = params.toString();
    return request(`/graph${query ? `?${query}` : ''}`);
}
