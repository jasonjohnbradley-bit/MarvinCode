/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { raceCancellation } from '../../../../base/common/async.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { stringHash } from '../../../../base/common/hash.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { equals as objectsEqual } from '../../../../base/common/objects.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { asJson, asText, IRequestService, isSuccess } from '../../../../platform/request/common/request.js';
import { IHeaders } from '../../../../base/parts/request/common/request.js';
import { ISecretStorageService } from '../../../../platform/secrets/common/secrets.js';
import {
	DEFAULT_FIRM_CONTEXT_KIND,
	DEFAULT_LAUNCHDARKLY_BASE_URL,
	ILaunchDarklyAIConfig,
	ILaunchDarklyAIConfigVariation,
	ILaunchDarklyClause,
	ILaunchDarklyConnectionConfig,
	ILaunchDarklyEnvironment,
	ILaunchDarklyEvaluationDegradation,
	ILaunchDarklyEvaluationOptions,
	ILaunchDarklyFeatureFlag,
	ILaunchDarklyFirm,
	ILaunchDarklyFirmAssignment,
	ILaunchDarklyFirmEvaluations,
	ILaunchDarklyFlagEnvironment,
	ILaunchDarklyFlagEvaluation,
	ILaunchDarklyFlagRule,
	ILaunchDarklyProject,
	ILaunchDarklyResolvedFirmConfig,
	ILaunchDarklyRollout,
	ILaunchDarklySegment,
	ILaunchDarklyService,
	ILaunchDarklyTarget,
	ILaunchDarklyVariation,
	ILaunchDarklyVariationRef,
	LAUNCHDARKLY_TOKEN_SECRET_KEY,
	LaunchDarklyConfig,
	LaunchDarklyError,
	LaunchDarklyReasonKind,
	LaunchDarklyVariationValue,
} from '../common/launchDarklyService.js';

const CALL_SITE = 'launchDarklyService';

/** Content type required by LaunchDarkly's semantic patch endpoints. */
const SEMANTIC_PATCH_CONTENT_TYPE = 'application/json; domain-model=launchdarkly.semanticpatch';
/** AI Configs endpoints require the beta API version header. */
const BETA_API_VERSION = 'beta';

/** How long a fetched flag list stays usable before being refetched. */
const FLAG_CACHE_TTL_MS = 60_000;
/** How long a firm's evaluation result stays usable before being refetched. */
const EVALUATION_CACHE_TTL_MS = 30_000;

/** Longest JSON value rendered inline before it is truncated. */
const MAX_VALUE_DISPLAY_CHARS = 60;
/** Longest clause summary rendered inline before it is truncated. */
const MAX_CLAUSE_SUMMARY_CHARS = 80;
/** Clauses beyond this many are collapsed into a "+n more" suffix. */
const MAX_SUMMARIZED_CLAUSES = 2;

interface IResolvedConnection {
	readonly baseUrl: string;
	readonly projectKey: string;
	readonly environmentKey: string;
	readonly token: string;
}

/** A LaunchDarkly context instance, as posted to the evaluation endpoint. */
interface IContextInstance {
	readonly kind: string;
	readonly key: string;
	readonly [attribute: string]: unknown;
}

interface IRawEvaluateItem {
	readonly key: string;
	readonly name?: string;
	readonly _value?: LaunchDarklyVariationValue;
	readonly reason?: {
		readonly kind?: string;
		readonly ruleIndex?: number;
		/** LaunchDarkly spells this `ruleID` here but `_id` on the rule itself. */
		readonly ruleID?: string;
		readonly ruleId?: string;
		readonly prerequisiteKey?: string;
		readonly inExperiment?: boolean;
		readonly errorKind?: string;
	};
}

interface IRawEvaluateResponse {
	readonly items?: ReadonlyArray<IRawEvaluateItem>;
	readonly totalCount?: number;
}

interface ICacheEntry<T> {
	readonly expiresAt: number;
	readonly value: Promise<T>;
}

/**
 * Short-lived cache that also de-duplicates in-flight requests. Rejections are
 * never retained, so a transient failure does not poison later reads.
 */
class TtlCache<T> {

	private readonly entries = new Map<string, ICacheEntry<T>>();

	constructor(private readonly ttlMs: number) { }

	get(key: string, compute: () => Promise<T>): Promise<T> {
		const existing = this.entries.get(key);
		if (existing && existing.expiresAt > Date.now()) {
			return existing.value;
		}
		const value = compute();
		this.entries.set(key, { expiresAt: Date.now() + this.ttlMs, value });
		value.catch(() => {
			if (this.entries.get(key)?.value === value) {
				this.entries.delete(key);
			}
		});
		return value;
	}

	delete(key: string): void {
		this.entries.delete(key);
	}

	clear(): void {
		this.entries.clear();
	}
}

/**
 * Thin typed wrapper around {@link IRequestService} that centralizes every
 * LaunchDarkly REST path, auth, and JSON handling. All paths are defined here
 * so they can be corrected in one place if the API surface changes.
 */
class LaunchDarklyRestClient {

	constructor(
		private readonly requestService: IRequestService,
		private readonly logService: ILogService,
	) { }

	//#region REST paths (verify against https://apidocs.launchdarkly.com)

	private projectsPath(): string {
		return `/api/v2/projects`;
	}
	private environmentsPath(projectKey: string): string {
		return `/api/v2/projects/${enc(projectKey)}/environments`;
	}
	private segmentsPath(projectKey: string, environmentKey: string): string {
		return `/api/v2/segments/${enc(projectKey)}/${enc(environmentKey)}`;
	}
	private contextsSearchPath(projectKey: string, environmentKey: string): string {
		return `/api/v2/projects/${enc(projectKey)}/environments/${enc(environmentKey)}/contexts/search`;
	}
	private flagsPath(projectKey: string): string {
		return `/api/v2/flags/${enc(projectKey)}`;
	}
	private flagPath(projectKey: string, flagKey: string): string {
		return `/api/v2/flags/${enc(projectKey)}/${enc(flagKey)}`;
	}
	private evaluateFlagsPath(projectKey: string, environmentKey: string): string {
		return `/api/v2/projects/${enc(projectKey)}/environments/${enc(environmentKey)}/flags/evaluate`;
	}
	private aiConfigsPath(projectKey: string): string {
		return `/api/v2/projects/${enc(projectKey)}/ai-configs`;
	}
	private aiConfigPath(projectKey: string, configKey: string): string {
		return `/api/v2/projects/${enc(projectKey)}/ai-configs/${enc(configKey)}`;
	}

	//#endregion

	async getJson<T>(conn: IResolvedConnection, path: string, token: CancellationToken, extraHeaders?: IHeaders): Promise<T> {
		return this.send<T>(conn, 'GET', path, undefined, token, extraHeaders);
	}

