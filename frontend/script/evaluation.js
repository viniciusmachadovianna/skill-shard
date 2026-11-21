/**
 * @file Conjunto de avaliação: exibe as perguntas de `backend/evals/questions.json`.
 *
 * Mostra a distribuição por categoria, filtros por categoria e tag, busca por
 * texto ou nome de documento e, em cada pergunta, os documentos esperados. O
 * botão "Perguntar" copia a pergunta para a caixa de mensagem, sem enviá-la,
 * para que o usuário escolha o modo de recuperação antes.
 */

import { $ } from './utils.js';
import { listEvaluationQuestions } from './api.js';
import { t, onLanguageChange } from './language.js';

/** Ordem de exibição das categorias; as cores ficam em evaluation.css. */
const CATEGORIES = ['simples', 'composta', 'sem_resposta'];

const dialog = $('#evaluation-dialog');
const openButton = $('#evaluation-button');
const closeButton = $('#evaluation-close');
const sidebarStatus = $('#evaluation-status');
const summary = $('#evaluation-summary');
const overview = $('#evaluation-overview');
const bar = $('#evaluation-bar');
const legend = $('#evaluation-legend');
const controls = $('#evaluation-controls');
const searchInput = $('#evaluation-search');
const categoryBar = $('#evaluation-category-filters');
const tagBar = $('#evaluation-tag-filters');
const list = $('#evaluation-list');
const emptyMessage = $('#evaluation-empty');
const promptInput = $('#prompt-input');

let questions = [];
let loading;
let categoryFilter = '';
const activeTags = new Set();

function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

function categoryLabel(category) {
    return t(`evaluation-category-${category}`, category);
}

function tagLabel(tag) {
    return t(`evaluation-tag-${tag}`, tag);
}

function countBy(items, key) {
    const counts = new Map();
    for (const item of items) counts.set(key(item), (counts.get(key(item)) ?? 0) + 1);
    return counts;
}

function renderOverview() {
    const counts = countBy(questions, (question) => question.category);
    bar.replaceChildren(...CATEGORIES.filter((category) => counts.get(category)).map((category) => {
        const segment = element('span', `evaluation-bar-segment is-${category}`);
        segment.style.flexGrow = String(counts.get(category));
        return segment;
    }));

    const subtypes = countBy(
        questions.filter((question) => question.category === 'sem_resposta'),
        (question) => question.subtype
    );
    legend.replaceChildren(...CATEGORIES.map((category) => {
        const item = element('li', `evaluation-legend-item is-${category}`);
        const count = counts.get(category) ?? 0;
        const share = questions.length ? Math.round((count / questions.length) * 100) : 0;
        item.append(
            element('span', 'evaluation-swatch'),
            element('strong', '', categoryLabel(category)),
            element('span', 'evaluation-legend-count', `${count} · ${share}%`)
        );
        if (category === 'sem_resposta' && subtypes.size) {
            const detail = [...subtypes].map(([subtype, n]) => `${n} ${t(`evaluation-subtype-${subtype}`, subtype)}`);
            item.append(element('small', 'evaluation-legend-detail', detail.join(' / ')));
        }
        return item;
    }));

    const answerable = questions.length - (counts.get('sem_resposta') ?? 0);
    summary.textContent = t('evaluation-summary')
        .replace('{count}', String(questions.length))
        .replace('{answerable}', String(answerable));
    sidebarStatus.textContent = t('evaluation-status').replace('{count}', String(questions.length));
    delete sidebarStatus.dataset.i18n;
}

function makeChip(label, pressed, count) {
    const chip = element('button', 'knowledge-filter');
    chip.type = 'button';
    chip.setAttribute('aria-pressed', String(pressed));
    chip.append(element('span', '', label));
    if (count !== undefined) chip.append(element('span', 'knowledge-filter-count', String(count)));
    return chip;
}

function renderFilters() {
    const counts = countBy(questions, (question) => question.category);
    const options = [['', t('knowledge-filter-all'), undefined], ...CATEGORIES.map(
        (category) => [category, categoryLabel(category), counts.get(category) ?? 0]
    )];
    categoryBar.replaceChildren(...options.map(([category, label, count]) => {
        const chip = makeChip(label, categoryFilter === category, count);
        chip.dataset.category = category;
        return chip;
    }));

    const tagCounts = countBy(questions.flatMap((question) => question.tags ?? []), (tag) => tag);
    tagBar.replaceChildren(...[...tagCounts]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([tag, count]) => {
            const chip = makeChip(tagLabel(tag), activeTags.has(tag), count);
            chip.dataset.tag = tag;
            return chip;
        }));
}

