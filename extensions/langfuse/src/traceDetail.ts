/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { buildAgentGraph, defaultGraphMode, GraphMode, shouldShowGraph } from './agentGraph';
import { LangfuseClient, LangfuseObservation, LangfuseTrace } from './api';
import { openUrl } from './browser';
import { GraphLayout, layoutGraph, MAX_LABEL_LENGTH } from './graphLayout';
import { buildTraceTree, formatCost, formatDuration, formatTokens, TraceNode, TraceTree } from './traceModel';

const MAX_VALUE_CHARS = 20_000;

/** A single reused webview panel rendering a trace as a tree, timeline and graph. */
export class TraceDetailPanel {

	private static current: TraceDetailPanel | undefined;

	private readonly disposables: vscode.Disposable[] = [];
	private url: string | undefined;
	private traceId: string | undefined;

	static show(client: LangfuseClient, trace: LangfuseTrace): void {
		if (TraceDetailPanel.current) {
			TraceDetailPanel.current.panel.reveal(vscode.ViewColumn.Active, false);
			void TraceDetailPanel.current.load(client, trace);
			return;
		}
		const panel = vscode.window.createWebviewPanel(
			'langfuse.trace',
			trace.name?.trim() || trace.id,
			vscode.ViewColumn.Active,
			{ enableScripts: true, retainContextWhenHidden: true });
		TraceDetailPanel.current = new TraceDetailPanel(panel);
		void TraceDetailPanel.current.load(client, trace);
	}

	private constructor(private readonly panel: vscode.WebviewPanel) {
		this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
		this.panel.webview.onDidReceiveMessage(async (message: { type?: string }) => {
			if (message?.type === 'openInLangfuse' && this.url) {
				await openUrl(this.url);
			} else if (message?.type === 'copyTraceId' && this.traceId) {
				await vscode.env.clipboard.writeText(this.traceId);
				void vscode.window.showInformationMessage(vscode.l10n.t('Trace ID copied.'));
			}
		}, null, this.disposables);
	}

	private async load(client: LangfuseClient, summary: LangfuseTrace): Promise<void> {
		this.panel.title = summary.name?.trim() || summary.id;
		this.panel.webview.html = shell(vscode.l10n.t('Loading trace…'), '');
		try {
			const trace = await client.getTrace(summary.id);
			this.url = client.traceUrl(trace);
			this.traceId = trace.id;
			this.panel.webview.html = renderTrace(trace);
		} catch (err) {
			this.panel.webview.html = shell('', `<p class="error">${escapeHtml(err instanceof Error ? err.message : String(err))}</p>`);
		}
	}

	private dispose(): void {
		TraceDetailPanel.current = undefined;
		this.panel.dispose();
		for (const d of this.disposables) {
			d.dispose();
		}
	}
}

// --- shared helpers ----------------------------------------------------------

function escapeHtml(value: string): string {
	return value.replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[ch]!));
}

function valueToString(value: unknown): string {
	if (value === undefined || value === null) {
		return '';
	}
	const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
	return text.length > MAX_VALUE_CHARS ? text.slice(0, MAX_VALUE_CHARS) + '\n… (truncated)' : text;
}

function chip(label: string, value: string | null | undefined): string {
	return value ? `<span class="chip"><span class="chip-k">${escapeHtml(label)}</span> ${escapeHtml(value)}</span>` : '';
}

function typeClass(o: LangfuseObservation): string {
	if ((o.level ?? '').toUpperCase() === 'ERROR') {
		return 'ERROR';
	}
	const type = (o.type ?? 'SPAN').toUpperCase();
	const known = ['SPAN', 'GENERATION', 'EVENT', 'AGENT', 'TOOL', 'CHAIN', 'RETRIEVER', 'EVALUATOR', 'EMBEDDING', 'GUARDRAIL'];
	return known.includes(type) ? type : 'SPAN';
}

function valueBlock(label: string, value: unknown): string {
	const text = valueToString(value);
	if (!text.trim()) {
		return '';
	}
	return `<details><summary>${escapeHtml(label)}</summary><pre>${escapeHtml(text)}</pre></details>`;
}

