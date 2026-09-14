/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Derives the agent graph from a trace's observations, mirroring Langfuse's own
// two builders (web/src/features/trace-graph-view):
//
//  * Aggregated — one node per step NAME, so repeated steps collapse and loops
//    render as cycles. Steps come from `metadata.langgraph_step` when the trace
//    was produced by LangGraph, otherwise they are inferred from timing. Edges
//    connect every node in step i to every node in step i+1.
//  * Expanded — one node per observation, in the order it ran, so loops unroll
//    into an acyclic graph. Edges follow sibling ordering with a transitive
//    reduction so only immediate predecessors are drawn.

import { LangfuseObservation, LangfuseTrace } from './api';
import { AgentGraph, GraphEdge, GraphNode, GraphNodeKind } from './graphLayout';
import { formatCost, formatDuration, observationCost, toMs } from './traceModel';

export const START_NODE = '__start__';
export const END_NODE = '__end__';

const LANGGRAPH_NODE_TAG = 'langgraph_node';
const LANGGRAPH_STEP_TAG = 'langgraph_step';

/** Langfuse's own ceilings; past these the views are unusable rather than slow. */
export const MAX_OBSERVATIONS_FOR_GRAPH = 5000;
const MAX_AGGREGATED_NODES = 500;
const MAX_AGGREGATED_EDGES = 250;
const MAX_EXPANDED_EDGES = 10_000;

export type GraphMode = 'aggregated' | 'expanded';

/** One observation reduced to just what graph building needs. */
interface GraphObservation {
	readonly id: string;
	readonly parentObservationId: string | undefined;
	readonly name: string;
	readonly type: string;
	readonly startMs: number;
	readonly endMs: number;
	readonly node: string | undefined;
	readonly step: number | undefined;
	readonly cost: number | undefined;
	readonly isError: boolean;
}

export interface AgentGraphResult {
	readonly graph: AgentGraph;
	/** Observation ids behind each node, in run order — drives click-through. */
	readonly nodeObservations: ReadonlyMap<string, readonly string[]>;
	/** Set when the graph was too large to build. */
	readonly unavailable?: string;
}

function readMetadataString(metadata: unknown, key: string): string | undefined {
	if (!metadata || typeof metadata !== 'object') {
		return undefined;
	}
	const record = metadata as Record<string, unknown>;
	const direct = record[key];
	if (typeof direct === 'string' && direct.trim()) {
		return direct.trim();
	}
	// The JS SDK flattens metadata into OTel attributes.
	const flattened = record[`langfuse.observation.metadata.${key}`];
	return typeof flattened === 'string' && flattened.trim() ? flattened.trim() : undefined;
}

function readMetadataNumber(metadata: unknown, key: string): number | undefined {
	if (!metadata || typeof metadata !== 'object') {
		return undefined;
	}
	const record = metadata as Record<string, unknown>;
	const raw = record[key] ?? record[`langfuse.observation.metadata.${key}`];
	if (typeof raw === 'number' && isFinite(raw)) {
		return raw;
	}
	// ClickHouse hands metadata back as strings, so coerce like Langfuse does.
	if (typeof raw === 'string' && raw.trim() && !Number.isNaN(Number(raw))) {
		return Number(raw);
	}
	return undefined;
}

function project(observations: readonly LangfuseObservation[]): GraphObservation[] {
	return observations.map(o => {
		const startMs = toMs(o.startTime) ?? 0;
		return {
			id: o.id,
			parentObservationId: o.parentObservationId ?? undefined,
			name: (o.name ?? '').trim() || o.id,
			type: (o.type ?? 'SPAN').toUpperCase(),
			startMs,
			endMs: toMs(o.endTime) ?? startMs,
			node: readMetadataString(o.metadata, LANGGRAPH_NODE_TAG),
			step: readMetadataNumber(o.metadata, LANGGRAPH_STEP_TAG),
			cost: observationCost(o),
			isError: (o.level ?? '').toUpperCase() === 'ERROR',
		};
	});
}

function kindFor(type: string, name: string): GraphNodeKind {
	if (name === START_NODE) { return 'start'; }
	if (name === END_NODE) { return 'end'; }
	if (type === 'GENERATION' || type === 'EMBEDDING') { return 'llm'; }
	if (type === 'TOOL' || type === 'RETRIEVER') { return 'tool'; }
	return 'step';
}

