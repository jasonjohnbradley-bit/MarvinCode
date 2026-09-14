/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Shared shaping of a Langfuse trace: the observation hierarchy plus the
// per-node aggregates the Tree and Timeline views display. Kept free of any
// vscode imports so it can be unit tested in isolation.

import { LangfuseObservation, LangfuseTrace } from './api';

/** An observation plus its children and subtree aggregates. */
export interface TraceNode {
	readonly observation: LangfuseObservation;
	readonly children: TraceNode[];
	readonly depth: number;
	/** Wall clock start/end in epoch ms; end falls back to start for events. */
	readonly startMs: number;
	readonly endMs: number;
	/** This observation's own cost in USD, if any. */
	readonly ownCost: number | undefined;
	/** Own cost plus the cost of every descendant — Langfuse's "∑" value. */
	readonly totalCost: number | undefined;
	/** Token usage of this observation (generations only, as a rule). */
	readonly tokens: TokenUsage | undefined;
}

export interface TokenUsage {
	readonly input: number | undefined;
	readonly output: number | undefined;
	readonly total: number | undefined;
}

export interface TraceTree {
	readonly roots: TraceNode[];
	/** Depth-first order, matching how the tree is rendered. */
	readonly flat: TraceNode[];
	readonly traceStartMs: number;
	readonly traceEndMs: number;
	readonly durationMs: number;
	readonly totalCost: number | undefined;
	readonly totalTokens: number | undefined;
}

export function toMs(iso: string | null | undefined): number | undefined {
	if (!iso) {
		return undefined;
	}
	const ms = Date.parse(iso);
	return Number.isNaN(ms) ? undefined : ms;
}

/**
 * Collapses a `usageDetails`/`costDetails` map the way Langfuse does: every key
 * prefixed "input" sums into input, every "output" key into output, while total
 * is read from the literal `total` key rather than summed. Providers report
 * extra buckets (cache reads, reasoning tokens) that belong to the total but to
 * neither side, so `input + output === total` does NOT generally hold.
 */
function reduceDetails(details: Record<string, number> | undefined): { input?: number; output?: number; total?: number } {
	if (!details) {
		return {};
	}
	let input: number | undefined;
	let output: number | undefined;
	for (const [key, value] of Object.entries(details)) {
		if (typeof value !== 'number' || !isFinite(value)) {
			continue;
		}
		if (key.startsWith('input')) {
			input = (input ?? 0) + value;
		} else if (key.startsWith('output')) {
			output = (output ?? 0) + value;
		}
	}
	const total = typeof details.total === 'number' ? details.total : undefined;
	return { input, output, total };
}

/** Token usage of a single observation, normalized across the API's shapes. */
export function observationTokens(o: LangfuseObservation): TokenUsage | undefined {
	const { input: detailInput, output: detailOutput, total: detailTotal } = reduceDetails(o.usageDetails ?? undefined);
	const usage = o.usage ?? undefined;

	const legacyNumber = (...candidates: unknown[]): number | undefined =>
		candidates.find((c): c is number => typeof c === 'number' && isFinite(c));

	const input = detailInput ?? legacyNumber(usage?.promptTokens, usage?.input);
	const output = detailOutput ?? legacyNumber(usage?.completionTokens, usage?.output);
	let total = detailTotal ?? legacyNumber(usage?.totalTokens, usage?.total);
	if (total === undefined && (input !== undefined || output !== undefined)) {
		total = (input ?? 0) + (output ?? 0);
	}

	if (input === undefined && output === undefined && total === undefined) {
		return undefined;
	}
	return { input, output, total };
}

/** This observation's own cost in USD (never includes descendants). */
export function observationCost(o: LangfuseObservation): number | undefined {
	const { input, output, total } = reduceDetails(o.costDetails ?? undefined);
	if (typeof total === 'number' && total > 0) {
		return total;
	}
	const sides = (input ?? 0) + (output ?? 0);
	if (sides > 0) {
		return sides;
	}
	if (typeof o.calculatedTotalCost === 'number' && o.calculatedTotalCost > 0) {
		return o.calculatedTotalCost;
	}
	return undefined;
}

/**
 * Builds the observation hierarchy from the flat list, ordering siblings by
 * start time and rolling costs up so each node carries its subtree total.
 * Observations whose parent is missing from the payload become roots.
 */
