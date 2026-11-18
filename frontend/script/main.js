/**
 * @file Ponto de entrada da interface.
 *
 * Monta a página e inicializa os outros módulos: chat, base de conhecimento,
 * grafo de entidades e idioma. Também controla a barra lateral (recolher e
 * redimensionar), o painel direito, a lista de conversas e os diálogos de
 * informações e de ajustes. Não exporta nada.
 */

import { applyTheme } from './theme.js';
import { applyLanguage, getCurrentLanguage, initializeLanguage, onLanguageChange, t } from './language.js';
import { clearChat, initializeChat, cancelPendingResponse } from './chat.js';
import { initializeKnowledgeBase } from './knowledge-base.js';
import { initializeEntityGraph, renderAnswerGraph } from './entity-graph.js';
import { showToast } from './toast.js';
import { listModels } from './api.js';
import { $ } from './utils.js';

document.addEventListener('DOMContentLoaded', () => {
    applyTheme();
    initializeLanguage();
});

const appShell = $('.app-shell');

const informationModal = $('#brand');
const informationDialog = $('#information-dialog');
const informationClose = $('#information-close');
const adjustmentsToggle = $('#adjustments-toggle');
const adjustmentsDialog = $('#adjustments-dialog');
const adjustmentsClose = $('#adjustments-close');
const assistantCopy = $('#assistant-copy');
const entityGraphDialog = $('#entity-graph-dialog');
$('#right-panel-preview').append($('#assistant-document-preview'));
const entityGraphHeader = entityGraphDialog.querySelector('.knowledge-dialog-header');
entityGraphHeader.querySelector('#entity-graph-close').remove();
entityGraphHeader.remove();
$('#right-panel-graph').append(entityGraphHeader, $('#entity-graph-refresh'), ...entityGraphDialog.children);
entityGraphDialog.remove();
adjustmentsDialog.append(assistantCopy);
assistantCopy.hidden = false;

const sidebar = $('.sidebar');
const sidebarToggle = $('.sidebar-toggle');
const sidebarToggleIcon = sidebarToggle.querySelector('img');
const sidebarResizeHandle = $('.sidebar-resize-handle');
const rightPanel = $('.right-panel');
const rightPanelResizeHandle = $('.right-panel-resize-handle');
const rightPanelToggle = $('.right-panel-toggle');
const rightPanelToggleIcon = rightPanelToggle.querySelector('img');
if (window.matchMedia('(max-width: 800px)').matches) rightPanel.classList.add('is-collapsed');

const conversationList = $('.sidebar-top');
const conversationEntries = $('#conversation-entries');
const conversationCount = $('#conversation-count');
const workspaceTitle = $('#workspace-title');
const retrievalMode = $('#retrieval-mode');
const retrievalModeIcon = $('#retrieval-mode-icon');
const conversationDeleteDialog = $('#conversation-delete-dialog');
const conversationDeleteMessage = $('#conversation-delete-message');
const conversationDeleteCancel = $('#conversation-delete-cancel');
const conversationDeleteConfirm = $('#conversation-delete-confirm');
let conversationPendingDeletion;

function updateRetrievalModeIcon() {
    const icon = retrievalMode.selectedOptions[0]?.dataset.icon;
    if (icon) retrievalModeIcon.src = icon;
}

export function showToast(message) {
    toast.textContent = message;
    toast.classList.add('visible');
    window.clearTimeout(toastTimeout);
    toastTimeout = window.setTimeout(() => toast.classList.remove('visible'), 3200);
}

function syncSidebarState() {
    const leftHidden = sidebar.classList.contains('is-collapsed');
    const rightHidden = rightPanel.classList.contains('is-collapsed');
    appShell.classList.toggle('sidebar-collapsed', leftHidden);
    appShell.classList.toggle('right-panel-collapsed', rightHidden);
    sidebarResizeHandle.hidden = leftHidden;
    rightPanelResizeHandle.hidden = rightHidden;

    sidebarToggle.dataset.i18nAria = leftHidden ? 'sidebar-expand' : 'sidebar-collapse';
    sidebarToggle.dataset.i18nTitle = leftHidden ? 'sidebar-expand' : 'sidebar-collapse';
    rightPanelToggle.dataset.i18nAria = rightHidden ? 'right-panel-expand' : 'right-panel-collapse';
    rightPanelToggle.dataset.i18nTitle = rightHidden ? 'right-panel-expand' : 'right-panel-collapse';

    sidebarToggleIcon.src = leftHidden ? 'assets/icons/left_panel_open.svg' : 'assets/icons/left_panel_close.svg';
    rightPanelToggleIcon.src = rightHidden ? 'assets/icons/right_panel_open.svg' : 'assets/icons/right_panel_close.svg';

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

    const menu = document.createElement('div');
    menu.className = 'conversation-menu';
    menu.setAttribute('role', 'menu');
    menu.hidden = true;

    entry.append(selectButton, deleteButton, menu);
    return entry;
}

