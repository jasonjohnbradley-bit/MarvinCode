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
				selector: ':selected',
				style: { 'border-width': 2, 'border-color': themeColor('--vscode-focusBorder') || '#007fd4' }
			}
		]
	});

	const sessionFilter = /** @type {HTMLSelectElement} */ (document.getElementById('sessionFilter'));
	const liveToggle = /** @type {HTMLInputElement} */ (document.getElementById('liveToggle'));
	const stats = /** @type {HTMLElement} */ (document.getElementById('stats'));
	let lastData = { snapshot: { nodes: [], edges: [] }, sessions: [] };

	function nodeId(type, key) {
		return type + ':' + key;
	}

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
				elements.push({ group: 'nodes', data: { id, label: node.label, kind: node.type, key: node.key } });
			}
		}
		for (const edge of edges) {
			const source = nodeId(edge.fromType, edge.fromKey);
			const target = nodeId(edge.toType, edge.toKey);
			const id = source + '->' + target + ':' + edge.rel;
			if (!seen.has(id) && seen.has(source) && seen.has(target)) {
				seen.add(id);
				elements.push({ group: 'edges', data: { id, source, target } });
			}
		}

		cy.elements().remove();
		cy.add(elements);
		cy.layout({ name: 'fcose', animate: false, nodeSeparation: 60 }).run();
		stats.textContent = `${nodes.length} nodes · ${edges.length} edges`;
	}

	cy.on('tap', 'node', event => {
		const data = event.target.data();
		if (data.kind === 'file') {
			vscode.postMessage({ type: 'openFile', path: data.key });
		}
	});

	sessionFilter.addEventListener('change', render);

	window.addEventListener('message', event => {
		const message = event.data;
		if (message.type === 'graph') {
			lastData = message;
			if (liveToggle.checked) {
				render();
			}
		}
	});

	vscode.postMessage({ type: 'ready' });
}());
