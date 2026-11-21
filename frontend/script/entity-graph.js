/**
 * @file Painel do grafo de entidades.
 *
 * Busca o grafo dos documentos ativados (`GET /graph`) e o desenha com a
 * biblioteca vis-network, que o `index.html` carrega como script global. Ao
 * selecionar um nó ou uma ligação, mostra as evidências de origem (de qual
 * item de qual documento a relação foi tirada). Também desenha o subgrafo
 * devolvido por uma resposta do modo `graphrag` e se redesenha quando o tema
 * muda.
 */

/**
 * @typedef {Object} GraphNode
 * @property {string} id
 * @property {string} label
 * @property {string} type `document`, `chunk`, um tipo de entidade de `graph_schema.json`
 *     (`pessoa`, `organizacao`, `local`, `documento`, `evento`, `ativo`) ou um tipo do
 *     grafo de metadados (`knowledge_item`, `project`, `tag`...).
 * @property {string[]} [aliases] Só em entidades: outros nomes do mesmo nó.
 * @property {string} [document_id] Só em `chunk`: documento do trecho.
 * @property {number} [chunk] Só em `chunk`: número do trecho no documento.
 * @property {number | null} [page] Só em `chunk`: página onde o trecho começa.
 */

/**
 * Indica de onde uma relação foi tirada.
 * @typedef {Object} GraphEvidence
 * @property {string} document_id
 * @property {string} document_name
 * @property {string} [title] Título do item de conhecimento (grafo de metadados).
 * @property {string} [source_url] Link da fonte original, quando existe.
 * @property {number} [chunk] Trecho de onde a relação foi tirada.
 * @property {number | null} [page] Página onde o trecho começa.
 * @property {string} [excerpt] Pedaço do texto em volta da menção.
 */

/**
 * @typedef {Object} GraphEdge
 * @property {string} id
 * @property {string} source ID do nó de origem.
 * @property {string} target ID do nó de destino.
 * @property {string} label Relação: `contains`, `mentions`, `cites`, `similar_to`,
 *     `type`, `project`, `product`, `topic` ou `tag`.
 * @property {GraphEvidence[]} evidence
 * @property {number} [weight] Só em `similar_to`: similaridade de cosseno.
 */

/**
 * Grafo de relações entre entidades, como devolvido por `/graph` e `/ask`.
 * @typedef {Object} Graph
 * @property {GraphNode[]} nodes
 * @property {GraphEdge[]} edges
 */

import * as api from './api.js';
import { t } from './language.js';
import { $ } from './utils.js';

const knowledgeDialog = $('#knowledge-dialog');
const refreshButton = $('#entity-graph-refresh');
const fitButton = $('#entity-graph-fit');
const spreadSelect = $('#entity-graph-spread');
const graphCanvas = $('#entity-graph-canvas');
const graphStatus = $('#entity-graph-status');
const graphSummary = $('#entity-graph-summary');
const graphEmpty = $('#entity-graph-empty');
const selectionEmpty = $('#entity-graph-selection-empty');
const selectionDetails = $('#entity-graph-selection');
const selectedLabel = $('#entity-graph-selected-label');
const selectedType = $('#entity-graph-selected-type');
const evidenceList = $('#entity-graph-evidence-list');
const evidenceMore = $('#entity-graph-evidence-more');
const legend = $('#entity-graph-legend');
const MAX_EVIDENCE_ITEMS = 12;
const NODE_LABEL_LINE_LENGTH = 22;
const ORBIT_LAYER_GAP = 180;
const ORBIT_NODE_GAP = 54;
const MIN_ORBIT_RADIUS = 180;

// A ordem também é a da legenda: estrutura, entidades (graph_schema.json) e,
// por último, os tipos do grafo de metadados.
const NODE_SHAPES = {
    document: 'box',
    chunk: 'square',
    pessoa: 'dot',
    organizacao: 'hexagon',
    local: 'triangle',
    documento: 'triangleDown',
    evento: 'star',
    ativo: 'diamond',
    knowledge_item: 'dot',
    document_type: 'triangle',
    project: 'hexagon',
    product: 'diamond',
    topic: 'ellipse',
    tag: 'star'
};

