/**
 * @file Aviso temporário (toast) exibido na tela.
 *
 * Fica em um módulo próprio, que depende apenas de `utils.js`, para que
 * qualquer módulo possa usá-lo sem criar importações circulares. Em especial,
 * `theme.js` é executado antes de `main.js` e já pode precisar de um aviso.
 */

import { $ } from './utils.js';

const stack = $('#toast-stack');

/** Máximo de toasts simultâneos; ao exceder, o mais antigo é descartado. */
const MAX_TOASTS = 7;

/** Ícone de cada tipo de toast, em `assets/icons/`. */
const TOAST_ICONS = {
    info: './assets/icons/info.svg',
    alert: './assets/icons/alert.svg',
    success: './assets/icons/success.svg',
    error: './assets/icons/error.svg',
};

/**
 * Mostra uma mensagem por 3,2 segundos. Cada chamada cria um toast próprio, que
 * fica pausado enquanto o mouse estiver sobre ele,
 * empilhado acima dos que já estão na tela (até 7; o mais antigo sai para dar
 * lugar ao novo); cada um some no seu tempo.
 *
 * @param {string} message Texto a exibir.
 * @param {'info' | 'alert' | 'success' | 'error'} [type='info'] Tipo: `info`
 *     azul claro, `alert` dourado, `success` verde e `error` vermelho.
 */
export function showToast(message, type = 'info') {
    const icon = document.createElement('img');
    icon.className = 'toast-icon';
    icon.src = TOAST_ICONS[type] ?? TOAST_ICONS.info;
    icon.alt = '';
    icon.width = 20;
    icon.height = 20;
    const text = document.createElement('span');
    text.className = 'toast-text';
    text.textContent = message;

    const toast = document.createElement('div');
    toast.className = 'toast';
    if (type !== 'info') toast.classList.add(`toast-${type}`);
    const progress = document.createElement('span');
    progress.className = 'toast-progress';
    toast.append(icon, text, progress);
    while (stack.children.length >= MAX_TOASTS) stack.lastElementChild.remove();
    stack.prepend(toast);

    // Re-open the popover so it goes to the top of the top layer, above a
    // modal dialog opened after the previous toast. Skipped otherwise, because
    // closing the popover restarts every running CSS animation (the bars).
    if (!stack.matches(':popover-open')) stack.showPopover();
    else if (document.querySelector('dialog[open]')) {
        stack.hidePopover();
        stack.showPopover();
    }
    // Force a style flush so the fade-in transition runs from opacity 0.
    void toast.offsetWidth;
    toast.classList.add('visible');

    // The CSS countdown bar drives the lifetime: it pauses while the toast is
    // hovered (see toast.css) and its end triggers the fade-out and removal.
    progress.addEventListener('animationend', () => {
        toast.classList.remove('visible');
        window.setTimeout(() => {
            toast.remove();
            if (!stack.children.length && stack.matches(':popover-open')) stack.hidePopover();
        }, 250);
    });
}