function activateConversation(entry) {
    conversationList.querySelectorAll('.conversation-entry').forEach((item) => {
        item.classList.toggle('active', item === entry);
    });
    const title = entry.querySelector('.conversation-item span:last-child');
    workspaceTitle.textContent = title.textContent;
    if (title.dataset.i18n) workspaceTitle.dataset.i18n = title.dataset.i18n;
    else delete workspaceTitle.dataset.i18n;
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
            workspaceTitle.dataset.i18n = 'no-conversation-selected';
            workspaceTitle.textContent = t('no-conversation-selected');
            clearChat();
        }
    }
    showToast(t('conversation-deleted'));
}

const chat = initializeChat({
    onEmptyExport: () => showToast(t('export-empty'), 'alert'),
    onRelationalResponse: (graph) => {
        rightPanel.classList.remove('is-collapsed');
        syncSidebarState();
        renderAnswerGraph(graph);
    }
});

const knowledgeBase = initializeKnowledgeBase({
    showToast,
    onIndexingState: chat.setKnowledgeIndexStatus
});
chat.setRetryKnowledgeIndex(knowledgeBase.retryIndexing);
initializeEntityGraph();

sidebarToggle.addEventListener('click', () => {
    sidebar.classList.toggle('is-collapsed');
    enforceSidebarMinimum();
    syncSidebarState();
});

rightPanelToggle.addEventListener('click', () => {
    rightPanel.classList.toggle('is-collapsed');
    syncSidebarState();
});

const sidebarBrand = sidebar.querySelector('.brand');
const sidebarBrandMark = sidebar.querySelector('.brand-mark');
const sidebarBrandCopy = sidebar.querySelector('.brand-copy');

function getBrandMinimumWidth() {
    const copyWidth = sidebarBrandCopy.offsetWidth;
    if (!copyWidth) return 0;
    const brandStyle = getComputedStyle(sidebarBrand);
    const topStyle = getComputedStyle(sidebarBrand.parentElement);
    const horizontal = (style, ...sides) => sides.reduce((sum, side) => sum + parseFloat(style[side]) || 0, 0);
    return Math.ceil(
        sidebarBrandMark.offsetWidth + (parseFloat(brandStyle.columnGap) || 0) + copyWidth
        + horizontal(brandStyle, 'paddingLeft', 'paddingRight')
        + horizontal(topStyle, 'paddingLeft', 'paddingRight') + 1
    );
}

function enforceSidebarMinimum() {
    if (sidebar.classList.contains('is-collapsed')) return;
    const { minimum } = getSidebarWidthBounds();
    if (sidebar.getBoundingClientRect().width < minimum) setSidebarWidth(minimum);
}

function getSidebarWidthBounds() {
    const compactLayout = window.matchMedia('(max-width: 800px)').matches;
    const narrowLayout = window.matchMedia('(max-width: 1050px)').matches;
    const minimumMainWidth = compactLayout ? 0 : narrowLayout ? 380 : 420;
    const rightPanelWidth = compactLayout ? 32 : rightPanel.getBoundingClientRect().width;
    const defaultWidth = compactLayout ? 190 : narrowLayout ? 205 : 232;
    const minimum = Math.max(160, getBrandMinimumWidth());
    const maximum = Math.max(defaultWidth, minimum, Math.min(420, appShell.clientWidth - minimumMainWidth - rightPanelWidth));
    return { minimum, maximum };
}

function setSidebarWidth(width, bounds = getSidebarWidthBounds()) {
    const { minimum, maximum } = bounds;
    const boundedWidth = Math.round(Math.min(maximum, Math.max(minimum, width)));
    appShell.style.setProperty('--sidebar-width', `${boundedWidth}px`);
    sidebarResizeHandle.setAttribute('aria-valuemin', String(minimum));
    sidebarResizeHandle.setAttribute('aria-valuemax', String(maximum));
    sidebarResizeHandle.setAttribute('aria-valuenow', String(boundedWidth));
}

let sidebarWidthAdjusted = false;

function updateSidebarResizeHandle() {
    const width = sidebar.getBoundingClientRect().width;
    const { minimum, maximum } = getSidebarWidthBounds();
    sidebarResizeHandle.setAttribute('aria-valuemin', String(minimum));
    sidebarResizeHandle.setAttribute('aria-valuemax', String(maximum));
    sidebarResizeHandle.setAttribute('aria-valuenow', String(Math.round(width)));
}