const NODE_SIZES = {
    knowledge_item: 10,
    chunk: 8,
    pessoa: 13,
    organizacao: 13,
    local: 12,
    documento: 12,
    evento: 12,
    ativo: 12
};

// Faixa de cosseno mapeada para a espessura das arestas `similar_to`. Com o
// modelo de embedding atual, os vizinhos ficam entre ~0,77 e ~0,95.
const SIMILARITY_WIDTH_RANGE = { min: 0.75, max: 0.95 };

const SPREAD_MODES = ['orbit', 'clusters', 'balanced', 'even', 'hierarchy'];
const DEFAULT_SPREAD_MODE = 'clusters';
const SPREAD_STORAGE_KEY = 'skill-shard-graph-spread';
const HIDDEN_TYPES_STORAGE_KEY = 'skill-shard-graph-hidden-types';

let network;
let networkSpreadMode;
let spreadMode = readStoredSpreadMode();
let hiddenTypes = readStoredHiddenTypes();
// Grafo completo (do backend ou da resposta) e o subgrafo desenhado, sem os
// tipos ocultos na legenda. Cliques, enquadrar e tema usam o desenhado.
let currentGraph;
let displayedGraph;
let requestId = 0;

function getEnabledDocumentIds() {
    return [...document.querySelectorAll('#knowledge-document-list .knowledge-document')]
        .filter((row) => row.querySelector('input[type="checkbox"]')?.checked)
        .map((row) => row.dataset.documentId)
        .filter(Boolean);
}

function setGraphStatus(message, state) {
    graphStatus.textContent = message;
    graphStatus.dataset.state = state;
}

function showEmptyMessage(key) {
    graphEmpty.dataset.i18n = key;
    graphEmpty.textContent = t(key);
    graphEmpty.hidden = false;
}

function clearSelection() {
    selectionDetails.hidden = true;
    selectionEmpty.hidden = false;
    evidenceList.replaceChildren();
    evidenceMore.hidden = true;
}

function validateGraph(graph) {
    if (!graph || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) {
        throw new Error(t('entity-graph-invalid-data'));
    }

    const nodeIds = new Set();
    for (const node of graph.nodes) {
        if (
            typeof node.id !== 'string'
            || typeof node.label !== 'string'
            || typeof node.type !== 'string'
        ) {
            throw new Error(t('entity-graph-invalid-data'));
        }
        nodeIds.add(node.id);
    }

    for (const edge of graph.edges) {
        if (
            typeof edge.id !== 'string'
            || typeof edge.source !== 'string'
            || typeof edge.target !== 'string'
            || typeof edge.label !== 'string'
            || !Array.isArray(edge.evidence)
            || !nodeIds.has(edge.source)
            || !nodeIds.has(edge.target)
        ) {
            throw new Error(t('entity-graph-invalid-data'));
        }
        if (edge.evidence.some((item) => (
            !item
            || typeof item.document_id !== 'string'
            || typeof item.document_name !== 'string'
            || (item.title != null && typeof item.title !== 'string')
            || (item.chunk != null && !Number.isInteger(item.chunk))
            || (item.title == null && item.chunk == null)
        ))) {
            throw new Error(t('entity-graph-invalid-data'));
        }
    }

    return graph;
}

async function fetchGraph(documentIds) {
    let result;
    try {
        result = await api.getGraph(documentIds);
    } catch (error) {
        if (error instanceof api.ApiError && typeof error.detail !== 'string') {
            throw new Error(`${t('entity-graph-load-error')} (${error.status})`);
        }
        throw error;
    }

    return validateGraph(result);
}

function getGraphColors() {
    const styles = getComputedStyle(document.documentElement);
    const value = (name) => styles.getPropertyValue(name).trim();
    return {
        text: value('--text'),
        muted: value('--muted'),
        edge: value('--graph-edge'),
        document: value('--graph-document'),
        knowledge_item: value('--graph-item'),
        document_type: value('--graph-type'),
        project: value('--graph-project'),
        product: value('--graph-product'),
        topic: value('--graph-topic'),
        tag: value('--graph-tag'),
        chunk: value('--graph-chunk'),
        pessoa: value('--graph-person'),
        organizacao: value('--graph-organization'),
        local: value('--graph-location'),
        documento: value('--graph-act'),
        evento: value('--graph-event'),
        ativo: value('--graph-asset')
    };
}