	async send<T>(conn: IResolvedConnection, method: string, path: string, body: { data: string; contentType: string } | undefined, token: CancellationToken, extraHeaders?: IHeaders): Promise<T> {
		const headers: IHeaders = {
			'Authorization': conn.token,
			...extraHeaders,
		};
		if (body) {
			headers['Content-Type'] = body.contentType;
		}
		const context = await this.requestService.request({
			type: method,
			url: `${conn.baseUrl}${path}`,
			headers,
			data: body?.data,
			callSite: CALL_SITE,
		}, token);

		if (!isSuccess(context)) {
			const statusCode = context.res.statusCode;
			let detail = '';
			try {
				detail = (await asText(context)) ?? '';
			} catch {
				// ignore
			}
			this.logService.warn(`[launchDarkly] ${method} ${path} -> ${statusCode}`);
			throw new LaunchDarklyError(launchDarklyErrorMessage(statusCode, detail), statusCode);
		}

		const json = await asJson<T>(context);
		return (json ?? ({} as T));
	}

	//#region Endpoint helpers

	listProjects(conn: IResolvedConnection, token: CancellationToken) {
		return this.getJson<{ items: any[] }>(conn, this.projectsPath(), token);
	}
	listEnvironments(conn: IResolvedConnection, token: CancellationToken) {
		return this.getJson<{ items: any[] }>(conn, this.environmentsPath(conn.projectKey), token);
	}
	listSegments(conn: IResolvedConnection, token: CancellationToken) {
		return this.getJson<{ items: any[] }>(conn, this.segmentsPath(conn.projectKey, conn.environmentKey), token);
	}
	searchContexts(conn: IResolvedConnection, contextKind: string, token: CancellationToken) {
		const body = JSON.stringify({ filter: `kind equals ${contextKind}`, limit: 200 });
		return this.send<{ items: any[] }>(conn, 'POST', this.contextsSearchPath(conn.projectKey, conn.environmentKey), { data: body, contentType: 'application/json' }, token);
	}
	listFlags(conn: IResolvedConnection, token: CancellationToken) {
		return this.getJson<{ items: any[] }>(conn, `${this.flagsPath(conn.projectKey)}?env=${enc(conn.environmentKey)}&summary=false`, token);
	}
	getFlag(conn: IResolvedConnection, flagKey: string, token: CancellationToken) {
		return this.getJson<any>(conn, `${this.flagPath(conn.projectKey, flagKey)}?env=${enc(conn.environmentKey)}`, token);
	}
	patchFlagSemantic(conn: IResolvedConnection, flagKey: string, instructions: object[], token: CancellationToken) {
		const data = JSON.stringify({ environmentKey: conn.environmentKey, instructions });
		return this.send<any>(conn, 'PATCH', this.flagPath(conn.projectKey, flagKey), { data, contentType: SEMANTIC_PATCH_CONTENT_TYPE }, token);
	}
	createFlag(conn: IResolvedConnection, spec: { key: string; name: string; description?: string }, token: CancellationToken) {
		const data = JSON.stringify({
			key: spec.key,
			name: spec.name,
			description: spec.description,
			variations: [{ value: true }, { value: false }],
		});
		return this.send<any>(conn, 'POST', this.flagsPath(conn.projectKey), { data, contentType: 'application/json' }, token);
	}
	/**
	 * Asks LaunchDarkly to evaluate every flag in the environment for one context
	 * instance. `limit=-1` requests all flags; it is LaunchDarkly's default but is
	 * sent explicitly so behaviour does not drift if that default changes.
	 */
	evaluateFlags(conn: IResolvedConnection, context: IContextInstance, token: CancellationToken) {
		const data = JSON.stringify(context);
		return this.send<IRawEvaluateResponse>(
			conn,
			'POST',
			`${this.evaluateFlagsPath(conn.projectKey, conn.environmentKey)}?limit=-1`,
			{ data, contentType: 'application/json' },
			token,
		);
	}
	listAIConfigs(conn: IResolvedConnection, token: CancellationToken) {
		return this.getJson<{ items: any[] }>(conn, this.aiConfigsPath(conn.projectKey), token, { 'LD-API-Version': BETA_API_VERSION });
	}
	getAIConfig(conn: IResolvedConnection, configKey: string, token: CancellationToken) {
		return this.getJson<any>(conn, this.aiConfigPath(conn.projectKey, configKey), token, { 'LD-API-Version': BETA_API_VERSION });
	}
	createAIConfig(conn: IResolvedConnection, spec: { key: string; name: string; description?: string }, token: CancellationToken) {
		const data = JSON.stringify({ key: spec.key, name: spec.name, description: spec.description });
		return this.send<any>(conn, 'POST', this.aiConfigsPath(conn.projectKey), { data, contentType: 'application/json' }, token, { 'LD-API-Version': BETA_API_VERSION });
	}
	patchAIConfig(conn: IResolvedConnection, configKey: string, patch: object, token: CancellationToken) {
		const data = JSON.stringify(patch);
		return this.send<any>(conn, 'PATCH', this.aiConfigPath(conn.projectKey, configKey), { data, contentType: 'application/json' }, token, { 'LD-API-Version': BETA_API_VERSION });
	}
	deleteAIConfig(conn: IResolvedConnection, configKey: string, token: CancellationToken) {
		return this.send<any>(conn, 'DELETE', this.aiConfigPath(conn.projectKey, configKey), undefined, token, { 'LD-API-Version': BETA_API_VERSION });
	}

	//#endregion
}

