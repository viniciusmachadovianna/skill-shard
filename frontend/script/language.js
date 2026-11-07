const FALLBACK_LANGUAGE = 'en';
const SUPPORTED_LANGUAGES = ['en', 'pt-BR'];

const translations = {
    en: {
        'system-status': 'LOCAL SYSTEM ONLINE',
        'workspace': 'WORKSPACE',
        'conversations': 'CONVERSATIONS',
        'new-conversation': 'NEW CONVERSATION',
        'new-investigation': 'New investigation',
        'brand-tagline': 'RETRIEVAL AUGMENTED INTELLIGENCE',
        'interface-initialized': 'COGNITIVE INTERFACE INITIALIZED',
        'knowledge-base': 'Knowledge base',
        'documents-available': 'DOCUMENTS AVAILABLE',
        'knowledge-summary': '{count} documents · Stored in this browser',
        'close-knowledge-base': 'Close knowledge base',
        'supported-document-formats': 'TXT / MARKDOWN / CSV / JSON · UP TO 2 MB EACH',
        'knowledge-local-note': 'Stored in this browser. Document retrieval is not connected yet.',
        'knowledge-documents': 'Knowledge base documents',
        'knowledge-empty': 'No documents yet. Add a file to get started.',
        'toggle-document': 'Use {name} in the knowledge base',
        'delete-document': 'Delete {name}',
        'delete-document-title': 'Delete document',
        'document-singular': 'DOCUMENT',
        'document-plural': 'DOCUMENTS',
        'documents-added': '{count} document(s) added to this browser.',
        'document-deleted': 'Document deleted.',
        'unsupported-document-type': '{name}: file type not supported.',
        'document-too-large': '{name}: maximum file size is 2 MB.',
        'knowledge-storage-error': 'Could not access local document storage. Check browser storage permissions and try again.',
        'operator': 'Operator',
        'local-session': 'LOCAL SESSION',
        'knowledge-sources': 'Knowledge sources',
        'source-metric': '00 DOCUMENTS',
        'source-metric-short': '00 DOCUMENTS',
        'objective-label': 'SELECT AN OBJECTIVE',
        'greeting-title': 'What do you',
        'greeting-emphasis': 'want to know?',
        'greeting-subtitle': "Every answer begins with a question. Let's find yours in the knowledge you trust.",
        'objective-analyze': 'Analyze a document',
        'objective-connect': 'Connect the dots',
        'objective-summary': 'Summarize a document',
        'objective-search': 'Search knowledge',
        'prompt-placeholder': 'Analyze the key findings in my documents.',
        'prompt-aria': 'Ask a question',
        'awaiting-input': 'AWAITING YOUR INPUT',
        'backend-checking': 'CHECKING MODEL CONNECTION',
        'backend-ready': 'MODEL CONNECTION READY',
        'backend-config-missing': 'MODEL CONFIGURATION MISSING',
        'backend-model-unavailable': 'MODEL UNAVAILABLE',
        'backend-unavailable': 'BACKEND UNAVAILABLE',
        'backend-check-timeout': 'CONNECTION CHECK TIMED OUT',
        'backend-retry': 'RETRY CHECK',
        'knowledge-base-meta': 'KNOWLEDGE BASE',
        'retrieval-mode-label': 'Select retrieval mode',
        'no-sources': 'NO SOURCES',
        'rag-mode': 'RAG MODE',
        'composer-footnote': 'Answers grounded in your documents. Decisions remain yours.',
        'new-conversation-toast': 'New investigation started.',
        'request-failed': 'Could not get an answer. Check that the backend is running and try again.',
        'assistant': 'ASSISTANT',
        'system-telemetry': 'SYSTEM TELEMETRY',
        'inference-engine': 'Inference engine',
        'chunking-overlap': 'Chunking overlap',
        'lm-model': 'LM Model',
        'conversation-memory': 'Conversation memory',
        'retrieval-protocol': 'Retrieval protocol',
        'not-connected': 'NOT CONNECTED',
        'local': 'LOCAL',
        'standby': 'STANDBY',
        'gemini': 'Gemini',
        'sidebar-collapse': 'Hide workspace sidebar',
        'sidebar-expand': 'Show workspace sidebar',
        'assistant-collapse': 'Hide assistant panel',
        'assistant-expand': 'Show assistant panel',
        'language-toggle': 'Switch language',
        'prompt-analyze': 'Analyze the key findings in my documents.',
        'prompt-connect': 'Connect the dots across my knowledge base.',
        'prompt-summary': 'Give me a concise summary of my documents.',
        'prompt-search': 'Search my knowledge base for a specific topic.'
    },
    'pt-BR': {
        'system-status': 'SISTEMA LOCAL ONLINE',
        'workspace': 'ESPAÇO DE TRABALHO',
        'conversations': 'CONVERSAS',
        'new-conversation': 'NOVA CONVERSA',
        'new-investigation': 'Nova investigação',
        'brand-tagline': 'INTELIGÊNCIA AUMENTADA POR RECUPERAÇÃO',
        'interface-initialized': 'INTERFACE COGNITIVA INICIALIZADA',
        'knowledge-base': 'Base de conhecimento',
        'documents-available': 'DOCUMENTOS DISPONÍVEIS',
        'knowledge-summary': '{count} documento(s) · Armazenados neste navegador',
        'close-knowledge-base': 'Fechar base de conhecimento',
        'supported-document-formats': 'TXT / MARKDOWN / CSV / JSON · ATÉ 2 MB CADA',
        'knowledge-local-note': 'Armazenados neste navegador. A busca nos documentos ainda não está conectada.',
        'knowledge-documents': 'Documentos da base de conhecimento',
        'knowledge-empty': 'Nenhum documento ainda. Adicione um arquivo para começar.',
        'toggle-document': 'Usar {name} na base de conhecimento',
        'delete-document': 'Excluir {name}',
        'delete-document-title': 'Excluir documento',
        'document-singular': 'DOCUMENTO',
        'document-plural': 'DOCUMENTOS',
        'documents-added': '{count} documento(s) adicionado(s) a este navegador.',
        'document-deleted': 'Documento excluído.',
        'unsupported-document-type': '{name}: tipo de arquivo não suportado.',
        'document-too-large': '{name}: o tamanho máximo é 2 MB.',
        'knowledge-storage-error': 'Não foi possível acessar o armazenamento local. Verifique as permissões do navegador e tente novamente.',
        'operator': 'Operador',
        'local-session': 'SESSÃO LOCAL',
        'knowledge-sources': 'Fontes de conhecimento',
        'source-metric': '00 DOCUMENTOS',
        'source-metric-short': '00 DOCUMENTOS',
        'objective-label': 'SELECIONE UM OBJETIVO',
        'greeting-title': 'O que você',
        'greeting-emphasis': 'quer saber?',
        'greeting-subtitle': 'Toda resposta começa com uma pergunta. Vamos encontrar a sua no conhecimento em que você confia.',
        'objective-analyze': 'Analisar um documento',
        'objective-connect': 'Conectar ideias',
        'objective-summary': 'Resumir um documento',
        'objective-search': 'Buscar conhecimento',
        'prompt-placeholder': 'Analise os principais achados dos meus documentos.',
        'prompt-aria': 'Faça uma pergunta',
        'awaiting-input': 'AGUARDANDO SUA ENTRADA',
        'backend-checking': 'VERIFICANDO CONEXÃO COM O MODELO',
        'backend-ready': 'CONEXÃO COM O MODELO PRONTA',
        'backend-config-missing': 'CONFIGURAÇÃO DO MODELO AUSENTE',
        'backend-model-unavailable': 'MODELO INDISPONÍVEL',
        'backend-unavailable': 'BACKEND INDISPONÍVEL',
        'backend-check-timeout': 'TEMPO ESGOTADO AO VERIFICAR CONEXÃO',
        'backend-retry': 'VERIFICAR NOVAMENTE',
        'knowledge-base-meta': 'BASE DE CONHECIMENTO',
        'retrieval-mode-label': 'Selecionar modo de recuperação',
        'no-sources': 'SEM FONTES',
        'rag-mode': 'MODO RAG',
        'composer-footnote': 'Respostas fundamentadas nos seus documentos. As decisões continuam sendo suas.',
        'new-conversation-toast': 'Nova investigação iniciada.',
        'request-failed': 'Não foi possível obter uma resposta. Verifique se o backend está ativo e tente novamente.',
        'assistant': 'ASSISTENTE',
        'system-telemetry': 'TELEMETRIA DO SISTEMA',
        'inference-engine': 'Motor de inferência',
        'chunking-overlap': 'Sobreposição de chunks',
        'lm-model': 'Modelo de IA',
        'conversation-memory': 'Memória da conversa',
        'retrieval-protocol': 'Protocolo de recuperação',
        'not-connected': 'NÃO CONECTADO',
        'local': 'LOCAL',
        'standby': 'EM ESPERA',
        'gemini': 'Gemini',
        'sidebar-collapse': 'Ocultar barra lateral',
        'sidebar-expand': 'Mostrar barra lateral',
        'assistant-collapse': 'Ocultar painel do assistente',
        'assistant-expand': 'Mostrar painel do assistente',
        'language-toggle': 'Alternar idioma',
        'prompt-analyze': 'Analise os principais achados dos meus documentos.',
        'prompt-connect': 'Conecte os pontos ao longo da minha base de conhecimento.',
        'prompt-summary': 'Me dê um resumo conciso dos meus documentos.',
        'prompt-search': 'Pesquise minha base de conhecimento por um tópico específico.'
    }
};