/** Duration text, tinted when this span dominates the trace's wall clock. */
function durationCell(ms: number, traceMs: number): string {
	const text = formatDuration(ms);
	if (!text) {
		return '';
	}
	const share = traceMs > 0 ? ms / traceMs : 0;
	const heat = share >= 0.5 ? ' hot' : share >= 0.2 ? ' warm' : '';
	return `<span class="dur${heat}">${escapeHtml(text)}</span>`;
}

// --- Tree view ---------------------------------------------------------------

/**
 * The observation hierarchy. Costs carry a "∑" prefix on nodes with children
 * because the figure includes the whole subtree; token counts never aggregate,
 * so they are shown bare (their own "∑" is the sum across usage types).
 */
function renderTree(tree: TraceTree): string {
	const rows = tree.flat.map(node => treeRow(node, tree)).join('');
	return `<div class="tree">${rows}</div>`;
}

function treeRow(node: TraceNode, tree: TraceTree): string {
	const o = node.observation;
	const cls = typeClass(o);
	const cost = formatCost(node.totalCost);
	const costText = cost ? (node.children.length ? `∑ ${cost}` : cost) : undefined;
	const tokens = formatTokens(node.tokens);
	const name = o.name || o.id;
	const searchText = `${name} ${o.model ?? ''} ${cls}`.toLowerCase();

	const meta = [
		durationCell(node.endMs - node.startMs, tree.durationMs),
		tokens ? `<span class="tok">${escapeHtml(tokens)}</span>` : '',
		costText ? `<span class="cost">${escapeHtml(costText)}</span>` : '',
		o.model ? `<span class="dim">${escapeHtml(o.model)}</span>` : '',
	].filter(Boolean).join('');

	const bodies = valueBlock(vscode.l10n.t('Input'), o.input) + valueBlock(vscode.l10n.t('Output'), o.output);
	const error = cls === 'ERROR' && o.statusMessage ? `<div class="err">${escapeHtml(o.statusMessage)}</div>` : '';
	const twisty = node.children.length
		? `<button class="twisty" aria-expanded="true" title="${escapeHtml(vscode.l10n.t('Collapse'))}">▾</button>`
		: '<span class="twisty-spacer"></span>';

	return `
		<div class="node" data-id="${escapeHtml(o.id)}" data-parent="${escapeHtml(o.parentObservationId ?? '')}" data-search="${escapeHtml(searchText)}" style="--depth:${node.depth}">
			<div class="row">
				${twisty}
				<span class="badge ${cls}" title="${escapeHtml(cls)}">${escapeHtml(cls.slice(0, 3))}</span>
				<span class="name">${escapeHtml(name)}</span>
				<span class="metrics">${meta}</span>
			</div>
			${error}
			${bodies ? `<div class="bodies">${bodies}</div>` : ''}
		</div>`;
}

// --- Timeline view -----------------------------------------------------------

/** The original waterfall: one bar per observation against the trace's clock. */
function renderTimeline(tree: TraceTree): string {
	const span = Math.max(1, tree.traceEndMs - tree.traceStartMs);
	const rows = tree.flat.map(node => {
		const o = node.observation;
		const cls = typeClass(o);
		const left = ((node.startMs - tree.traceStartMs) / span) * 100;
		const width = Math.max(((node.endMs - node.startMs) / span) * 100, 0.6);
		const duration = formatDuration(node.endMs - node.startMs) ?? '';
		const detail = [duration, formatTokens(node.tokens), formatCost(node.ownCost), o.model || undefined].filter(Boolean).join(' · ');
		return `
			<div class="cell-info" style="padding-left:${8 + node.depth * 14}px">
				<span class="badge ${cls}">${escapeHtml(cls.slice(0, 3))}</span>
				<span class="name">${escapeHtml(o.name || o.id)}</span>
				${detail ? `<div class="meta">${escapeHtml(detail)}</div>` : ''}
			</div>
			<div class="cell-track"><div class="bar ${cls}" style="left:${left.toFixed(2)}%;width:${width.toFixed(2)}%" title="${escapeHtml(duration)}"></div></div>`;
	}).join('');
	return `<div class="grid">${rows}</div>`;
}

