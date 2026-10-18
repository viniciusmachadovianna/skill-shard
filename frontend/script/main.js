import { applyTheme } from './theme.js';

document.addEventListener('DOMContentLoaded', () => {
    applyTheme();
});

const composer = document.querySelector('#composer');
const promptInput = document.querySelector('#prompt-input');
const conversationOutput = document.querySelector('#conversation-output');
const workArea = document.querySelector('#work-area');
const toast = document.querySelector('#toast');
const fileInput = document.querySelector('#file-input');
const sidebar = document.querySelector('.sidebar');
const assistantPanel = document.querySelector('.assistant-panel');
const sidebarToggle = document.querySelector('.sidebar-toggle');
const assistantToggle = document.querySelector('.assistant-toggle');
const appShell = document.querySelector('.app-shell');
let toastTimeout;
const conversationList = document.querySelector('.sidebar-top');
const conversationCount = document.querySelector('#conversation-count');
const workspaceTitle = document.querySelector('#workspace-title');
const responseLoader = document.querySelector('#response-loader');
let responseTimeout;

export function showToast(message) {
    toast.textContent = message;
    toast.classList.add('visible');
    window.clearTimeout(toastTimeout);
    toastTimeout = window.setTimeout(() => toast.classList.remove('visible'), 3200);
}

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

function syncSidebarState() {
    const leftHidden = sidebar.classList.contains('is-collapsed');
    const rightHidden = assistantPanel.classList.contains('is-collapsed');
    appShell.classList.toggle('sidebar-collapsed', leftHidden);
    appShell.classList.toggle('assistant-collapsed', rightHidden);
    sidebarToggle.textContent = leftHidden ? '⟩' : '⟨';
    sidebarToggle.setAttribute('aria-label', leftHidden ? 'Show workspace sidebar' : 'Hide workspace sidebar');
    sidebarToggle.title = leftHidden ? 'Show workspace sidebar' : 'Hide workspace sidebar';
    assistantToggle.textContent = rightHidden ? '⟨' : '⟩';
    assistantToggle.setAttribute('aria-label', rightHidden ? 'Show assistant panel' : 'Hide assistant panel');
    assistantToggle.title = rightHidden ? 'Show assistant panel' : 'Hide assistant panel';
}

function createConversationEntry(name) {
    const entry = document.createElement('div');
    entry.className = 'conversation-entry';

    const selectButton = document.createElement('button');
    selectButton.type = 'button';
    selectButton.className = 'conversation-item';
    const icon = document.createElement('span');
    icon.className = 'chat-icon';
    icon.textContent = '▱';
    const title = document.createElement('span');
    title.textContent = name;
    selectButton.append(icon, title);

    // const menuToggle = document.createElement('button');
    // menuToggle.type = 'button';
    // menuToggle.className = 'conversation-menu-toggle';
    // menuToggle.setAttribute('aria-label', 'Conversation options');
    // menuToggle.setAttribute('aria-haspopup', 'menu');
    // menuToggle.setAttribute('aria-expanded', 'false');
    // menuToggle.textContent = '···';

    const menu = document.createElement('div');
    menu.className = 'conversation-menu';
    menu.setAttribute('role', 'menu');
    menu.hidden = true;
    // for (const [action, label] of [['rename', 'Rename'], ['delete', 'Delete']]) {
    //     const button = document.createElement('button');
    //     button.type = 'button';
    //     button.setAttribute('role', 'menuitem');
    //     button.dataset.conversationAction = action;
    //     button.textContent = label;
    //     menu.append(button);
    // }

    entry.append(selectButton, menu);
    // entry.append(selectButton, menuToggle, menu);
    return entry;
}

// function closeConversationMenus() {
//     conversationList.querySelectorAll('.conversation-entry').forEach((entry) => {
//         entry.classList.remove('menu-open');
//         entry.querySelector('.conversation-menu').hidden = true;
//         entry.querySelector('.conversation-menu-toggle').setAttribute('aria-expanded', 'false');
//     });
// }

function activateConversation(entry) {
    conversationList.querySelectorAll('.conversation-entry').forEach((item) => {
        item.classList.toggle('active', item === entry);
    });
    workspaceTitle.textContent = entry.querySelector('.conversation-item span:last-child').textContent;
}

function updateConversationCount() {
    conversationCount.textContent = String(conversationList.querySelectorAll('.conversation-entry').length).padStart(2, '0');
}

function cancelPendingResponse() {
    window.clearTimeout(responseTimeout);
    responseTimeout = undefined;
    responseLoader.hidden = true;
    conversationOutput.removeAttribute('aria-busy');
}