/** True when the trace carries usable LangGraph step metadata. */
function hasStepData(observations: readonly GraphObservation[]): boolean {
	return observations.some(o => o.step !== undefined && o.step !== 0 && o.node !== undefined);
}

/**
 * Groups observations into "super-steps" by overlap: observations that run
 * concurrently share a step. Ported from Langfuse's buildStepData for traces
 * without framework metadata.
 */
function assignTimingSteps(observations: readonly GraphObservation[]): Map<string, number> {
	const sorted = [...observations].sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs || a.id.localeCompare(b.id));
	const steps = new Map<string, number>();

	let remaining = sorted;
	let step = 1;
	while (remaining.length) {
		const group: GraphObservation[] = [remaining[0]];
		let groupEnd = remaining[0].endMs;
		const leftovers: GraphObservation[] = [];
		for (const candidate of remaining.slice(1)) {
			if (candidate.startMs < groupEnd) {
				group.push(candidate);
				groupEnd = Math.max(groupEnd, candidate.endMs);
			} else {
				leftovers.push(candidate);
			}
		}
		// Drop members that begin only after another member already finished:
		// they are sequential, not concurrent, so they belong to a later step.
		const earliestEnd = Math.min(...group.map(o => o.endMs));
		const concurrent = group.filter((o, index) => index === 0 || o.startMs < earliestEnd);
		const deferred = group.filter(o => !concurrent.includes(o));

		for (const o of concurrent) {
			steps.set(o.id, step);
		}
		step++;
		remaining = [...deferred, ...leftovers].sort((a, b) => a.startMs - b.startMs || a.id.localeCompare(b.id));
	}

	// A child can never share or precede its parent's step.
	const byId = new Map(observations.map(o => [o.id, o]));
	for (let pass = 0; pass < 100; pass++) {
		let changed = false;
		for (const o of sorted) {
			const parentId = o.parentObservationId;
			if (!parentId || !byId.has(parentId)) {
				continue;
			}
			const parentStep = steps.get(parentId) ?? 0;
			if ((steps.get(o.id) ?? 0) <= parentStep) {
				steps.set(o.id, parentStep + 1);
				changed = true;
			}
		}
		if (!changed) {
			break;
		}
	}
	return steps;
}

function nodeTooltip(observations: readonly GraphObservation[]): string | undefined {
	if (!observations.length) {
		return undefined;
	}
	const runs = observations.length;
	const duration = formatDuration(observations.reduce((acc, o) => acc + Math.max(0, o.endMs - o.startMs), 0));
	const cost = formatCost(observations.reduce((acc, o) => acc + (o.cost ?? 0), 0) || undefined);
	const parts = [
		runs > 1 ? `${runs} runs` : undefined,
		duration ? `${runs > 1 ? 'total ' : ''}${duration}` : undefined,
		cost,
		observations[0].type,
	].filter(Boolean);
	return parts.join(' · ');
}