sidebarResizeHandle.addEventListener('pointerdown', (event) => {
    if (!event.isPrimary || (event.pointerType === 'mouse' && event.button !== 0)) return;
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = sidebar.getBoundingClientRect().width;
    const widthBounds = getSidebarWidthBounds();
    appShell.classList.add('is-resizing');
    sidebarResizeHandle.setPointerCapture(event.pointerId);

    const resize = (pointerEvent) => {
        if (pointerEvent.pointerId === event.pointerId) {
            sidebarWidthAdjusted = true;
            setSidebarWidth(startWidth + pointerEvent.clientX - startX, widthBounds);
        }
    };
    const stopResizing = (pointerEvent) => {
        if (pointerEvent.pointerId !== event.pointerId) return;
        sidebarResizeHandle.removeEventListener('pointermove', resize);
        sidebarResizeHandle.removeEventListener('pointerup', stopResizing);
        sidebarResizeHandle.removeEventListener('pointercancel', stopResizing);
        appShell.classList.remove('is-resizing');
    };

    sidebarResizeHandle.addEventListener('pointermove', resize);
    sidebarResizeHandle.addEventListener('pointerup', stopResizing);
    sidebarResizeHandle.addEventListener('pointercancel', stopResizing);
});

sidebarResizeHandle.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const currentWidth = sidebar.getBoundingClientRect().width;
    const direction = event.key === 'ArrowRight' ? 1 : -1;
    sidebarWidthAdjusted = true;
    setSidebarWidth(currentWidth + direction * (event.shiftKey ? 30 : 10));
});

function getRightPanelWidthBounds() {
    const compactLayout = window.matchMedia('(max-width: 800px)').matches;
    const narrowLayout = window.matchMedia('(max-width: 1050px)').matches;
    const minimumMainWidth = narrowLayout ? 380 : 420;
    const defaultWidth = narrowLayout ? 260 : 306;
    const minimum = 260;
    const sidebarWidth = compactLayout ? 0 : sidebar.getBoundingClientRect().width;
    const maximum = Math.max(defaultWidth, minimum, Math.min(560, appShell.clientWidth - minimumMainWidth - sidebarWidth));
    return { minimum, maximum };
}

function setRightPanelWidth(width, bounds = getRightPanelWidthBounds()) {
    const { minimum, maximum } = bounds;
    const boundedWidth = Math.round(Math.min(maximum, Math.max(minimum, width)));
    appShell.style.setProperty('--right-panel-width', `${boundedWidth}px`);
    rightPanelResizeHandle.setAttribute('aria-valuemin', String(minimum));
    rightPanelResizeHandle.setAttribute('aria-valuemax', String(maximum));
    rightPanelResizeHandle.setAttribute('aria-valuenow', String(boundedWidth));
}

let rightPanelWidthAdjusted = false;

function updateRightPanelResizeHandle() {
    const { minimum, maximum } = getRightPanelWidthBounds();
    rightPanelResizeHandle.setAttribute('aria-valuemin', String(minimum));
    rightPanelResizeHandle.setAttribute('aria-valuemax', String(maximum));
    rightPanelResizeHandle.setAttribute('aria-valuenow', String(Math.round(rightPanel.getBoundingClientRect().width)));
}

rightPanelResizeHandle.addEventListener('pointerdown', (event) => {
    if (!event.isPrimary || (event.pointerType === 'mouse' && event.button !== 0)) return;
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = rightPanel.getBoundingClientRect().width;
    const widthBounds = getRightPanelWidthBounds();
    appShell.classList.add('is-resizing');
    rightPanelResizeHandle.setPointerCapture(event.pointerId);

    const resize = (pointerEvent) => {
        if (pointerEvent.pointerId === event.pointerId) {
            rightPanelWidthAdjusted = true;
            // The handle is on the panel's left edge, so dragging left widens it.
            setRightPanelWidth(startWidth - (pointerEvent.clientX - startX), widthBounds);
        }
    };
    const stopResizing = (pointerEvent) => {
        if (pointerEvent.pointerId !== event.pointerId) return;
        rightPanelResizeHandle.removeEventListener('pointermove', resize);
        rightPanelResizeHandle.removeEventListener('pointerup', stopResizing);
        rightPanelResizeHandle.removeEventListener('pointercancel', stopResizing);
        appShell.classList.remove('is-resizing');
    };

    rightPanelResizeHandle.addEventListener('pointermove', resize);
    rightPanelResizeHandle.addEventListener('pointerup', stopResizing);
    rightPanelResizeHandle.addEventListener('pointercancel', stopResizing);
});

