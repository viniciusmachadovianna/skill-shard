/**
 * @file Chat: envio de perguntas, exibição das mensagens e estado da conexão.
 *
 * Responsabilidades:
 * - enviar a pergunta ao backend no modo escolhido (`llm`, `rag` ou
 *   `graphrag`), com os IDs dos documentos ativados e nunca o conteúdo;
 * - exibir as mensagens, com um renderizador de Markdown simples (títulos,
 *   listas, blocos de código, negrito, itálico, código em linha e links
 *   http/https);
 * - verificar se o backend e o modelo estão prontos e refletir isso no
 *   indicador de status e no botão de envio;
 * - exportar a conversa como arquivo de texto.
 */

import { $, $$ } from './utils.js';
import * as api from './api.js';
import { t, onLanguageChange } from './language.js';
import { showToast } from './toast.js';
import { getEnabledDocuments } from './knowledge-base.js';

const composer = $('#composer');
const workArea = $('#work-area');
const welcomeContent = $('.welcome-content');
const promptInput = $('#prompt-input');
const retrievalMode = $('#retrieval-mode');
// Cada conversa guarda suas mensagens em um elemento próprio no DOM; só o da
// conversa ativa fica visível. O elemento original da página fica sempre
// vazio e serve de "sem conversa". `conversationOutput` aponta para o visível.
const emptyConversationOutput = $('#conversation-output');
const conversationOutputs = new Map();
let conversationOutput = emptyConversationOutput;
const scrollCue = $('.scroll-cue');
const backendStatus = $('#backend-status');
const backendStatusText = $('#backend-status-text');
const backendRetryButton = $('#backend-retry');
const backendLed = $('#backend-led');
const composerActions = $('.composer-actions');
const exportButton = $('#export-button');
const workspaceHeading = $('.workspace-heading');
const messageCount = $('#workspace-message-count');
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

function addMessage(label, message, className = '', mode = '') {
    const article = document.createElement('article');
    article.className = `chat-message ${className}`.trim();
    if (mode) article.dataset.retrievalMode = mode;
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
    if (className.includes('assistant-reply')) {
        const copyButton = document.createElement('button');
        copyButton.type = 'button';
        copyButton.className = 'copy-message';
        copyButton.title = t('copy-message');
        copyButton.setAttribute('aria-label', t('copy-message'));
        copyButton.dataset.i18nTitle = 'copy-message';
        copyButton.dataset.i18nAria = 'copy-message';
        copyButton.addEventListener('click', async () => {
            await navigator.clipboard.writeText(message);
            showToast(t('message-copied'));
        });
        caption.append(copyButton);
    }
    const body = document.createElement('div');
    body.innerHTML = className.includes('assistant-reply') ? renderMarkdown(message) : escapeHtml(message);
    article.append(caption, body);
    conversationOutput.append(article);
    updateExportButton();
    scrollToLatestMessage();
}

/**
 * Cancela a pergunta em andamento: aborta a requisição, esconde o indicador de
 * carregamento e reabilita o envio se o backend estiver pronto. É seguro
 * chamar sem nenhuma pergunta pendente.
 */
export function cancelPendingResponse() {
    pendingRequestController?.abort();
    pendingRequestController = undefined;
    responseLoader.hidden = true;
    conversationOutput.removeAttribute('aria-busy');
    sendButton.disabled = !backendReady;
    updateScrollCue();
}

/**
 * Cria o espaço de mensagens de uma conversa: um elemento oculto no DOM que
 * guarda as mensagens dela. Ignora IDs já registrados.
 *
 * @param {string} id ID da conversa.
 */
export function createConversationOutput(id) {
    if (conversationOutputs.has(id)) return;
    const output = document.createElement('div');
    output.className = 'conversation-output';
    output.setAttribute('aria-live', 'polite');
    output.dataset.conversationId = id;
    output.hidden = true;
    responseLoader.before(output);
    conversationOutputs.set(id, output);
}

/**
 * Informa se a conversa `id` ainda não tem nenhuma mensagem.
 *
 * @param {string} id ID da conversa.
 * @returns {boolean} `false` também para IDs desconhecidos.
 */
export function isConversationEmpty(id) {
    const output = conversationOutputs.get(id);
    return Boolean(output) && output.childElementCount === 0;
}

function activateOutput(next) {
    if (next === conversationOutput) return;
    cancelPendingResponse();
    conversationOutput.hidden = true;
    next.hidden = false;
    conversationOutput = next;
    welcomeContent.hidden = next.childElementCount > 0;
    updateExportButton();
    updateScrollCue();
}

/**
 * Mostra as mensagens da conversa `id` e esconde as das outras. Uma pergunta
 * pendente é cancelada, porque a resposta pertenceria à conversa anterior.
 * Sem mensagens, a tela de boas-vindas volta; o campo de texto não muda.
 *
 * @param {string} id ID de uma conversa criada com `createConversationOutput`.
 */
export function showConversation(id) {
    const next = conversationOutputs.get(id);
    if (next) activateOutput(next);
}