export class LaunchDarklyService extends Disposable implements ILaunchDarklyService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeConfiguration = this._register(new Emitter<void>());
	readonly onDidChangeConfiguration: Event<void> = this._onDidChangeConfiguration.event;

	private readonly client: LaunchDarklyRestClient;

	private readonly flagCache = new TtlCache<ReadonlyArray<ILaunchDarklyFeatureFlag>>(FLAG_CACHE_TTL_MS);
	private readonly evaluationCache = new TtlCache<ILaunchDarklyFirmEvaluations>(EVALUATION_CACHE_TTL_MS);

	constructor(
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ISecretStorageService private readonly secretStorageService: ISecretStorageService,
		@IRequestService requestService: IRequestService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this.client = new LaunchDarklyRestClient(requestService, this.logService);

		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (Object.values(LaunchDarklyConfig).some(key => e.affectsConfiguration(key))) {
				this.invalidateCache();
				this._onDidChangeConfiguration.fire();
			}
		}));
		this._register(this.secretStorageService.onDidChangeSecret(key => {
			if (key === LAUNCHDARKLY_TOKEN_SECRET_KEY) {
				this.invalidateCache();
				this._onDidChangeConfiguration.fire();
			}
		}));
	}

	invalidateCache(): void {
		this.flagCache.clear();
		this.evaluationCache.clear();
	}

	//#region Configuration

	private getConfigValue<T>(key: string, fallback: T): T {
		const value = this.configurationService.getValue<T>(key);
		return value === undefined || value === null || value === '' ? fallback : value;
	}

	async getConnectionConfig(): Promise<ILaunchDarklyConnectionConfig> {
		const token = await this.secretStorageService.get(LAUNCHDARKLY_TOKEN_SECRET_KEY);
		return {
			baseUrl: this.getConfigValue(LaunchDarklyConfig.baseUrl, DEFAULT_LAUNCHDARKLY_BASE_URL),
			projectKey: this.getConfigValue<string | undefined>(LaunchDarklyConfig.projectKey, undefined),
			environmentKey: this.getConfigValue<string | undefined>(LaunchDarklyConfig.environmentKey, undefined),
			firmSource: this.getConfigValue<'contextKind' | 'segment'>(LaunchDarklyConfig.firmSource, 'contextKind'),
			firmContextKind: this.getConfigValue(LaunchDarklyConfig.firmContextKind, DEFAULT_FIRM_CONTEXT_KIND),
			hasToken: !!token,
		};
	}

	async isConfigured(): Promise<boolean> {
		const config = await this.getConnectionConfig();
		return config.hasToken && !!config.projectKey;
	}

	async setAccessToken(token: string | undefined): Promise<void> {
		if (token) {
			await this.secretStorageService.set(LAUNCHDARKLY_TOKEN_SECRET_KEY, token);
		} else {
			await this.secretStorageService.delete(LAUNCHDARKLY_TOKEN_SECRET_KEY);
		}
	}

	private async resolveConnection(requireEnvironment = true): Promise<IResolvedConnection> {
		const token = await this.secretStorageService.get(LAUNCHDARKLY_TOKEN_SECRET_KEY);
		if (!token) {
			throw new LaunchDarklyError('No LaunchDarkly access token is configured. Run "LaunchDarkly: Set Access Token".');
		}
		const baseUrl = this.getConfigValue(LaunchDarklyConfig.baseUrl, DEFAULT_LAUNCHDARKLY_BASE_URL).replace(/\/+$/, '');
		const projectKey = this.getConfigValue<string | undefined>(LaunchDarklyConfig.projectKey, undefined);
		if (!projectKey) {
			throw new LaunchDarklyError('No LaunchDarkly project is configured. Set "launchdarkly.projectKey".');
		}
		const environmentKey = this.getConfigValue<string | undefined>(LaunchDarklyConfig.environmentKey, undefined);
		if (requireEnvironment && !environmentKey) {
			throw new LaunchDarklyError('No LaunchDarkly environment is configured. Set "launchdarkly.environmentKey".');
		}
		return { baseUrl, projectKey, environmentKey: environmentKey ?? '', token };
	}

	//#endregion

	//#region Discovery

	async listProjects(token: CancellationToken): Promise<ReadonlyArray<ILaunchDarklyProject>> {
		const conn = await this.resolveConnection(false);
		const res = await this.client.listProjects(conn, token);
		return (res.items ?? []).map((p): ILaunchDarklyProject => ({ key: p.key, name: p.name ?? p.key }));
	}

	async listEnvironments(projectKey: string, token: CancellationToken): Promise<ReadonlyArray<ILaunchDarklyEnvironment>> {
		const conn = { ...(await this.resolveConnection(false)), projectKey };
		const res = await this.client.listEnvironments(conn, token);
		return (res.items ?? []).map((e): ILaunchDarklyEnvironment => ({ key: e.key, name: e.name ?? e.key, color: e.color }));
	}

	async listSegments(projectKey: string, environmentKey: string, token: CancellationToken): Promise<ReadonlyArray<ILaunchDarklySegment>> {
		const conn = { ...(await this.resolveConnection(false)), projectKey, environmentKey };
		const res = await this.client.listSegments(conn, token);
		return (res.items ?? []).map((s): ILaunchDarklySegment => ({ key: s.key, name: s.name ?? s.key, description: s.description }));
	}

	async listFirms(token: CancellationToken): Promise<ReadonlyArray<ILaunchDarklyFirm>> {
		const conn = await this.resolveConnection();
		const config = await this.getConnectionConfig();
		if (config.firmSource === 'segment') {
			const segments = await this.client.listSegments(conn, token);
			return (segments.items ?? []).map((s): ILaunchDarklyFirm => ({ key: s.key, name: s.name ?? s.key, origin: 'segment' }));
		}
		// Context-kind sourced firms. LaunchDarkly's context index only holds
		// contexts an SDK evaluated recently (inactive ones expire after ~30
		// days), so the search alone frequently returns nothing even though
		// flags clearly target firms. Merge in every firm key referenced by
		// flag targeting so the list reflects what is actually configured.
		const firms = new Map<string, ILaunchDarklyFirm>();
		try {
			const res = await this.client.searchContexts(conn, config.firmContextKind, token);
			for (const c of res.items ?? []) {
				const key = c.context?.key ?? c.key;
				if (key) {
					firms.set(key, {
						key,
						name: c.context?.name ?? c.name ?? key,
						origin: 'contextKind',
						attributes: c.context,
					});
				}
			}
		} catch (err) {
			this.logService.warn(`[launchDarkly] context search failed, falling back to targeting-derived firms: ${err}`);
		}
		try {
			for (const key of await this.deriveFirmKeysFromTargeting(conn, config.firmContextKind, token)) {
				if (!firms.has(key)) {
					firms.set(key, { key, name: key, origin: 'contextKind' });
				}
			}
		} catch (err) {
			this.logService.warn(`[launchDarkly] deriving firms from flag targeting failed: ${err}`);
		}
		return [...firms.values()].sort((a, b) => a.name.localeCompare(b.name));
	}

	/**
	 * Collects every context key of the firm kind referenced by the active
	 * environment's flag targeting — individual context targets plus simple
	 * `key in [...]` rule clauses. These are exactly the firms that have
	 * flag-specific configuration, so they belong in the picker even when
	 * LaunchDarkly's context index has expired them.
	 */
	private async deriveFirmKeysFromTargeting(conn: IResolvedConnection, firmContextKind: string, token: CancellationToken): Promise<ReadonlyArray<string>> {
		const keys = new Set<string>();
		const flags = await this.listFeatureFlags(token);
		for (const flag of flags) {
			const env = flag.environments[conn.environmentKey];
			if (!env) {
				continue;
			}
			for (const target of [...(env.targets ?? []), ...(env.contextTargets ?? [])]) {
				if ((target.contextKind ?? 'user') === firmContextKind) {
					for (const value of target.values) {
						keys.add(value);
					}
				}
			}
			for (const rule of env.rules ?? []) {
				for (const clause of rule.clauses) {
					if (clause.contextKind === firmContextKind && clause.attribute === 'key' && clause.op === 'in' && !clause.negate) {
						for (const value of clause.values) {
							if (typeof value === 'string') {
								keys.add(value);
							}
						}
					}
				}
			}
		}
		return [...keys];
	}

	//#endregion

	//#region Feature flags

	async listFeatureFlags(token: CancellationToken): Promise<ReadonlyArray<ILaunchDarklyFeatureFlag>> {
		const conn = await this.resolveConnection();
		const res = await this.client.listFlags(conn, token);
		return (res.items ?? []).map(raw => mapFlag(raw));
	}

	async getFeatureFlag(flagKey: string, token: CancellationToken): Promise<ILaunchDarklyFeatureFlag> {
		const conn = await this.resolveConnection();
		return mapFlag(await this.client.getFlag(conn, flagKey, token));
	}

	async setFlagTargeting(flagKey: string, on: boolean, token: CancellationToken): Promise<void> {
		const conn = await this.resolveConnection();
		await this.client.patchFlagSemantic(conn, flagKey, [{ kind: on ? 'turnFlagOn' : 'turnFlagOff' }], token);
		// Targeting changed, so every cached flag body and evaluation is stale.
		this.invalidateCache();
	}

	/**
	 * Cache key for the flag list. The token is hashed rather than stored so a
	 * rotated token misses the cache even before the secret-change event lands.
	 */
	private flagCacheKey(conn: IResolvedConnection): string {
		return `${conn.baseUrl}|${conn.projectKey}|${conn.environmentKey}|${stringHash(conn.token, 0)}`;
	}

	/**
	 * The flag list, cached and de-duplicated. Requests run with
	 * `CancellationToken.None` so a cancelled caller cannot poison the entry for
	 * everyone else; callers race the result against their own token instead.
	 */
	private async listFeatureFlagsCached(conn: IResolvedConnection, token: CancellationToken): Promise<ReadonlyArray<ILaunchDarklyFeatureFlag>> {
		const flags = this.flagCache.get(this.flagCacheKey(conn), async () => {
			const res = await this.client.listFlags(conn, CancellationToken.None);
			return (res.items ?? []).map(raw => mapFlag(raw));
		});
		return (await raceCancellation(flags, token)) ?? [];
	}

	async createFeatureFlag(spec: { key: string; name: string; description?: string }, token: CancellationToken): Promise<ILaunchDarklyFeatureFlag> {
		const conn = await this.resolveConnection(false);
		return mapFlag(await this.client.createFlag(conn, spec, token));
	}

	//#endregion

	//#region AI Configs

	async listAIConfigs(token: CancellationToken): Promise<ReadonlyArray<ILaunchDarklyAIConfig>> {
		const conn = await this.resolveConnection(false);
		const res = await this.client.listAIConfigs(conn, token);
		return (res.items ?? []).map(raw => mapAIConfig(raw));
	}

	async getAIConfig(configKey: string, token: CancellationToken): Promise<ILaunchDarklyAIConfig> {
		const conn = await this.resolveConnection(false);
		return mapAIConfig(await this.client.getAIConfig(conn, configKey, token));
	}

	async createAIConfig(spec: { key: string; name: string; description?: string }, token: CancellationToken): Promise<ILaunchDarklyAIConfig> {
		const conn = await this.resolveConnection(false);
		return mapAIConfig(await this.client.createAIConfig(conn, spec, token));
	}

	async updateAIConfig(configKey: string, patch: { name?: string; description?: string }, token: CancellationToken): Promise<ILaunchDarklyAIConfig> {
		const conn = await this.resolveConnection(false);
		return mapAIConfig(await this.client.patchAIConfig(conn, configKey, patch, token));
	}

	async deleteAIConfig(configKey: string, token: CancellationToken): Promise<void> {
		const conn = await this.resolveConnection(false);
		await this.client.deleteAIConfig(conn, configKey, token);
	}

	//#endregion

	//#region Firm assignment resolution

	async getFirmFlagAssignments(firmKey: string, token: CancellationToken): Promise<ReadonlyArray<ILaunchDarklyFirmAssignment>> {
		const config = await this.getConnectionConfig();
		const conn = await this.resolveConnection();
		const flags = await this.listFeatureFlagsCached(conn, token);
		return flags.map(flag => resolveAssignment(flag.key, flag.name, flag.variations, flag.environments[conn.environmentKey], firmKey, config.firmContextKind));
	}

	async getFirmAIConfigAssignments(firmKey: string, token: CancellationToken): Promise<ReadonlyArray<ILaunchDarklyFirmAssignment>> {
		const config = await this.getConnectionConfig();
		const conn = await this.resolveConnection();
		const aiConfigs = await this.listAIConfigs(token);
		// AI Configs are backed by a feature flag with the same key, so one cached
		// flag list answers every config instead of a GET per config.
		let flagsByKey: Map<string, ILaunchDarklyFeatureFlag>;
		try {
			flagsByKey = new Map((await this.listFeatureFlagsCached(conn, token)).map(flag => [flag.key, flag]));
		} catch (err) {
			this.logService.trace(`[launchDarkly] could not load flags for AI Config resolution: ${err}`);
			flagsByKey = new Map();
		}

		return aiConfigs.map((cfg): ILaunchDarklyFirmAssignment => {
			const flag = flagsByKey.get(cfg.key);
			if (!flag) {
				return { configKey: cfg.key, configName: cfg.name, reason: 'unknown', enabled: false };
			}
			const base = resolveAssignment(cfg.key, cfg.name, flag.variations, flag.environments[conn.environmentKey], firmKey, config.firmContextKind);
			// Map the resolved variation index back to an AI Config variation name when possible.
			const variationName = base.variationName ?? mapAIConfigVariationName(cfg, base.variationName);
			return { ...base, variationName };
		});
	}

	async getFirmFlagEvaluations(firmKey: string, options: ILaunchDarklyEvaluationOptions, token: CancellationToken): Promise<ILaunchDarklyFirmEvaluations> {
		const config = await this.getConnectionConfig();
		const conn = await this.resolveConnection();
		const key = `${this.flagCacheKey(conn)}|${config.firmContextKind}|${firmKey}|${stringHash(JSON.stringify(options.contextAttributes ?? {}), 0)}`;
		if (options.forceRefresh) {
			this.flagCache.delete(this.flagCacheKey(conn));
			this.evaluationCache.delete(key);
		}
		const result = this.evaluationCache.get(key, () => this.computeFirmFlagEvaluations(conn, config.firmSource, config.firmContextKind, firmKey, options));
		const raced = await raceCancellation(result, token);
		return raced ?? { firmKey, firmContextKind: config.firmContextKind, projectKey: conn.projectKey, environmentKey: conn.environmentKey, source: 'approximation', evaluatedAt: Date.now(), evaluations: [] };
	}

	private async computeFirmFlagEvaluations(
		conn: IResolvedConnection,
		firmSource: 'contextKind' | 'segment',
		firmContextKind: string,
		firmKey: string,
		options: ILaunchDarklyEvaluationOptions,
	): Promise<ILaunchDarklyFirmEvaluations> {
		const flags = await this.listFeatureFlagsCached(conn, CancellationToken.None);
		const base = {
			firmKey,
			firmContextKind,
			projectKey: conn.projectKey,
			environmentKey: conn.environmentKey,
			evaluatedAt: Date.now(),
		};
		const envOf = (flag: ILaunchDarklyFeatureFlag) => flag.environments[conn.environmentKey];

		// A segment is a set of contexts, not a context instance, so it cannot be
		// evaluated. Report which flags target it instead of inventing a member.
		if (firmSource === 'segment') {
			return {
				...base,
				source: 'segmentReference',
				degradation: {
					kind: 'segmentFirm',
					message: localize('ld.degraded.segmentFirm', "Exact per-firm evaluation is not available for segment-sourced firms. Showing which flags target this segment; set \"launchdarkly.firmSource\" to \"contextKind\" for authoritative results."),
				},
				evaluations: flags.map(flag => segmentReferenceEvaluation(flag, envOf(flag), firmKey, firmContextKind)),
			};
		}

		const context: IContextInstance = { ...sanitizeContextAttributes(options.contextAttributes), kind: firmContextKind, key: firmKey };
		let evaluated: IRawEvaluateResponse;
		try {
			evaluated = await this.client.evaluateFlags(conn, context, CancellationToken.None);
		} catch (err) {
			// An invalid token is a configuration error, not degraded data.
			if (err instanceof LaunchDarklyError && err.statusCode === 401) {
				throw err;
			}
			this.logService.warn(`[launchDarkly] flag evaluation unavailable, falling back to approximation: ${err}`);
			return {
				...base,
				source: 'approximation',
				degradation: degradationFor(err),
				evaluations: flags.map(flag => approximateEvaluation(flag, envOf(flag), firmKey, firmContextKind)),
			};
		}

		const byKey = new Map((evaluated.items ?? []).map(item => [item.key, item]));
		if (evaluated.totalCount !== undefined && (evaluated.items?.length ?? 0) < evaluated.totalCount) {
			this.logService.warn(`[launchDarkly] evaluation returned ${evaluated.items?.length ?? 0} of ${evaluated.totalCount} flags; the remainder is approximated.`);
		}
		return {
			...base,
			source: 'evaluate',
			// Driven by the flag list so the grid is complete and stably ordered
			// even when the evaluation response omits a flag.
			evaluations: flags.map(flag => {
				const item = byKey.get(flag.key);
				return item
					? mapEvaluation(flag, envOf(flag), item, firmKey, firmContextKind, this.logService)
					: approximateEvaluation(flag, envOf(flag), firmKey, firmContextKind);
			}),
		};
	}

	//#endregion

	//#region Agent integration

	async getActiveFirmKey(): Promise<string | undefined> {
		return this.getConfigValue<string | undefined>(LaunchDarklyConfig.activeFirmKey, undefined);
	}

	async resolveActiveFirmAgentConfig(token: CancellationToken): Promise<ILaunchDarklyResolvedFirmConfig | undefined> {
		const firmKey = await this.getActiveFirmKey();
		if (!firmKey || !(await this.isConfigured())) {
			return undefined;
		}
		const [aiConfigs, flags] = await Promise.all([
			this.getFirmAIConfigAssignments(firmKey, token),
			this.getFirmFlagAssignments(firmKey, token),
		]);
		return { firmKey, aiConfigs, flags };
	}

	//#endregion
}