function wrapNodeLabel(label) {
    const lines = [];
    let line = '';

    label.split(/\s+/).forEach((originalWord) => {
        let word = originalWord;
        while (word.length > NODE_LABEL_LINE_LENGTH) {
            if (line) {
                lines.push(line);
                line = '';
            }
            lines.push(word.slice(0, NODE_LABEL_LINE_LENGTH));
            word = word.slice(NODE_LABEL_LINE_LENGTH);
        }

        if (line && line.length + word.length + 1 > NODE_LABEL_LINE_LENGTH) {
            lines.push(line);
            line = '';
        }
        line = line ? `${line} ${word}` : word;
    });

    if (line) lines.push(line);
    return lines.join('\n');
}

function getOrbitPositions(graph) {
    const adjacency = new Map(graph.nodes.map((node) => [node.id, []]));
    graph.edges.forEach(({ source, target }) => {
        adjacency.get(source).push(target);
        adjacency.get(target).push(source);
    });

    const distances = new Map();
    let remaining = [...graph.nodes];
    let startLevel = 0;

    while (remaining.length) {
        const documentRoots = remaining.filter((node) => node.type === 'document');
        const roots = documentRoots.length
            ? documentRoots
            : [remaining.reduce((best, node) => (
                adjacency.get(node.id).length > adjacency.get(best.id).length ? node : best
            ))];
        const queue = [];

        roots.forEach((root) => {
            distances.set(root.id, startLevel);
            queue.push(root.id);
        });

        for (let index = 0; index < queue.length; index += 1) {
            const nodeId = queue[index];
            adjacency.get(nodeId).forEach((neighborId) => {
                if (distances.has(neighborId)) return;
                distances.set(neighborId, distances.get(nodeId) + 1);
                queue.push(neighborId);
            });
        }

        remaining = graph.nodes.filter((node) => !distances.has(node.id));
        if (remaining.length) {
            startLevel = Math.max(...distances.values()) + 1;
        }
    }

    const layers = new Map();
    graph.nodes.forEach((node) => {
        const level = distances.get(node.id);
        if (!layers.has(level)) layers.set(level, []);
        layers.get(level).push(node);
    });

    const positions = new Map();
    let previousRadius = 0;
    [...layers.entries()].sort(([left], [right]) => left - right).forEach(([level, nodes]) => {
        nodes.sort((left, right) => (
            left.label.localeCompare(right.label) || left.id.localeCompare(right.id)
        ));
        const radius = level === 0 && nodes.length === 1
            ? 0
            : Math.max(
                MIN_ORBIT_RADIUS + Math.max(0, level - 1) * ORBIT_LAYER_GAP,
                (nodes.length * ORBIT_NODE_GAP) / (2 * Math.PI),
                previousRadius + ORBIT_LAYER_GAP
            );
        const angleOffset = -Math.PI / 2;

        nodes.forEach((node, index) => {
            const angle = angleOffset + (2 * Math.PI * index) / nodes.length;
            positions.set(node.id, {
                x: Math.cos(angle) * radius,
                y: Math.sin(angle) * radius
            });
        });
        previousRadius = Math.max(previousRadius, radius);
    });

    return positions;
}

/**
 * Mostra na legenda os tipos de nó presentes no grafo (completo, não só o
 * visível), na ordem de `NODE_SHAPES`, com o ícone no mesmo formato e cor do
 * nó. Cada tipo é um botão que mostra ou oculta os nós daquele tipo
 * (`aria-pressed` = visível). Quando algum tipo está oculto, aparece o botão
 * "mostrar todos". Sem grafo (ou com grafo vazio), a legenda fica escondida.
 * Os rótulos usam `data-i18n`, então acompanham a troca de idioma.
 *
 * @param {Graph | undefined} graph
 */