export function buildTraceTree(trace: LangfuseTrace): TraceTree {
	const observations = [...(trace.observations ?? [])];
	const byId = new Map(observations.map(o => [o.id, o]));

	const nodes = new Map<string, TraceNode>();
	for (const observation of observations) {
		const startMs = toMs(observation.startTime) ?? 0;
		nodes.set(observation.id, {
			observation,
			children: [],
			depth: 0,
			startMs,
			endMs: toMs(observation.endTime) ?? startMs,
			ownCost: observationCost(observation),
			totalCost: undefined,
			tokens: observationTokens(observation),
		});
	}

	const roots: TraceNode[] = [];
	for (const node of nodes.values()) {
		const parentId = node.observation.parentObservationId ?? undefined;
		const parent = parentId && byId.has(parentId) ? nodes.get(parentId) : undefined;
		if (parent && parent !== node) {
			parent.children.push(node);
		} else {
			roots.push(node);
		}
	}

	const byStart = (a: TraceNode, b: TraceNode) => a.startMs - b.startMs || a.observation.id.localeCompare(b.observation.id);
	roots.sort(byStart);
	for (const node of nodes.values()) {
		node.children.sort(byStart);
	}

	// Roll subtree costs up and assign depth, iteratively so a pathological
	// (cyclic or very deep) payload cannot blow the stack.
	const flat: TraceNode[] = [];
	const visited = new Set<string>();
	const assign = (root: TraceNode): void => {
		const stack: { node: TraceNode; depth: number; exiting: boolean }[] = [{ node: root, depth: 0, exiting: false }];
		while (stack.length) {
			const frame = stack.pop()!;
			const { node, depth } = frame;
			if (frame.exiting) {
				let total = node.ownCost ?? 0;
				for (const child of node.children) {
					total += child.totalCost ?? 0;
				}
				(node as { totalCost: number | undefined }).totalCost = total > 0 ? total : undefined;
				continue;
			}
			if (visited.has(node.observation.id)) {
				continue;
			}
			visited.add(node.observation.id);
			(node as { depth: number }).depth = depth;
			flat.push(node);
			stack.push({ node, depth, exiting: true });
			for (let i = node.children.length - 1; i >= 0; i--) {
				stack.push({ node: node.children[i], depth: depth + 1, exiting: false });
			}
		}
	};
	for (const root of roots) {
		assign(root);
	}

	const traceTimestamp = toMs(trace.timestamp);
	const starts = flat.map(n => n.startMs).filter(n => n > 0);
	const ends = flat.map(n => n.endMs).filter(n => n > 0);
	const traceStartMs = Math.min(...(traceTimestamp ? [traceTimestamp] : []), ...(starts.length ? starts : [traceTimestamp ?? 0]));
	const traceEndMs = Math.max(traceStartMs + 1, ...(ends.length ? ends : [traceStartMs + 1]));

	const summedCost = roots.reduce((acc, n) => acc + (n.totalCost ?? 0), 0);
	const totalCost = typeof trace.totalCost === 'number' && trace.totalCost > 0 ? trace.totalCost : (summedCost > 0 ? summedCost : undefined);
	const summedTokens = flat.reduce((acc, n) => acc + (n.tokens?.total ?? 0), 0);
	const durationMs = typeof trace.latency === 'number' && trace.latency > 0 ? trace.latency * 1000 : traceEndMs - traceStartMs;

	return {
		roots,
		flat,
		traceStartMs,
		traceEndMs,
		durationMs,
		totalCost,
		totalTokens: summedTokens > 0 ? summedTokens : undefined,
	};
}

// --- formatting --------------------------------------------------------------

/**
 * Langfuse-style duration: sub-minute always in seconds (never milliseconds),
 * then "1m 49s", then "1h 04m 09s".
 */
export function formatDuration(ms: number | undefined): string | undefined {
	if (typeof ms !== 'number' || !isFinite(ms) || ms < 0) {
		return undefined;
	}
	const totalSeconds = ms / 1000;
	if (totalSeconds < 60) {
		return `${totalSeconds.toFixed(2)}s`;
	}
	const rounded = Math.round(totalSeconds);
	const hours = Math.floor(rounded / 3600);
	const minutes = Math.floor((rounded % 3600) / 60);
	const seconds = rounded % 60;
	const pad = (value: number) => String(value).padStart(2, '0');
	return hours > 0 ? `${hours}h ${pad(minutes)}m ${pad(seconds)}s` : `${minutes}m ${pad(seconds)}s`;
}

export function formatCost(cost: number | undefined): string | undefined {
	if (typeof cost !== 'number' || !isFinite(cost) || cost === 0) {
		return undefined;
	}
	// Per-call costs are fractions of a cent, so sub-dollar amounts keep six
	// decimals; larger totals would only be noise at that precision.
	return cost < 1 ? `$${cost.toFixed(6)}` : `$${cost.toFixed(4)}`;
}

export function formatCount(value: number): string {
	return value.toLocaleString('en-US');
}

/** "81,944 → 173 (∑ 82,117)", omitting parts the provider did not report. */
export function formatTokens(tokens: TokenUsage | undefined): string | undefined {
	if (!tokens) {
		return undefined;
	}
	const { input, output, total } = tokens;
	if (input !== undefined && output !== undefined) {
		const sum = total !== undefined ? ` (∑ ${formatCount(total)})` : '';
		return `${formatCount(input)} → ${formatCount(output)}${sum}`;
	}
	if (total !== undefined) {
		return `∑ ${formatCount(total)}`;
	}
	const single = input ?? output;
	return single !== undefined ? formatCount(single) : undefined;
}