//#region Mapping helpers

function enc(segment: string): string {
	return encodeURIComponent(segment);
}

function launchDarklyErrorMessage(statusCode: number | undefined, detail: string): string {
	let parsed = detail;
	try {
		const json = JSON.parse(detail);
		parsed = json.message ?? json.code ?? detail;
	} catch {
		// keep raw
	}
	const suffix = parsed ? `: ${parsed}` : '';
	switch (statusCode) {
		case 401: return `LaunchDarkly rejected the access token (401)${suffix}`;
		case 403: return `The access token lacks permission for this operation (403)${suffix}`;
		case 404: return `Resource not found (404)${suffix}`;
		case 429: return `Rate limited by LaunchDarkly (429)${suffix}`;
		default: return `LaunchDarkly request failed (${statusCode ?? 'network error'})${suffix}`;
	}
}

function mapVariations(raw: any): ILaunchDarklyVariation[] {
	return (raw?.variations ?? []).map((v: any): ILaunchDarklyVariation => ({
		_id: v._id,
		value: v.value,
		name: v.name,
		description: v.description,
	}));
}

function mapTargets(raw: any): ILaunchDarklyTarget[] {
	return (raw ?? []).map((t: any): ILaunchDarklyTarget => ({
		variationIndex: t.variation,
		contextKind: t.contextKind,
		values: t.values ?? [],
	}));
}