function updateLegend(graph) {
    const types = new Set(graph?.nodes.map((node) => node.type) ?? []);
    const orderedTypes = [
        ...Object.keys(NODE_SHAPES).filter((type) => types.has(type)),
        ...[...types].filter((type) => !(type in NODE_SHAPES)).sort()
    ];

    const items = orderedTypes.map((type) => {
        const item = document.createElement('button');
        const icon = document.createElement('i');
        const label = document.createElement('span');
        item.type = 'button';
        item.className = 'graph-legend-toggle';
        item.dataset.type = type;
        item.setAttribute('aria-pressed', String(!hiddenTypes.has(type)));
        icon.className = `graph-legend-dot graph-legend-shape-${NODE_SHAPES[type] || 'dot'} graph-type-${type}`;
        icon.setAttribute('aria-hidden', 'true');
        label.dataset.i18n = `entity-graph-type-${type}`;
        label.textContent = t(`entity-graph-type-${type}`, type);
        item.append(icon, label);
        return item;
    });

    if (orderedTypes.some((type) => hiddenTypes.has(type))) {
        const showAll = document.createElement('button');
        showAll.type = 'button';
        showAll.className = 'graph-legend-show-all';
        showAll.dataset.legendAction = 'show-all';
        showAll.dataset.i18n = 'entity-graph-legend-show-all';
        showAll.textContent = t('entity-graph-legend-show-all');
        items.push(showAll);
    }

    legend.replaceChildren(legend.firstElementChild, ...items);
    legend.hidden = !orderedTypes.length;
}

/**
 * Subgrafo sem os tipos ocultos na legenda. Uma aresta só fica se as duas
 * pontas estiverem visíveis.
 *
 * @param {Graph} graph
 * @returns {Graph}
 */
function getVisibleGraph(graph) {
    const nodes = graph.nodes.filter((node) => !hiddenTypes.has(node.type));
    const visibleIds = new Set(nodes.map((node) => node.id));
    return {
        nodes,
        edges: graph.edges.filter((edge) => visibleIds.has(edge.source) && visibleIds.has(edge.target))
    };
}

function updateSummary(graph, visible) {
    const filtered = visible.nodes.length !== graph.nodes.length;
    graphSummary.textContent = t(filtered ? 'entity-graph-summary-filtered' : 'entity-graph-summary')
        .replace('{visibleNodes}', String(visible.nodes.length))
        .replace('{visibleEdges}', String(visible.edges.length))
        .replace('{nodes}', String(graph.nodes.length))
        .replace('{edges}', String(graph.edges.length));
}

function readStoredHiddenTypes() {
    try {
        const stored = JSON.parse(localStorage.getItem(HIDDEN_TYPES_STORAGE_KEY) ?? '[]');
        return new Set(Array.isArray(stored) ? stored.filter((type) => typeof type === 'string') : []);
    } catch {
        return new Set();
    }
}

function storeHiddenTypes() {
    try {
        localStorage.setItem(HIDDEN_TYPES_STORAGE_KEY, JSON.stringify([...hiddenTypes]));
    } catch {
        // Sem armazenamento: o filtro vale só nesta sessão.
    }
}

function setHiddenTypes(nextHiddenTypes) {
    hiddenTypes = nextHiddenTypes;
    storeHiddenTypes();
    clearSelection();
    if (currentGraph?.nodes.length) updateNetwork(currentGraph);
}

function handleLegendClick(event) {
    if (event.target.closest('[data-legend-action="show-all"]')) {
        setHiddenTypes(new Set());
        return;
    }
    const toggle = event.target.closest('.graph-legend-toggle');
    if (!toggle) return;
    const next = new Set(hiddenTypes);
    if (next.has(toggle.dataset.type)) {
        next.delete(toggle.dataset.type);
    } else {
        next.add(toggle.dataset.type);
    }
    setHiddenTypes(next);
}

function getSimilarityWidth(weight) {
    if (typeof weight !== 'number') return 1;
    const { min, max } = SIMILARITY_WIDTH_RANGE;
    const ratio = Math.min(1, Math.max(0, (weight - min) / (max - min)));
    return 0.75 + ratio * 2.5;
}

