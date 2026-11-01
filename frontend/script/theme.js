import { showToast } from './main.js';

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
    themeIcon.alt = `${isLight ? 'dark' : 'light'} theme icon`;
    themeToggle.setAttribute('aria-label', `Switch to ${isLight ? 'dark' : 'light'} theme`);
    themeToggle.title = `Switch to ${isLight ? 'dark' : 'light'} theme`;
    themeColor.content = isLight ? mobileTheme.light : mobileTheme.dark;
}

try {
    const savedTheme = localStorage.getItem('deviant-theme');
    if (savedTheme === 'light' || savedTheme === 'dark') applyTheme(savedTheme);
} catch (error) {
    console.error('Could not load the saved theme preference.', error);
    showToast('Theme preference could not be loaded. Using dark theme.');
}

themeToggle.addEventListener('click', () => {
    const theme = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
    applyTheme(theme);
    try {
        localStorage.setItem('deviant-theme', theme);
    } catch (error) {
        console.error('Could not save the theme preference.', error);
        showToast('Theme changed, but your preference could not be saved.');
    }
});