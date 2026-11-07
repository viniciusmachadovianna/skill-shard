import { $, $$ } from './utils.js';
import { t } from './language.js';

const composer = $('#composer');
const workArea = $('#work-area');
const welcomeContent = $('.welcome-content');
const promptInput = $('#prompt-input');
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

function addMessage(label, message, className = '') {
    const article = document.createElement('article');
    article.className = `chat-message ${className}`.trim();
    const caption = document.createElement('small');
    caption.textContent = label;
    const body = document.createElement('div');
    body.textContent = message;
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

async function ask(question, signal) {
    const response = await fetch('http://127.0.0.1:8000/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question }),
        signal
    });

    if (!response.ok) {
        throw new Error(`Response status: ${response.status}`);
    }

    const answer = await response.json();
    if (typeof answer !== 'string' || !answer.trim()) {
        throw new Error('The API returned an invalid answer.');
    }

    return answer;
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
    backendStatus.classList.toggle('is-unavailable', !backendReady);
    backendStatusText.dataset.i18n = backendReady ? 'awaiting-input' : key;
    backendStatusText.textContent = t(backendReady ? 'awaiting-input' : key);
    backendLed.classList.toggle('status-led-blue', backendReady);
    backendLed.classList.toggle('status-led-red', !backendReady);
    backendActionsState();
}

function backendActionsState() {
    composerActions.classList.toggle('is-unavailable', !backendReady);
    promptInput.disabled = !backendReady;
    sendButton.disabled = !backendReady || Boolean(pendingRequestController);
    backendRetryButton.hidden = backendReady || backendStatusText.dataset.i18n === 'backend-checking';
}

function markBackendReady() {
    readinessController?.abort();
    readinessController = undefined;
    setBackendStatus('backend-ready');
}

async function checkBackendReadiness({ refresh = false } = {}) {
    readinessController?.abort();
    const controller = new AbortController();
    readinessController = controller;
    const timeout = window.setTimeout(() => controller.abort(), 5_000);
    backendRetryButton.disabled = true;
    setBackendStatus('backend-checking');

    try {
        const response = await fetch(
            `http://127.0.0.1:8000/ready${refresh ? '?refresh=true' : ''}`,
            { cache: 'no-store', signal: controller.signal }
        );
        const result = await response.json();
        const reason = result.detail?.reason ?? result.reason;

        if (response.ok && result.ready) {
            setBackendStatus('backend-ready');
        } else if (reason === 'configuration_missing') {
            setBackendStatus('backend-config-missing');
        } else {
            setBackendStatus('backend-model-unavailable');
        }
    } catch (error) {
        if (readinessController !== controller) return;
        setBackendStatus(controller.signal.aborted
            ? 'backend-check-timeout'
            : 'backend-unavailable');
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
        const [label, ...body] = message.innerText.split('\n');
        return `${label}\n${body.join('\n')}`;
    });
    if (!messages.length) {
        onEmptyExport();
        return;
    }

    const file = new Blob([messages.join('\n\n')], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(file);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'deviant-investigation.txt';
    link.click();
    URL.revokeObjectURL(url);
}

export function initializeChat({ onEmptyExport }) {
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
    setBackendStatus('backend-checking');
    backendRetryButton.addEventListener('click', () => checkBackendReadiness({ refresh: true }));
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
            const answer = await ask(message, controller.signal);
            if (controller.signal.aborted) return;
            markBackendReady();
            addMessage('SS-800 / SYSTEM', answer, 'assistant-reply');
        } catch (error) {
            if (controller.signal.aborted) return;
            console.error('Unable to get an answer from the API:', error);
            addMessage('SS-800 / SYSTEM', t('request-failed'), 'assistant-reply');
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
}