/** Aggregated graph: one node per step name, edges between consecutive steps. */
function buildAggregated(observations: readonly GraphObservation[]): AgentGraphResult {
	const usesLangGraph = hasStepData(observations);

	// LangGraph traces show only framework nodes; their LLM/tool children are
	// folded away because they carry no langgraph_node of their own.
	const relevant = observations.filter(o => o.type !== 'EVENT' && (usesLangGraph ? o.node !== undefined : true));
	if (!relevant.length) {
		return { graph: { nodes: [], edges: [] }, nodeObservations: new Map() };
	}

	const timingSteps = usesLangGraph ? undefined : assignTimingSteps(relevant);
	const stepOf = (o: GraphObservation): number => (usesLangGraph ? (o.step ?? 0) : (timingSteps!.get(o.id) ?? 0));
	const nameOf = (o: GraphObservation): string => (usesLangGraph ? o.node! : o.name);

	const byStep = new Map<number, Set<string>>();
	const nodeObservations = new Map<string, string[]>();
	const nodeSamples = new Map<string, GraphObservation[]>();
	const byId = new Map(relevant.map(o => [o.id, o]));

	for (const o of [...relevant].sort((a, b) => a.startMs - b.startMs)) {
		const name = nameOf(o);
		if (name === START_NODE || name === END_NODE) {
			continue;
		}
		const step = stepOf(o);
		(byStep.get(step) ?? byStep.set(step, new Set()).get(step)!).add(name);

		// Only the outermost of a same-name parent/child chain is clickable, so
		// nested retries do not register the same node twice.
		const parent = o.parentObservationId ? byId.get(o.parentObservationId) : undefined;
		if (!parent || nameOf(parent) !== name) {
			(nodeObservations.get(name) ?? nodeObservations.set(name, []).get(name)!).push(o.id);
			(nodeSamples.get(name) ?? nodeSamples.set(name, []).get(name)!).push(o);
		}
	}

	const steps = [...byStep.keys()].sort((a, b) => a - b);

	// A looping agent revisits the same node at higher step numbers. Nodes are
	// keyed by name, so each name is emitted once and layered by where it first
	// ran; the repeat visits become the cycle edges below.
	const firstLayerOf = new Map<string, number>();
	steps.forEach((step, index) => {
		for (const name of byStep.get(step)!) {
			if (!firstLayerOf.has(name)) {
				firstLayerOf.set(name, index + 1);
			}
		}
	});

	const nodes: GraphNode[] = [{ id: START_NODE, label: START_NODE, kind: 'start', layer: 0 }];
	for (const [name, layer] of firstLayerOf) {
		const samples = nodeSamples.get(name) ?? [];
		const runs = nodeObservations.get(name)?.length ?? 0;
		nodes.push({
			id: name,
			label: name,
			kind: kindFor(samples[0]?.type ?? 'SPAN', name),
			layer,
			executions: runs,
			completed: runs,
			tooltip: nodeTooltip(samples),
			hasError: samples.some(o => o.isError),
		});
	}
	nodes.push({ id: END_NODE, label: END_NODE, kind: 'end', layer: Math.max(...firstLayerOf.values(), 0) + 1 });

	// Complete bipartite between consecutive steps, exactly as Langfuse does.
	const edges: GraphEdge[] = [];
	const seen = new Set<string>();
	const addEdge = (from: string, to: string) => {
		const key = `${from} ${to}`;
		if (from !== to && !seen.has(key)) {
			seen.add(key);
			edges.push({ from, to });
		}
	};
	for (const name of byStep.get(steps[0]) ?? []) {
		addEdge(START_NODE, name);
	}
	for (let i = 0; i < steps.length - 1; i++) {
		for (const from of byStep.get(steps[i])!) {
			for (const to of byStep.get(steps[i + 1])!) {
				addEdge(from, to);
			}
		}
	}
	for (const name of byStep.get(steps[steps.length - 1]) ?? []) {
		addEdge(name, END_NODE);
	}

	if (nodes.length > MAX_AGGREGATED_NODES || edges.length > MAX_AGGREGATED_EDGES) {
		return {
			graph: { nodes: [], edges: [] },
			nodeObservations: new Map(),
			unavailable: `This trace is too large for the aggregated graph (${nodes.length} nodes, ${edges.length} edges). Try the expanded view.`,
		};
	}

	return { graph: { nodes, edges }, nodeObservations };
}

/**
 * Expanded graph: a node per observation in run order. Siblings are chained by
 * "finished before this started", reduced so only immediate predecessors keep an
 * edge; a node with no such predecessor descends from its parent instead.
 */