function mapClause(raw: any): ILaunchDarklyClause {
	return {
		_id: raw._id,
		contextKind: raw.contextKind,
		attribute: raw.attribute ?? '',
		op: raw.op ?? '',
		negate: !!raw.negate,
		values: raw.values ?? [],
	};
}

function mapRollout(raw: any): ILaunchDarklyRollout | undefined {
	if (!raw) {
		return undefined;
	}
	return {
		variations: (raw.variations ?? []).map((v: any) => ({ variationIndex: v.variation, weight: v.weight })),
		bucketBy: raw.bucketBy,
		contextKind: raw.contextKind,
		seed: raw.seed,
		isExperiment: raw.kind === 'experiment',
	};
}

function mapRule(raw: any): ILaunchDarklyFlagRule {
	return {
		_id: raw._id,
		description: raw.description,
		clauses: (raw.clauses ?? []).map(mapClause),
		variationIndex: raw.variation,
		rollout: mapRollout(raw.rollout),
	};
}

function mapFlag(raw: any): ILaunchDarklyFeatureFlag {
	const environments: Record<string, ILaunchDarklyFlagEnvironment> = {};
	for (const [envKey, envRaw] of Object.entries<any>(raw?.environments ?? {})) {
		environments[envKey] = {
			on: !!envRaw.on,
			offVariation: envRaw.offVariation,
			fallthroughVariationIndex: envRaw.fallthrough?.variation,
			targets: mapTargets(envRaw.targets),
			ruleCount: Array.isArray(envRaw.rules) ? envRaw.rules.length : 0,
			// `undefined` (not `[]`) when the payload carried no rules at all, so
			// the reason renderer can tell "unknown" from "genuinely none".
			rules: Array.isArray(envRaw.rules) ? envRaw.rules.map(mapRule) : undefined,
			contextTargets: envRaw.contextTargets ? mapTargets(envRaw.contextTargets) : undefined,
			fallthroughRollout: mapRollout(envRaw.fallthrough?.rollout),
			prerequisites: (envRaw.prerequisites ?? []).map((p: any) => ({ key: p.key, variationIndex: p.variation })),
		};
	}
	return {
		key: raw.key,
		name: raw.name ?? raw.key,
		kind: raw.kind ?? 'boolean',
		description: raw.description,
		tags: raw.tags,
		variations: mapVariations(raw),
		environments,
	};
}