rightPanelResizeHandle.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const direction = event.key === 'ArrowLeft' ? 1 : -1;
    rightPanelWidthAdjusted = true;
    setRightPanelWidth(rightPanel.getBoundingClientRect().width + direction * (event.shiftKey ? 30 : 10));
});

enforceSidebarMinimum();
updateSidebarResizeHandle();
updateRightPanelResizeHandle();
window.addEventListener('resize', () => {
    if (sidebarWidthAdjusted) setSidebarWidth(sidebar.getBoundingClientRect().width);
    if (rightPanelWidthAdjusted) setRightPanelWidth(rightPanel.getBoundingClientRect().width);
    enforceSidebarMinimum();
    updateSidebarResizeHandle();
    updateRightPanelResizeHandle();
});

new ResizeObserver(() => {
    enforceSidebarMinimum();
    updateSidebarResizeHandle();
}).observe(sidebarBrandCopy);

syncSidebarState();
retrievalMode.addEventListener('change', updateRetrievalModeIcon);
updateRetrievalModeIcon();

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
        const conversation = createConversationEntry(t('new-investigation'));
        conversation.querySelector('.conversation-item span:last-child').dataset.i18n = 'new-investigation';
        conversationEntries.append(conversation);
        conversation.scrollIntoView({ block: 'nearest' });
        activateConversation(conversation);
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
        menu.hidden = !shouldOpen;
        menuToggle.setAttribute('aria-expanded', String(shouldOpen));
        entry.classList.toggle('menu-open', shouldOpen);
        return;
    }

    const actionButton = target.closest('[data-conversation-action]');
    if (actionButton) {
        const action = actionButton.dataset.conversationAction;
        const title = entry.querySelector('.conversation-item span:last-child');

        if (action === 'rename') {
            const newName = window.prompt(t('rename-conversation-prompt'), title.textContent);
            if (newName === null) return;
            const trimmedName = newName.trim();
            if (!trimmedName) {
                showToast(t('conversation-name-empty'), 'alert');
                return;
            }
            delete title.dataset.i18n;
            title.textContent = trimmedName;
            if (entry.classList.contains('active')) {
                delete workspaceTitle.dataset.i18n;
                workspaceTitle.textContent = trimmedName;
            }
            showToast(t('conversation-renamed'));
        } else if (action === 'delete') {
            conversationPendingDeletion = entry;
            conversationDeleteMessage.textContent = t('delete-conversation-confirm')
                .replace('{name}', title.textContent);
            conversationDeleteDialog.showModal();
            conversationDeleteCancel.focus();
        }
        return;
    }
});

document.addEventListener('keydown', (event) => {
    if (!(event.target instanceof Element)) return;
    const entry = event.target.closest('.conversation-entry');

    if (event.key === 'Escape') {
        const openEntry = conversationList.querySelector('.conversation-entry.menu-open');
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

informationModal.addEventListener('click', (event) => {
    event.preventDefault();
    informationDialog.showModal();
    informationClose.focus();
});

informationClose.addEventListener('click', () => {
    informationDialog.close();
});

informationDialog.addEventListener('click', (event) => {
    if (event.target === informationDialog) informationDialog.close();
});

const modelSelect = $('#adjustments-model');
let modelsLoaded = false;
let modelsLoading = false;

/** Preenche o seletor de modelos com `GET /models`; tenta de novo na próxima abertura se falhar. */
async function loadModelOptions() {
    if (modelsLoaded || modelsLoading) return;
    modelsLoading = true;
    try {
        const { models } = await listModels();
        if (!models.length) throw new Error('No models returned');
        const previous = modelSelect.value;
        modelSelect.replaceChildren(...models.map((model) => {
            const option = document.createElement('option');
            option.value = model.id;
            option.textContent = model.display_name;
            return option;
        }));
        const preferred = models.find((model) => model.id === previous) ?? models.find((model) => model.default);
        if (preferred) modelSelect.value = preferred.id;
        modelsLoaded = true;
    } catch {
        const option = document.createElement('option');
        option.value = '';
        option.dataset.i18n = 'lm-model-unavailable';
        option.textContent = t('lm-model-unavailable');
        modelSelect.replaceChildren(option);
    } finally {
        modelsLoading = false;
    }
}

adjustmentsToggle.addEventListener('click', () => {
    adjustmentsDialog.showModal();
    loadModelOptions();
});

adjustmentsClose.addEventListener('click', () => {
    adjustmentsDialog.close();
});

adjustmentsDialog.addEventListener('click', (event) => {
    if (event.target === adjustmentsDialog) adjustmentsDialog.close();
});