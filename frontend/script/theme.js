/**
 * @file Tema claro e escuro.
 *
 * Aplica o tema, guarda a preferência no `localStorage` (chave
 * `skill-shard-theme`) e atende o botão `#theme-toggle`. Ao ser importado, o
 * módulo já lê a preferência salva e registra o clique do botão.
 */

import { showToast } from './toast.js';
import { t } from './language.js';

const themeToggle = document.getElementById('theme-toggle');
const themeIcon = document.getElementById('theme-icon');
const themeColor = document.querySelector('meta[name="theme-color"]');
const mobileTheme = {
    light: '#f1f5f7',
    dark: '#080b0e'
}
/**
 * Aplica um tema: define `data-theme` no `<html>`, troca o ícone do botão,
 * atualiza o rótulo dele (traduzido) e a cor da barra do navegador em
 * dispositivos móveis. Não salva a preferência.
 *
 * @param {'light' | 'dark'} [theme] Qualquer valor diferente de `'light'`,
 *     inclusive nenhum, aplica o tema escuro.
 */
export function applyTheme(theme) {
    const isLight = theme === 'light';
    document.documentElement.dataset.theme = isLight ? 'light' : 'dark';
    const iconPath = isLight ? 'assets/icons/dark_mode.svg' : 'assets/icons/light_mode.svg';
    themeIcon.src = iconPath;
    const switchKey = isLight ? 'theme-switch-to-dark' : 'theme-switch-to-light';
    themeToggle.dataset.i18nAria = switchKey;
    themeToggle.dataset.i18nTitle = switchKey;
    themeToggle.setAttribute('aria-label', t(switchKey));
    themeToggle.title = t(switchKey);
    themeColor.content = isLight ? mobileTheme.light : mobileTheme.dark;
}

try {
    const savedTheme = localStorage.getItem('skill-shard-theme');
    if (savedTheme === 'light' || savedTheme === 'dark') applyTheme(savedTheme);
} catch (error) {
    console.error('Could not load the saved theme preference.', error);
    showToast(t('theme-load-error'), 'error');
}

themeToggle.addEventListener('click', () => {
    const theme = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
    applyTheme(theme);
    try {
        localStorage.setItem('skill-shard-theme', theme);
    } catch (error) {
        console.error('Could not save the theme preference.', error);
        showToast(t('theme-save-error'), 'error');
    }
});