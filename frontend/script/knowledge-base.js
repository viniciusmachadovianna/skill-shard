/**
 * @file Base de conhecimento: os documentos que o usuário pode consultar.
 *
 * - Guarda os documentos no navegador, em IndexedDB.
 * - Lista os documentos da pasta `data/` do repositório, que começam
 *   desativados.
 * - Permite adicionar arquivos (TXT, MD, CSV, JSON e PDF, até 2 MB), ativar,
 *   desativar e excluir os que o usuário enviou.
 * - Mostra uma prévia dos documentos ativados.
 * - Mantém o backend sincronizado: quando a seleção muda, os documentos
 *   ativados são enviados para `/index`.
 */

import * as api from './api.js';
import { onLanguageChange, t } from './language.js';
import { $ } from './utils.js';

const DATABASE_NAME = 'skill-shard-knowledge-base';
const DATABASE_VERSION = 1;
const STORE_NAME = 'documents';
const MAX_FILE_SIZE = 2 * 1024 * 1024;
const DOCUMENT_ICON_EXTENSIONS = new Set(['CSV', 'JSON', 'MD', 'PDF', 'TXT']);
const SUPPORTED_EXTENSIONS = new Set(['txt', 'md', 'csv', 'json', 'pdf']);

const dialog = $('#knowledge-dialog');
const knowledgeButton = $('#knowledge-button');
const closeButton = $('#knowledge-close');
const addButton = $('#add-documents');
const fileInput = $('#file-input');
const documentList = $('#knowledge-document-list');
const emptyState = $('#knowledge-empty');
const summary = $('#knowledge-summary');
const knowledgeStatus = $('#knowledge-status');
const searchInput = $('#knowledge-search');
const noResults = $('#knowledge-no-results');
const previewTitle = $('#document-preview-title');
const previewEmpty = $('#assistant-document-empty');
const previewText = $('#assistant-document-text');
const previewPager = $('#assistant-document-pager');
const previewPrevious = $('#assistant-chunk-prev');
const previewNext = $('#assistant-chunk-next');
const previewPosition = $('#assistant-chunk-position');

let databasePromise;
let currentDocuments = [];
let selectedPreviewDocumentId;
let previewChunkIndex = 0;
let previewChunks = [];
const chunkCache = new Map();

function openDatabase() {
    if (!('indexedDB' in window)) {
        return Promise.reject(new Error('This browser does not support local document storage.'));
    }

    if (!databasePromise) {
        databasePromise = new Promise((resolve, reject) => {
            const request = window.indexedDB.open(DATABASE_NAME, DATABASE_VERSION);

            request.onupgradeneeded = () => {
                if (!request.result.objectStoreNames.contains(STORE_NAME)) {
                    request.result.createObjectStore(STORE_NAME, { keyPath: 'id' });
                }
            };
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error ?? new Error('Could not open local document storage.'));
            request.onblocked = () => reject(new Error('Local document storage is blocked by another tab.'));
        }).catch((error) => {
            databasePromise = undefined;
            throw error;
        });
    }

    return databasePromise;
}

async function runTransaction(mode, operation) {
    const database = await openDatabase();

    return new Promise((resolve, reject) => {
        const transaction = database.transaction(STORE_NAME, mode);
        const request = operation(transaction.objectStore(STORE_NAME));
        let result;

        request.onsuccess = () => {
            result = request.result;
        };
        request.onerror = () => reject(request.error ?? new Error('Local document storage request failed.'));
        transaction.oncomplete = () => resolve(result);
        transaction.onerror = () => reject(transaction.error ?? new Error('Local document storage transaction failed.'));
        transaction.onabort = () => reject(transaction.error ?? new Error('Local document storage transaction was aborted.'));
    });
}

function getDocuments() {
    return runTransaction('readonly', (store) => store.getAll());
}

function saveDocument(document) {
    return runTransaction('readwrite', (store) => store.put(document));
}

function removeDocument(id) {
    return runTransaction('readwrite', (store) => store.delete(id));
}

async function removeIndexedDocument(id) {
    await api.deleteDocument(id);
}