function renderExpected(question) {
    const block = element('div', 'evaluation-expected');
    if (!question.expected.length) {
        const subtype = t(`evaluation-subtype-${question.subtype}`, question.subtype);
        block.append(element('span', 'evaluation-expected-none', `${t('evaluation-no-answer')} · ${subtype}`));
        return block;
    }
    block.append(element('span', 'evaluation-expected-label', t('evaluation-expected')));
    question.expected.forEach((group, index) => {
        if (index > 0) block.append(element('span', 'evaluation-joiner', '+'));
        const groupNode = element('span', 'evaluation-group');
        group.forEach((name, nameIndex) => {
            if (nameIndex > 0) groupNode.append(element('span', 'evaluation-joiner', t('evaluation-or')));
            const file = element('code', 'evaluation-file', name);
            file.title = name;
            groupNode.append(file);
        });
        block.append(groupNode);
    });
    return block;
}

function createQuestionItem(question) {
    const item = element('li', `evaluation-question is-${question.category}`);
    item.dataset.id = question.id;

    const meta = element('div', 'evaluation-question-meta');
    meta.append(
        element('span', 'evaluation-id', question.id),
        element('span', 'evaluation-category', categoryLabel(question.category))
    );
    for (const tag of question.tags ?? []) meta.append(element('span', 'evaluation-tag', tagLabel(tag)));

    const askButton = element('button', 'evaluation-ask', t('evaluation-ask'));
    askButton.type = 'button';
    askButton.dataset.question = question.question;

    item.append(meta, element('p', 'evaluation-question-text', question.question), renderExpected(question));
    if (question.note) item.append(element('p', 'evaluation-note', question.note));
    item.append(askButton);
    return item;
}

function matches(question, term) {
    if (categoryFilter && question.category !== categoryFilter) return false;
    if ([...activeTags].some((tag) => !(question.tags ?? []).includes(tag))) return false;
    if (!term) return true;
    const haystack = [question.id, question.question, ...question.expected.flat()].join(' ').toLocaleLowerCase();
    return haystack.includes(term);
}

function renderList() {
    const term = searchInput.value.trim().toLocaleLowerCase();
    const visible = questions.filter((question) => matches(question, term));
    list.replaceChildren(...visible.map(createQuestionItem));
    list.hidden = visible.length === 0;
    emptyMessage.hidden = visible.length > 0;
    emptyMessage.textContent = t('evaluation-no-results');
}

function render() {
    if (!questions.length) return;
    renderOverview();
    renderFilters();
    renderList();
}

function showLoadError() {
    overview.hidden = true;
    controls.hidden = true;
    list.hidden = true;
    summary.textContent = '';
    emptyMessage.hidden = false;
    emptyMessage.textContent = t('evaluation-load-error');
}

/** Carrega as perguntas uma vez; se falhar, tenta de novo na próxima abertura. */
async function loadQuestions() {
    if (questions.length) return;
    loading ??= listEvaluationQuestions()
        .then((data) => {
            questions = data.questions ?? [];
            overview.hidden = false;
            controls.hidden = false;
            render();
        })
        .catch(showLoadError)
        .finally(() => { loading = undefined; });
    return loading;
}

/**
 * Liga o botão da barra lateral e os controles do diálogo.
 *
 * @param {Object} options
 * @param {(message: string, type?: string) => void} options.showToast Exibe avisos curtos.
 */
export function initializeEvaluation({ showToast }) {
    openButton.addEventListener('click', () => {
        if (!dialog.open) dialog.showModal();
        loadQuestions();
    });
    closeButton.addEventListener('click', () => dialog.close());
    dialog.addEventListener('click', (event) => {
        if (event.target === dialog) dialog.close();
    });

    searchInput.addEventListener('input', renderList);
    categoryBar.addEventListener('click', (event) => {
        const chip = event.target.closest('.knowledge-filter');
        if (!chip) return;
        categoryFilter = chip.dataset.category;
        renderFilters();
        renderList();
    });
    tagBar.addEventListener('click', (event) => {
        const chip = event.target.closest('.knowledge-filter');
        if (!chip) return;
        if (activeTags.has(chip.dataset.tag)) activeTags.delete(chip.dataset.tag);
        else activeTags.add(chip.dataset.tag);
        renderFilters();
        renderList();
    });

    list.addEventListener('click', (event) => {
        const button = event.target.closest('.evaluation-ask');
        if (!button) return;
        promptInput.value = button.dataset.question;
        dialog.close();
        if (promptInput.disabled) {
            showToast(t('evaluation-ask-unavailable'));
            return;
        }
        promptInput.focus();
        showToast(t('evaluation-ask-ready'));
    });

    onLanguageChange(render);
    // Preenche o contador da barra lateral sem esperar a primeira abertura.
    loadQuestions();
}
