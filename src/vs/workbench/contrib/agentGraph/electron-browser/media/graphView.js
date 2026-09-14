/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
(function () {
	// @ts-ignore
	const vscode = acquireVsCodeApi();
	// @ts-ignore
	cytoscape.use(cytoscapeFcose);

	const style = getComputedStyle(document.body);
	const themeColor = name => style.getPropertyValue(name).trim() || undefined;

	const TYPE_COLORS = {
		session: themeColor('--vscode-charts-purple') || '#b180d7',
		prompt: themeColor('--vscode-charts-blue') || '#3794ff',
		tool: themeColor('--vscode-charts-orange') || '#d18616',
		file: themeColor('--vscode-charts-green') || '#89d185',
		command: themeColor('--vscode-charts-yellow') || '#cca700',
		task: themeColor('--vscode-charts-red') || '#f14c4c',
		url: themeColor('--vscode-charts-foreground') || '#cccccc'
	};

	// @ts-ignore
	const cy = cytoscape({
		container: document.getElementById('graph'),
		wheelSensitivity: 0.2,
		style: [
			{
				selector: 'node',
				style: {
					'label': 'data(label)',
					'font-size': '9px',
					'min-zoomed-font-size': 8,
					'color': themeColor('--vscode-foreground') || '#ccc',
					'text-valign': 'bottom',
					'text-margin-y': 4,
					'width': 'data(size)',
					'height': 'data(size)',
					'opacity': 'data(op)',
					'background-color': ele => TYPE_COLORS[ele.data('kind')] || '#888'
				}
			},
			{
				selector: 'node[kind="session"]',
				style: { 'font-size': '11px', 'text-wrap': 'wrap', 'text-max-width': '140px' }
			},
			{
				selector: 'edge',
				style: {
					'width': ele => Math.min(4, 1 + Math.log(ele.data('n') || 1)),
					'line-color': themeColor('--vscode-panel-border') || '#555',
					'target-arrow-shape': 'triangle',
					'target-arrow-color': themeColor('--vscode-panel-border') || '#555',
					'arrow-scale': 0.7,
					'curve-style': 'bezier'
				}
			},
			{
				selector: 'edge:selected',
				style: {
					'label': 'data(rel)',
					'font-size': '8px',
					'color': themeColor('--vscode-foreground') || '#ccc',
					'text-background-color': themeColor('--vscode-editor-background') || '#1e1e1e',
					'text-background-opacity': 0.85,
					'text-background-padding': '2px',
					'width': 2,
					'line-color': themeColor('--vscode-focusBorder') || '#007fd4',
					'target-arrow-color': themeColor('--vscode-focusBorder') || '#007fd4'
				}
			},
			{
				selector: 'node:selected',
				style: { 'border-width': 2, 'border-color': themeColor('--vscode-focusBorder') || '#007fd4' }
			},
			{
				selector: '.search-hit',
				style: { 'border-width': 3, 'border-color': themeColor('--vscode-charts-yellow') || '#cca700' }
			},
			{
				selector: '.kind-dimmed',
				style: { 'opacity': 0.12 }
			}
		]
	});

	const sessionFilter = /** @type {HTMLSelectElement} */ (document.getElementById('sessionFilter'));
	const liveToggle = /** @type {HTMLInputElement} */ (document.getElementById('liveToggle'));
	const stats = /** @type {HTMLElement} */ (document.getElementById('stats'));
	const searchInput = /** @type {HTMLInputElement} */ (document.getElementById('search'));
	const legendEl = /** @type {HTMLElement} */ (document.getElementById('legend'));
	const inspectorEl = /** @type {HTMLElement} */ (document.getElementById('inspector'));

	let lastData = { snapshot: { nodes: [], edges: [] }, sessions: [] };
	const dimmedKinds = new Set();
	let presentKinds = new Set();

	// A synchronous fcose layout over the full store freezes the webview for
	// minutes once the event DB grows (62s for ~7.7k elements measured), so
	// the view is layered: an overview of sessions and task cards, and a
	// per-session drill-down whose command nodes are bucketed and whose
	// edges are capped at the most recent MAX_EDGES. Live refreshes are
	// rate-limited and skipped when nothing changed.
	const MAX_EDGES = 1000;
	const LIVE_RENDER_INTERVAL = 3000;
	const FEED_MAX = 200;
	let liveRenderTimer;
	let lastRenderTs = 0;
	let hasLayout = false;

	const view = { mode: 'overview', sessionId: '', feedOpen: true };
	let recentEvents = [];
	const sessionEvents = new Map(); // sessionId -> Map<eventId, event>
	const pendingEventRequests = new Set();
	const promptTexts = new Map(); // promptId -> full prompt text
	let bucketIndex = { byBucket: new Map(), keyToBucket: new Map() };
	let lastKeepSet = null;
	const sessionLabels = new Map(); // sessionId -> 'source · id8'

	function nodeId(type, key) {
		return type + ':' + key;
	}

	function truncate(text, length) {
		return text.length > length ? text.slice(0, length - 1) + '…' : text;
	}

	function basename(path) {
		return path.split('/').pop() || path;
	}

	function relTime(ts) {
		const diff = Date.now() - ts;
		if (diff < 60e3) {
			return 'now';
		}
		if (diff < 3600e3) {
			return Math.floor(diff / 60e3) + 'm ago';
		}
		if (diff < 86400e3) {
			return Math.floor(diff / 3600e3) + 'h ago';
		}
		return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
	}

	function timeShort(ts) {
		return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
	}

	// ---------- State persistence ----------

	function saveState() {
		vscode.setState({ mode: view.mode, sessionId: view.sessionId, feedOpen: view.feedOpen, dimmedKinds: [...dimmedKinds] });
	}

	function restoreState() {
		const state = vscode.getState();
		if (!state) {
			return;
		}
		if (state.mode === 'session' && typeof state.sessionId === 'string' && state.sessionId) {
			view.mode = 'session';
			view.sessionId = state.sessionId;
		}
		if (typeof state.feedOpen === 'boolean') {
			view.feedOpen = state.feedOpen;
		}
		if (Array.isArray(state.dimmedKinds)) {
			for (const kind of state.dimmedKinds) {
				dimmedKinds.add(kind);
			}
		}
	}

	// ---------- Chrome (breadcrumb, feed panel, empty state) ----------

	const toolbarEl = /** @type {HTMLElement} */ (document.getElementById('toolbar'));
	const breadcrumbEl = document.createElement('div');
	const feedToggleEl = document.createElement('button');
	const feedEl = document.createElement('aside');
	const feedTitleEl = document.createElement('div');
	const feedListEl = document.createElement('ol');
	const emptyStateEl = document.createElement('div');

	function buildChrome() {
		breadcrumbEl.id = 'breadcrumb';
		toolbarEl.insertBefore(breadcrumbEl, sessionFilter);

		feedToggleEl.id = 'feedToggle';
		feedToggleEl.textContent = 'Feed';
		feedToggleEl.title = 'Toggle activity feed';
		toolbarEl.insertBefore(feedToggleEl, stats);
		feedToggleEl.addEventListener('click', toggleFeed);

		feedEl.id = 'feed';
		feedTitleEl.className = 'feed-title';
		feedTitleEl.textContent = 'Activity';
		feedListEl.id = 'feedList';
		feedEl.appendChild(feedTitleEl);
		feedEl.appendChild(feedListEl);
		document.body.appendChild(feedEl);
		feedListEl.addEventListener('click', e => {
			const entry = /** @type {HTMLElement} */ (e.target instanceof Element ? e.target.closest('.feed-entry') : null);
			if (entry) {
				focusNodeFromFeed(entry.dataset.target, entry.dataset.session, entry);
			}
		});

		emptyStateEl.id = 'emptyState';
		emptyStateEl.hidden = true;
		document.body.appendChild(emptyStateEl);

		sessionFilter.options[0].textContent = 'Overview';
	}

	function updateBreadcrumb() {
		breadcrumbEl.textContent = '';
		const overviewButton = document.createElement('button');
		overviewButton.className = 'crumb';
		overviewButton.textContent = 'Overview';
		overviewButton.disabled = view.mode === 'overview';
		overviewButton.addEventListener('click', () => setMode('overview', ''));
		breadcrumbEl.appendChild(overviewButton);
		if (view.mode === 'session') {
			const sep = document.createElement('span');
			sep.className = 'crumb-sep';
			sep.textContent = '›';
			breadcrumbEl.appendChild(sep);
			const current = document.createElement('span');
			current.className = 'crumb-current';
			current.textContent = sessionLabels.get(view.sessionId) || view.sessionId.slice(0, 8);
			breadcrumbEl.appendChild(current);
		}
	}

	function toggleFeed() {
		view.feedOpen = !view.feedOpen;
		document.body.classList.toggle('feed-open', view.feedOpen);
		cy.resize();
		if (view.feedOpen) {
			renderFeed();
		}
		saveState();
	}

	// ---------- Mode transitions ----------

	function setMode(mode, sessionId) {
		view.mode = mode === 'session' && sessionId ? 'session' : 'overview';
		view.sessionId = view.mode === 'session' ? sessionId : '';
		if (sessionFilter.value !== view.sessionId) {
			sessionFilter.value = view.sessionId;
		}
		cy.elements().remove();
		hasLayout = false;
		if (view.mode === 'session') {
			requestSessionEvents(view.sessionId);
		}
		closeInspector();
		render();
		saveState();
	}

	// ---------- Events (host round trip) ----------

	function requestSessionEvents(sessionId) {
		if (pendingEventRequests.has(sessionId)) {
			return;
		}
		pendingEventRequests.add(sessionId);
		vscode.postMessage({ type: 'getEvents', sessionId });
	}

	function absorbEvents(events) {
		for (const event of events) {
			if (!event || typeof event.sessionId !== 'string' || typeof event.id !== 'string') {
				continue;
			}
			let map = sessionEvents.get(event.sessionId);
			if (!map) {
				map = new Map();
				sessionEvents.set(event.sessionId, map);
			}
			map.set(event.id, event);
			if (event.verb === 'prompt.submit' && typeof event.promptId === 'string'
				&& event.payload && typeof event.payload.prompt === 'string') {
				promptTexts.set(event.promptId, event.payload.prompt);
			}
		}
	}

	// ---------- Command bucketing ----------

	function commandBucket(command) {
		let s = command.trim();
		for (let i = 0; i < 5; i++) {
			const before = s;
			s = s.replace(/^[A-Za-z_][A-Za-z0-9_]*=("[^"]*"|'[^']*'|\S*)\s+/, '');
			s = s.replace(/^(sudo|env|command|exec|nohup|time)\s+(-\S+\s+)*/, '');
			if (/^cd\s/.test(s)) {
				const sep = /&&|;/.exec(s);
				if (sep) {
					s = s.slice(sep.index + sep[0].length).trim();
					continue;
				}
			}
			s = s.replace(/^[({\s]+/, '');
			if (s === before) {
				break;
			}
		}
		let token = s.split(/\s+/)[0] || '';
		token = token.split('/').pop() || token;
		token = token.replace(/["'`;()]+$/g, '');
		return token || 'shell';
	}

	// ---------- Element building ----------

	function buildOverviewElements() {
		const { snapshot, sessions } = lastData;
		const elements = [];
		const kinds = new Set();
		for (const session of sessions) {
			kinds.add('session');
			elements.push({
				group: 'nodes', data: {
					id: nodeId('session', session.sessionId),
					label: `${session.source} · ${session.sessionId.slice(0, 8)}\n${relTime(session.lastTs)} · ${session.eventCount} ev`,
					kind: 'session', key: session.sessionId,
					firstSeen: session.firstTs, lastSeen: session.lastTs,
					degreeBoost: Math.log2(session.eventCount + 1)
				}
			});
		}
		const taskNodes = snapshot.nodes.filter(node => node.type === 'task');
		for (const node of taskNodes) {
			kinds.add('task');
			elements.push({
				group: 'nodes', data: {
					id: nodeId('task', node.key), label: node.label, kind: 'task', key: node.key,
					firstSeen: node.firstSeen, lastSeen: node.lastSeen
				}
			});
		}
		const nodeIds = new Set(elements.map(element => element.data.id));

		// Prompts belong to sessions via the 'submitted' edges; use that to
		// attribute prompt→task edges to their owning session
		const promptSession = new Map();
		for (const edge of snapshot.edges) {
			if (edge.rel === 'submitted' && edge.fromType === 'session' && edge.toType === 'prompt') {
				promptSession.set(edge.toKey, edge.fromKey);
			}
		}
		const seenEdges = new Set();
		for (const edge of snapshot.edges) {
			if (edge.toType !== 'task') {
				continue;
			}
			let source;
			let rel;
			if (edge.fromType === 'task') {
				source = nodeId('task', edge.fromKey);
				rel = edge.rel;
			} else {
				const sessionKey = edge.fromType === 'session' ? edge.fromKey
					: edge.fromType === 'prompt' ? promptSession.get(edge.fromKey) : undefined;
				if (!sessionKey) {
					continue;
				}
				source = nodeId('session', sessionKey);
				rel = 'touched';
			}
			const target = nodeId('task', edge.toKey);
			const id = source + '->' + target + ':' + rel;
			if (!seenEdges.has(id) && nodeIds.has(source) && nodeIds.has(target) && source !== target) {
				seenEdges.add(id);
				elements.push({ group: 'edges', data: { id, source, target, rel, n: 1 } });
			}
		}
		return {
			elements,
			presentKinds: kinds,
			statsText: `${sessions.length} sessions · ${taskNodes.length} task cards`
		};
	}

	function buildSessionElements(sessionId) {
		const { snapshot } = lastData;

		// Keep only nodes reachable from the session. Tool nodes are shared
		// hubs (tool→file/command edges span every session), so never expand
		// through them — their edges still render when both endpoints are
		// otherwise part of the session.
		const keep = new Set([nodeId('session', sessionId)]);
		let grew = true;
		while (grew) {
			grew = false;
			for (const edge of snapshot.edges) {
				if (edge.fromType === 'tool') {
					continue;
				}
				const from = nodeId(edge.fromType, edge.fromKey);
				const to = nodeId(edge.toType, edge.toKey);
				if (keep.has(from) && !keep.has(to)) {
					keep.add(to);
					grew = true;
				}
			}
		}
		lastKeepSet = keep;
		const nodes = snapshot.nodes.filter(node => keep.has(nodeId(node.type, node.key)));
		const rawEdges = snapshot.edges.filter(edge =>
			keep.has(nodeId(edge.fromType, edge.fromKey)) && keep.has(nodeId(edge.toType, edge.toKey)));

		// Bucket command nodes by their first meaningful token
		bucketIndex = { byBucket: new Map(), keyToBucket: new Map() };
		const tokenGroups = new Map();
		const displayNodes = new Map(); // displayed id -> node data
		const idMap = new Map(); // original graph node id -> displayed id
		for (const node of nodes) {
			if (node.type === 'command') {
				const token = commandBucket(node.key);
				let group = tokenGroups.get(token);
				if (!group) {
					group = [];
					tokenGroups.set(token, group);
				}
				group.push(node);
				continue;
			}
			const id = nodeId(node.type, node.key);
			idMap.set(id, id);
			displayNodes.set(id, {
				id, label: node.label, kind: node.type, key: node.key,
				firstSeen: node.firstSeen, lastSeen: node.lastSeen
			});
		}
		let bucketedCommands = 0;
		let bucketCount = 0;
		for (const [token, group] of tokenGroups) {
			if (group.length === 1) {
				const node = group[0];
				const id = nodeId('command', node.key);
				idMap.set(id, id);
				bucketIndex.keyToBucket.set(node.key, id);
				displayNodes.set(id, {
					id, label: node.label, kind: 'command', key: node.key,
					firstSeen: node.firstSeen, lastSeen: node.lastSeen
				});
				continue;
			}
			bucketCount++;
			bucketedCommands += group.length;
			const bucketId = 'cmdbucket:' + sessionId + ':' + token;
			const members = [];
			let firstSeen = Infinity;
			let lastSeen = 0;
			for (const node of group) {
				idMap.set(nodeId('command', node.key), bucketId);
				bucketIndex.keyToBucket.set(node.key, bucketId);
				members.push({ key: node.key, lastTs: node.lastSeen });
				firstSeen = Math.min(firstSeen, node.firstSeen);
				lastSeen = Math.max(lastSeen, node.lastSeen);
			}
			members.sort((a, b) => b.lastTs - a.lastTs);
			bucketIndex.byBucket.set(bucketId, members);
			displayNodes.set(bucketId, {
				id: bucketId, label: `${token} ×${group.length}`, kind: 'command', key: token,
				firstSeen, lastSeen, bucketCount: group.length,
				searchText: members.map(member => member.key).join('\n').toLowerCase()
			});
		}

		// Prompt nodes read much better labeled with their prompt text
		for (const data of displayNodes.values()) {
			if (data.kind === 'prompt') {
				const text = promptTexts.get(data.key);
				if (text) {
					const clean = text.replace(/\s+/g, ' ').trim();
					data.label = truncate(clean, 40);
					data.fullPrompt = text;
					data.searchText = clean.toLowerCase();
				}
			}
		}

		// Newest-first distinct edges, capped; bucket re-pointing collapses
		// most command edges so the cap rarely bites after aggregation
		const keptEdges = [];
		const keptById = new Map();
		const seenEdges = new Set();
		for (let i = rawEdges.length - 1; i >= 0; i--) {
			const edge = rawEdges[i];
			const source = idMap.get(nodeId(edge.fromType, edge.fromKey));
			const target = idMap.get(nodeId(edge.toType, edge.toKey));
			if (!source || !target || source === target) {
				continue;
			}
			const id = source + '->' + target + ':' + edge.rel;
			if (seenEdges.has(id)) {
				const kept = keptById.get(id);
				if (kept) {
					kept.n++;
				}
				continue;
			}
			seenEdges.add(id);
			if (keptEdges.length < MAX_EDGES) {
				const kept = { id, source, target, rel: edge.rel, n: 1 };
				keptEdges.push(kept);
				keptById.set(id, kept);
			}
		}

		const elements = [];
		const kinds = new Set();
		const usedNodeIds = new Set([nodeId('session', sessionId)]);
		for (const edge of keptEdges) {
			usedNodeIds.add(edge.source);
			usedNodeIds.add(edge.target);
		}
		for (const id of usedNodeIds) {
			const data = displayNodes.get(id);
			if (data) {
				kinds.add(data.kind);
				elements.push({ group: 'nodes', data });
			}
		}
		for (const edge of keptEdges) {
			elements.push({ group: 'edges', data: edge });
		}

		let statsText = `${usedNodeIds.size} nodes · ${keptEdges.length} edges`;
		if (bucketCount > 0) {
			statsText += ` · ${bucketedCommands} commands in ${bucketCount} buckets`;
		}
		if (seenEdges.size > keptEdges.length) {
			statsText += ` · latest ${keptEdges.length} of ${seenEdges.size}`;
		}
		return { elements, presentKinds: kinds, statsText };
	}

	function computeVisualData(elements) {
		const degree = new Map();
		let minSeen = Infinity;
		let maxSeen = -Infinity;
		for (const element of elements) {
			if (element.group === 'edges') {
				degree.set(element.data.source, (degree.get(element.data.source) || 0) + 1);
				degree.set(element.data.target, (degree.get(element.data.target) || 0) + 1);
			} else if (typeof element.data.lastSeen === 'number') {
				minSeen = Math.min(minSeen, element.data.lastSeen);
				maxSeen = Math.max(maxSeen, element.data.lastSeen);
			}
		}
		for (const element of elements) {
			if (element.group === 'edges') {
				continue;
			}
			const weight = (degree.get(element.data.id) || 0) + (element.data.degreeBoost || 0);
			element.data.size = Math.min(46, 16 + 4 * Math.sqrt(weight));
			const t = maxSeen > minSeen && typeof element.data.lastSeen === 'number'
				? (element.data.lastSeen - minSeen) / (maxSeen - minSeen)
				: 1;
			element.data.op = 0.35 + 0.65 * t;
		}
	}

	// ---------- Legend ----------

	function buildLegend() {
		legendEl.textContent = '';
		for (const [kind, color] of Object.entries(TYPE_COLORS)) {
			if (!presentKinds.has(kind)) {
				continue;
			}
			const row = document.createElement('button');
			row.className = 'legend-row' + (dimmedKinds.has(kind) ? ' dimmed' : '');
			row.setAttribute('aria-pressed', String(!dimmedKinds.has(kind)));
			row.title = dimmedKinds.has(kind) ? `Show ${kind} nodes` : `Dim ${kind} nodes`;
			const swatch = document.createElement('span');
			swatch.className = 'legend-swatch';
			swatch.style.backgroundColor = color;
			row.appendChild(swatch);
			const label = document.createElement('span');
			label.textContent = kind;
			row.appendChild(label);
			row.addEventListener('click', () => {
				if (dimmedKinds.has(kind)) {
					dimmedKinds.delete(kind);
				} else {
					dimmedKinds.add(kind);
				}
				applyDimming();
				buildLegend();
				saveState();
			});
			legendEl.appendChild(row);
		}
		legendEl.style.display = legendEl.childElementCount ? '' : 'none';
	}

	function applyDimming() {
		cy.nodes().forEach(node => {
			node.toggleClass('kind-dimmed', dimmedKinds.has(node.data('kind')));
		});
		cy.edges().forEach(edge => {
			const dim = dimmedKinds.has(edge.source().data('kind')) || dimmedKinds.has(edge.target().data('kind'));
			edge.toggleClass('kind-dimmed', dim);
		});
	}

	// ---------- Inspector ----------

	function closeInspector() {
		inspectorEl.hidden = true;
		inspectorEl.textContent = '';
	}

	function inspectorButton(label, onClick) {
		const button = document.createElement('button');
		button.className = 'inspector-action';
		button.textContent = label;
		button.addEventListener('click', onClick);
		return button;
	}

	function formatTs(value) {
		return typeof value === 'number' && value > 0 && value !== Infinity ? new Date(value).toLocaleString() : undefined;
	}

	function openInspector(node) {
		const data = node.data();
		inspectorEl.textContent = '';
		inspectorEl.hidden = false;

		const head = document.createElement('div');
		head.className = 'inspector-head';
		const swatch = document.createElement('span');
		swatch.className = 'legend-swatch';
		swatch.style.backgroundColor = TYPE_COLORS[data.kind] || '#888';
		head.appendChild(swatch);
		const kindEl = document.createElement('span');
		kindEl.className = 'inspector-kind';
		kindEl.textContent = data.kind;
		head.appendChild(kindEl);
		const close = document.createElement('button');
		close.className = 'inspector-close';
		close.textContent = 'x';
		close.setAttribute('aria-label', 'Close inspector');
		close.addEventListener('click', closeInspector);
		head.appendChild(close);
		inspectorEl.appendChild(head);

		const title = document.createElement('div');
		title.className = 'inspector-title';
		title.textContent = data.label;
		inspectorEl.appendChild(title);

		const rows = [
			['key', data.key],
			['connections', String(node.degree(false))],
			['first seen', formatTs(data.firstSeen)],
			['last seen', formatTs(data.lastSeen)]
		];
		for (const [label, value] of rows) {
			if (!value) {
				continue;
			}
			const row = document.createElement('div');
			row.className = 'inspector-row';
			const labelEl = document.createElement('span');
			labelEl.className = 'inspector-label';
			labelEl.textContent = label;
			row.appendChild(labelEl);
			const valueEl = document.createElement('span');
			valueEl.className = 'inspector-value';
			valueEl.textContent = value;
			row.appendChild(valueEl);
			inspectorEl.appendChild(row);
		}

		if (data.fullPrompt) {
			const prompt = document.createElement('div');
			prompt.className = 'inspector-prompt';
			prompt.textContent = data.fullPrompt;
			inspectorEl.appendChild(prompt);
		}

		if (data.bucketCount > 1) {
			const members = bucketIndex.byBucket.get(node.id()) || [];
			const list = document.createElement('div');
			list.className = 'inspector-list';
			for (const member of members.slice(0, 50)) {
				const item = document.createElement('div');
				item.className = 'inspector-list-item';
				item.textContent = member.key;
				list.appendChild(item);
			}
			if (members.length > 50) {
				const more = document.createElement('div');
				more.className = 'inspector-list-item';
				more.textContent = `… and ${members.length - 50} more`;
				list.appendChild(more);
			}
			inspectorEl.appendChild(list);
		}

		const actions = document.createElement('div');
		actions.className = 'inspector-actions';
		if (data.kind === 'file') {
			actions.appendChild(inspectorButton('Open file', () => vscode.postMessage({ type: 'openFile', path: data.key })));
		}
		if (data.kind === 'session' && view.mode === 'overview') {
			actions.appendChild(inspectorButton('Open session', () => setMode('session', data.key)));
		}
		actions.appendChild(inspectorButton('Select neighbours', () => {
			cy.elements().unselect();
			node.closedNeighborhood().select();
		}));
		inspectorEl.appendChild(actions);
	}

	// ---------- Search ----------

	let searchHits = [];
	let searchIndex = -1;

	function runSearch(advance) {
		const query = searchInput.value.trim().toLowerCase();
		cy.nodes().removeClass('search-hit');
		if (!query) {
			searchHits = [];
			searchIndex = -1;
			return;
		}
		searchHits = cy.nodes().filter(node => {
			const data = node.data();
			return String(data.label).toLowerCase().includes(query)
				|| String(data.key).toLowerCase().includes(query)
				|| (typeof data.searchText === 'string' && data.searchText.includes(query));
		});
		searchHits.addClass('search-hit');
		if (searchHits.length) {
			searchIndex = advance ? (searchIndex + 1) % searchHits.length : 0;
			const hit = searchHits[searchIndex];
			cy.animate({ center: { eles: hit }, zoom: Math.max(cy.zoom(), 1.2) }, { duration: 200 });
			openInspector(hit);
		}
	}

	searchInput.addEventListener('input', () => runSearch(false));
	searchInput.addEventListener('keydown', e => {
		if (e.key === 'Enter') {
			runSearch(true);
		} else if (e.key === 'Escape') {
			searchInput.value = '';
			runSearch(false);
		}
	});

	// ---------- Activity feed ----------

	function commandFeedEntry(event, command) {
		return {
			ts: event.ts,
			icon: '$',
			text: truncate(command.key.replace(/\s+/g, ' '), 60),
			ok: event.ok,
			durationMs: event.durationMs,
			targetId: bucketIndex.keyToBucket.get(command.key) || nodeId('command', command.key),
			key: 'cmd:' + commandBucket(command.key),
			sessionId: event.sessionId
		};
	}

	function feedEntryFromEvent(event) {
		const objects = Array.isArray(event.objects) ? event.objects : [];
		const file = objects.find(object => object.type === 'file');
		const command = objects.find(object => object.type === 'command');
		const tool = objects.find(object => object.type === 'tool');
		const task = objects.find(object => object.type === 'task');
		const payload = event.payload && typeof event.payload === 'object' ? event.payload : {};
		const sid8 = event.sessionId.slice(0, 8);
		switch (event.verb) {
			case 'prompt.submit': {
				const text = typeof payload.prompt === 'string' ? payload.prompt.replace(/\s+/g, ' ').trim() : '';
				return {
					ts: event.ts, icon: '❯',
					text: text ? truncate(text, 80) : 'Prompt ' + (event.promptId || '').slice(0, 8),
					targetId: event.promptId ? nodeId('prompt', event.promptId) : nodeId('session', event.sessionId),
					key: 'prompt:' + (event.promptId || event.id), sessionId: event.sessionId
				};
			}
			case 'session.start':
				return { ts: event.ts, icon: '▶', text: `Session started — ${event.source} ${sid8}`, targetId: nodeId('session', event.sessionId), key: 'start:' + event.id, sessionId: event.sessionId };
			case 'session.end':
				return { ts: event.ts, icon: '■', text: `Session ended — ${event.source} ${sid8}`, targetId: nodeId('session', event.sessionId), key: 'end:' + event.id, sessionId: event.sessionId };
			case 'task.create':
				return { ts: event.ts, icon: '▣', text: task ? `Created card ${task.key}` : 'Created card', targetId: task ? nodeId('task', task.key) : undefined, key: 'taskc:' + event.id, sessionId: event.sessionId };
			case 'task.complete':
				return { ts: event.ts, icon: '✓', text: task ? `Completed card ${task.key}` : 'Completed card', targetId: task ? nodeId('task', task.key) : undefined, key: 'taskd:' + event.id, sessionId: event.sessionId };
			case 'file.edit': {
				if (!file) {
					return undefined;
				}
				const state = typeof payload.editState === 'string' ? ` (${payload.editState})` : '';
				return {
					ts: event.ts, icon: '✎', text: `Edited ${basename(file.key)}${state}`, ok: event.ok,
					durationMs: event.durationMs, targetId: nodeId('file', file.key),
					key: 'edit:' + file.key, sessionId: event.sessionId
				};
			}
			case 'tool.start':
				return undefined; // always followed by tool.end
			default: {
				if (command) {
					return commandFeedEntry(event, command);
				}
				if (file) {
					const toolName = typeof payload.toolName === 'string' ? payload.toolName : (tool ? tool.key : 'Used');
					return {
						ts: event.ts, icon: '⚒', text: `${toolName} ${basename(file.key)}`, ok: event.ok,
						durationMs: event.durationMs, targetId: nodeId('file', file.key),
						key: toolName + ':' + file.key, sessionId: event.sessionId
					};
				}
				if (tool) {
					return {
						ts: event.ts, icon: '⚒', text: tool.key, ok: event.ok, durationMs: event.durationMs,
						targetId: nodeId('tool', tool.key), key: 'tool:' + tool.key, sessionId: event.sessionId
					};
				}
				return undefined;
			}
		}
	}

	function feedEntryFromEdge(edge, nodeById) {
		const targetNode = nodeById.get(nodeId(edge.toType, edge.toKey));
		const label = targetNode ? targetNode.label : edge.toKey;
		switch (edge.toType) {
			case 'prompt':
				return { ts: edge.ts, icon: '❯', text: promptTexts.has(edge.toKey) ? truncate(promptTexts.get(edge.toKey).replace(/\s+/g, ' ').trim(), 80) : 'Prompt ' + edge.toKey.slice(0, 8), targetId: nodeId('prompt', edge.toKey), key: 'prompt:' + edge.toKey };
			case 'command':
				return { ts: edge.ts, icon: '$', text: truncate(label.replace(/\s+/g, ' '), 60), targetId: bucketIndex.keyToBucket.get(edge.toKey) || nodeId('command', edge.toKey), key: 'cmd:' + commandBucket(edge.toKey) };
			case 'file':
				return { ts: edge.ts, icon: edge.rel === 'file.edit' ? '✎' : '⚒', text: `${edge.rel === 'file.edit' ? 'Edited' : 'Used'} ${basename(edge.toKey)}`, targetId: nodeId('file', edge.toKey), key: edge.rel + ':' + edge.toKey };
			case 'task':
				if (edge.fromType === 'task') {
					return { ts: edge.ts, icon: '▣', text: `Linked ${edge.fromKey} → ${edge.toKey}`, targetId: nodeId('task', edge.toKey), key: 'link:' + edge.fromKey + ':' + edge.toKey };
				}
				return { ts: edge.ts, icon: '▣', text: `${edge.rel === 'task.create' ? 'Created' : 'Touched'} card ${edge.toKey}`, targetId: nodeId('task', edge.toKey), key: 'task:' + edge.toKey };
			case 'tool':
				return { ts: edge.ts, icon: '⚒', text: edge.toKey, targetId: nodeId('tool', edge.toKey), key: 'tool:' + edge.toKey };
			default:
				return undefined;
		}
	}

	function feedEntriesFromEdges() {
		const { snapshot } = lastData;
		const nodeById = new Map(snapshot.nodes.map(node => [nodeId(node.type, node.key), node]));
		const scoped = view.mode === 'session' ? lastKeepSet : null;
		const entries = [];
		for (let i = snapshot.edges.length - 1; i >= 0 && entries.length < FEED_MAX * 3; i--) {
			const edge = snapshot.edges[i];
			if (edge.fromType === 'tool') {
				continue; // duplicates of the prompt/session → object edges
			}
			if (scoped && (!scoped.has(nodeId(edge.fromType, edge.fromKey)) || !scoped.has(nodeId(edge.toType, edge.toKey)))) {
				continue;
			}
			const entry = feedEntryFromEdge(edge, nodeById);
			if (entry) {
				entries.push(entry);
			}
		}
		return entries;
	}

	function coalesceFeed(entries) {
		const out = [];
		for (const entry of entries) {
			const last = out[out.length - 1];
			if (last && last.key === entry.key) {
				last.count++;
				if (last.details.length < 10) {
					last.details.push(entry.text);
				}
				continue;
			}
			if (out.length >= FEED_MAX) {
				break;
			}
			out.push(Object.assign({}, entry, { count: 1, details: [] }));
		}
		return out;
	}

	function formatDuration(ms) {
		return ms >= 1000 ? (ms / 1000).toFixed(1) + 's' : Math.round(ms) + 'ms';
	}

	function renderFeed() {
		if (!view.feedOpen) {
			return;
		}
		feedTitleEl.textContent = view.mode === 'session'
			? 'Activity — ' + (sessionLabels.get(view.sessionId) || view.sessionId.slice(0, 8))
			: 'Activity';

		let entries;
		let loading = false;
		if (view.mode === 'session') {
			const map = sessionEvents.get(view.sessionId);
			if (map && map.size) {
				entries = [...map.values()].sort((a, b) => b.ts - a.ts).map(feedEntryFromEvent).filter(Boolean);
			} else {
				entries = feedEntriesFromEdges();
				loading = pendingEventRequests.has(view.sessionId);
			}
		} else {
			entries = recentEvents.length
				? recentEvents.map(feedEntryFromEvent).filter(Boolean)
				: feedEntriesFromEdges();
		}
		const coalesced = coalesceFeed(entries);

		const scrollTop = feedListEl.scrollTop;
		feedListEl.textContent = '';
		if (loading) {
			const item = document.createElement('li');
			item.className = 'feed-loading';
			item.textContent = 'Loading full activity…';
			feedListEl.appendChild(item);
		}
		if (!coalesced.length && !loading) {
			const item = document.createElement('li');
			item.className = 'feed-empty';
			item.textContent = 'No activity';
			feedListEl.appendChild(item);
		}
		for (const entry of coalesced) {
			const item = document.createElement('li');
			item.className = 'feed-entry' + (entry.ok === true ? ' ok' : entry.ok === false ? ' fail' : '');
			if (entry.targetId) {
				item.dataset.target = entry.targetId;
			}
			if (entry.sessionId) {
				item.dataset.session = entry.sessionId;
			}
			const icon = document.createElement('span');
			icon.className = 'feed-icon';
			icon.textContent = entry.ok === false ? '✗' : entry.icon;
			item.appendChild(icon);
			const text = document.createElement('span');
			text.className = 'feed-text';
			text.textContent = entry.text;
			if (entry.count > 1) {
				const count = document.createElement('span');
				count.className = 'feed-count';
				count.textContent = '×' + entry.count;
				text.appendChild(count);
			}
			item.appendChild(text);
			const time = document.createElement('span');
			time.className = 'feed-time';
			time.textContent = timeShort(entry.ts);
			item.appendChild(time);
			const tooltip = [];
			if (entry.count > 1 && entry.details.length) {
				tooltip.push(entry.details.join('\n'));
			}
			if (typeof entry.durationMs === 'number') {
				tooltip.push(formatDuration(entry.durationMs));
			}
			if (tooltip.length) {
				item.title = tooltip.join('\n');
			}
			feedListEl.appendChild(item);
		}
		feedListEl.scrollTop = scrollTop;
	}

	function focusNodeFromFeed(targetId, sessionId, entryEl) {
		let ele = targetId ? cy.getElementById(targetId) : undefined;
		if ((!ele || ele.empty()) && view.mode === 'overview' && sessionId) {
			ele = cy.getElementById(nodeId('session', sessionId));
		}
		if (ele && !ele.empty()) {
			cy.elements().unselect();
			ele.select();
			cy.animate({ center: { eles: ele }, zoom: Math.max(cy.zoom(), 1.2) }, { duration: 200 });
			openInspector(ele);
		} else if (entryEl) {
			entryEl.classList.add('feed-miss');
			setTimeout(() => entryEl.classList.remove('feed-miss'), 600);
		}
	}

	// ---------- Render ----------

	function scheduleLiveRender() {
		if (liveRenderTimer !== undefined) {
			return;
		}
		const wait = Math.max(0, LIVE_RENDER_INTERVAL - (Date.now() - lastRenderTs));
		liveRenderTimer = setTimeout(() => {
			liveRenderTimer = undefined;
			render();
		}, wait);
	}

	function render() {
		lastRenderTs = Date.now();
		const { sessions } = lastData;

		// Keep the session dropdown in sync with the store
		const known = new Set(sessions.map(session => session.sessionId));
		for (const option of Array.from(sessionFilter.options).slice(1)) {
			if (!known.has(option.value)) {
				option.remove();
			}
		}
		const existing = new Set(Array.from(sessionFilter.options).map(option => option.value));
		for (const session of sessions) {
			sessionLabels.set(session.sessionId, `${session.source} · ${session.sessionId.slice(0, 8)}`);
			if (!existing.has(session.sessionId)) {
				const option = document.createElement('option');
				option.value = session.sessionId;
				option.textContent = `${session.source} · ${session.sessionId.slice(0, 8)} (${session.eventCount})`;
				sessionFilter.appendChild(option);
			}
		}
		if (sessionFilter.value !== view.sessionId) {
			sessionFilter.value = view.sessionId;
		}

		const built = view.mode === 'session' ? buildSessionElements(view.sessionId) : buildOverviewElements();
		if (view.mode === 'overview') {
			lastKeepSet = null;
		}
		computeVisualData(built.elements);
		presentKinds = built.presentKinds;

		// Diff against the current elements: relayout only when the graph
		// actually changed, and incrementally (randomize: false) so live
		// updates keep existing node positions instead of rescrambling
		const newIds = new Set(built.elements.map(element => element.data.id));
		let changed = false;
		cy.elements().forEach(ele => {
			if (!newIds.has(ele.id())) {
				ele.remove();
				changed = true;
			}
		});
		const toAdd = [];
		for (const element of built.elements) {
			const current = cy.getElementById(element.data.id);
			if (current.empty()) {
				toAdd.push(element);
			} else {
				current.data(element.data);
			}
		}
		if (toAdd.length) {
			cy.add(toAdd);
			changed = true;
		}
		if (changed) {
			// Disconnected sessions are tiled by fcose; generous padding keeps
			// their two-line labels from colliding in the overview
			const layoutOptions = view.mode === 'overview'
				? { name: 'fcose', animate: false, nodeSeparation: 120, idealEdgeLength: 110, tile: true, tilingPaddingVertical: 55, tilingPaddingHorizontal: 150, randomize: !hasLayout }
				: { name: 'fcose', animate: false, nodeSeparation: 60, randomize: !hasLayout };
			cy.layout(layoutOptions).run();
			if (!hasLayout) {
				cy.fit(undefined, 30);
			}
			hasLayout = true;
			applyDimming();
			runSearch(false);
		}

		stats.textContent = built.statsText;
		buildLegend();
		updateBreadcrumb();
		renderFeed();

		let emptyMessage = '';
		if (!sessions.length) {
			emptyMessage = 'No agent activity yet. Claude Code sessions and chat activity will appear here.';
		} else if (view.mode === 'session' && !built.elements.some(element => element.group === 'edges')) {
			emptyMessage = 'No graph activity in this session.';
		}
		emptyStateEl.textContent = emptyMessage;
		emptyStateEl.hidden = !emptyMessage;
	}

	// ---------- Wiring ----------

	cy.on('tap', 'node', event => {
		const data = event.target.data();
		if (view.mode === 'overview' && data.kind === 'session') {
			setMode('session', data.key);
		} else {
			openInspector(event.target);
		}
	});
	cy.on('tap', event => {
		if (event.target === cy) {
			closeInspector();
		}
	});

	sessionFilter.addEventListener('change', () => {
		setMode(sessionFilter.value ? 'session' : 'overview', sessionFilter.value);
	});
	document.getElementById('fitButton').addEventListener('click', () => cy.fit(undefined, 30));
	document.getElementById('relayoutButton').addEventListener('click', () => cy.layout({ name: 'fcose', animate: true, nodeSeparation: 60 }).run());
	liveToggle.addEventListener('change', () => {
		if (liveToggle.checked) {
			scheduleLiveRender();
		}
	});

	let resizeTimer;
	new ResizeObserver(() => {
		clearTimeout(resizeTimer);
		resizeTimer = setTimeout(() => cy.resize(), 100);
	}).observe(/** @type {Element} */(document.getElementById('graph')));

	window.addEventListener('message', event => {
		const message = event.data;
		if (message.type === 'graph') {
			lastData = { snapshot: message.snapshot, sessions: message.sessions };
			recentEvents = Array.isArray(message.events) ? message.events : [];
			absorbEvents(recentEvents);
			// A restored session may no longer exist in the store
			if (view.mode === 'session' && !message.sessions.some(session => session.sessionId === view.sessionId)) {
				view.mode = 'overview';
				view.sessionId = '';
				saveState();
			}
			if (liveToggle.checked || !hasLayout) {
				scheduleLiveRender();
			}
		} else if (message.type === 'events' && typeof message.sessionId === 'string') {
			pendingEventRequests.delete(message.sessionId);
			absorbEvents(Array.isArray(message.events) ? message.events : []);
			if (view.mode === 'session' && view.sessionId === message.sessionId) {
				render();
			}
		}
	});

	buildChrome();
	restoreState();
	document.body.classList.toggle('feed-open', view.feedOpen);
	updateBreadcrumb();
	buildLegend();
	// Exposed for the test harness; harmless in production
	window.__agentGraph = { cy, get view() { return view; }, render };
	vscode.postMessage({ type: 'ready' });
}());