/**
 * Remove do DOM as mensagens da conversa `id`. Se ela era a visível, o chat
 * volta para a tela de boas-vindas, sem conversa, até outra ser mostrada.
 *
 * @param {string} id ID da conversa removida.
 */
export function removeConversation(id) {
    const output = conversationOutputs.get(id);
    if (!output) return;
    if (output === conversationOutput) {
        activateOutput(emptyConversationOutput);
        promptInput.value = '';
    }
    conversationOutputs.delete(id);
    output.remove();
}

/**
 * Limpa a conversa: cancela a pergunta pendente, remove as mensagens, volta à
 * tela de boas-vindas e esvazia o campo de texto.
 */
export function clearChat() {
    cancelPendingResponse();
    conversationOutput.replaceChildren();
    welcomeContent.hidden = false;
    promptInput.value = '';
    updateExportButton();
    updateScrollCue();
}

async function ask(question, mode, documentIds, signal) {
    const result = await api.askQuestion({ question, mode, documentIds, signal });

    const answer = result.answer;
    if (typeof answer !== 'string' || !answer.trim()) {
        throw new Error(t('api-invalid-answer'));
    }

    if (result.mode !== mode) {
        throw new Error(t('api-mode-mismatch'));
    }

    return { answer, graph: result.graph };
}

function scrollToLatestMessage() {
    workArea.scrollTo({ top: workArea.scrollHeight, behavior: 'smooth' });
}

function updateExportButton() {
    const count = conversationOutput.childElementCount;
    exportButton.disabled = count === 0;
    workspaceHeading.hidden = count === 0;
    messageCount.textContent = t(count === 1 ? 'message-count-one' : 'message-count-many')
        .replace('{count}', String(count));
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
        const { ok, result } = await api.fetchReadiness({ refresh, signal: controller.signal });
        const reason = result.detail?.reason ?? result.reason;

        if (ok && result.ready) {
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
        const mode = message.dataset.retrievalMode ? ` (${message.dataset.retrievalMode})` : '';
        return `[${timestamp}] ${label}${mode}:\n\n${body}`;
    });
    if (!messages.length) {
        onEmptyExport();
        return;
    }

    const file = new Blob([messages.join('\n\n\n')], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(file);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'skill-shard.txt';
    link.click();
    URL.revokeObjectURL(url);
}

/**
 * Liga o chat à página: cartões de objetivo, envio com Enter (Shift+Enter
 * quebra a linha), rolagem, botão de nova verificação, formulário de envio e
 * exportação. Também inicia a primeira verificação do backend (`GET /ready`).
 * Deve ser chamada uma vez.
 *
 * @param {Object} callbacks
 * @param {() => void} callbacks.onEmptyExport Chamada quando o usuário pede
 *     para exportar uma conversa sem mensagens.
 * @param {() => void} callbacks.ensureConversation Chamada antes de enviar uma
 *     pergunta quando não há conversa ativa; deve criar e ativar uma.
 * @param {(graph: Object) => void} callbacks.onRelationalResponse Chamada
 *     depois de uma resposta bem-sucedida no modo `graphrag`, com o subgrafo
 *     devolvido pelo backend.
 * @returns {{
 *     setKnowledgeIndexStatus: (status: 'loading' | 'ready' | 'error') => void,
 *     setRetryKnowledgeIndex: (retry: () => void) => void
 * }} Funções para a base de conhecimento informar o andamento da indexação (o
 *     chat só libera o envio quando ela termina) e registrar o que fazer
 *     quando o usuário pedir uma nova tentativa.
 */
export function initializeChat({ onEmptyExport, onRelationalResponse, ensureConversation }) {
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
    updateExportButton();
    onLanguageChange(updateExportButton);
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

        if (conversationOutput === emptyConversationOutput) ensureConversation?.();
        welcomeContent.hidden = true;
        addMessage(t('message-operator'), message, 'user-prompt');
        promptInput.value = '';
        const controller = new AbortController();
        pendingRequestController = controller;
        sendButton.disabled = true;
        responseLoader.hidden = false;
        conversationOutput.setAttribute('aria-busy', 'true');
        updateScrollCue();

        const mode = retrievalMode.value;
        const modeLabel = retrievalMode.selectedOptions[0].textContent.trim();
        try {
            const documents = mode === 'llm' ? [] : await getEnabledDocuments();
            const documentIds = documents.map((document) => document.id);
            const result = await ask(message, mode, documentIds, controller.signal);
            if (controller.signal.aborted) return;
            markBackendReady();
            addMessage(t('message-system'), result.answer, 'assistant-reply', modeLabel);
            if (mode === 'graphrag') onRelationalResponse?.(result.graph);
        } catch (error) {
            if (controller.signal.aborted) return;
            console.error('Unable to get an answer from the API:', error);
            const detail = error instanceof Error ? `\n${error.message}` : '';
            addMessage(t('message-system'), `${t('request-failed')}${detail}`, 'assistant-reply', modeLabel);
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