function normalizeLanguage(language) {
    if (language === 'pt-BR') return 'pt-BR';
    return FALLBACK_LANGUAGE;
}

function getStoredLanguage() {
    try {
        const stored = localStorage.getItem('deviant-language');
        return normalizeLanguage(stored);
    } catch (error) {
        return FALLBACK_LANGUAGE;
    }
}

export function getCurrentLanguage() {
    return normalizeLanguage(document.documentElement.dataset.lang || getStoredLanguage());
}

export function t(key, fallback = '') {
    const current = getCurrentLanguage();
    return translations[current]?.[key] ?? translations[FALLBACK_LANGUAGE]?.[key] ?? fallback ?? key;
}

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
        localStorage.setItem('deviant-language', current);
    } catch (error) {
        console.warn('Could not save language preference.', error);
    }
}

export function toggleLanguage() {
    const nextLanguage = getCurrentLanguage() === 'pt-BR' ? 'en' : 'pt-BR';
    applyLanguage(nextLanguage);
    return nextLanguage;
}

export function initializeLanguage() {
    const savedLanguage = getStoredLanguage();
    applyLanguage(savedLanguage);

    const languageToggle = document.getElementById('language-toggle');
    if (!languageToggle) return;

    languageToggle.addEventListener('click', () => {
        toggleLanguage();
    });
}

export const supportedLanguages = SUPPORTED_LANGUAGES;