async function synchronizeRepositoryDocuments() {
    const repositoryDocuments = await api.listRepositoryDocuments();
    if (!Array.isArray(repositoryDocuments) || repositoryDocuments.some((document) => (
        typeof document.id !== 'string'
        || !document.id.startsWith('repository:')
        || typeof document.name !== 'string'
        || typeof document.content !== 'string'
        || !['text', 'base64'].includes(document.encoding)
        || (document.chunk_count !== undefined && (!Number.isInteger(document.chunk_count) || document.chunk_count < 0))
    ))) {
        throw new Error('The API returned an invalid repository document list.');
    }

    const storedDocuments = await getDocuments();
    const storedRepositoryDocuments = new Map(
        storedDocuments
            .filter((document) => document.source === 'repository')
            .map((document) => [document.id, document])
    );
    const currentIds = new Set();
    let changed = false;

    for (const document of repositoryDocuments) {
        currentIds.add(document.id);
        const storedDocument = storedRepositoryDocuments.get(document.id);
        const chunkCount = Number.isInteger(document.chunk_count) ? document.chunk_count : storedDocument?.chunk_count ?? 0;
        if (
            !storedDocument
            || storedDocument.name !== document.name
            || storedDocument.content !== document.content
            || storedDocument.encoding !== document.encoding
            || storedDocument.chunk_count !== chunkCount
        ) {
            changed = true;
        }
        await saveDocument({
            ...document,
            source: 'repository',
            enabled: storedDocument?.enabled ?? false,
            chunk_count: chunkCount
        });
    }

    for (const [id] of storedRepositoryDocuments) {
        if (!currentIds.has(id)) {
            try {
                await removeIndexedDocument(id);
            } catch (error) {
                console.error('Could not remove a deleted repository document from the backend:', error);
                throw new Error(t('document-backend-delete-error'));
            }
            await removeDocument(id);
            changed = true;
        }
    }

    return changed;
}

function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';

    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    }

    return window.btoa(binary);
}

async function readDocumentFile(file, extension) {
    if (extension === 'pdf') {
        return {
            content: arrayBufferToBase64(await file.arrayBuffer()),
            encoding: 'base64'
        };
    }

    return {
        content: await file.text(),
        encoding: 'text'
    };
}

/**
 * Lê do navegador os documentos que estão ativados.
 *
 * @returns {Promise<Array<{id: string, name: string, content: string, encoding: 'text' | 'base64'}>>}
 *     Documentos no formato aceito pelo backend. Documentos antigos sem
 *     `encoding` são tratados como `'text'`.
 * @throws {Error} Se o armazenamento local do navegador estiver indisponível.
 */
export async function getEnabledDocuments() {
    const documents = await getDocuments();
    return documents
        .filter((document) => document.enabled)
        .map(({ id, name, content, encoding }) => ({
            id,
            name,
            content,
            encoding: encoding ?? 'text'
        }));
}

async function requestDocumentIndex(documents) {
    const result = await api.indexDocuments(documents);
    if (!Number.isInteger(result.indexed_chunks) || result.indexed_chunks < 0) {
        throw new Error('The API returned an invalid document indexing result.');
    }
    if (result.chunk_counts !== undefined && (typeof result.chunk_counts !== 'object' || result.chunk_counts === null)) {
        throw new Error('The API returned an invalid chunk count payload.');
    }

    return result;
}

async function updateDocumentChunkCounts(documents, chunkCounts = {}) {
    if (!documents.length) return;

    const storedDocuments = new Map(
        (await getDocuments()).map((document) => [document.id, document])
    );
    for (const document of documents) {
        const count = Number(chunkCounts[document.id]);
        if (!Number.isInteger(count) || count < 0) continue;
        const storedDocument = storedDocuments.get(document.id);
        if (!storedDocument) {
            throw new Error(`Could not find document ${document.id} while updating its chunk count.`);
        }
        await saveDocument({ ...storedDocument, chunk_count: count });
    }
}

function getDocumentBytes(document) {
    const content = document.content ?? '';
    if (document.encoding === 'base64') {
        const padding = content.endsWith('==') ? 2 : content.endsWith('=') ? 1 : 0;
        return Math.floor(content.length * 3 / 4) - padding;
    }
    return new TextEncoder().encode(content).length;
}

function formatBytes(bytes) {
    const kb = bytes / 1024;
    if (kb < 1024) return `${kb.toFixed(1)} KB`;
    const mb = kb / 1024;
    if (mb < 1024) return `${mb.toFixed(1)} MB`;
    return `${(mb / 1024).toFixed(1)} GB`;
}

function formatSummary(count) {
    return t('knowledge-summary').replace('{count}', String(count));
}