// --- Graph view --------------------------------------------------------------

function renderGraphSvg(layout: GraphLayout): string {
	if (!layout.nodes.length) {
		return '';
	}
	const edges = layout.edges.map(edge => {
		const points = edge.points.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
		return `<polyline class="edge${edge.isReturn ? ' return' : ''}" points="${points}" marker-end="url(#arrow)" />`;
	}).join('');

	const nodes = layout.nodes.map(node => {
		const counter = node.executions && node.executions > 1 ? ` (${node.completed ?? node.executions}/${node.executions})` : '';
		const label = node.label.length > MAX_LABEL_LENGTH ? node.label.slice(0, MAX_LABEL_LENGTH - 1) + '…' : node.label;
		const title = `<title>${escapeHtml(node.tooltip ? `${node.label} — ${node.tooltip}` : node.label)}</title>`;
		return `
			<g class="gnode ${node.kind}${node.hasError ? ' error' : ''}" transform="translate(${node.x.toFixed(1)},${node.y.toFixed(1)})">
				${title}
				<rect width="${node.width}" height="${node.height}" rx="7" />
				<text x="${node.width / 2}" y="${node.height / 2}" dominant-baseline="central" text-anchor="middle">${escapeHtml(label + counter)}</text>
			</g>`;
	}).join('');

	return `
		<svg id="graph-svg" viewBox="0 0 ${Math.ceil(layout.width)} ${Math.ceil(layout.height)}" width="${Math.ceil(layout.width)}" height="${Math.ceil(layout.height)}">
			<defs>
				<marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
					<path d="M 0 0 L 10 5 L 0 10 z" />
				</marker>
			</defs>
			<g id="graph-viewport">${edges}${nodes}</g>
		</svg>`;
}

function renderGraph(trace: LangfuseTrace): string {
	if (!shouldShowGraph(trace)) {
		return `<p class="dim">${escapeHtml(vscode.l10n.t('This trace does not have enough distinct steps to draw a graph.'))}</p>`;
	}
	const mode = defaultGraphMode(trace);
	const panes = (['aggregated', 'expanded'] as GraphMode[]).map(candidate => {
		const result = buildAgentGraph(trace, candidate);
		const body = result.unavailable
			? `<p class="dim">${escapeHtml(result.unavailable)}</p>`
			: renderGraphSvg(layoutGraph(result.graph)) || `<p class="dim">${escapeHtml(vscode.l10n.t('Nothing to draw.'))}</p>`;
		return `<div class="graph-pane" data-mode="${candidate}" ${candidate === mode ? '' : 'hidden'}>${body}</div>`;
	}).join('');

	return `
		<div class="graph-toolbar">
			<div class="switch" role="tablist">
				<button class="mode ${mode === 'aggregated' ? 'active' : ''}" data-mode="aggregated" title="${escapeHtml(vscode.l10n.t('Repeated steps grouped into one node — the overall shape'))}">${escapeHtml(vscode.l10n.t('Aggregated'))}</button>
				<button class="mode ${mode === 'expanded' ? 'active' : ''}" data-mode="expanded" title="${escapeHtml(vscode.l10n.t('Every call as its own node, in the order it ran'))}">${escapeHtml(vscode.l10n.t('Expanded'))}</button>
			</div>
			<div class="zoom">
				<button id="zoom-in" title="${escapeHtml(vscode.l10n.t('Zoom In'))}">+</button>
				<button id="zoom-out" title="${escapeHtml(vscode.l10n.t('Zoom Out'))}">−</button>
				<button id="zoom-fit" title="${escapeHtml(vscode.l10n.t('Fit to View'))}">⤢</button>
			</div>
		</div>
		<div class="graph-canvas" id="graph-canvas">${panes}</div>`;
}

// --- page --------------------------------------------------------------------

