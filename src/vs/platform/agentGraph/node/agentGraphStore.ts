/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'fs';
import { dirname } from '../../../base/common/path.js';
import type { Database } from '@vscode/sqlite3';
import { IAgentEvent, IAgentGraphEdge, IAgentGraphFilter, IAgentGraphNode, IAgentGraphSnapshot, IAgentSessionSummary, AgentEventSource, AgentEventVerb, AgentGraphNodeType } from '../common/agentGraph.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
	id TEXT PRIMARY KEY,
	ts INTEGER NOT NULL,
	source TEXT NOT NULL,
	session_id TEXT NOT NULL,
	prompt_id TEXT,
	actor TEXT NOT NULL,
	verb TEXT NOT NULL,
	ok INTEGER,
	duration_ms INTEGER,
	objects TEXT NOT NULL,
	payload TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_session_ts ON events(session_id, ts);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
CREATE TABLE IF NOT EXISTS nodes (
	type TEXT NOT NULL,
	key TEXT NOT NULL,
	label TEXT NOT NULL,
	first_seen INTEGER NOT NULL,
	last_seen INTEGER NOT NULL,
	PRIMARY KEY (type, key)
);
CREATE TABLE IF NOT EXISTS edges (
	from_type TEXT NOT NULL,
	from_key TEXT NOT NULL,
	to_type TEXT NOT NULL,
	to_key TEXT NOT NULL,
	rel TEXT NOT NULL,
	event_id TEXT NOT NULL,
	ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_edges_from ON edges(from_type, from_key);
CREATE INDEX IF NOT EXISTS idx_edges_ts ON edges(ts);
`;

/**
 * Append-only SQLite store for agent events plus the graph tables derived
 * from them. One instance lives in the Electron main process, so a single
 * writer serves every window.
 */
export class AgentGraphStore {

	private readonly whenReady: Promise<Database>;

	constructor(private readonly dbPath: string) {
		this.whenReady = this.open();
	}

	private async open(): Promise<Database> {
		await fs.mkdir(dirname(this.dbPath), { recursive: true });
		const sqlite3 = await import('@vscode/sqlite3');
		const db = await new Promise<Database>((resolve, reject) => {
			const database: Database = new sqlite3.default.Database(this.dbPath, (error: Error | null) => error ? reject(error) : resolve(database));
		});
		await this.exec(db, 'PRAGMA journal_mode = WAL;');
		await this.exec(db, SCHEMA);
		return db;
	}

	private exec(db: Database, sql: string): Promise<void> {
		return new Promise((resolve, reject) => db.exec(sql, error => error ? reject(error) : resolve()));
	}

	private run(db: Database, sql: string, params: unknown[]): Promise<void> {
		return new Promise((resolve, reject) => db.run(sql, params, (error: Error | null) => error ? reject(error) : resolve()));
	}

	private all<T>(db: Database, sql: string, params: unknown[]): Promise<T[]> {
		return new Promise((resolve, reject) => db.all(sql, params, (error: Error | null, rows: T[]) => error ? reject(error) : resolve(rows)));
	}

	async insert(event: IAgentEvent, nodes: readonly IAgentGraphNode[], edges: readonly IAgentGraphEdge[]): Promise<void> {
		const db = await this.whenReady;
		await this.exec(db, 'BEGIN');
		try {
			await this.run(db, 'INSERT OR IGNORE INTO events VALUES (?,?,?,?,?,?,?,?,?,?,?)', [
				event.id, event.ts, event.source, event.sessionId, event.promptId ?? null, event.actor, event.verb,
				typeof event.ok === 'boolean' ? (event.ok ? 1 : 0) : null, event.durationMs ?? null,
				JSON.stringify(event.objects), event.payload !== undefined ? JSON.stringify(event.payload) : null
			]);
			for (const node of nodes) {
				await this.run(db, `INSERT INTO nodes VALUES (?,?,?,?,?)
					ON CONFLICT (type, key) DO UPDATE SET last_seen = excluded.last_seen, label = excluded.label`, [
					node.type, node.key, node.label, node.firstSeen, node.lastSeen
				]);
			}
			for (const edge of edges) {
				await this.run(db, 'INSERT INTO edges VALUES (?,?,?,?,?,?,?)', [
					edge.fromType, edge.fromKey, edge.toType, edge.toKey, edge.rel, edge.eventId, edge.ts
				]);
			}
			await this.exec(db, 'COMMIT');
		} catch (error) {
			await this.exec(db, 'ROLLBACK');
			throw error;
		}
	}

	async getRecentEvents(limit: number, filter?: IAgentGraphFilter): Promise<IAgentEvent[]> {
		const db = await this.whenReady;
		const where: string[] = [];
		const params: unknown[] = [];
		if (filter?.sessionId) {
			where.push('session_id = ?');
			params.push(filter.sessionId);
		}
		if (filter?.sinceTs) {
			where.push('ts >= ?');
			params.push(filter.sinceTs);
		}
		params.push(Math.max(1, Math.min(limit, 1000)));
		interface Row { id: string; ts: number; source: AgentEventSource; session_id: string; prompt_id: string | null; actor: string; verb: AgentEventVerb; ok: number | null; duration_ms: number | null; objects: string; payload: string | null }
		const rows = await this.all<Row>(db, `SELECT * FROM events ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ts DESC LIMIT ?`, params);
		return rows.map(row => ({
			id: row.id,
			ts: row.ts,
			source: row.source,
			sessionId: row.session_id,
			promptId: row.prompt_id ?? undefined,
			actor: row.actor,
			verb: row.verb,
			objects: JSON.parse(row.objects),
			ok: row.ok === null ? undefined : row.ok === 1,
			durationMs: row.duration_ms ?? undefined,
			payload: row.payload ? JSON.parse(row.payload) : undefined
		}));
	}

	async getSessions(): Promise<IAgentSessionSummary[]> {
		const db = await this.whenReady;
		interface Row { session_id: string; source: AgentEventSource; first_ts: number; last_ts: number; event_count: number }
		const rows = await this.all<Row>(db, `SELECT session_id, source, MIN(ts) AS first_ts, MAX(ts) AS last_ts, COUNT(*) AS event_count
			FROM events GROUP BY session_id, source ORDER BY last_ts DESC`, []);
		return rows.map(row => ({ sessionId: row.session_id, source: row.source, firstTs: row.first_ts, lastTs: row.last_ts, eventCount: row.event_count }));
	}

	async getGraph(filter?: IAgentGraphFilter): Promise<IAgentGraphSnapshot> {
		const db = await this.whenReady;
		interface EdgeRow { from_type: AgentGraphNodeType; from_key: string; to_type: AgentGraphNodeType; to_key: string; rel: string; event_id: string; ts: number }
		const edgeWhere: string[] = [];
		const params: unknown[] = [];
		if (filter?.sinceTs) {
			edgeWhere.push('e.ts >= ?');
			params.push(filter.sinceTs);
		}
		if (filter?.sessionId) {
			edgeWhere.push('ev.session_id = ?');
			params.push(filter.sessionId);
		}
		const edgeRows = await this.all<EdgeRow>(db, `SELECT e.* FROM edges e JOIN events ev ON ev.id = e.event_id
			${edgeWhere.length ? 'WHERE ' + edgeWhere.join(' AND ') : ''} ORDER BY e.ts ASC LIMIT 20000`, params);
		const edges: IAgentGraphEdge[] = edgeRows.map(row => ({
			fromType: row.from_type, fromKey: row.from_key, toType: row.to_type, toKey: row.to_key,
			rel: row.rel, eventId: row.event_id, ts: row.ts
		}));

		const wanted = new Set<string>();
		for (const edge of edges) {
			wanted.add(`${edge.fromType}:${edge.fromKey}`);
			wanted.add(`${edge.toType}:${edge.toKey}`);
		}
		interface NodeRow { type: AgentGraphNodeType; key: string; label: string; first_seen: number; last_seen: number }
		const nodeRows = await this.all<NodeRow>(db, 'SELECT * FROM nodes', []);
		const nodes: IAgentGraphNode[] = nodeRows
			.filter(row => wanted.has(`${row.type}:${row.key}`))
			.map(row => ({ type: row.type, key: row.key, label: row.label, firstSeen: row.first_seen, lastSeen: row.last_seen }));
		return { nodes, edges };
	}

	async close(): Promise<void> {
		const db = await this.whenReady;
		await new Promise<void>(resolve => db.close(() => resolve()));
	}
}