function mapAIConfig(raw: any): ILaunchDarklyAIConfig {
	const variations: ILaunchDarklyAIConfigVariation[] = (raw?.variations ?? []).map((v: any): ILaunchDarklyAIConfigVariation => ({
		key: v.key ?? v._id ?? v.name,
		name: v.name,
		modelConfigKey: v.modelConfigKey,
		model: v.model ? { name: v.model.name ?? v.modelConfigKey ?? '', parameters: v.model.parameters, custom: v.model.custom } : undefined,
		messages: v.messages,
		instructions: v.instructions,
	}));
	return {
		key: raw.key,
		name: raw.name ?? raw.key,
		description: raw.description,
		tags: raw.tags,
		maintainerId: raw.maintainerId,
		variations,
	};
}

function mapAIConfigVariationName(cfg: ILaunchDarklyAIConfig, current: string | undefined): string | undefined {
	if (current) {
		return current;
	}
	return cfg.variations[0]?.name ?? cfg.variations[0]?.key;
}

//#region Evaluation helpers

function truncate(value: string, max: number): string {
	return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/** Keys LaunchDarkly owns on a context instance, which callers must not override. */
const RESERVED_CONTEXT_KEYS = new Set(['kind', 'key', '_meta', '_links', '_access', 'anonymous']);

/**
 * Strips the metadata that the contexts endpoint returns alongside real
 * attributes, so a firm's attributes can be replayed into an evaluation.
 */
function sanitizeContextAttributes(attributes: Readonly<Record<string, unknown>> | undefined): Record<string, unknown> {
	if (!attributes) {
		return {};
	}
	const result: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(attributes)) {
		if (!RESERVED_CONTEXT_KEYS.has(key) && !key.startsWith('_')) {
			result[key] = value;
		}
	}
	return result;
}

/** Short, always-populated display form of a variation value. */
export function describeVariationValue(value: LaunchDarklyVariationValue | undefined): string {
	if (value === undefined || value === null) {
		return localize('ld.value.none', "—");
	}
	if (typeof value === 'boolean') {
		return value ? localize('ld.value.on', "On") : localize('ld.value.off', "Off");
	}
	if (typeof value === 'number') {
		return String(value);
	}
	if (typeof value === 'string') {
		return value.length ? value : localize('ld.value.emptyString', "(empty)");
	}
	return truncate(JSON.stringify(value), MAX_VALUE_DISPLAY_CHARS);
}

function variationRef(variations: ReadonlyArray<ILaunchDarklyVariation>, index: number | undefined, value: LaunchDarklyVariationValue | undefined): ILaunchDarklyVariationRef {
	const variation = index !== undefined ? variations[index] : undefined;
	const resolvedValue = value !== undefined ? value : variation?.value;
	const displayValue = describeVariationValue(resolvedValue);
	return {
		index,
		_id: variation?._id,
		name: variation?.name,
		value: resolvedValue,
		displayValue,
		displayLabel: variation?.name ?? displayValue,
	};
}

/** Normalizes LaunchDarkly's reason kind spellings onto our union. */
function normalizeReasonKind(raw: string | undefined): LaunchDarklyReasonKind {
	switch ((raw ?? '').toUpperCase().replace(/_/g, '')) {
		case 'OFF': return 'off';
		case 'FALLTHROUGH': return 'fallthrough';
		case 'TARGETMATCH': return 'targetMatch';
		case 'RULEMATCH': return 'ruleMatch';
		case 'PREREQUISITEFAILED': return 'prerequisiteFailed';
		case 'ERROR': return 'error';
		default: return 'unknown';
	}
}

/** Renders a LaunchDarkly clause operator as a short phrase. */
function describeOperator(op: string, valueCount: number): string {
	switch (op) {
		case 'in': return valueCount > 1 ? localize('ld.op.isOneOf', "is one of") : localize('ld.op.is', "is");
		case 'startsWith': return localize('ld.op.startsWith', "starts with");
		case 'endsWith': return localize('ld.op.endsWith', "ends with");
		case 'contains': return localize('ld.op.contains', "contains");
		case 'matches': return localize('ld.op.matches', "matches");
		case 'lessThan': case 'semVerLessThan': return '<';
		case 'lessThanOrEqual': return '<=';
		case 'greaterThan': case 'semVerGreaterThan': return '>';
		case 'greaterThanOrEqual': return '>=';
		case 'semVerEqual': return '=';
		case 'before': return localize('ld.op.before', "before");
		case 'after': return localize('ld.op.after', "after");
		default: return op;
	}
}

function describeClause(clause: ILaunchDarklyClause, firmContextKind: string): string {
	const values = clause.values.map(v => typeof v === 'string' ? v : JSON.stringify(v)).join(', ');
	if (clause.op === 'segmentMatch' || clause.op === 'segmentIsOneOf') {
		return clause.negate
			? localize('ld.clause.notInSegment', "not in segment {0}", values)
			: localize('ld.clause.inSegment', "in segment {0}", values);
	}
	const attribute = clause.contextKind && clause.contextKind !== firmContextKind
		? `${clause.contextKind}.${clause.attribute}`
		: clause.attribute;
	const body = `${attribute} ${describeOperator(clause.op, clause.values.length)} ${values}`;
	return clause.negate ? localize('ld.clause.negated', "not {0}", body) : body;
}

/** Human-readable summary of a rule's conditions, e.g. "country is GB". */
export function summarizeClauses(rule: ILaunchDarklyFlagRule, firmContextKind: string): string {
	if (!rule.clauses.length) {
		return localize('ld.clause.any', "any context");
	}
	const shown = rule.clauses.slice(0, MAX_SUMMARIZED_CLAUSES).map(c => describeClause(c, firmContextKind));
	let summary = shown.join(localize('ld.clause.and', " and "));
	const remaining = rule.clauses.length - shown.length;
	if (remaining > 0) {
		summary += localize('ld.clause.more', " +{0} more", remaining);
	}
	return truncate(summary, MAX_CLAUSE_SUMMARY_CHARS);
}

/** Percentage a rollout assigns to a variation; weights are in 1/1000 of a percent. */
function rolloutPercent(rollout: ILaunchDarklyRollout, variationIndex: number | undefined): string | undefined {
	const entry = variationIndex !== undefined
		? rollout.variations.find(v => v.variationIndex === variationIndex)
		: undefined;
	if (!entry) {
		return undefined;
	}
	const percent = entry.weight / 1000;
	return Number.isInteger(percent) ? String(percent) : percent.toFixed(2);
}

/**
 * Best-effort resolution of the variation a firm receives. Handles the flag
 * off state, explicit context targets, and fallthrough. Rule-based targeting
 * (segments/clauses) cannot be resolved here and is reported as `unknown`.
 */