function renderTrace(trace: LangfuseTrace): string {
	const tree = buildTraceTree(trace);

	const scores = (trace.scores ?? []).map(s => {
		const value = s.value !== null && s.value !== undefined ? String(s.value) : (s.stringValue ?? '');
		return `<span class="chip"><span class="chip-k">${escapeHtml(s.name)}</span> ${escapeHtml(value)}${s.source ? ` <span class="dim">(${escapeHtml(s.source)})</span>` : ''}</span>`;
	}).join('');

	const header = `
		<div class="header">
			<h1>${escapeHtml(trace.name?.trim() || trace.id)}</h1>
			<div class="actions">
				<button id="open">${escapeHtml(vscode.l10n.t('Open in Langfuse'))}</button>
				<button id="copy" class="secondary">${escapeHtml(vscode.l10n.t('Copy Trace ID'))}</button>
			</div>
		</div>
		<div class="chips">
			${chip(vscode.l10n.t('Time'), new Date(trace.timestamp).toLocaleString())}
			${chip(vscode.l10n.t('Duration'), formatDuration(tree.durationMs))}
			${chip(vscode.l10n.t('Tokens'), tree.totalTokens ? tree.totalTokens.toLocaleString('en-US') : undefined)}
			${chip(vscode.l10n.t('Cost'), formatCost(tree.totalCost))}
			${chip(vscode.l10n.t('Spans'), tree.flat.length ? String(tree.flat.length) : undefined)}
			${chip(vscode.l10n.t('User'), trace.userId)}
			${chip(vscode.l10n.t('Session'), trace.sessionId)}
			${chip(vscode.l10n.t('Env'), trace.environment)}
			${chip(vscode.l10n.t('Release'), trace.release)}
			${chip(vscode.l10n.t('Version'), trace.version)}
			${chip(vscode.l10n.t('Tags'), trace.tags?.length ? trace.tags.join(', ') : undefined)}
		</div>
		${scores ? `<div class="chips scores">${scores}</div>` : ''}
		<div class="trace-io">${valueBlock(vscode.l10n.t('Trace input'), trace.input)}${valueBlock(vscode.l10n.t('Trace output'), trace.output)}</div>`;

	if (!tree.flat.length) {
		return shell('', header + `<p class="dim">${escapeHtml(vscode.l10n.t('This trace has no observations.'))}</p>`);
	}

	const tabs = `
		<div class="tabs">
			<div class="tabstrip" role="tablist">
				<button class="tab active" data-tab="tree">${escapeHtml(vscode.l10n.t('Tree'))}</button>
				<button class="tab" data-tab="timeline">${escapeHtml(vscode.l10n.t('Timeline'))}</button>
				<button class="tab" data-tab="graph">${escapeHtml(vscode.l10n.t('Graph'))}</button>
			</div>
			<div class="tabtools">
				<input id="search" type="search" placeholder="${escapeHtml(vscode.l10n.t('Search spans…'))}" />
				<button id="collapse-all" class="secondary" title="${escapeHtml(vscode.l10n.t('Collapse All'))}">${escapeHtml(vscode.l10n.t('Collapse All'))}</button>
				<button id="expand-all" class="secondary" title="${escapeHtml(vscode.l10n.t('Expand All'))}">${escapeHtml(vscode.l10n.t('Expand All'))}</button>
			</div>
		</div>
		<div class="pane" data-pane="tree">${renderTree(tree)}</div>
		<div class="pane" data-pane="timeline" hidden>${renderTimeline(tree)}</div>
		<div class="pane" data-pane="graph" hidden>${renderGraph(trace)}</div>`;

	return shell('', header + tabs);
}

