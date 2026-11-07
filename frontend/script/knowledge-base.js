import { t } from './language.js';

const DATABASE_NAME = 'skill-shard-knowledge-base';
const DATABASE_VERSION = 1;
const STORE_NAME = 'documents';
const MAX_FILE_SIZE = 2 * 1024 * 1024;
const SUPPORTED_EXTENSIONS = new Set(['txt', 'md', 'csv', 'json', 'pdf']);

const dialog = document.querySelector('#knowledge-dialog');
const knowledgeButton = document.querySelector('#knowledge-button');
const closeButton = document.querySelector('#knowledge-close');
const addButton = document.querySelector('#add-documents');
const fileInput = document.querySelector('#file-input');
const documentList = document.querySelector('#knowledge-document-list');
const emptyState = document.querySelector('#knowledge-empty');
const summary = document.querySelector('#knowledge-summary');
const documentCount = document.querySelector('#document-count');
const sourceMetric = document.querySelector('#source-metric');

let databasePromise;

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

function formatSummary(count) {
    return t('knowledge-summary').replace('{count}', String(count));
}

function updateDocumentCounters(documents) {
    const enabledCount = documents.filter((document) => document.enabled).length;
    documentCount.textContent = String(enabledCount);
    sourceMetric.textContent = `${String(enabledCount).padStart(2, '0')} ${t(enabledCount === 1 ? 'document-singular' : 'document-plural')}`;
    summary.textContent = formatSummary(documents.length);
    documentList.hidden = documents.length === 0;
    emptyState.hidden = documents.length !== 0;
}

function createDocumentRow(document) {
    const row = documentList.ownerDocument.createElement('li');
    row.className = 'knowledge-document';
    row.dataset.documentId = document.id;

    const icon = documentList.ownerDocument.createElement('span');
    icon.className = 'knowledge-document-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = '▤';

    const name = documentList.ownerDocument.createElement('span');
    name.className = 'knowledge-document-name';
    name.textContent = document.name;
    name.title = document.name;

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

    const deleteButton = documentList.ownerDocument.createElement('button');
    deleteButton.className = 'knowledge-delete';
    deleteButton.type = 'button';
    deleteButton.setAttribute('aria-label', t('delete-document').replace('{name}', document.name));
    deleteButton.title = t('delete-document-title');
    const deleteIcon = documentList.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'svg');
    deleteIcon.setAttribute('viewBox', '0 0 20 20');
    deleteIcon.setAttribute('aria-hidden', 'true');
    const deletePath = documentList.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'path');
    deletePath.setAttribute('d', 'M6 6h8l-.7 11H6.7L6 6Zm-2-2h12M8 4V2.8h4V4m-3.8 4.5v5.5m3.6-5.5v5.5');
    deleteIcon.append(deletePath);
    deleteButton.append(deleteIcon);

    row.append(icon, name, toggleLabel, deleteButton);
    return row;
}

async function renderDocuments() {
    const documents = await getDocuments();
    documentList.replaceChildren(...documents.map(createDocumentRow));
    updateDocumentCounters(documents);
    return documents;
}

function reportStorageError(error, showToast) {
    console.error('Could not update the local knowledge base:', error);
    showToast(t('knowledge-storage-error'));
}

export function initializeKnowledgeBase({ showToast }) {
    async function refreshDocuments() {
        try {
            await renderDocuments();
        } catch (error) {
            reportStorageError(error, showToast);
        }
    }

    function openDialog() {
        if (!dialog.open) dialog.showModal();
        refreshDocuments();
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
                await saveDocument({
                    id: window.crypto.randomUUID(),
                    name: file.name,
                    content: await file.text(),
                    enabled: true
                });
                addedCount += 1;
            } catch (error) {
                reportStorageError(error, showToast);
                break;
            }
        }

        fileInput.value = '';
        await refreshDocuments();

        if (errors.length) showToast(errors.join(' '));
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
            await refreshDocuments();
        } catch (error) {
            reportStorageError(error, showToast);
            await refreshDocuments();
        }
    });

    documentList.addEventListener('click', async (event) => {
        if (!(event.target instanceof Element)) return;
        const deleteButton = event.target.closest('.knowledge-delete');
        const row = deleteButton?.closest('.knowledge-document');
        if (!row) return;

        try {
            await removeDocument(row.dataset.documentId);
            await refreshDocuments();
            showToast(t('document-deleted'));
        } catch (error) {
            reportStorageError(error, showToast);
        }
    });

    refreshDocuments();
}
