/**
 * @file Aviso temporário (toast) exibido na tela.
 *
 * Fica em um módulo próprio, que depende apenas de `utils.js`, para que
 * qualquer módulo possa usá-lo sem criar importações circulares. Em especial,
 * `theme.js` é executado antes de `main.js` e já pode precisar de um aviso.
 */

import { $ } from './utils.js';

const toast = $('#toast');
let toastTimeout;

/**
 * Mostra uma mensagem por 3,2 segundos. Uma nova chamada substitui a mensagem
 * atual e reinicia a contagem.
 *
 * @param {string} message Texto a exibir.
 * @param {'info' | 'error' | 'alert'} [type='info'] Gravidade: `error` ganha
 *     borda vermelha e `alert` borda dourada.
 */
export function showToast(message, type = 'info') {
    toast.textContent = message;
    toast.classList.toggle('toast-error', type === 'error');
    toast.classList.toggle('toast-alert', type === 'alert');
    toast.classList.add('visible');
    window.clearTimeout(toastTimeout);
    toastTimeout = window.setTimeout(() => toast.classList.remove('visible'), 3200);
}
