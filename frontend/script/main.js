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
$('#knowledge-dialog').append($('#assistant-document-preview'));
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
const rightPanelToggle = $('.right-panel-toggle');
const rightPanelToggleIcon = rightPanelToggle.querySelector('img');
if (window.matchMedia('(max-width: 800px)').matches) rightPanel.classList.add('is-collapsed');
const rightPanelBar = $('.right-panel-bar');

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

const graphSection = $('#right-panel-graph');
const graphModeSwitch = $('#graph-mode-switch');

function updateGraphAvailability() {
    const available = retrievalMode.value === 'graphrag';
    graphSection.classList.toggle('is-locked', !available);
}

function updateRetrievalModeIcon() {
    const icon = retrievalMode.selectedOptions[0]?.dataset.icon;
    if (icon) retrievalModeIcon.src = icon;
    updateGraphAvailability();
}

graphModeSwitch.addEventListener('click', () => {
    retrievalMode.value = 'graphrag';
    retrievalMode.dispatchEvent(new Event('change'));
    retrievalMode.focus();
});

function syncSidebarState() {
    const leftHidden = sidebar.classList.contains('is-collapsed');
    const rightHidden = rightPanel.classList.contains('is-collapsed');
    appShell.classList.toggle('sidebar-collapsed', leftHidden);
    sidebarResizeHandle.hidden = leftHidden;

    sidebarToggle.dataset.i18nAria = leftHidden ? 'sidebar-expand' : 'sidebar-collapse';
    sidebarToggle.dataset.i18nTitle = leftHidden ? 'sidebar-expand' : 'sidebar-collapse';
    rightPanelToggle.dataset.i18nAria = rightHidden ? 'right-panel-expand' : 'right-panel-collapse';
    rightPanelToggle.dataset.i18nTitle = rightHidden ? 'right-panel-expand' : 'right-panel-collapse';

    sidebarToggleIcon.src = leftHidden ? 'assets/icons/right.svg' : 'assets/icons/left.svg';
    rightPanelToggleIcon.src = rightHidden ? 'assets/icons/connections.svg' : 'assets/icons/collapse.svg';

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
    if (suppressPanelToggleClick) return;
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
    const defaultWidth = compactLayout ? 190 : narrowLayout ? 205 : 232;
    const minimum = Math.max(160, getBrandMinimumWidth());
    const maximum = Math.max(defaultWidth, minimum, Math.min(420, appShell.clientWidth - minimumMainWidth));
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

function saveFloatingPanel() {
    try {
        const saved = {};
        for (const property of ['left', 'top', 'width', 'height']) {
            if (rightPanel.style[property]) saved[property] = rightPanel.style[property];
        }
        localStorage.setItem(PANEL_STORAGE_KEY, JSON.stringify(saved));
    } catch { /* storage unavailable: the position just won't persist */ }
}

function restoreFloatingPanel() {
    try {
        const saved = JSON.parse(localStorage.getItem(PANEL_STORAGE_KEY) ?? '{}');
        for (const property of ['left', 'top', 'width', 'height']) {
            if (/^-?\d+(\.\d+)?px$/.test(saved[property] ?? '')) rightPanel.style[property] = saved[property];
        }
    } catch { /* ignore a corrupt or unavailable saved layout */ }
}

let panelSaveTimer;
new ResizeObserver(() => {
    if (rightPanel.classList.contains('is-collapsed') || !rightPanel.style.width) return;
    clearTimeout(panelSaveTimer);
    panelSaveTimer = setTimeout(() => { clampFloatingPanel(); saveFloatingPanel(); }, 200);
}).observe(rightPanel);

function clampFloatingPanel() {
    if (!rightPanel.style.left) return;
    const rect = rightPanel.getBoundingClientRect();
    const left = Math.min(Math.max(0, rect.left), Math.max(0, window.innerWidth - rect.width));
    const top = Math.min(Math.max(0, rect.top), Math.max(0, window.innerHeight - 44));
    rightPanel.style.left = `${Math.round(left)}px`;
    rightPanel.style.top = `${Math.round(top)}px`;
}

// The data explorer is a floating window: drag it by its title bar, or by the
// collapsed icon. Movement under the threshold still counts as a click.
const PANEL_STORAGE_KEY = 'skill-shard.right-panel';
const DRAG_THRESHOLD = 4;
let suppressPanelToggleClick = false;

rightPanelBar.addEventListener('pointerdown', (event) => {
    if (!event.isPrimary || (event.pointerType === 'mouse' && event.button !== 0)) return;
    const startX = event.clientX;
    const startY = event.clientY;
    const rect = rightPanel.getBoundingClientRect();
    let dragging = false;

    const move = (pointerEvent) => {
        if (pointerEvent.pointerId !== event.pointerId) return;
        if (!dragging) {
            if (Math.hypot(pointerEvent.clientX - startX, pointerEvent.clientY - startY) < DRAG_THRESHOLD) return;
            dragging = true;
            rightPanel.classList.add('is-dragging');
            rightPanelBar.setPointerCapture(event.pointerId);
        }
        const width = rightPanel.offsetWidth;
        const left = Math.min(Math.max(0, rect.left + pointerEvent.clientX - startX), Math.max(0, window.innerWidth - width));
        const top = Math.min(Math.max(0, rect.top + pointerEvent.clientY - startY), Math.max(0, window.innerHeight - 44));
        rightPanel.style.left = `${left}px`;
        rightPanel.style.top = `${top}px`;
    };
    const stop = (pointerEvent) => {
        if (pointerEvent.pointerId !== event.pointerId) return;
        rightPanelBar.removeEventListener('pointermove', move);
        rightPanelBar.removeEventListener('pointerup', stop);
        rightPanelBar.removeEventListener('pointercancel', stop);
        rightPanel.classList.remove('is-dragging');
        if (dragging) {
            saveFloatingPanel();
            suppressPanelToggleClick = true;
            setTimeout(() => { suppressPanelToggleClick = false; }, 0);
        }
    };
    rightPanelBar.addEventListener('pointermove', move);
    rightPanelBar.addEventListener('pointerup', stop);
    rightPanelBar.addEventListener('pointercancel', stop);
});

restoreFloatingPanel();
clampFloatingPanel();
enforceSidebarMinimum();
updateSidebarResizeHandle();
window.addEventListener('resize', () => {
    if (sidebarWidthAdjusted) setSidebarWidth(sidebar.getBoundingClientRect().width);
    clampFloatingPanel();
    enforceSidebarMinimum();
    updateSidebarResizeHandle();
});

new ResizeObserver(() => {
    enforceSidebarMinimum();
    updateSidebarResizeHandle();
}).observe(sidebarBrandCopy);

syncSidebarState();
retrievalMode.addEventListener('change', updateRetrievalModeIcon);
onLanguageChange(updateGraphAvailability);
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