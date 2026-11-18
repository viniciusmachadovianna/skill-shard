/**
 * @file Internacionalização (inglês e português do Brasil).
 *
 * Importa os dicionários de `locales/` e aplica o idioma escolhido na página.
 * Textos fixos do HTML usam os atributos `data-i18n`, `data-i18n-placeholder`,
 * `data-i18n-aria` e `data-i18n-title`; textos criados em JavaScript usam
 * `t(chave)`. O idioma escolhido fica salvo no `localStorage` (chave
 * `skill-shard-language`). Toda chave nova precisa existir nos dois idiomas.
 */

import en from './locales/en.js';
import ptBR from './locales/pt-BR.js';

/**
 * Código de um idioma disponível.
 * @typedef {'en' | 'pt-BR'} Language
 */

const FALLBACK_LANGUAGE = 'en';
const SUPPORTED_LANGUAGES = ['en', 'pt-BR'];

const translations = { en, 'pt-BR': ptBR };

function normalizeLanguage(language) {
    if (language === 'pt-BR') return 'pt-BR';
    return FALLBACK_LANGUAGE;
}

function getStoredLanguage() {
    try {
        const stored = localStorage.getItem('skill-shard-language');
        return normalizeLanguage(stored);
    } catch (error) {
        return FALLBACK_LANGUAGE;
    }
}

/**
 * Devolve o idioma em uso: o aplicado na página ou, se ainda não houver, o
 * salvo no navegador (inglês por padrão).
 *
 * @returns {Language}
 */
export function getCurrentLanguage() {
    return normalizeLanguage(document.documentElement.dataset.lang || getStoredLanguage());
}

/**
 * Traduz uma chave para o idioma atual.
 *
 * Se a chave não existir no idioma atual, usa o inglês. Se não existir em
 * nenhum, devolve `fallback`, que por padrão é uma string vazia (e não a
 * própria chave).
 *
 * @param {string} key Chave do dicionário, por exemplo `'send-message'`.
 * @param {string} [fallback=''] Texto devolvido quando a chave não existe.
 * @returns {string}
 */
export function t(key, fallback = '') {
    const current = getCurrentLanguage();
    return translations[current]?.[key] ?? translations[FALLBACK_LANGUAGE]?.[key] ?? fallback ?? key;
}

/**
 * Aplica um idioma à página inteira e salva a escolha.
 *
 * Atualiza os atributos `lang` e `data-lang` do `<html>` e traduz os elementos
 * marcados com `data-i18n` (texto), `data-i18n-placeholder`, `data-i18n-aria`
 * (`aria-label`), `data-i18n-title` e `data-prompt-key` (preenche
 * `data-prompt`, a pergunta que os cartões de objetivo inserem no campo de
 * texto). Elementos cuja chave não existe no dicionário ficam como estão.
 *
 * Não avisa os ouvintes de `onLanguageChange`; só `toggleLanguage` faz isso.
 *
 * @param {Language} [language] Idioma desejado; por padrão, o salvo no navegador.
 */
export function applyLanguage(language = getStoredLanguage()) {
    const current = normalizeLanguage(language);
    document.documentElement.dataset.lang = current;
    document.documentElement.lang = current === 'pt-BR' ? 'pt-BR' : 'en';

    const dict = translations[current];

    document.querySelectorAll('[data-i18n]').forEach((element) => {
        const key = element.dataset.i18n;
        const value = dict[key];
        if (!value) return;
        element.textContent = value;
    });

    document.querySelectorAll('[data-i18n-placeholder]').forEach((element) => {
        const key = element.dataset.i18nPlaceholder;
        const value = dict[key];
        if (!value) return;
        element.placeholder = value;
    });

    document.querySelectorAll('[data-i18n-aria]').forEach((element) => {
        const key = element.dataset.i18nAria;
        const value = dict[key];
        if (!value) return;
        element.setAttribute('aria-label', value);
    });

    document.querySelectorAll('[data-i18n-title]').forEach((element) => {
        const key = element.dataset.i18nTitle;
        const value = dict[key];
        if (!value) return;
        element.title = value;
    });

    document.querySelectorAll('[data-prompt-key]').forEach((element) => {
        const key = element.dataset.promptKey;
        const value = dict[key];
        if (!value) return;
        element.dataset.prompt = value;
    });

    try {
        localStorage.setItem('skill-shard-language', current);
    } catch (error) {
        console.warn('Could not save language preference.', error);
    }
}

const languageChangeListeners = [];

/**
 * Registra uma função para ser chamada quando o usuário trocar de idioma.
 *
 * Serve para atualizar textos que o JavaScript gera em tempo de execução e que
 * o `applyLanguage` não alcança. A função é chamada depois que a página já foi
 * traduzida e recebe o novo idioma. Não há como remover o ouvinte.
 *
 * @param {(language: Language) => void} listener
 */
export function onLanguageChange(listener) {
    languageChangeListeners.push(listener);
}

/**
 * Alterna entre inglês e português do Brasil, aplica o novo idioma e avisa os
 * ouvintes registrados com `onLanguageChange`.
 *
 * @returns {Language} O novo idioma.
 */
export function toggleLanguage() {
    const nextLanguage = getCurrentLanguage() === 'pt-BR' ? 'en' : 'pt-BR';
    applyLanguage(nextLanguage);
    languageChangeListeners.forEach((listener) => listener(nextLanguage));
    return nextLanguage;
}

/**
 * Aplica o idioma salvo e liga o botão `#language-toggle` à troca de idioma.
 * Deve ser chamada uma vez, quando o DOM estiver pronto.
 */
export function initializeLanguage() {
    const savedLanguage = getStoredLanguage();
    applyLanguage(savedLanguage);

    const languageSelect = document.getElementById('language-select');
    if (!languageSelect) return;

    languageSelect.value = getCurrentLanguage();
    languageSelect.addEventListener('change', () => {
        const next = normalizeLanguage(languageSelect.value);
        if (next === getCurrentLanguage()) return;
        applyLanguage(next);
        languageChangeListeners.forEach((listener) => listener(next));
    });
}

/**
 * Códigos dos idiomas disponíveis.
 * @type {Language[]}
 */
export const supportedLanguages = SUPPORTED_LANGUAGES;
