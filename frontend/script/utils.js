/**
 * @file Atalhos para consultar o DOM.
 */

/**
 * Atalho para `document.querySelector`.
 * @param {string} selector Seletor CSS.
 * @returns {Element | null} O primeiro elemento encontrado, ou `null`.
 */
export const $ = (selector) => document.querySelector(selector);

/**
 * Atalho para `document.querySelectorAll`.
 * @param {string} selector Seletor CSS.
 * @returns {NodeListOf<Element>} Todos os elementos encontrados.
 */
export const $$ = (selector) => document.querySelectorAll(selector);