function resolveAssignment(
	configKey: string,
	configName: string,
	variations: ReadonlyArray<ILaunchDarklyVariation>,
	env: ILaunchDarklyFlagEnvironment | undefined,
	firmKey: string,
	firmContextKind: string,
): ILaunchDarklyFirmAssignment {
	if (!env) {
		return { configKey, configName, reason: 'unknown', enabled: false };
	}
	const variationName = (index: number | undefined): string | undefined => {
		if (index === undefined) {
			return undefined;
		}
		const v = variations[index];
		return v?.name ?? (typeof v?.value === 'string' ? v.value : undefined);
	};
	if (!env.on) {
		return { configKey, configName, variationName: variationName(env.offVariation), reason: 'off', enabled: false };
	}
	// Explicit target match. `contextTargets` carries non-user kinds, which is
	// where firm targets normally live.
	for (const target of [...(env.contextTargets ?? []), ...(env.targets ?? [])]) {
		const kindMatches = (target.contextKind ?? 'user') === firmContextKind || target.contextKind === undefined;
		if (kindMatches && target.values.includes(firmKey)) {
			return { configKey, configName, variationName: variationName(target.variationIndex), reason: 'explicitTarget', enabled: true };
		}
	}
	if ((env.ruleCount ?? 0) > 0) {
		// Cannot resolve rule-based targeting without SDK evaluation.
		return { configKey, configName, reason: 'unknown', enabled: true };
	}
	return { configKey, configName, variationName: variationName(env.fallthroughVariationIndex), reason: 'fallthrough', enabled: true };
}

/** Finds the target entry that names this firm, preferring a matching kind. */
function findMatchingTarget(env: ILaunchDarklyFlagEnvironment, firmKey: string, firmContextKind: string): ILaunchDarklyTarget | undefined {
	const candidates = [...(env.contextTargets ?? []), ...(env.targets ?? [])].filter(t => t.values.includes(firmKey));
	return candidates.find(t => t.contextKind === firmContextKind) ?? candidates[0];
}

/** Locates the rule the evaluation matched, by id when possible, else by index. */
function findMatchedRule(env: ILaunchDarklyFlagEnvironment, ruleId: string | undefined, ruleIndex: number | undefined): { rule: ILaunchDarklyFlagRule; index: number } | undefined {
	const rules = env.rules;
	if (!rules?.length) {
		return undefined;
	}
	if (ruleId) {
		const byId = rules.findIndex(r => r._id === ruleId);
		if (byId !== -1) {
			return { rule: rules[byId], index: byId };
		}
	}
	if (ruleIndex !== undefined && ruleIndex >= 0 && ruleIndex < rules.length) {
		return { rule: rules[ruleIndex], index: ruleIndex };
	}
	return undefined;
}

/**
 * Resolves which variation was served. The reason gives a deterministic index
 * for most kinds; the served value then confirms it, and recovers the variation
 * for rollouts where the reason alone cannot say which bucket was picked.
 */
function resolveEvaluatedVariation(
	flag: ILaunchDarklyFeatureFlag,
	env: ILaunchDarklyFlagEnvironment | undefined,
	reasonKind: LaunchDarklyReasonKind,
	item: IRawEvaluateItem,
	firmKey: string,
	firmContextKind: string,
	logService: ILogService,
): ILaunchDarklyVariationRef | undefined {
	const value = item._value;
	let index: number | undefined;

	if (env) {
		switch (reasonKind) {
			case 'off':
			case 'prerequisiteFailed':
				index = env.offVariation;
				break;
			case 'targetMatch':
				index = findMatchingTarget(env, firmKey, firmContextKind)?.variationIndex;
				break;
			case 'ruleMatch': {
				const matched = findMatchedRule(env, item.reason?.ruleID ?? item.reason?.ruleId, item.reason?.ruleIndex);
				index = matched?.rule.variationIndex;
				break;
			}
			case 'fallthrough':
				index = env.fallthroughVariationIndex;
				break;
			default:
				break;
		}
	}

	if (value !== undefined) {
		const matches = flag.variations.reduce<number[]>((acc, variation, i) => {
			if (objectsEqual(variation.value, value)) {
				acc.push(i);
			}
			return acc;
		}, []);
		if (index === undefined || !objectsEqual(flag.variations[index]?.value, value)) {
			if (matches.length === 1) {
				index = matches[0];
			} else if (matches.length > 1) {
				index = matches.includes(index ?? -1) ? index : matches[0];
				logService.trace(`[launchDarkly] flag '${flag.key}' has duplicate variation values; variation name may be ambiguous.`);
			}
		}
	}

	if (index === undefined && value === undefined) {
		return undefined;
	}
	return variationRef(flag.variations, index, value);
}

/** One-line explanation of why this variation was served. */
function describeEvaluationReason(
	env: ILaunchDarklyFlagEnvironment | undefined,
	reasonKind: LaunchDarklyReasonKind,
	item: IRawEvaluateItem,
	variationIndex: number | undefined,
	firmContextKind: string,
): string {
	const suffixExperiment = (text: string): string => item.reason?.inExperiment
		? text + localize('ld.reason.inExperimentSuffix', " — in experiment")
		: text;

	switch (reasonKind) {
		case 'off':
			return suffixExperiment(localize('ld.reason.off', "Targeting is off"));
		case 'targetMatch':
			return suffixExperiment(localize('ld.reason.targetMatch', "Individual target"));
		case 'ruleMatch': {
			const matched = env ? findMatchedRule(env, item.reason?.ruleID ?? item.reason?.ruleId, item.reason?.ruleIndex) : undefined;
			if (!matched) {
				const number = (item.reason?.ruleIndex ?? 0) + 1;
				return suffixExperiment(localize('ld.reason.ruleIndexOnly', "Matched targeting rule {0}", number));
			}
			const detail = matched.rule.description?.trim() || summarizeClauses(matched.rule, firmContextKind);
			let text = localize('ld.reason.ruleDescribed', "Rule {0}: {1}", matched.index + 1, detail);
			if (matched.rule.rollout) {
				const percent = rolloutPercent(matched.rule.rollout, variationIndex);
				if (percent !== undefined) {
					text += localize('ld.reason.rolloutSuffix', " (rollout {0}%)", percent);
				}
			}
			return suffixExperiment(text);
		}
		case 'fallthrough': {
			if (env?.fallthroughRollout) {
				const percent = rolloutPercent(env.fallthroughRollout, variationIndex);
				if (percent !== undefined) {
					return suffixExperiment(localize('ld.reason.fallthroughRollout', "Default rollout ({0}%)", percent));
				}
			}
			return suffixExperiment(localize('ld.reason.fallthrough', "Default rule"));
		}
		case 'prerequisiteFailed':
			return localize('ld.reason.prerequisiteFailed', "Prerequisite not met: {0}", item.reason?.prerequisiteKey ?? localize('ld.unknownFlag', "unknown flag"));
		case 'error':
			return localize('ld.reason.error', "Evaluation error: {0}", item.reason?.errorKind ?? localize('ld.unknownError', "unknown"));
		default:
			return localize('ld.reason.unknown', "Could not be determined");
	}
}

