/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// A thin, dependency-free client for the Langfuse public REST API
// (https://langfuse.com/docs/api). Reads observability data only. Auth is HTTP
// Basic with the public key as username and the secret key as password, exactly
// like the OTLP ingestion setup the agents already use.

export interface LangfuseUsage {
	readonly input?: number;
	readonly output?: number;
	readonly total?: number;
	readonly promptTokens?: number;
	readonly completionTokens?: number;
	readonly totalTokens?: number;
	readonly [key: string]: unknown;
}

export type ObservationType = 'SPAN' | 'GENERATION' | 'EVENT' | string;
export type ObservationLevel = 'DEBUG' | 'DEFAULT' | 'WARNING' | 'ERROR' | string;

export interface LangfuseObservation {
	readonly id: string;
	readonly traceId?: string;
	readonly parentObservationId?: string | null;
	readonly type: ObservationType;
	readonly name?: string;
	readonly startTime: string;
	readonly endTime?: string | null;
	readonly completionStartTime?: string | null;
	readonly model?: string | null;
	readonly level?: ObservationLevel;
	readonly statusMessage?: string | null;
	readonly input?: unknown;
	readonly output?: unknown;
	/** Framework-supplied attributes; carries the LangGraph node/step keys the graph view reads. */
	readonly metadata?: unknown;
	readonly usage?: LangfuseUsage | null;
	readonly usageDetails?: Record<string, number> | null;
	readonly calculatedTotalCost?: number | null;
	readonly costDetails?: Record<string, number> | null;
	readonly latency?: number | null;
	readonly timeToFirstToken?: number | null;
}

export interface LangfuseScore {
	readonly id: string;
	readonly name: string;
	readonly value?: number | null;
	readonly stringValue?: string | null;
	readonly dataType?: string;
	readonly source?: string;
	readonly comment?: string | null;
	readonly observationId?: string | null;
	readonly traceId?: string | null;
}

export interface LangfuseTrace {
	readonly id: string;
	readonly name?: string | null;
	readonly timestamp: string;
	readonly userId?: string | null;
	readonly sessionId?: string | null;
	readonly release?: string | null;
	readonly version?: string | null;
	readonly environment?: string | null;
	readonly tags?: readonly string[];
	readonly input?: unknown;
	readonly output?: unknown;
	readonly metadata?: unknown;
	readonly htmlPath?: string;
	readonly latency?: number | null;
	readonly totalCost?: number | null;
	readonly observations?: readonly LangfuseObservation[];
	readonly scores?: readonly LangfuseScore[];
}

export interface Paginated<T> {
	readonly data: readonly T[];
	readonly meta?: { readonly page?: number; readonly limit?: number; readonly totalItems?: number; readonly totalPages?: number };
}

export interface TraceListParams {
	readonly limit?: number;
	readonly page?: number;
	readonly name?: string;
	readonly userId?: string;
	readonly sessionId?: string;
	readonly tags?: readonly string[];
	readonly environment?: string;
	readonly fromTimestamp?: string;
}

export class LangfuseApiError extends Error {
	constructor(public readonly status: number, message: string) {
		super(message);
	}
}

/** Receives every request and failure so the Output panel can explain errors. */
export interface LangfuseLogger {
	trace(message: string): void;
	error(message: string): void;
}

let logger: LangfuseLogger | undefined;

export function setLangfuseLogger(value: LangfuseLogger | undefined): void {
	logger = value;
}

function hintFor(status: number): string {
	if (status === 401 || status === 403) {
		return ' Check your API keys and host (run "Langfuse: Set API Keys").';
	}
	if (status === 422) {
		// Langfuse validates query parameters with zod and answers 422 when one
		// is rejected; the body names the offending field.
		return ' Langfuse rejected a query parameter — see the details below and the Langfuse output channel.';
	}
	if (status === 404) {
		return ' Not found — the trace may have been deleted, or the host points at the wrong region.';
	}
	return '';
}

export class LangfuseClient {

	private readonly authHeader: string;

	constructor(
		public readonly host: string,
		publicKey: string,
		secretKey: string,
	) {
		this.authHeader = 'Basic ' + Buffer.from(`${publicKey}:${secretKey}`).toString('base64');
	}

	private async get<T>(path: string, query?: Record<string, string | number | readonly string[] | undefined>): Promise<T> {
		const url = new URL(path, this.host.endsWith('/') ? this.host : this.host + '/');
		if (query) {
			for (const [key, value] of Object.entries(query)) {
				if (value === undefined) {
					continue;
				}
				if (Array.isArray(value)) {
					for (const item of value) {
						url.searchParams.append(key, item);
					}
				} else {
					url.searchParams.set(key, String(value));
				}
			}
		}
		let response: Response;
		logger?.trace(`GET ${url.pathname}${url.search}`);
		try {
			response = await fetch(url, { headers: { Authorization: this.authHeader, Accept: 'application/json' } });
		} catch (err) {
			const message = `Could not reach ${this.host} (${err instanceof Error ? err.message : String(err)}).`;
			logger?.error(message);
			throw new LangfuseApiError(0, message);
		}
		if (!response.ok) {
			const body = await response.text().catch(() => '');
			logger?.error(`GET ${url.pathname}${url.search} → ${response.status} ${response.statusText}\n${body}`);
			throw new LangfuseApiError(response.status, `Langfuse ${response.status} ${response.statusText} on ${url.pathname}.${hintFor(response.status)} ${body.slice(0, 400)}`.trim());
		}
		return await response.json() as T;
	}

	/** Cheap connectivity + auth probe. */
	async health(): Promise<void> {
		await this.get('api/public/health');
	}

	async listTraces(params: TraceListParams): Promise<Paginated<LangfuseTrace>> {
		return this.get<Paginated<LangfuseTrace>>('api/public/traces', {
			limit: params.limit,
			page: params.page,
			name: params.name,
			userId: params.userId,
			sessionId: params.sessionId,
			tags: params.tags,
			environment: params.environment,
			fromTimestamp: params.fromTimestamp,
		});
	}

	async getTrace(traceId: string): Promise<LangfuseTrace> {
		return this.get<LangfuseTrace>(`api/public/traces/${encodeURIComponent(traceId)}`);
	}

	/** Absolute URL of a trace in the Langfuse web UI. */
	traceUrl(trace: LangfuseTrace): string {
		const base = this.host.replace(/\/$/, '');
		if (trace.htmlPath) {
			return trace.htmlPath.startsWith('http') ? trace.htmlPath : base + (trace.htmlPath.startsWith('/') ? '' : '/') + trace.htmlPath;
		}
		return `${base}/trace/${encodeURIComponent(trace.id)}`;
	}
}
