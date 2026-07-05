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
					'color': themeColor('--vscode-foreground') || '#ccc',
					'text-valign': 'bottom',
					'text-margin-y': 4,
					'width': 18,
					'height': 18,
					'background-color': ele => TYPE_COLORS[ele.data('kind')] || '#888'
				}
			},
			{
				selector: 'node[kind="session"]',
				style: { 'width': 34, 'height': 34, 'font-size': '11px' }
			},
			{
				selector: 'edge',
				style: {
					'width': 1,
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

	function nodeId(type, key) {
		return type + ':' + key;
	}

	// ---------- Legend ----------

	function buildLegend() {
		legendEl.textContent = '';
		for (const [kind, color] of Object.entries(TYPE_COLORS)) {
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
			});
			legendEl.appendChild(row);
		}
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
		return typeof value === 'number' && value > 0 ? new Date(value).toLocaleString() : undefined;
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

		const actions = document.createElement('div');
		actions.className = 'inspector-actions';
		if (data.kind === 'file') {
			actions.appendChild(inspectorButton('Open file', () => vscode.postMessage({ type: 'openFile', path: data.key })));
		}
		if (data.kind === 'session') {
			actions.appendChild(inspectorButton('Filter to session', () => {
				sessionFilter.value = data.key;
				render();
			}));
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
			return String(data.label).toLowerCase().includes(query) || String(data.key).toLowerCase().includes(query);
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

	// ---------- Render ----------

	function render() {
		const { snapshot, sessions } = lastData;
		const selected = sessionFilter.value;

		const known = new Set(sessions.map(s => s.sessionId));
		for (const option of Array.from(sessionFilter.options).slice(1)) {
			if (!known.has(option.value)) {
				option.remove();
			}
		}
		const existing = new Set(Array.from(sessionFilter.options).map(o => o.value));
		for (const session of sessions) {
			if (!existing.has(session.sessionId)) {
				const option = document.createElement('option');
				option.value = session.sessionId;
				option.textContent = `${session.source} · ${session.sessionId.slice(0, 8)} (${session.eventCount})`;
				sessionFilter.appendChild(option);
			}
		}

		// When a session is selected, keep only nodes reachable from it
		let nodes = snapshot.nodes;
		let edges = snapshot.edges;
		if (selected) {
			const keep = new Set([nodeId('session', selected)]);
			let grew = true;
			while (grew) {
				grew = false;
				for (const edge of edges) {
					const from = nodeId(edge.fromType, edge.fromKey);
					const to = nodeId(edge.toType, edge.toKey);
					if (keep.has(from) && !keep.has(to)) {
						keep.add(to);
						grew = true;
					}
				}
			}
			nodes = nodes.filter(n => keep.has(nodeId(n.type, n.key)));
			edges = edges.filter(e => keep.has(nodeId(e.fromType, e.fromKey)) && keep.has(nodeId(e.toType, e.toKey)));
		}

		const elements = [];
		const seen = new Set();
		for (const node of nodes) {
			const id = nodeId(node.type, node.key);
			if (!seen.has(id)) {
				seen.add(id);
				elements.push({ group: 'nodes', data: { id, label: node.label, kind: node.type, key: node.key, firstSeen: node.firstSeen, lastSeen: node.lastSeen } });
			}
		}
		for (const edge of edges) {
			const source = nodeId(edge.fromType, edge.fromKey);
			const target = nodeId(edge.toType, edge.toKey);
			const id = source + '->' + target + ':' + edge.rel;
			if (!seen.has(id) && seen.has(source) && seen.has(target)) {
				seen.add(id);
				elements.push({ group: 'edges', data: { id, source, target, rel: edge.rel } });
			}
		}

		cy.elements().remove();
		cy.add(elements);
		cy.layout({ name: 'fcose', animate: false, nodeSeparation: 60 }).run();
		applyDimming();
		runSearch(false);
		stats.textContent = `${nodes.length} nodes · ${edges.length} edges`;
	}

	cy.on('tap', 'node', event => {
		openInspector(event.target);
	});
	cy.on('tap', event => {
		if (event.target === cy) {
			closeInspector();
		}
	});

	sessionFilter.addEventListener('change', render);
	document.getElementById('fitButton').addEventListener('click', () => cy.fit(undefined, 30));
	document.getElementById('relayoutButton').addEventListener('click', () => cy.layout({ name: 'fcose', animate: true, nodeSeparation: 60 }).run());

	window.addEventListener('message', event => {
		const message = event.data;
		if (message.type === 'graph') {
			lastData = message;
			if (liveToggle.checked) {
				render();
			}
		}
	});

	buildLegend();
	vscode.postMessage({ type: 'ready' });
}());