/** Builds one authoritative grid row from an evaluate response item. */
function mapEvaluation(
	flag: ILaunchDarklyFeatureFlag,
	env: ILaunchDarklyFlagEnvironment | undefined,
	item: IRawEvaluateItem,
	firmKey: string,
	firmContextKind: string,
	logService: ILogService,
): ILaunchDarklyFlagEvaluation {
	const reasonKind = normalizeReasonKind(item.reason?.kind);
	const variation = resolveEvaluatedVariation(flag, env, reasonKind, item, firmKey, firmContextKind, logService);
	return {
		flagKey: flag.key,
		flagName: flag.name,
		kind: flag.kind,
		tags: flag.tags,
		variation,
		reasonKind,
		explanation: describeEvaluationReason(env, reasonKind, item, variation?.index, firmContextKind),
		ruleIndex: item.reason?.ruleIndex,
		ruleId: item.reason?.ruleID ?? item.reason?.ruleId,
		prerequisiteKey: item.reason?.prerequisiteKey,
		inExperiment: item.reason?.inExperiment,
		errorKind: item.reason?.errorKind,
		enabled: env?.on ?? reasonKind !== 'off',
		authoritative: true,
	};
}

/**
 * Builds a best-effort grid row without asking LaunchDarkly to evaluate. Rules
 * cannot be applied here, but because rule bodies are preserved the row can at
 * least say which conditions stand in the way.
 */
function approximateEvaluation(
	flag: ILaunchDarklyFeatureFlag,
	env: ILaunchDarklyFlagEnvironment | undefined,
	firmKey: string,
	firmContextKind: string,
): ILaunchDarklyFlagEvaluation {
	const assignment = resolveAssignment(flag.key, flag.name, flag.variations, env, firmKey, firmContextKind);
	const reasonKind: LaunchDarklyReasonKind = assignment.reason === 'explicitTarget' ? 'targetMatch'
		: assignment.reason === 'fallthrough' ? 'fallthrough'
			: assignment.reason === 'off' ? 'off'
				: 'unknown';

	let index: number | undefined;
	if (env) {
		if (reasonKind === 'off') {
			index = env.offVariation;
		} else if (reasonKind === 'targetMatch') {
			index = findMatchingTarget(env, firmKey, firmContextKind)?.variationIndex;
		} else if (reasonKind === 'fallthrough' && !env.fallthroughRollout) {
			index = env.fallthroughVariationIndex;
		}
	}

	let explanation: string;
	if (reasonKind === 'unknown') {
		const ruleCount = env?.ruleCount ?? 0;
		const first = env?.rules?.[0];
		explanation = first
			? localize('ld.reason.rulesNotEvaluatedDetail', "{0} targeting rule(s) apply — could not be evaluated ({1})", ruleCount, summarizeClauses(first, firmContextKind))
			: localize('ld.reason.rulesNotEvaluated', "{0} targeting rule(s) apply — could not be evaluated", ruleCount);
	} else {
		explanation = describeEvaluationReason(env, reasonKind, {} as IRawEvaluateItem, index, firmContextKind);
	}

	return {
		flagKey: flag.key,
		flagName: flag.name,
		kind: flag.kind,
		tags: flag.tags,
		variation: index !== undefined ? variationRef(flag.variations, index, undefined) : undefined,
		reasonKind,
		explanation,
		enabled: env?.on ?? false,
		authoritative: false,
	};
}

/**
 * Rows for a segment-sourced firm. A segment is a set rather than a context
 * instance, so it cannot be evaluated; instead report which flags target it,
 * which is exactly answerable from the preserved rules.
 */
function segmentReferenceEvaluation(
	flag: ILaunchDarklyFeatureFlag,
	env: ILaunchDarklyFlagEnvironment | undefined,
	segmentKey: string,
	firmContextKind: string,
): ILaunchDarklyFlagEvaluation {
	const rules = env?.rules ?? [];
	for (let i = 0; i < rules.length; i++) {
		const rule = rules[i];
		const clause = rule.clauses.find(c =>
			(c.op === 'segmentMatch' || c.op === 'segmentIsOneOf' || c.op === 'segmentIsNotOneOf')
			&& c.values.some(v => v === segmentKey));
		if (!clause) {
			continue;
		}
		const excludes = clause.negate || clause.op === 'segmentIsNotOneOf';
		const variation = rule.variationIndex !== undefined ? variationRef(flag.variations, rule.variationIndex, undefined) : undefined;
		const explanation = excludes
			? localize('ld.reason.segmentExcluded', "Rule {0} excludes this segment", i + 1)
			: localize('ld.reason.segmentReference', "Rule {0} targets this segment → {1}", i + 1, variation?.displayLabel ?? summarizeClauses(rule, firmContextKind));
		return {
			flagKey: flag.key,
			flagName: flag.name,
			kind: flag.kind,
			tags: flag.tags,
			variation,
			reasonKind: 'ruleMatch',
			explanation,
			ruleIndex: i,
			ruleId: rule._id,
			enabled: env?.on ?? false,
			authoritative: false,
		};
	}
	return {
		flagKey: flag.key,
		flagName: flag.name,
		kind: flag.kind,
		tags: flag.tags,
		variation: undefined,
		reasonKind: 'unknown',
		explanation: localize('ld.reason.segmentNoReference', "Does not target this segment"),
		enabled: env?.on ?? false,
		authoritative: false,
	};
}

/** Classifies an evaluate failure into a user-presentable degradation. */
function degradationFor(err: unknown): ILaunchDarklyEvaluationDegradation {
	const statusCode = err instanceof LaunchDarklyError ? err.statusCode : undefined;
	switch (statusCode) {
		case 403:
			return { kind: 'forbidden', statusCode, message: localize('ld.degraded.forbidden', "The access token cannot evaluate flags (403). Showing best-effort results based on targeting configuration.") };
		case 404:
		case 405:
			return { kind: 'notFound', statusCode, message: localize('ld.degraded.notFound', "This LaunchDarkly instance does not support flag evaluation through the API. Showing best-effort results based on targeting configuration.") };
		case 429:
			return { kind: 'rateLimited', statusCode, message: localize('ld.degraded.rateLimited', "Rate limited by LaunchDarkly (429). Showing best-effort results; refresh again in a moment.") };
		default:
			return { kind: 'error', statusCode, message: localize('ld.degraded.error', "Could not evaluate flags: {0}. Showing best-effort results based on targeting configuration.", err instanceof Error ? err.message : String(err)) };
	}
}

//#endregion

registerSingleton(ILaunchDarklyService, LaunchDarklyService, InstantiationType.Delayed);