function updateDocumentCounters(documents) {
    const enabledCount = documents.filter((document) => document.enabled).length;
    if (documents.length === 0) {
        knowledgeStatus.textContent = t('knowledge-status-none');
    } else if (enabledCount === 0) {
        knowledgeStatus.textContent = t(documents.length === 1 ? 'knowledge-status-available-one' : 'knowledge-status-available-many')
            .replace('{count}', String(documents.length));
    } else {
        knowledgeStatus.textContent = t('knowledge-status-active')
            .replace('{active}', String(enabledCount))
            .replace('{count}', String(documents.length));
    }
    const totalBytes = documents.reduce((sum, document) => sum + getDocumentBytes(document), 0);
    summary.textContent = `${formatSummary(documents.length)} · ${formatBytes(totalBytes)}`;
    documentList.hidden = documents.length === 0;
    emptyState.hidden = documents.length !== 0;
}

function applyDocumentSearch() {
    const term = searchInput.value.trim().toLocaleLowerCase();
    let visible = 0;
    documentList.querySelectorAll('.knowledge-document').forEach((row) => {
        const matches = !term || row.querySelector('.knowledge-document-name').textContent.toLocaleLowerCase().includes(term);
        row.hidden = !matches;
        if (matches) visible += 1;
    });
    noResults.hidden = !(term && currentDocuments.length > 0 && visible === 0);
}

function createDocumentRow(document) {
    const row = documentList.ownerDocument.createElement('li');
    row.className = 'knowledge-document';
    row.dataset.documentId = document.id;
    row.classList.toggle('is-selected', document.id === selectedPreviewDocumentId);

    const icon = documentList.ownerDocument.createElement('img');
    icon.className = 'knowledge-document-icon';
    const extension = document.name.split('.').pop().toUpperCase();
    icon.src = DOCUMENT_ICON_EXTENSIONS.has(extension)
        ? `assets/icons/file${extension}.svg`
        : 'assets/icons/database.svg';
    icon.alt = '';
    icon.setAttribute('aria-hidden', 'true');

    const copy = documentList.ownerDocument.createElement('div');
    copy.className = 'knowledge-document-copy';

    const name = documentList.ownerDocument.createElement('span');
    name.className = 'knowledge-document-name';
    name.textContent = document.name;
    name.title = document.name;

    const metadata = documentList.ownerDocument.createElement('span');
    metadata.className = 'knowledge-document-meta';
    const chunkCount = Number(document.chunk_count ?? 0);
    metadata.textContent = `${formatBytes(getDocumentBytes(document))} · ${chunkCount} ${t(chunkCount === 1 ? 'chunk-singular' : 'chunk-plural')}`;

    copy.append(name, metadata);

    const toggleLabel = documentList.ownerDocument.createElement('label');
    toggleLabel.className = 'knowledge-switch';
    const toggle = documentList.ownerDocument.createElement('input');
    toggle.type = 'checkbox';
    toggle.checked = document.enabled;
    toggle.setAttribute('aria-label', t('toggle-document').replace('{name}', document.name));
    const toggleTrack = documentList.ownerDocument.createElement('span');
    toggleTrack.className = 'knowledge-switch-track';
    toggleTrack.setAttribute('aria-hidden', 'true');
    toggleLabel.append(toggle, toggleTrack);

    row.append(icon, copy, toggleLabel);
    if (document.source !== 'repository') {
        const deleteButton = documentList.ownerDocument.createElement('button');
        deleteButton.className = 'knowledge-delete';
        deleteButton.type = 'button';
        deleteButton.setAttribute('aria-label', t('delete-document').replace('{name}', document.name));
        deleteButton.title = t('delete-document-title');
        const deleteIcon = documentList.ownerDocument.createElement('img');
        deleteIcon.src = 'assets/icons/delete.svg';
        deleteIcon.alt = '';
        deleteIcon.setAttribute('aria-hidden', 'true');
        deleteButton.append(deleteIcon);
        row.append(deleteButton);
    }
    return row;
}

async function renderDocuments() {
    const documents = await getDocuments();
    currentDocuments = documents;
    documentList.replaceChildren(...documents.map(createDocumentRow));
    updateDocumentCounters(documents);
    applyDocumentSearch();
    renderAssistantPreview(documents);
    return documents;
}

function getDocumentChunks(document) {
    const cacheKey = `${document.id}:${document.content?.length ?? 0}`;
    if (!chunkCache.has(cacheKey)) {
        const request = api.getDocumentChunks(document)
            .then((result) => result.chunks)
            .catch((error) => {
                chunkCache.delete(cacheKey);
                throw error;
            });
        chunkCache.set(cacheKey, request);
    }
    return chunkCache.get(cacheKey);
}