/** Wraps content in the full HTML document with CSP, theme-aware styles and behaviour. */
function shell(loadingText: string, content: string): string {
	const nonce = crypto.randomUUID().replace(/-/g, '');
	const inner = loadingText ? `<p class="dim">${escapeHtml(loadingText)}</p>` : content;
	return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<style>
		body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); padding: 12px 16px; font-size: 13px; }
		h1 { font-size: 15px; margin: 0; overflow-wrap: anywhere; }
		.header { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; }
		.actions { display: flex; gap: 6px; flex: none; }
		button { font-family: inherit; font-size: 12px; padding: 4px 10px; border: none; border-radius: 3px; cursor: pointer; color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
		button:hover { background: var(--vscode-button-hoverBackground); }
		button.secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
		button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
		.chips { display: flex; flex-wrap: wrap; gap: 6px; margin: 10px 0; }
		.chip { background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); border-radius: 10px; padding: 2px 8px; font-size: 11px; }
		.chip-k { opacity: 0.7; margin-right: 3px; }
		.scores .chip { background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-panel-border); }
		.dim { opacity: 0.7; }
		.error { color: var(--vscode-errorForeground); white-space: pre-wrap; }
		.trace-io { margin-bottom: 10px; }

		/* tabs */
		.tabs { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: 6px; margin-bottom: 6px; }
		.tabstrip, .switch, .zoom { display: flex; gap: 2px; background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-panel-border); border-radius: 5px; padding: 2px; }
		.tab, .mode { background: transparent; color: var(--vscode-foreground); opacity: 0.75; padding: 3px 12px; }
		.tab:hover, .mode:hover { background: var(--vscode-toolbar-hoverBackground); }
		.tab.active, .mode.active { background: var(--vscode-button-background); color: var(--vscode-button-foreground); opacity: 1; }
		.tabtools { display: flex; gap: 6px; align-items: center; }
		#search { font-family: inherit; font-size: 12px; padding: 3px 8px; min-width: 160px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius: 3px; }

		/* shared span chrome */
		.badge { font-size: 9px; font-weight: 600; padding: 1px 5px; border-radius: 3px; margin-right: 5px; color: var(--vscode-editor-background); flex: none; }
		.badge.SPAN, .bar.SPAN { background: var(--vscode-charts-blue); }
		.badge.GENERATION, .bar.GENERATION { background: var(--vscode-charts-purple); }
		.badge.EVENT, .bar.EVENT { background: var(--vscode-charts-green); }
		.badge.AGENT, .bar.AGENT { background: var(--vscode-charts-purple); }
		.badge.TOOL, .bar.TOOL { background: var(--vscode-charts-orange); }
		.badge.CHAIN, .bar.CHAIN { background: var(--vscode-charts-blue); }
		.badge.RETRIEVER, .bar.RETRIEVER { background: var(--vscode-charts-green); }
		.badge.EVALUATOR, .bar.EVALUATOR { background: var(--vscode-charts-yellow); }
		.badge.EMBEDDING, .bar.EMBEDDING { background: var(--vscode-charts-yellow); }
		.badge.GUARDRAIL, .bar.GUARDRAIL { background: var(--vscode-charts-red); }
		.badge.ERROR, .bar.ERROR { background: var(--vscode-charts-red); }
		.name { overflow-wrap: anywhere; }
		.err { color: var(--vscode-errorForeground); font-size: 11px; margin: 0 0 4px calc(var(--depth) * 16px + 30px); white-space: pre-wrap; }

		/* tree */
		.tree { padding-top: 2px; }
		.node.hidden-row { display: none; }
		.node.collapsed-child { display: none; }
		.row { display: flex; align-items: baseline; gap: 4px; padding: 3px 4px 3px calc(var(--depth) * 16px + 4px); border-radius: 3px; }
		.row:hover { background: var(--vscode-list-hoverBackground); }
		.node.match > .row { background: var(--vscode-editor-findMatchHighlightBackground); }
		.twisty { background: transparent; color: var(--vscode-foreground); opacity: 0.65; padding: 0 3px; font-size: 10px; line-height: 1; }
		.twisty:hover { background: var(--vscode-toolbar-hoverBackground); }
		.twisty-spacer { display: inline-block; width: 14px; flex: none; }
		.metrics { display: flex; gap: 8px; flex-wrap: wrap; margin-left: auto; padding-left: 10px; font-size: 11px; align-items: baseline; }
		.dur { font-variant-numeric: tabular-nums; opacity: 0.75; }
		.dur.warm { color: var(--vscode-charts-yellow); opacity: 1; }
		.dur.hot { color: var(--vscode-charts-red); opacity: 1; }
		.tok { font-variant-numeric: tabular-nums; opacity: 0.75; }
		.cost { font-variant-numeric: tabular-nums; color: var(--vscode-charts-green); }
		.bodies { padding: 0 0 4px calc(var(--depth) * 16px + 30px); }

		/* timeline */
		.grid { display: grid; grid-template-columns: minmax(220px, 42%) 1fr; border-top: 1px solid var(--vscode-panel-border); }
		.cell-info, .cell-track { border-bottom: 1px solid var(--vscode-panel-border); padding: 5px 8px; min-width: 0; }
		.cell-track { position: relative; }
		.meta { opacity: 0.7; font-size: 11px; margin-top: 2px; }
		.bar { position: absolute; top: 50%; transform: translateY(-50%); height: 10px; border-radius: 3px; min-width: 2px; opacity: 0.85; }

		/* graph */
		.graph-toolbar { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
		.graph-canvas { overflow: auto; border: 1px solid var(--vscode-panel-border); border-radius: 5px; background: var(--vscode-editorWidget-background); max-height: 70vh; }
		#graph-svg { display: block; }
		.edge { fill: none; stroke: var(--vscode-editorLineNumber-foreground); stroke-width: 1.4; opacity: 0.75; }
		.edge.return { stroke-dasharray: 4 3; opacity: 0.6; }
		#arrow path { fill: var(--vscode-editorLineNumber-foreground); opacity: 0.75; }
		.gnode rect { fill: var(--vscode-editor-background); stroke: var(--vscode-charts-blue); stroke-width: 2; }
		.gnode text { fill: var(--vscode-foreground); font-size: 12px; font-family: var(--vscode-font-family); }
		.gnode.start rect { fill: var(--vscode-charts-green); stroke: var(--vscode-charts-green); }
		.gnode.end rect { fill: var(--vscode-charts-red); stroke: var(--vscode-charts-red); }
		.gnode.start text, .gnode.end text { fill: var(--vscode-editor-background); font-weight: 600; }
		.gnode.llm rect { stroke: var(--vscode-charts-purple); }
		.gnode.tool rect { stroke: var(--vscode-charts-orange); }
		.gnode.error rect { stroke: var(--vscode-charts-red); }

		details { margin: 2px 0; }
		summary { cursor: pointer; opacity: 0.8; font-size: 11px; }
		pre { white-space: pre-wrap; overflow-wrap: anywhere; background: var(--vscode-textCodeBlock-background); padding: 8px; border-radius: 4px; margin: 4px 0; max-height: 360px; overflow: auto; font-family: var(--vscode-editor-font-family); font-size: 12px; }
	</style>
</head>
<body>
	${inner}
	<script nonce="${nonce}">
		const vscodeApi = acquireVsCodeApi();
		document.getElementById('open')?.addEventListener('click', () => vscodeApi.postMessage({ type: 'openInLangfuse' }));
		document.getElementById('copy')?.addEventListener('click', () => vscodeApi.postMessage({ type: 'copyTraceId' }));

		// --- tabs
		const panes = document.querySelectorAll('.pane');
		document.querySelectorAll('.tab').forEach(tab => tab.addEventListener('click', () => {
			document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t === tab));
			panes.forEach(pane => { pane.hidden = pane.dataset.pane !== tab.dataset.tab; });
			if (tab.dataset.tab === 'graph') { fit(); }
		}));

		// --- tree collapse / expand
		const nodes = Array.from(document.querySelectorAll('.node'));
		const childrenOf = new Map();
		for (const node of nodes) {
			const parent = node.dataset.parent;
			if (parent) {
				if (!childrenOf.has(parent)) { childrenOf.set(parent, []); }
				childrenOf.get(parent).push(node);
			}
		}
		const collapsed = new Set();
		function applyVisibility() {
			for (const node of nodes) {
				let hidden = false;
				let parent = node.dataset.parent;
				const seen = new Set();
				while (parent && !seen.has(parent)) {
					seen.add(parent);
					if (collapsed.has(parent)) { hidden = true; break; }
					const parentNode = nodes.find(n => n.dataset.id === parent);
					parent = parentNode?.dataset.parent;
				}
				node.classList.toggle('collapsed-child', hidden);
			}
		}
		function setCollapsed(node, isCollapsed) {
			const id = node.dataset.id;
			const twisty = node.querySelector('.twisty');
			if (!twisty) { return; }
			if (isCollapsed) { collapsed.add(id); } else { collapsed.delete(id); }
			twisty.textContent = isCollapsed ? '▸' : '▾';
			twisty.setAttribute('aria-expanded', String(!isCollapsed));
		}
		document.querySelectorAll('.node .twisty').forEach(twisty => twisty.addEventListener('click', () => {
			const node = twisty.closest('.node');
			setCollapsed(node, !collapsed.has(node.dataset.id));
			applyVisibility();
		}));
		document.getElementById('collapse-all')?.addEventListener('click', () => {
			nodes.forEach(node => setCollapsed(node, true));
			applyVisibility();
		});
		document.getElementById('expand-all')?.addEventListener('click', () => {
			nodes.forEach(node => setCollapsed(node, false));
			applyVisibility();
		});

		// --- search: keeps matches plus their ancestors, and expands to reveal them
		const search = document.getElementById('search');
		search?.addEventListener('input', () => {
			const term = search.value.trim().toLowerCase();
			if (!term) {
				nodes.forEach(node => { node.classList.remove('hidden-row', 'match'); });
				applyVisibility();
				return;
			}
			const keep = new Set();
			for (const node of nodes) {
				const isMatch = (node.dataset.search || '').includes(term);
				node.classList.toggle('match', isMatch);
				if (!isMatch) { continue; }
				keep.add(node.dataset.id);
				let parent = node.dataset.parent;
				const seen = new Set();
				while (parent && !seen.has(parent)) {
					seen.add(parent);
					keep.add(parent);
					parent = nodes.find(n => n.dataset.id === parent)?.dataset.parent;
				}
			}
			nodes.forEach(node => {
				node.classList.toggle('hidden-row', !keep.has(node.dataset.id));
				setCollapsed(node, false);
			});
			applyVisibility();
		});

		// --- graph: mode switch, pan and zoom
		let scale = 1;
		function activePane() { return document.querySelector('.graph-pane:not([hidden])'); }
		function applyScale() {
			const svg = activePane()?.querySelector('#graph-svg, svg');
			if (!svg) { return; }
			const base = Number(svg.getAttribute('viewBox')?.split(' ')[2] || 0);
			const baseHeight = Number(svg.getAttribute('viewBox')?.split(' ')[3] || 0);
			svg.setAttribute('width', String(Math.max(1, base * scale)));
			svg.setAttribute('height', String(Math.max(1, baseHeight * scale)));
		}
		function fit() {
			const pane = activePane();
			const svg = pane?.querySelector('svg');
			const canvas = document.getElementById('graph-canvas');
			if (!svg || !canvas) { return; }
			const base = Number(svg.getAttribute('viewBox')?.split(' ')[2] || 0);
			if (!base) { return; }
			scale = Math.min(1, Math.max(0.2, (canvas.clientWidth - 8) / base));
			applyScale();
		}
		document.getElementById('zoom-in')?.addEventListener('click', () => { scale = Math.min(3, scale * 1.2); applyScale(); });
		document.getElementById('zoom-out')?.addEventListener('click', () => { scale = Math.max(0.15, scale / 1.2); applyScale(); });
		document.getElementById('zoom-fit')?.addEventListener('click', fit);
		document.querySelectorAll('.mode').forEach(button => button.addEventListener('click', () => {
			document.querySelectorAll('.mode').forEach(b => b.classList.toggle('active', b === button));
			document.querySelectorAll('.graph-pane').forEach(pane => { pane.hidden = pane.dataset.mode !== button.dataset.mode; });
			fit();
		}));
	</script>
</body>
</html>`;
}