function buildExpanded(observations: readonly GraphObservation[]): AgentGraphResult {
	const included = observations.filter(o => o.type !== 'EVENT');
	if (!included.length) {
		return { graph: { nodes: [], edges: [] }, nodeObservations: new Map() };
	}
	const includedIds = new Set(included.map(o => o.id));
	const byId = new Map(observations.map(o => [o.id, o]));

	/** Nearest ancestor that survived filtering. */
	const resolveParent = (o: GraphObservation): string | undefined => {
		let parentId = o.parentObservationId;
		const seen = new Set<string>();
		while (parentId && !seen.has(parentId)) {
			seen.add(parentId);
			if (includedIds.has(parentId)) {
				return parentId;
			}
			parentId = byId.get(parentId)?.parentObservationId;
		}
		return undefined;
	};

	const groups = new Map<string, GraphObservation[]>();
	const parentOf = new Map<string, string | undefined>();
	for (const o of included) {
		const parent = resolveParent(o);
		parentOf.set(o.id, parent);
		const key = parent ?? ' root';
		(groups.get(key) ?? groups.set(key, []).get(key)!).push(o);
	}
	const byRunOrder = (a: GraphObservation, b: GraphObservation) =>
		a.startMs - b.startMs || a.endMs - b.endMs || a.id.localeCompare(b.id);
	for (const group of groups.values()) {
		group.sort(byRunOrder);
	}

	const edges: GraphEdge[] = [];
	const hasIncoming = new Set<string>();
	const hasSiblingOutgoing = new Set<string>();

	for (const [key, group] of groups) {
		const parent = key === ' root' ? undefined : key;
		group.forEach((observation, index) => {
			const before = group.slice(0, index).filter(candidate => candidate.endMs <= observation.startMs);
			if (!before.length) {
				if (parent) {
					edges.push({ from: parent, to: observation.id });
					hasIncoming.add(observation.id);
				}
				return;
			}
			// Transitive reduction over the interval order: keep predecessor p
			// only if it ends after every *other* predecessor started, i.e. no
			// third span sits between p and this observation.
			const starts = [...before].map(o => o.startMs).sort((a, b) => b - a);
			const [largestStart, secondStart = -Infinity] = starts;
			let immediate = before.filter(p => p.endMs > (p.startMs === largestStart ? secondStart : largestStart));
			if (!immediate.length) {
				const latestEnd = Math.max(...before.map(o => o.endMs));
				immediate = before.filter(o => o.endMs === latestEnd);
			}
			for (const predecessor of immediate) {
				edges.push({ from: predecessor.id, to: observation.id });
				hasIncoming.add(observation.id);
				hasSiblingOutgoing.add(predecessor.id);
			}
		});
	}

	const nodes: GraphNode[] = [{ id: START_NODE, label: START_NODE, kind: 'start' }];
	for (const o of [...included].sort(byRunOrder)) {
		nodes.push({
			id: o.id,
			label: o.name,
			kind: kindFor(o.type, o.name),
			tooltip: nodeTooltip([o]),
			hasError: o.isError,
		});
	}
	nodes.push({ id: END_NODE, label: END_NODE, kind: 'end' });

	for (const o of included) {
		if (!hasIncoming.has(o.id)) {
			edges.push({ from: START_NODE, to: o.id });
		}
	}
	const rootGroup = groups.get(' root') ?? [];
	for (const o of rootGroup) {
		if (!hasSiblingOutgoing.has(o.id)) {
			edges.push({ from: o.id, to: END_NODE });
		}
	}

	if (edges.length > MAX_EXPANDED_EDGES) {
		return {
			graph: { nodes: [], edges: [] },
			nodeObservations: new Map(),
			unavailable: 'This trace branches too widely for the expanded graph.',
		};
	}

	return {
		graph: { nodes, edges },
		nodeObservations: new Map(included.map(o => [o.id, [o.id]])),
	};
}

/**
 * True when a graph is worth showing: either the trace is agentic (agentic
 * observation types or LangGraph steps) or it simply has more than one distinct
 * step name to draw.
 */
export function shouldShowGraph(trace: LangfuseTrace): boolean {
	const observations = project(trace.observations ?? []);
	if (!observations.length || observations.length > MAX_OBSERVATIONS_FOR_GRAPH) {
		return false;
	}
	const nonEvent = observations.filter(o => o.type !== 'EVENT');
	const agentic = nonEvent.some(o => !['SPAN', 'EVENT', 'GENERATION'].includes(o.type) || (o.step !== undefined && o.step !== 0));
	if (agentic) {
		return true;
	}
	const names = new Set(nonEvent.map(o => o.name));
	const rootless = nonEvent.filter(o => !o.parentObservationId);
	// A lone synthetic root span mirroring the trace is not a graph.
	return names.size > 1 && !(names.size === 1 && rootless.length === 1);
}

/** Expanded is the default for agentic traces, matching Langfuse. */
export function defaultGraphMode(trace: LangfuseTrace): GraphMode {
	const observations = project(trace.observations ?? []);
	const agentic = observations.some(o =>
		(o.type !== 'SPAN' && o.type !== 'EVENT' && o.type !== 'GENERATION') || (o.step !== undefined && o.step !== 0));
	return agentic ? 'expanded' : 'aggregated';
}

export function buildAgentGraph(trace: LangfuseTrace, mode: GraphMode): AgentGraphResult {
	const observations = project(trace.observations ?? []);
	if (observations.length > MAX_OBSERVATIONS_FOR_GRAPH) {
		return {
			graph: { nodes: [], edges: [] },
			nodeObservations: new Map(),
			unavailable: `This trace has ${observations.length} observations, above the ${MAX_OBSERVATIONS_FOR_GRAPH} the graph can render.`,
		};
	}
	return mode === 'expanded' ? buildExpanded(observations) : buildAggregated(observations);
}