/**
 * Opções da vis-network para cada modo de dispersão do seletor.
 *
 * - `orbit`: anéis por distância até os arquivos (`getOrbitPositions`), sem
 *   física. Estável e previsível; bom para grafos pequenos.
 * - `clusters`: ForceAtlas2, que aproxima nós ligados e afasta os demais;
 *   evidencia comunidades (contrato, incidente, diretoria).
 * - `balanced`: Barnes-Hut, espaçamento mais uniforme e grupos mais suaves.
 * - `even`: repulsão simples, distâncias quase iguais entre os nós.
 * - `hierarchy`: camadas de cima para baixo seguindo a direção das arestas
 *   (arquivo -> trecho -> entidade).
 *
 * Nos modos com física, a simulação roda até estabilizar e então é desligada
 * (veja `freezeAfterStabilization`), para o desenho parar de se mexer.
 *
 * @param {string} mode
 */
function getSpreadOptions(mode) {
    const stabilization = { enabled: true, iterations: 600, updateInterval: 50, fit: true };
    const options = {
        orbit: { layout: { hierarchical: false }, physics: { enabled: false } },
        clusters: {
            layout: { hierarchical: false, improvedLayout: false },
            physics: {
                enabled: true,
                solver: 'forceAtlas2Based',
                forceAtlas2Based: {
                    gravitationalConstant: -70,
                    centralGravity: 0.01,
                    springLength: 110,
                    springConstant: 0.06,
                    damping: 0.5,
                    avoidOverlap: 0.6
                },
                stabilization
            }
        },
        balanced: {
            layout: { hierarchical: false, improvedLayout: false },
            physics: {
                enabled: true,
                solver: 'barnesHut',
                barnesHut: {
                    gravitationalConstant: -9000,
                    centralGravity: 0.25,
                    springLength: 150,
                    springConstant: 0.03,
                    avoidOverlap: 0.4
                },
                stabilization
            }
        },
        even: {
            layout: { hierarchical: false, improvedLayout: false },
            physics: {
                enabled: true,
                solver: 'repulsion',
                repulsion: { nodeDistance: 170, springLength: 160, centralGravity: 0.15 },
                stabilization
            }
        },
        hierarchy: {
            layout: {
                hierarchical: {
                    enabled: true,
                    direction: 'UD',
                    sortMethod: 'directed',
                    shakeTowards: 'roots',
                    levelSeparation: 140,
                    nodeSpacing: 110,
                    treeSpacing: 160
                }
            },
            physics: { enabled: false }
        }
    };
    return options[mode] ?? options.orbit;
}

function readStoredSpreadMode() {
    try {
        const stored = localStorage.getItem(SPREAD_STORAGE_KEY);
        return SPREAD_MODES.includes(stored) ? stored : DEFAULT_SPREAD_MODE;
    } catch {
        return DEFAULT_SPREAD_MODE;
    }
}

function storeSpreadMode(mode) {
    try {
        localStorage.setItem(SPREAD_STORAGE_KEY, mode);
    } catch {
        // Sem armazenamento (janela privada, por exemplo): a escolha vale só nesta sessão.
    }
}

function freezeAfterStabilization() {
    network.once('stabilizationIterationsDone', () => {
        network.setOptions({ physics: { enabled: false } });
        network.fit({ animation: true });
    });
}

/**
 * @param {Graph} graph
 * @param {Map<string, {x: number, y: number}> | undefined} fixedPositions
 *     Posições a manter (troca de tema). Sem elas, o modo `orbit` calcula os
 *     anéis e os outros modos deixam a vis-network posicionar os nós.
 */