function renderPreviewChunk() {
    const chunk = previewChunks[previewChunkIndex];
    previewText.textContent = chunk.text;
    previewText.scrollTop = 0;
    previewText.hidden = false;
    previewEmpty.hidden = true;
    previewPager.hidden = false;
    previewPosition.textContent = t(chunk.page ? 'chunk-position-page' : 'chunk-position')
        .replace('{current}', String(previewChunkIndex + 1))
        .replace('{total}', String(previewChunks.length))
        .replace('{page}', String(chunk.page ?? ''));
    previewPrevious.disabled = previewChunkIndex === 0;
    previewNext.disabled = previewChunkIndex === previewChunks.length - 1;
}

function showPreviewMessage(key) {
    previewText.hidden = true;
    previewPager.hidden = true;
    previewEmpty.hidden = false;
    previewEmpty.textContent = t(key);
}

async function renderAssistantPreview(documents, { resetChunk = false } = {}) {
    const selectedDocument = documents.find((document) => document.id === selectedPreviewDocumentId);
    if (!selectedDocument) selectedPreviewDocumentId = undefined;
    previewTitle.textContent = selectedDocument?.name ?? t('document-preview-title');
    previewTitle.title = selectedDocument?.name ?? '';

    previewChunks = [];
    if (!selectedDocument) {
        showPreviewMessage('document-preview-empty');
        return;
    }
    if (resetChunk) previewChunkIndex = 0;

    if (selectedDocument.name.toLowerCase().endsWith('.pdf') && selectedDocument.encoding !== 'base64') {
        showPreviewMessage('document-preview-pdf-readd');
        return;
    }

    showPreviewMessage('document-preview-loading');
    const requestedId = selectedDocument.id;
    try {
        const chunks = await getDocumentChunks(selectedDocument);
        if (selectedPreviewDocumentId !== requestedId) return;
        if (!chunks.length) {
            showPreviewMessage('document-preview-no-text');
            return;
        }
        previewChunks = chunks;
        previewChunkIndex = Math.min(previewChunkIndex, chunks.length - 1);
        renderPreviewChunk();
    } catch (error) {
        if (selectedPreviewDocumentId !== requestedId) return;
        console.error('Could not load the document chunks:', error);
        showPreviewMessage('document-preview-error');
    }
}

function stepPreviewChunk(step) {
    const next = previewChunkIndex + step;
    if (next < 0 || next >= previewChunks.length) return;
    previewChunkIndex = next;
    renderPreviewChunk();
}

function reportStorageError(error, showToast) {
    console.error('Could not update the local knowledge base:', error);
    showToast(t('knowledge-storage-error'), 'error');
}

/**
 * Liga a interface da base de conhecimento e inicia a sincronização inicial:
 * carrega os documentos do repositório e indexa os que estão ativados. Também
 * atualiza os textos da lista quando o idioma muda. Deve ser chamada uma vez.
 *
 * @param {Object} callbacks
 * @param {(message: string) => void} callbacks.showToast Mostra uma mensagem ao usuário.
 * @param {(status: 'loading' | 'ready' | 'error') => void} [callbacks.onIndexingState]
 *     Chamada a cada mudança no andamento da indexação.
 * @returns {{ retryIndexing: () => Promise<void> }} `retryIndexing`
 *     sincroniza e indexa de novo; é o que o botão de nova tentativa chama
 *     depois de uma falha.
 */