document.querySelectorAll('.objective-card').forEach((card) => {
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

composer.addEventListener('submit', (event) => {
    event.preventDefault();
    const message = promptInput.value.trim();
    if (!message) {
        promptInput.focus();
        return;
    }

    addMessage('OPERATOR / RK-900', message);
    promptInput.value = '';
    window.clearTimeout(responseTimeout);
    responseLoader.hidden = false;
    conversationOutput.setAttribute('aria-busy', 'true');
    responseTimeout = window.setTimeout(() => {
        responseLoader.hidden = true;
        responseTimeout = undefined;
        conversationOutput.removeAttribute('aria-busy');
        addMessage(
            'RK-900 / SYSTEM',
            'The interface is ready, but no inference engine is connected yet. Add a retrieval and language-model backend to receive grounded answers.',
            'assistant-reply'
        );
        workArea.scrollTo({ top: workArea.scrollHeight, behavior: 'smooth' });
    }, 1200);
    workArea.scrollTo({ top: workArea.scrollHeight, behavior: 'smooth' });
});

sidebarToggle.addEventListener('click', () => {
    sidebar.classList.toggle('is-collapsed');
    syncSidebarState();
});

assistantToggle.addEventListener('click', () => {
    assistantPanel.classList.toggle('is-collapsed');
    syncSidebarState();
});

syncSidebarState();

conversationList.addEventListener('click', (event) => {
    if (!(event.target instanceof Element)) return;
    const target = event.target;
    const newConversationButton = target.closest('.new-conversation');

    if (newConversationButton) {
        cancelPendingResponse();
        const conversation = createConversationEntry('New investigation');
        conversationList.append(conversation);
        activateConversation(conversation);
        conversationOutput.replaceChildren();
        promptInput.value = '';
        // closeConversationMenus();
        updateConversationCount();
        showToast('New investigation started.');
        return;
    }

    const entry = target.closest('.conversation-entry');
    if (!entry) return;

    const menuToggle = target.closest('.conversation-menu-toggle');
    if (menuToggle) {
        const menu = entry.querySelector('.conversation-menu');
        const shouldOpen = menu.hidden;
        // closeConversationMenus();
        menu.hidden = !shouldOpen;
        menuToggle.setAttribute('aria-expanded', String(shouldOpen));
        entry.classList.toggle('menu-open', shouldOpen);
        return;
    }

    const actionButton = target.closest('[data-conversation-action]');
    if (actionButton) {
        const action = actionButton.dataset.conversationAction;
        const title = entry.querySelector('.conversation-item span:last-child');
        // closeConversationMenus();

        if (action === 'rename') {
            const newName = window.prompt('Rename conversation:', title.textContent);
            if (newName === null) return;
            const trimmedName = newName.trim();
            if (!trimmedName) {
                showToast('Conversation name cannot be empty.');
                return;
            }
            title.textContent = trimmedName;
            if (entry.classList.contains('active')) workspaceTitle.textContent = trimmedName;
            showToast('Conversation renamed.');
        } else if (action === 'delete') {
            if (!window.confirm(`Delete "${title.textContent}"?`)) return;
            const entries = [...conversationList.querySelectorAll('.conversation-entry')];
            const wasActive = entry.classList.contains('active');
            const deletedIndex = entries.indexOf(entry);
            if (wasActive) cancelPendingResponse();
            entry.remove();
            updateConversationCount();

            if (wasActive) {
                const remainingEntries = conversationList.querySelectorAll('.conversation-entry');
                const nextEntry = remainingEntries[Math.min(deletedIndex, remainingEntries.length - 1)];
                if (nextEntry) {
                    activateConversation(nextEntry);
                } else {
                    workspaceTitle.textContent = 'No conversation selected';
                    conversationOutput.replaceChildren();
                    promptInput.value = '';
                }
            }
            showToast('Conversation deleted.');
        }
        return;
    }

    // if (target.closest('.conversation-item')) {
    //     activateConversation(entry);
    //     closeConversationMenus();
    // }
});

// document.addEventListener('click', (event) => {
//     if (!(event.target instanceof Element) || !event.target.closest('.conversation-entry')) {
//         closeConversationMenus();
//     }
// });

document.addEventListener('keydown', (event) => {
    if (!(event.target instanceof Element)) return;
    const entry = event.target.closest('.conversation-entry');

    if (event.key === 'Escape') {
        const openEntry = conversationList.querySelector('.conversation-entry.menu-open');
        // closeConversationMenus();
        openEntry?.querySelector('.conversation-menu-toggle').focus();
        return;
    }

    if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && entry?.classList.contains('menu-open')) {
        const menuItems = [...entry.querySelectorAll('[role="menuitem"]')];
        const currentIndex = menuItems.indexOf(event.target);
        const direction = event.key === 'ArrowDown' ? 1 : -1;
        const nextIndex = (currentIndex + direction + menuItems.length) % menuItems.length;
        event.preventDefault();
        menuItems[nextIndex].focus();
    }
});

document.querySelector('.scroll-cue').addEventListener('click', () => {
    document.querySelector('.composer').scrollIntoView({ behavior: 'smooth', block: 'center' });
    promptInput.focus({ preventScroll: true });
});

document.querySelector('#knowledge-button').addEventListener('click', () => fileInput.click());

fileInput.addEventListener('change', () => {
    const count = fileInput.files.length;
    if (!count) return;
    document.querySelector('#document-count').textContent = String(count);
    document.querySelector('#source-metric').textContent = `${String(count).padStart(2, '0')} DOCUMENT${count === 1 ? '' : 'S'}`;
    showToast(`${count} document${count === 1 ? '' : 's'} selected locally. Connect a retrieval backend to index them.`);
});

document.querySelector('#export-button').addEventListener('click', () => {
    const messages = [...conversationOutput.querySelectorAll('.chat-message')].map((message) => {
        const [label, ...body] = message.innerText.split('\n');
        return `${label}\n${body.join('\n')}`;
    });
    if (!messages.length) {
        showToast('There are no messages to export yet.');
        return;
    }
    const file = new Blob([messages.join('\n\n')], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(file);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'deviant-investigation.txt';
    link.click();
    URL.revokeObjectURL(url);
});

document.querySelector('.help-button').addEventListener('click', () => {
    showToast('DEVIANT is a local interface prototype. No documents leave this device.');
});