function makeNetworkData(graph, fixedPositions = undefined) {
    const colors = getGraphColors();
    const positions = fixedPositions ?? (
        spreadMode === 'orbit' ? getOrbitPositions(graph) : new Map()
    );
    const nodes = new window.vis.DataSet(graph.nodes.map((node) => {
        const color = colors[node.type] || colors.knowledge_item;
        return {
            ...node,
            ...positions.get(node.id),
            label: wrapNodeLabel(node.label),
            title: node.label,
            shape: NODE_SHAPES[node.type] || 'dot',
            color: {
                background: color,
                border: color,
                highlight: { background: color, border: colors.text },
                hover: { background: color, border: colors.text }
            },
            font: { color: colors.text, face: 'IBM Plex Mono', size: 12 },
            borderWidth: 2,
            size: NODE_SIZES[node.type] ?? 14
        };
    }));
    const edges = new window.vis.DataSet(graph.edges.map((edge) => {
        // Similaridade não tem direção: linha tracejada, sem seta, mais grossa
        // quanto mais parecidos os trechos.
        const similarity = edge.label === 'similar_to';
        return {
            ...edge,
            from: edge.source,
            to: edge.target,
            label: '',
            color: {
                color: colors.edge,
                highlight: colors.knowledge_item,
                hover: colors.knowledge_item
            },
            width: similarity ? getSimilarityWidth(edge.weight) : 1.5,
            hoverWidth: 2,
            dashes: similarity,
            arrows: { to: { enabled: !similarity, scaleFactor: 0.35 } },
            smooth: { type: 'continuous', roundness: 0.15 }
        };
    }));

    return { nodes, edges };
}

function getEvidence(edges) {
    const evidence = new Map();
    edges.flatMap((edge) => edge.evidence).forEach((item) => {
        const key = `${item.document_id}\0${item.chunk ?? ''}\0${item.title ?? ''}\0${item.source_url ?? ''}`;
        evidence.set(key, item);
    });
    return [...evidence.values()];
}

function safeSourceUrl(sourceUrl) {
    if (typeof sourceUrl !== 'string') return undefined;
    try {
        const url = new URL(sourceUrl);
        return ['http:', 'https:'].includes(url.protocol) ? url.href : undefined;
    } catch {
        return undefined;
    }
}

function renderEvidence(items) {
    evidenceList.replaceChildren();
    const visibleItems = items.slice(0, MAX_EVIDENCE_ITEMS);

    visibleItems.forEach((item) => {
        const entry = document.createElement('li');
        const title = document.createElement('strong');
        const source = document.createElement('span');
        const chunkLabel = Number.isInteger(item.chunk)
            ? t('entity-graph-evidence-chunk').replace('{chunk}', String(item.chunk))
            : '';
        const pageLabel = Number.isInteger(item.page)
            ? t('entity-graph-evidence-page').replace('{page}', String(item.page))
            : '';
        title.textContent = item.title || chunkLabel;
        source.textContent = [item.document_name, item.title ? chunkLabel : '', pageLabel]
            .filter(Boolean)
            .join(' · ');
        entry.append(title, source);

        if (item.qualifiers && typeof item.qualifiers === 'object') {
            const qualifiers = Object.entries(item.qualifiers)
                .filter(([, value]) => typeof value === 'string' && value)
                .map(([key, value]) => `${t(`entity-graph-qualifier-${key}`, key)}: ${value}`);
            if (qualifiers.length) {
                const details = document.createElement('span');
                details.className = 'graph-evidence-qualifiers';
                details.textContent = qualifiers.join(' · ');
                entry.append(details);
            }
        }

        if (item.excerpt) {
            const excerpt = document.createElement('span');
            excerpt.className = 'graph-evidence-excerpt';
            excerpt.textContent = item.excerpt;
            entry.append(excerpt);
        }

        const sourceUrl = safeSourceUrl(item.source_url);
        if (sourceUrl) {
            const link = document.createElement('a');
            link.href = sourceUrl;
            link.target = '_blank';
            link.rel = 'noopener noreferrer';
            link.textContent = t('entity-graph-source-link');
            entry.append(link);
        }
        evidenceList.append(entry);
    });

    evidenceMore.hidden = items.length <= MAX_EVIDENCE_ITEMS;
    if (!evidenceMore.hidden) {
        evidenceMore.textContent = t('entity-graph-evidence-more')
            .replace('{count}', String(items.length - MAX_EVIDENCE_ITEMS));
    }
}

