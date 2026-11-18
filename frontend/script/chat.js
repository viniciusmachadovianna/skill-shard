import { $, $$ } from './utils.js';
import { t } from './language.js';
import { getEnabledDocuments } from './knowledge-base.js';

const composer = $('#composer');
const workArea = $('#work-area');
const welcomeContent = $('.welcome-content');
const promptInput = $('#prompt-input');
const retrievalMode = $('#retrieval-mode');
const conversationOutput = $('#conversation-output');
const scrollCue = $('.scroll-cue');
const backendStatus = $('#backend-status');
const backendStatusText = $('#backend-status-text');
const backendRetryButton = $('#backend-retry');
const backendLed = $('#backend-led');
const composerActions = $('.composer-actions');
const exportButton = $('#export-button');
const sendButton = $('.send-button');
const responseLoader = $('#response-loader');
let pendingRequestController;
let readinessController;
let backendReady = false;
let modelReady = false;
let modelStatus = 'backend-checking';
let knowledgeIndexStatus = 'loading';
let retryKnowledgeIndex = () => {};

function escapeHtml(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function formatInlineMarkdown(value) {
    let html = escapeHtml(value);
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
    html = html.replace(/(\*\*|__)(.+?)\1/g, '<strong>$2</strong>');
    html = html.replace(/(\*|_)(.+?)\1/g, '<em>$2</em>');
    html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
        '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
    return html;
}

function renderMarkdown(markdown) {
    const blocks = String(markdown ?? '').replace(/\r/g, '').split(/\n{2,}/).filter((block) => block.trim());
    if (!blocks.length) return '<p></p>';

    return blocks.map((block) => {
        const trimmed = block.trim();

        if (trimmed.startsWith('```')) {
            const code = trimmed
                .replace(/^```[^\n]*\n/, '')
                .replace(/```$/, '')
                .trim();
            return `<pre><code>${escapeHtml(code)}</code></pre>`;
        }

        if (/^#{1,6}\s+/.test(trimmed)) {
            const match = trimmed.match(/^(#{1,6})\s+/);
            const level = match[1].length;
            const text = formatInlineMarkdown(trimmed.slice(match[0].length));
            return `<h${level}>${text}</h${level}>`;
        }

        const lines = trimmed.split('\n');
        const hasListItems = lines.length > 0 && lines.every((line) => /^([-*]|\d+\.)\s+/.test(line.trim()));
        if (hasListItems) {
            const ordered = lines.every((line) => /^\d+\.\s+/.test(line.trim()));
            const listType = ordered ? 'ol' : 'ul';
            const items = lines.map((line) => {
                const item = line.trim().replace(/^(?:[-*]|\d+\.)\s+/, '');
                return `<li>${formatInlineMarkdown(item)}</li>`;
            }).join('');
            return `<${listType}>${items}</${listType}>`;
        }

        return `<p>${formatInlineMarkdown(trimmed)}</p>`;
    }).join('');
}

function addMessage(label, message, className = '') {
    const article = document.createElement('article');
    article.className = `chat-message ${className}`.trim();
    const caption = document.createElement('small');
    const messageLabel = document.createElement('span');
    messageLabel.textContent = label;
    const timestamp = new Date();
    const time = document.createElement('time');
    time.dateTime = timestamp.toISOString();
    time.textContent = new Intl.DateTimeFormat(document.documentElement.lang, {
        hour: 'numeric',
        minute: '2-digit'
    }).format(timestamp);
    caption.append(messageLabel, time);
    const body = document.createElement('div');
    body.innerHTML = className.includes('assistant-reply') ? renderMarkdown(message) : escapeHtml(message);
    article.append(caption, body);
    conversationOutput.append(article);
    scrollToLatestMessage();
}

export function cancelPendingResponse() {
    pendingRequestController?.abort();
    pendingRequestController = undefined;
    responseLoader.hidden = true;
    conversationOutput.removeAttribute('aria-busy');
    sendButton.disabled = !backendReady;
    updateScrollCue();
}

export function clearChat() {
    cancelPendingResponse();
    conversationOutput.replaceChildren();
    welcomeContent.hidden = false;
    promptInput.value = '';
    updateScrollCue();
}

async function ask(question, mode, documentIds, signal) {
    const response = await fetch('http://127.0.0.1:8000/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question, mode, document_ids: documentIds }),
        signal
    });

    const result = await response.json();
    if (!response.ok) {
        throw new Error(typeof result.detail === 'string'
            ? result.detail
            : `Response status: ${response.status}`);
    }

    const answer = result.answer;
    if (typeof answer !== 'string' || !answer.trim()) {
        throw new Error('The API returned an invalid answer.');
    }

    if (result.mode !== mode) {
        throw new Error('The API returned a response for a different retrieval mode.');
    }

    return { answer, graph: result.graph };
}

function scrollToLatestMessage() {
    workArea.scrollTo({ top: workArea.scrollHeight, behavior: 'smooth' });
}

function updateScrollCue() {
    const cueHeight = scrollCue.offsetHeight || 34;
    scrollCue.style.top = `${Math.max(0, workArea.clientHeight - cueHeight - 5)}px`;
    scrollCue.hidden = conversationOutput.childElementCount === 0
        || workArea.scrollTop + workArea.clientHeight >= workArea.scrollHeight - 1;
}

function setBackendStatus(key) {
    backendReady = key === 'backend-ready';
    const isLoading = ['backend-checking', 'indexing-documents'].includes(key);
    backendStatus.classList.toggle('is-unavailable', !backendReady && !isLoading);
    backendStatus.classList.toggle('is-loading', isLoading);
    backendStatusText.dataset.i18n = backendReady ? 'awaiting-input' : key;
    backendStatusText.textContent = t(backendReady ? 'awaiting-input' : key);
    backendLed.classList.toggle('status-led-blue', backendReady || isLoading);
    backendLed.classList.toggle('status-led-red', !backendReady && !isLoading);
    backendActionsState();
}

function updateBackendStatus() {
    if (knowledgeIndexStatus === 'loading') {
        setBackendStatus('indexing-documents');
    } else if (modelStatus === 'backend-checking') {
        setBackendStatus(modelStatus);
    } else if (!modelReady) {
        setBackendStatus(modelStatus);
    } else if (knowledgeIndexStatus === 'error') {
        setBackendStatus('indexing-failed');
    } else {
        setBackendStatus('backend-ready');
    }
}

function setKnowledgeIndexStatus(status) {
    knowledgeIndexStatus = status;
    updateBackendStatus();
}

function setRetryKnowledgeIndex(retry) {
    retryKnowledgeIndex = retry;
}

function backendActionsState() {
    composerActions.classList.toggle('is-unavailable', !backendReady);
    promptInput.disabled = !backendReady;
    sendButton.disabled = !backendReady || Boolean(pendingRequestController);
    backendRetryButton.hidden = backendReady
        || ['backend-checking', 'indexing-documents'].includes(backendStatusText.dataset.i18n);
}

function markBackendReady() {
    readinessController?.abort();
    readinessController = undefined;
    modelReady = true;
    modelStatus = 'backend-ready';
    updateBackendStatus();
}

async function checkBackendReadiness({ refresh = false } = {}) {
    readinessController?.abort();
    const controller = new AbortController();
    readinessController = controller;
    const timeout = window.setTimeout(() => controller.abort(), 5_000);
    backendRetryButton.disabled = true;
    modelStatus = 'backend-checking';
    updateBackendStatus();

    try {
        const response = await fetch(
            `http://127.0.0.1:8000/ready${refresh ? '?refresh=true' : ''}`,
            { cache: 'no-store', signal: controller.signal }
        );
        const result = await response.json();
        const reason = result.detail?.reason ?? result.reason;

        if (response.ok && result.ready) {
            modelReady = true;
            modelStatus = 'backend-ready';
        } else if (reason === 'configuration_missing') {
            modelReady = false;
            modelStatus = 'backend-config-missing';
        } else {
            modelReady = false;
            modelStatus = 'backend-model-unavailable';
        }
        updateBackendStatus();
    } catch (error) {
        if (readinessController !== controller) return;
        modelReady = false;
        modelStatus = controller.signal.aborted
            ? 'backend-check-timeout'
            : 'backend-unavailable';
        updateBackendStatus();
    } finally {
        window.clearTimeout(timeout);
        if (readinessController === controller) {
            readinessController = undefined;
            backendRetryButton.disabled = false;
            backendActionsState();
        }
    }
}

function exportConversation(onEmptyExport) {
    const messages = [...conversationOutput.querySelectorAll('.chat-message')].map((message) => {
        const label = message.querySelector('small span').textContent;
        const timestamp = message.querySelector('time').textContent;
        const body = message.querySelector(':scope > div').innerText;
        return `${label} — ${timestamp}\n${body}`;
    });
    if (!messages.length) {
        onEmptyExport();
        return;
    }

    const file = new Blob([messages.join('\n\n')], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(file);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'skill-shard.txt';
    link.click();
    URL.revokeObjectURL(url);
}

export function initializeChat({ onEmptyExport, onRelationalResponse }) {
    $$('.objective-card').forEach((card) => {
        card.addEventListener('click', () => {
            promptInput.value = card.dataset.prompt;
            promptInput.focus();
        });
    });

    promptInput.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
        event.preventDefault();
        composer.requestSubmit();
    });

    window.addEventListener('resize', updateScrollCue);
    workArea.addEventListener('scroll', updateScrollCue);
    updateScrollCue();
    updateBackendStatus();
    backendRetryButton.addEventListener('click', () => {
        if (knowledgeIndexStatus === 'error') retryKnowledgeIndex();
        checkBackendReadiness({ refresh: true });
    });
    checkBackendReadiness();

    composer.addEventListener('submit', async (event) => {
        event.preventDefault();
        const message = promptInput.value.trim();
        if (!message) {
            promptInput.focus();
            return;
        }
        if (!backendReady) {
            checkBackendReadiness({ refresh: true });
            return;
        }
        if (pendingRequestController) return;

        welcomeContent.hidden = true;
        addMessage('OPERATOR / SS-800', message, 'user-prompt');
        promptInput.value = '';
        const controller = new AbortController();
        pendingRequestController = controller;
        sendButton.disabled = true;
        responseLoader.hidden = false;
        conversationOutput.setAttribute('aria-busy', 'true');
        updateScrollCue();

        try {
            const mode = retrievalMode.value;
            const documents = mode === 'llm' ? [] : await getEnabledDocuments();
            const documentIds = documents.map((document) => document.id);
            const result = await ask(message, mode, documentIds, controller.signal);
            if (controller.signal.aborted) return;
            markBackendReady();
            addMessage('SS-800 / SYSTEM', result.answer, 'assistant-reply');
            if (mode === 'graphrag') onRelationalResponse?.(result.graph);
        } catch (error) {
            if (controller.signal.aborted) return;
            console.error('Unable to get an answer from the API:', error);
            const detail = error instanceof Error ? `\n${error.message}` : '';
            addMessage('SS-800 / SYSTEM', `${t('request-failed')}${detail}`, 'assistant-reply');
            checkBackendReadiness({ refresh: true });
        } finally {
            if (pendingRequestController === controller) {
                pendingRequestController = undefined;
                sendButton.disabled = !backendReady;
                responseLoader.hidden = true;
                conversationOutput.removeAttribute('aria-busy');
                updateScrollCue();
            }
            scrollToLatestMessage();
        }
    });

    scrollCue.addEventListener('click', () => {
        scrollToLatestMessage();
        promptInput.focus({ preventScroll: true });
    });

    exportButton.addEventListener('click', () => exportConversation(onEmptyExport));

    return { setKnowledgeIndexStatus, setRetryKnowledgeIndex };
}
