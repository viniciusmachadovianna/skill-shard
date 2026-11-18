import { showToast } from './main.js';
import { t } from './language.js';

const themeToggle = document.getElementById('theme-toggle');
const themeIcon = document.getElementById('theme-icon');
const themeColor = document.querySelector('meta[name="theme-color"]');
const mobileTheme = {
    light: '#f1f5f7',
    dark: '#080b0e'
}
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
    showToast(t('theme-load-error'));
}

themeToggle.addEventListener('click', () => {
    const theme = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
    applyTheme(theme);
    try {
        localStorage.setItem('skill-shard-theme', theme);
    } catch (error) {
        console.error('Could not save the theme preference.', error);
        showToast(t('theme-save-error'));
    }
});