function showSelection(label, type, edges, relation = '', weight = undefined) {
    selectedLabel.textContent = label;
    const typeLabel = t(`entity-graph-type-${type}`, type);
    const relationLabel = relation
        ? t(`entity-graph-relation-${relation}`, relation)
        : '';
    const similarityLabel = typeof weight === 'number'
        ? t('entity-graph-similarity').replace('{score}', weight.toFixed(3))
        : '';
    const description = relationLabel ? `${relationLabel} - ${typeLabel}` : typeLabel;
    selectedType.textContent = similarityLabel ? `${description} · ${similarityLabel}` : description;

    const evidence = getEvidence(edges);
    renderEvidence(evidence);
    if (!evidence.length) {
        const emptyEvidence = document.createElement('li');
        emptyEvidence.textContent = t('entity-graph-no-evidence');
        evidenceList.append(emptyEvidence);
    }

    selectionEmpty.hidden = true;
    selectionDetails.hidden = false;
}

function handleGraphClick({ nodes, edges }) {
    if (!displayedGraph) return;
    if (nodes.length) {
        const nodeId = nodes[0];
        const node = displayedGraph.nodes.find((item) => item.id === nodeId);
        const relatedEdges = displayedGraph.edges.filter(
            (edge) => edge.source === nodeId || edge.target === nodeId
        );
        if (node) {
            const aliases = Array.isArray(node.aliases) && node.aliases.length
                ? ` (${node.aliases.join(', ')})`
                : '';
            showSelection(`${node.label}${aliases}`, node.type, relatedEdges);
        }
        return;
    }

    if (edges.length) {
        const edge = displayedGraph.edges.find((item) => item.id === edges[0]);
        if (edge) {
            const source = displayedGraph.nodes.find((item) => item.id === edge.source);
            const target = displayedGraph.nodes.find((item) => item.id === edge.target);
            const arrow = edge.label === 'similar_to' ? '↔' : '→';
            showSelection(
                `${source?.label ?? edge.source} ${arrow} ${target?.label ?? edge.target}`,
                'relation',
                [edge],
                edge.label,
                edge.weight
            );
        }
        return;
    }

    clearSelection();
}

function updateNetwork(graph, fit = true) {
    if (!window.vis?.Network || !window.vis?.DataSet) {
        throw new Error(t('entity-graph-library-unavailable'));
    }

    // Só os tipos visíveis vão para a rede: o layout se refaz com eles, sem
    // buracos onde estavam os nós ocultos.
    const visible = getVisibleGraph(graph);
    displayedGraph = visible;
    updateLegend(graph);
    updateSummary(graph, visible);
    if (graph.nodes.length && !visible.nodes.length) {
        showEmptyMessage('entity-graph-all-hidden');
    } else if (graph.nodes.length) {
        graphEmpty.hidden = true;
    }

    const data = makeNetworkData(visible);
    const spreadOptions = getSpreadOptions(spreadMode);

    // Trocar de modo recria a rede: a vis-network não alterna de forma
    // confiável entre layout hierárquico e livre na mesma instância.
    if (network && networkSpreadMode !== spreadMode) {
        network.destroy();
        network = undefined;
    }

    if (!network) {
        // Criada vazia: os eventos são ligados antes de os dados chegarem, para
        // não perder o fim da estabilização.
        const empty = { nodes: new window.vis.DataSet(), edges: new window.vis.DataSet() };
        network = new window.vis.Network(graphCanvas, empty, {
            autoResize: true,
            interaction: {
                hover: true,
                keyboard: { enabled: true, bindToWindow: false },
                navigationButtons: false,
                tooltipDelay: 150
            },
            ...spreadOptions,
            nodes: { chosen: true },
            edges: { chosen: true }
        });
        networkSpreadMode = spreadMode;
        network.on('click', handleGraphClick);
    } else {
        // Mesmo modo, dados novos: religa a física (se o modo usa) para
        // posicionar os nós novos antes de congelar de novo.
        network.setOptions(spreadOptions);
    }

    if (spreadOptions.physics.enabled) freezeAfterStabilization();
    network.setData(data);
    if (!spreadOptions.physics.enabled && fit) network.fit({ animation: true });
}

function changeSpreadMode(mode) {
    spreadMode = SPREAD_MODES.includes(mode) ? mode : DEFAULT_SPREAD_MODE;
    storeSpreadMode(spreadMode);
    if (currentGraph?.nodes.length) {
        clearSelection();
        updateNetwork(currentGraph);
    }
}

