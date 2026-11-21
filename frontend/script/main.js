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
import {
    initializeChat,
    cancelPendingResponse,
    createConversationOutput,
    isConversationEmpty,
    showConversation,
    removeConversation
} from './chat.js';
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
// The data explorer always starts collapsed; the toggle (or a Relational RAG answer) opens it.
rightPanel.classList.add('is-collapsed');
const rightPanelBar = $('.right-panel-bar');
const workArea = $('#work-area');

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
    entry.dataset.conversationId = crypto.randomUUID();
    createConversationOutput(entry.dataset.conversationId);

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

    const renameButton = document.createElement('button');
    renameButton.className = 'knowledge-delete conversation-delete conversation-rename';
    renameButton.type = 'button';
    renameButton.dataset.conversationAction = 'rename';
    renameButton.setAttribute('aria-label', t('rename-conversation'));
    renameButton.dataset.i18nAria = 'rename-conversation';
    renameButton.title = t('rename-conversation');
    renameButton.dataset.i18nTitle = 'rename-conversation';
    const renameIcon = document.createElement('img');
    renameIcon.src = 'assets/icons/edit.svg';
    renameIcon.alt = '';
    renameIcon.setAttribute('aria-hidden', 'true');
    renameButton.append(renameIcon);

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

    entry.append(selectButton, renameButton, deleteButton, menu);
    return entry;
}

function activateConversation(entry) {
    conversationList.querySelectorAll('.conversation-entry').forEach((item) => {
        item.classList.toggle('active', item === entry);
        const button = item.querySelector('.conversation-item');
        if (item === entry) button.setAttribute('aria-current', 'true');
        else button.removeAttribute('aria-current');
    });
    const title = entry.querySelector('.conversation-item span:last-child');
    workspaceTitle.textContent = title.textContent;
    if (title.dataset.i18n) workspaceTitle.dataset.i18n = title.dataset.i18n;
    else delete workspaceTitle.dataset.i18n;
    showConversation(entry.dataset.conversationId);
}

function setConversationName(entry, name) {
    const title = entry.querySelector('.conversation-item span:last-child');
    delete title.dataset.i18n;
    title.textContent = name;
    if (entry.classList.contains('active')) {
        delete workspaceTitle.dataset.i18n;
        workspaceTitle.textContent = name;
    }
}

/** Troca o título da conversa por um campo de texto: Enter ou sair do campo confirma, Esc cancela. */
function startRename(entry) {
    if (entry.querySelector('.conversation-rename-input')) return;
    const selectButton = entry.querySelector('.conversation-item');
    const title = selectButton.querySelector('span:last-child');
    const input = document.createElement('input');
    input.className = 'conversation-rename-input';
    input.type = 'text';
    input.maxLength = 80;
    input.value = title.textContent;
    input.setAttribute('aria-label', t('rename-conversation'));
    // Keep the chat icon; the field takes the place of the title, to its right.
    selectButton.classList.add('is-renaming');
    title.hidden = true;
    selectButton.after(input);
    input.focus();
    input.select();

    let finished = false;
    const finish = (save) => {
        if (finished) return;
        finished = true;
        const name = input.value.trim();
        input.remove();
        selectButton.classList.remove('is-renaming');
        title.hidden = false;
        if (!save || name === title.textContent) return;
        if (!name) {
            showToast(t('conversation-name-empty'), 'alert');
            return;
        }
        setConversationName(entry, name);
        showToast(t('conversation-renamed'), 'success');
    };
    input.addEventListener('keydown', (event) => {
        if (event.isComposing) return;
        if (event.key === 'Enter') finish(true);
        else if (event.key === 'Escape') finish(false);
        event.stopPropagation();
    });
    input.addEventListener('blur', () => finish(true));
}

function createConversation() {
    const conversation = createConversationEntry(t('new-investigation'));
    conversation.querySelector('.conversation-item span:last-child').dataset.i18n = 'new-investigation';
    conversationEntries.append(conversation);
    conversation.scrollIntoView({ block: 'nearest' });
    activateConversation(conversation);
    updateConversationCount();
}