export function initializeKnowledgeBase({ showToast, onIndexingState = () => {} }) {
    let indexRequestId = 0;

    async function indexEnabledDocuments() {
        const requestId = ++indexRequestId;
        onIndexingState('loading');

        try {
            const documents = await getEnabledDocuments();
            const result = await requestDocumentIndex(documents);
            await updateDocumentChunkCounts(documents, result.chunk_counts ?? {});
            await renderDocuments();
            if (requestId === indexRequestId) onIndexingState('ready');
            return result;
        } catch (error) {
            if (requestId === indexRequestId) onIndexingState('error');
            throw error;
        }
    }

    async function retryIndexing() {
        try {
            await synchronizeRepositoryDocuments();
            await renderDocuments();
            await indexEnabledDocuments();
        } catch (error) {
            console.error('Could not index enabled documents:', error);
            showToast(t('document-indexing-error'), 'error');
        }
    }

    searchInput.addEventListener('input', applyDocumentSearch);
    previewPrevious.addEventListener('click', () => stepPreviewChunk(-1));
    previewNext.addEventListener('click', () => stepPreviewChunk(1));

    async function refreshDocuments({ synchronize = false, index = false } = {}) {
        let repositoryDocumentsChanged = false;
        if (synchronize) {
            try {
                repositoryDocumentsChanged = await synchronizeRepositoryDocuments();
            } catch (error) {
                console.error('Could not load repository documents:', error);
                showToast(t('repository-documents-error'), 'error');
            }
        }

        try {
            await renderDocuments();
        } catch (error) {
            reportStorageError(error, showToast);
            if (index) onIndexingState('error');
            return;
        }

        if (index || repositoryDocumentsChanged) {
            try {
                await indexEnabledDocuments();
            } catch (error) {
                console.error('Could not index enabled documents:', error);
                showToast(t('document-indexing-error'), 'error');
            }
        }
    }

    function openDialog() {
        if (!dialog.open) dialog.showModal();
        refreshDocuments({ synchronize: true });
    }

    knowledgeButton.addEventListener('click', openDialog);
    closeButton.addEventListener('click', () => dialog.close());
    dialog.addEventListener('click', (event) => {
        if (event.target === dialog) dialog.close();
    });

    addButton.addEventListener('click', () => fileInput.click());

    fileInput.addEventListener('change', async () => {
        const files = Array.from(fileInput.files ?? []);
        let addedCount = 0;
        const errors = [];

        for (const file of files) {
            const extension = file.name.split('.').pop()?.toLowerCase();
            if (!extension || !SUPPORTED_EXTENSIONS.has(extension)) {
                errors.push(t('unsupported-document-type').replace('{name}', file.name));
                continue;
            }
            if (file.size > MAX_FILE_SIZE) {
                errors.push(t('document-too-large').replace('{name}', file.name));
                continue;
            }

            try {
                const fileContent = await readDocumentFile(file, extension);
                await saveDocument({
                    id: window.crypto.randomUUID(),
                    name: file.name,
                    ...fileContent,
                    enabled: true
                });
                addedCount += 1;
            } catch (error) {
                reportStorageError(error, showToast);
                break;
            }
        }

        fileInput.value = '';
        await refreshDocuments({ index: true });

        if (errors.length) showToast(errors.join(' '), 'error');
        else if (addedCount) showToast(t('documents-added').replace('{count}', String(addedCount)));
    });

    documentList.addEventListener('change', async (event) => {
        if (!(event.target instanceof HTMLInputElement) || event.target.type !== 'checkbox') return;

        const row = event.target.closest('.knowledge-document');
        if (!row) return;

        try {
            const documents = await getDocuments();
            const document = documents.find((item) => item.id === row.dataset.documentId);
            if (!document) return;
            document.enabled = event.target.checked;
            await saveDocument(document);
            await refreshDocuments({ index: true });
        } catch (error) {
            reportStorageError(error, showToast);
            await refreshDocuments({ index: true });
        }
    });

    documentList.addEventListener('click', async (event) => {
        if (!(event.target instanceof Element)) return;
        const deleteButton = event.target.closest('.knowledge-delete');
        if (!deleteButton) {
            const selectedRow = event.target.closest('.knowledge-document');
            if (!selectedRow || event.target.closest('.knowledge-switch')) return;
            selectedPreviewDocumentId = selectedRow.dataset.documentId;
            documentList.querySelectorAll('.knowledge-document').forEach((item) => {
                item.classList.toggle('is-selected', item === selectedRow);
            });
            renderAssistantPreview(currentDocuments, { resetChunk: true });
            return;
        }
        const row = deleteButton.closest('.knowledge-document');
        if (!row) return;

        try {
            await removeIndexedDocument(row.dataset.documentId);
            await removeDocument(row.dataset.documentId);
            await refreshDocuments({ index: true });
            showToast(t('document-deleted'));
        } catch (error) {
            console.error('Could not delete the document from the local knowledge base:', error);
            showToast(t('document-backend-delete-error'), 'error');
        }
    });

    onIndexingState('loading');
    refreshDocuments({ synchronize: true, index: true });

    onLanguageChange(() => {
        renderDocuments().catch((error) => {
            console.error('Could not refresh the knowledge base after a language change:', error);
        });
    });

    return { retryIndexing };
}
