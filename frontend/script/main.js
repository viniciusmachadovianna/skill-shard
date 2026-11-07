import { applyTheme } from './theme.js';
import { applyLanguage, getCurrentLanguage, initializeLanguage, t } from './language.js';
import { clearChat, initializeChat, cancelPendingResponse } from './chat.js';
import { initializeKnowledgeBase } from './knowledge-base.js';
import { $ } from './utils.js';

document.addEventListener('DOMContentLoaded', () => {
    applyTheme();
    initializeLanguage();
});

const appShell = $('.app-shell');

const toast = $('#toast');
let toastTimeout;

const helpButton = $('.help-button');

const sidebar = $('.sidebar');
const assistantPanel = $('.assistant-panel');
const sidebarToggle = $('.sidebar-toggle');
const sidebarToggleIcon = sidebarToggle.querySelector('img');
const assistantToggle = $('.assistant-toggle');
const assistantToggleIcon = assistantToggle.querySelector('img');

const conversationList = $('.sidebar-top');
const conversationCount = $('#conversation-count');
const workspaceTitle = $('#workspace-title');
const conversationDeleteDialog = $('#conversation-delete-dialog');
const conversationDeleteMessage = $('#conversation-delete-message');
const conversationDeleteCancel = $('#conversation-delete-cancel');
const conversationDeleteConfirm = $('#conversation-delete-confirm');
let conversationPendingDeletion;

export function showToast(message) {
    toast.textContent = message;
    toast.classList.add('visible');
    window.clearTimeout(toastTimeout);
    toastTimeout = window.setTimeout(() => toast.classList.remove('visible'), 3200);
}

function syncSidebarState() {
    const leftHidden = sidebar.classList.contains('is-collapsed');
    const rightHidden = assistantPanel.classList.contains('is-collapsed');
    appShell.classList.toggle('sidebar-collapsed', leftHidden);
    appShell.classList.toggle('assistant-collapsed', rightHidden);

    sidebarToggle.dataset.i18nAria = leftHidden ? 'sidebar-expand' : 'sidebar-collapse';
    sidebarToggle.dataset.i18nTitle = leftHidden ? 'sidebar-expand' : 'sidebar-collapse';
    assistantToggle.dataset.i18nAria = rightHidden ? 'assistant-expand' : 'assistant-collapse';
    assistantToggle.dataset.i18nTitle = rightHidden ? 'assistant-expand' : 'assistant-collapse';

    sidebarToggleIcon.src = leftHidden ? 'assets/icons/left_panel_open.svg' : 'assets/icons/left_panel_close.svg';
    sidebarToggleIcon.alt = leftHidden ? 'Show workspace sidebar' : 'Hide workspace sidebar';
    assistantToggleIcon.src = rightHidden ? 'assets/icons/right_panel_open.svg' : 'assets/icons/right_panel_close.svg';
    assistantToggleIcon.alt = rightHidden ? 'Show assistant panel' : 'Hide assistant panel';

    applyLanguage(getCurrentLanguage());
}

function createConversationEntry(name) {
    const entry = document.createElement('div');
    entry.className = 'conversation-entry';

    const selectButton = document.createElement('button');
    selectButton.type = 'button';
    selectButton.className = 'conversation-item';
    const icon = document.createElement('img');
    icon.className = 'chat-icon';
    icon.src = 'assets/icons/chat.svg';
    icon.alt = '';
    const title = document.createElement('span');
    title.textContent = name;
    selectButton.append(icon, title);

    const deleteButton = document.createElement('button');
    deleteButton.className = 'knowledge-delete conversation-delete';
    deleteButton.type = 'button';
    deleteButton.dataset.conversationAction = 'delete';
    deleteButton.setAttribute('aria-label', t('delete-conversation'));
    deleteButton.dataset.i18nAria = 'delete-conversation';
    deleteButton.title = t('delete-conversation');
    deleteButton.dataset.i18nTitle = 'delete-conversation';
    const deleteIcon = document.createElement('img');
    deleteIcon.src = 'assets/icons/delete.svg';
    deleteIcon.alt = '';
    deleteIcon.setAttribute('aria-hidden', 'true');
    deleteButton.append(deleteIcon);

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

    entry.append(selectButton, deleteButton, menu);
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

function deleteConversation(entry) {
    if (!entry.isConnected) return;

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
            clearChat();
        }
    }
    showToast(t('conversation-deleted'));
}

initializeChat({
    onEmptyExport: () => showToast('There are no messages to export yet.')
});

initializeKnowledgeBase({ showToast });

sidebarToggle.addEventListener('click', () => {
    sidebar.classList.toggle('is-collapsed');
    syncSidebarState();
});

assistantToggle.addEventListener('click', () => {
    assistantPanel.classList.toggle('is-collapsed');
    syncSidebarState();
});

syncSidebarState();

conversationDeleteCancel.addEventListener('click', () => conversationDeleteDialog.close());
conversationDeleteConfirm.addEventListener('click', () => {
    if (conversationPendingDeletion) deleteConversation(conversationPendingDeletion);
    conversationPendingDeletion = undefined;
    conversationDeleteDialog.close();
});
conversationDeleteDialog.addEventListener('close', () => {
    conversationPendingDeletion = undefined;
});

conversationList.addEventListener('click', (event) => {
    if (!(event.target instanceof Element)) return;
    const target = event.target;
    const newConversationButton = target.closest('.new-conversation');

    if (newConversationButton) {
        clearChat();
        const conversation = createConversationEntry('New investigation');
        conversationList.append(conversation);
        activateConversation(conversation);
        // closeConversationMenus();
        updateConversationCount();
        showToast(t('new-conversation-toast'));
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
            conversationPendingDeletion = entry;
            conversationDeleteMessage.textContent = t('delete-conversation-confirm')
                .replace('{name}', title.textContent);
            conversationDeleteDialog.showModal();
            conversationDeleteCancel.focus();
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

helpButton.addEventListener('click', () => {
    showToast('DEVIANT is a local interface prototype. No documents leave this device.');
});