// A conversa que já vem no HTML também precisa de um espaço de mensagens.
const initialConversation = conversationList.querySelector('.conversation-entry');
if (initialConversation) {
    initialConversation.dataset.conversationId = crypto.randomUUID();
    createConversationOutput(initialConversation.dataset.conversationId);
    activateConversation(initialConversation);
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
    removeConversation(entry.dataset.conversationId);
    updateConversationCount();

    if (wasActive) {
        const remainingEntries = conversationList.querySelectorAll('.conversation-entry');
        const nextEntry = remainingEntries[Math.min(deletedIndex, remainingEntries.length - 1)];
        if (nextEntry) {
            activateConversation(nextEntry);
        } else {
            workspaceTitle.dataset.i18n = 'no-conversation-selected';
            workspaceTitle.textContent = t('no-conversation-selected');
        }
    }
    showToast(t('conversation-deleted'), 'success');
}

const chat = initializeChat({
    onEmptyExport: () => showToast(t('export-empty'), 'alert'),
    ensureConversation: createConversation,
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
    syncRightPanelMaxHeight();
    placeFloatingPanelAfterToggle();
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

// The explorer may be dragged shorter than its content, never taller: cap its
// max-height at the natural content height. The content box itself stretches
// with the panel, so measure its children instead of its scrollHeight; outside
// Relational RAG mode the only visible child is the graph-view notice, so the
// cap follows the notice height.
const rightPanelContent = rightPanel.querySelector('.right-panel-content');

function getNaturalContentHeight() {
    const style = getComputedStyle(rightPanelContent);
    const children = [...rightPanelContent.children].filter((child) => child.offsetHeight > 0);
    const gaps = Math.max(0, children.length - 1) * (parseFloat(style.rowGap) || 0);
    const padding = (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0);
    return children.reduce((sum, child) => sum + child.offsetHeight, 0) + gaps + padding;
}

function syncRightPanelMaxHeight() {
    if (rightPanel.classList.contains('is-collapsed')) return;
    const frame = rightPanel.offsetHeight - rightPanel.clientHeight;
    const natural = rightPanelBar.offsetHeight + getNaturalContentHeight() + frame;
    const viewportCap = Math.min(window.innerHeight * 0.8, 720);
    rightPanel.style.maxHeight = `${Math.ceil(Math.min(natural, viewportCap))}px`;
    clampFloatingPanel();
}

const rightPanelContentObserver = new ResizeObserver(syncRightPanelMaxHeight);
rightPanelContentObserver.observe(rightPanelContent);
for (const child of rightPanelContent.querySelectorAll(':scope > *, :scope > * > *')) {
    rightPanelContentObserver.observe(child);
}
window.addEventListener('resize', syncRightPanelMaxHeight);

// The collapsed icon only slides vertically, along the right edge of the work area.
const COLLAPSED_ICON_SIZE = 44;
const WORK_AREA_EDGE_GAP = 24;
const WORK_AREA_VERTICAL_GAP = 16;
const VIEWPORT_MARGIN = 8;

// Keeps the expanded panel fully on screen, with a small margin on every side.
function clampToViewport(left, top, width, height) {
    const maxLeft = Math.max(VIEWPORT_MARGIN, window.innerWidth - width - VIEWPORT_MARGIN);
    const maxTop = Math.max(VIEWPORT_MARGIN, window.innerHeight - height - VIEWPORT_MARGIN);
    return {
        left: Math.min(Math.max(VIEWPORT_MARGIN, left), maxLeft),
        top: Math.min(Math.max(VIEWPORT_MARGIN, top), maxTop),
    };
}

function placeCollapsedIcon(requestedTop) {
    const area = workArea.getBoundingClientRect();
    const currentTop = requestedTop ?? rightPanel.getBoundingClientRect().top;
    const minTop = area.top + WORK_AREA_VERTICAL_GAP;
    const maxTop = Math.max(minTop, area.bottom - WORK_AREA_VERTICAL_GAP - COLLAPSED_ICON_SIZE);
    rightPanel.style.left = `${Math.round(area.right - WORK_AREA_EDGE_GAP - COLLAPSED_ICON_SIZE)}px`;
    rightPanel.style.top = `${Math.round(Math.min(Math.max(minTop, currentTop), maxTop))}px`;
}

function placeFloatingPanelAfterToggle() {
    if (rightPanel.classList.contains('is-collapsed')) {
        placeCollapsedIcon();
        return;
    }
    // Expanding: keep the panel's right edge where the icon was.
    const iconRect = rightPanel.getBoundingClientRect();
    const width = rightPanel.offsetWidth;
    const height = rightPanel.offsetHeight;
    const { left, top } = clampToViewport(iconRect.right - width, iconRect.top, width, height);
    rightPanel.style.left = `${Math.round(left)}px`;
    rightPanel.style.top = `${Math.round(top)}px`;
}

function clampFloatingPanel() {
    if (rightPanel.classList.contains('is-collapsed')) {
        placeCollapsedIcon();
        return;
    }
    if (!rightPanel.style.left) return;
    const rect = rightPanel.getBoundingClientRect();
    const { left, top } = clampToViewport(rect.left, rect.top, rect.width, rect.height);
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
        if (rightPanel.classList.contains('is-collapsed')) {
            placeCollapsedIcon(rect.top + pointerEvent.clientY - startY);
            return;
        }
        const width = rightPanel.offsetWidth;
        const { left, top } = clampToViewport(
            rect.left + pointerEvent.clientX - startX,
            rect.top + pointerEvent.clientY - startY,
            width,
            rightPanel.offsetHeight,
        );
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

conversationList.addEventListener('dblclick', (event) => {
    if (!(event.target instanceof Element)) return;
    const entry = event.target.closest('.conversation-entry');
    if (entry && event.target.closest('.conversation-item')) startRename(entry);
});

conversationList.addEventListener('click', (event) => {
    if (!(event.target instanceof Element)) return;
    const target = event.target;
    const newConversationButton = target.closest('.new-conversation');

    if (newConversationButton) {
        // The first conversation is created by sending a message from the welcome screen.
        if (!conversationList.querySelector('.conversation-entry')) {
            showToast(t('new-conversation-use-welcome'), 'alert');
            return;
        }
        const emptyEntry = [...conversationList.querySelectorAll('.conversation-entry')]
            .find((item) => isConversationEmpty(item.dataset.conversationId));
        if (emptyEntry) {
            activateConversation(emptyEntry);
            emptyEntry.scrollIntoView({ block: 'nearest' });
            showToast(t('new-conversation-blocked'), 'alert');
            return;
        }
        createConversation();
        showToast(t('new-conversation-toast'));
        return;
    }

    const entry = target.closest('.conversation-entry');
    if (!entry) return;

    if (target.closest('.conversation-rename-input')) return;

    if (target.closest('.conversation-item')) {
        if (!entry.classList.contains('active')) activateConversation(entry);
        return;
    }

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
            startRename(entry);
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

// Collapsed sidebar: heading shortcuts reuse the hidden sidebar buttons.
$('#collapsed-knowledge').addEventListener('click', () => $('#knowledge-button').click());
$('#collapsed-adjustments').addEventListener('click', () => adjustmentsToggle.click());

// Keep the collapsed shortcuts' bottom edge aligned with the composer box (their size is fixed).
function syncCollapsedRail() {
    const composerBox = $('#composer').getBoundingClientRect();
    const sidebarBox = sidebar.getBoundingClientRect();
    appShell.style.setProperty('--rail-bottom', `${Math.max(0, sidebarBox.bottom - composerBox.bottom)}px`);
}
const railObserver = new ResizeObserver(syncCollapsedRail);
railObserver.observe($('#composer'));
railObserver.observe(appShell);

adjustmentsClose.addEventListener('click', () => {
    adjustmentsDialog.close();
});

adjustmentsDialog.addEventListener('click', (event) => {
    if (event.target === adjustmentsDialog) adjustmentsDialog.close();
});