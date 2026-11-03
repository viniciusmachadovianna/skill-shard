import { $, $$ } from './utils.js';
import { t } from './language.js';

const composer = $('#composer');
const workArea = $('#work-area');
const promptInput = $('#prompt-input');
const conversationOutput = $('#conversation-output');
const exportButton = $('#export-button');
const sendButton = $('.send-button');
const responseLoader = $('#response-loader');
let pendingRequestController;

function addMessage(label, message, className = '') {
    const article = document.createElement('article');
    article.className = `chat-message ${className}`.trim();
    const caption = document.createElement('small');
    caption.textContent = label;
    const body = document.createElement('div');
    body.textContent = message;
    article.append(caption, body);
    conversationOutput.append(article);
}

export function cancelPendingResponse() {
    pendingRequestController?.abort();
    pendingRequestController = undefined;
    responseLoader.hidden = true;
    conversationOutput.removeAttribute('aria-busy');
    sendButton.disabled = false;
}

export function clearChat() {
    cancelPendingResponse();
    conversationOutput.replaceChildren();
    promptInput.value = '';
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

    composer.addEventListener('submit', async (event) => {
        event.preventDefault();
        const message = promptInput.value.trim();
        if (!message) {
            promptInput.focus();
            return;
        }
        if (pendingRequestController) return;

        addMessage('OPERATOR / SS-800', message);
        promptInput.value = '';
        const controller = new AbortController();
        pendingRequestController = controller;
        sendButton.disabled = true;
        responseLoader.hidden = false;
        conversationOutput.setAttribute('aria-busy', 'true');

        try {
            const answer = await ask(message, controller.signal);
            if (controller.signal.aborted) return;
            addMessage('SS-800 / SYSTEM', answer, 'assistant-reply');
        } catch (error) {
            if (controller.signal.aborted) return;
            console.error('Unable to get an answer from the API:', error);
            addMessage('SS-800 / SYSTEM', t('request-failed'), 'assistant-reply');
        } finally {
            if (pendingRequestController === controller) {
                pendingRequestController = undefined;
                sendButton.disabled = false;
                responseLoader.hidden = true;
                conversationOutput.removeAttribute('aria-busy');
            }
            scrollToLatestMessage();
        }
    });

    document.querySelector('.scroll-cue').addEventListener('click', () => {
        composer.scrollIntoView({ behavior: 'smooth', block: 'center' });
        promptInput.focus({ preventScroll: true });
    });

    exportButton.addEventListener('click', () => exportConversation(onEmptyExport));
}