async function openEntityGraph() {
    if (knowledgeDialog.open) knowledgeDialog.close();
    const currentRequestId = ++requestId;
    currentGraph = undefined;
    displayedGraph = undefined;
    fitButton.disabled = true;
    graphSummary.textContent = '';
    updateLegend(undefined);
    clearSelection();
    showEmptyMessage('entity-graph-loading');
    setGraphStatus(t('entity-graph-loading'), 'loading');

    const documentIds = getEnabledDocumentIds();
    if (!documentIds.length) {
        setGraphStatus(t('entity-graph-no-documents'), 'empty');
        showEmptyMessage('entity-graph-no-documents');
        return;
    }

    try {
        const graph = await fetchGraph(documentIds);
        if (currentRequestId !== requestId) return;
        currentGraph = graph;

        if (!graph.nodes.length) {
            setGraphStatus(t('entity-graph-empty-result'), 'empty');
            showEmptyMessage('entity-graph-empty-result');
            return;
        }

        updateNetwork(graph);
        fitButton.disabled = false;
        setGraphStatus(
            graph.edges.length
                ? t('entity-graph-loaded')
                : t('entity-graph-no-relationships'),
            'ready'
        );
    } catch (error) {
        if (currentRequestId !== requestId) return;
        console.error('Could not render the entity graph:', error);
        const detail = error instanceof Error ? error.message : t('entity-graph-load-error');
        setGraphStatus(`${t('entity-graph-load-error')} ${detail}`, 'error');
        showEmptyMessage('entity-graph-load-error');
    }
}

/**
 * Desenha no painel o subgrafo devolvido por uma resposta do modo `graphrag`.
 *
 * Valida o formato antes de desenhar. Em vez de lançar erro, mostra a falha na
 * área do painel: dados inválidos viram uma mensagem de erro, e um grafo vazio
 * vira o aviso de que nenhuma relação foi encontrada nos trechos recuperados.
 *
 * @param {Graph} graph Subgrafo da resposta.
 */
export function renderAnswerGraph(graph) {
    try {
        const validGraph = validateGraph(graph);
        currentGraph = validGraph;
        clearSelection();
        updateNetwork(validGraph);
        fitButton.disabled = validGraph.nodes.length === 0;

        if (!validGraph.nodes.length) {
            setGraphStatus(t('entity-graph-answer-empty'), 'empty');
            showEmptyMessage('entity-graph-answer-empty');
            return;
        }

        setGraphStatus(t('entity-graph-answer-loaded'), 'ready');
    } catch (error) {
        updateLegend(undefined);
        console.error('Could not render the answer entity graph:', error);
        const detail = error instanceof Error ? error.message : t('entity-graph-load-error');
        setGraphStatus(`${t('entity-graph-load-error')} ${detail}`, 'error');
        showEmptyMessage('entity-graph-load-error');
    }
}

/**
 * Liga os botões do painel (ver grafo, atualizar e enquadrar) e o observador
 * de tema. Deve ser chamada uma vez.
 *
 * Ao abrir ou atualizar, o grafo é pedido para os documentos ativados na lista
 * da base de conhecimento; os IDs são lidos direto das caixas de seleção dessa
 * lista no DOM.
 */
export function initializeEntityGraph() {
    refreshButton.addEventListener('click', openEntityGraph);
    fitButton.addEventListener('click', () => network?.fit({
        nodes: displayedGraph?.nodes.map((node) => node.id),
        animation: { duration: 450, easingFunction: 'easeInOutQuad' }
    }));

    spreadSelect.value = spreadMode;
    spreadSelect.addEventListener('change', () => changeSpreadMode(spreadSelect.value));
    legend.addEventListener('click', handleLegendClick);

    const themeObserver = new MutationObserver(() => {
        if (!network || !displayedGraph) return;
        // Mantém as posições atuais: só as cores mudam com o tema.
        const positions = new Map(Object.entries(network.getPositions()));
        network.setOptions({ physics: { enabled: false } });
        network.setData(makeNetworkData(displayedGraph, positions));
    });
    themeObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['data-theme']
    });
}
