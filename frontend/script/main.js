const composer = document.querySelector('#composer');
const promptInput = document.querySelector('#prompt-input');
const conversationOutput = document.querySelector('#conversation-output');
const workArea = document.querySelector('#work-area');
const toast = document.querySelector('#toast');
const fileInput = document.querySelector('#file-input');
const sidebar = document.querySelector('.sidebar');
const assistantPanel = document.querySelector('.assistant-panel');
const sidebarToggle = document.querySelector('.sidebar-toggle');
const assistantToggle = document.querySelector('.assistant-toggle');
const appShell = document.querySelector('.app-shell');
let toastTimeout;
const themeToggle = document.querySelector('#theme-toggle');
const themeColor = document.querySelector('meta[name="theme-color"]');
const conversationList = document.querySelector('.sidebar-top');
const conversationCount = document.querySelector('#conversation-count');

function showToast(message) {
    toast.textContent = message;
    toast.classList.add('visible');
    window.clearTimeout(toastTimeout);
    toastTimeout = window.setTimeout(() => toast.classList.remove('visible'), 3200);
}

function addMessage(label, message, className = '') {
    const article = document.createElement('article');
    article.className = `chat-message ${className}`.trim();
    const caption = document.createElement('small');
    caption.textContent = label;
    const body = document.createElement('div');
    body.textContent = message;
    article.append(caption, body);
    conversationOutput.append(article);
}

function applyTheme(theme) {
    const isLight = theme === 'light';
    document.documentElement.dataset.theme = isLight ? 'light' : 'dark';
    themeToggle.textContent = isLight ? '☾' : '☼';
    themeToggle.setAttribute('aria-label', `Switch to ${isLight ? 'dark' : 'light'} theme`);
    themeToggle.title = `Switch to ${isLight ? 'dark' : 'light'} theme`;
    themeColor.content = isLight ? '#f1f5f7' : '#080b0e';
}

function syncSidebarState() {
    const leftHidden = sidebar.classList.contains('is-collapsed');
    const rightHidden = assistantPanel.classList.contains('is-collapsed');
    appShell.classList.toggle('sidebar-collapsed', leftHidden);
    appShell.classList.toggle('assistant-collapsed', rightHidden);
    sidebarToggle.textContent = leftHidden ? '⟩' : '⟨';
    sidebarToggle.setAttribute('aria-label', leftHidden ? 'Show workspace sidebar' : 'Hide workspace sidebar');
    sidebarToggle.title = leftHidden ? 'Show workspace sidebar' : 'Hide workspace sidebar';
    assistantToggle.textContent = rightHidden ? '⟨' : '⟩';
    assistantToggle.setAttribute('aria-label', rightHidden ? 'Show assistant panel' : 'Hide assistant panel');
    assistantToggle.title = rightHidden ? 'Show assistant panel' : 'Hide assistant panel';
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

document.querySelectorAll('.objective-card').forEach((card) => {
    card.addEventListener('click', () => {
        promptInput.value = card.dataset.prompt;
        promptInput.focus();
    });
});

composer.addEventListener('submit', (event) => {
    event.preventDefault();
    const message = promptInput.value.trim();
    if (!message) {
        promptInput.focus();
        return;
    }

    addMessage('OPERATOR / RK-900', message);
    addMessage(
        'RK-900 / SYSTEM',
        'The interface is ready, but no inference engine is connected yet. Add a retrieval and language-model backend to receive grounded answers.',
        'assistant-reply'
    );
    promptInput.value = '';
    workArea.scrollTo({ top: workArea.scrollHeight, behavior: 'smooth' });
});

sidebarToggle.addEventListener('click', () => {
    sidebar.classList.toggle('is-collapsed');
    syncSidebarState();
});

assistantToggle.addEventListener('click', () => {
    assistantPanel.classList.toggle('is-collapsed');
    syncSidebarState();
});

syncSidebarState();

conversationList.addEventListener('click', (event) => {
    const newConversationButton = event.target.closest('.new-conversation');

    if (newConversationButton) {
        const conversation = document.createElement('button');
        conversation.type = 'button';
        conversation.className = 'conversation-item active';

        const icon = document.createElement('span');
        icon.className = 'chat-icon';
        icon.textContent = '▱';
        const title = document.createElement('span');
        title.textContent = 'New investigation';
        conversation.append(icon, title);
        conversationList.append(conversation);
        conversationList.querySelectorAll('.conversation-item').forEach((item) => {
            item.classList.toggle('active', item === conversation);
        });

        conversationOutput.replaceChildren();
        promptInput.value = '';
        document.querySelector('#workspace-title').textContent = 'New investigation';
        conversationCount.textContent = String(conversationList.querySelectorAll('.conversation-item').length).padStart(2, '0');
        showToast('New investigation started.');
    }
});

document.querySelector('.scroll-cue').addEventListener('click', () => {
    document.querySelector('.composer').scrollIntoView({ behavior: 'smooth', block: 'center' });
    promptInput.focus({ preventScroll: true });
});

document.querySelector('#knowledge-button').addEventListener('click', () => fileInput.click());

fileInput.addEventListener('change', () => {
    const count = fileInput.files.length;
    if (!count) return;
    document.querySelector('#document-count').textContent = String(count);
    document.querySelector('#source-metric').textContent = `${String(count).padStart(2, '0')} DOCUMENT${count === 1 ? '' : 'S'}`;
    showToast(`${count} document${count === 1 ? '' : 's'} selected locally. Connect a retrieval backend to index them.`);
});

document.querySelector('#export-button').addEventListener('click', () => {
    const messages = [...conversationOutput.querySelectorAll('.chat-message')].map((message) => {
        const [label, ...body] = message.innerText.split('\n');
        return `${label}\n${body.join('\n')}`;
    });
    if (!messages.length) {
        showToast('There are no messages to export yet.');
        return;
    }
    const file = new Blob([messages.join('\n\n')], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(file);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'deviant-investigation.txt';
    link.click();
    URL.revokeObjectURL(url);
});

document.querySelector('.help-button').addEventListener('click', () => {
    showToast('DEVIANT is a local interface prototype. No documents leave this device.');
});