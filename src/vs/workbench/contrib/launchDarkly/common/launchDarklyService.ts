/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

/**
 * NOTE ON THE LAUNCHDARKLY REST API
 * ---------------------------------
 * These types and the accompanying service model LaunchDarkly's public REST API
 * (base `https://app.launchdarkly.com/api/v2`) plus the AI Configs endpoints.
 *
 * The AI Configs endpoints were still evolving at time of writing and may require
 * the `LD-API-Version: beta` header. Every REST path lives in a single small
 * helper in the browser implementation so it can be corrected in one place once
 * verified against the current docs. See `launchDarklyRestClient.ts`.
 */

export const ILaunchDarklyService = createDecorator<ILaunchDarklyService>('launchDarklyService');

/** Configuration setting keys (non-secret). */
export const LaunchDarklyConfig = {
	/** API base origin, e.g. `https://app.launchdarkly.com`. */
	baseUrl: 'launchdarkly.baseUrl',
	/** Default LaunchDarkly project key. */
	projectKey: 'launchdarkly.projectKey',
	/** Default LaunchDarkly environment key. */
	environmentKey: 'launchdarkly.environmentKey',
	/** How firms are enumerated: 'contextKind' | 'segment'. */
	firmSource: 'launchdarkly.firmSource',
	/** The context kind used to model a firm when `firmSource` is 'contextKind'. */
	firmContextKind: 'launchdarkly.firmContextKind',
	/** The firm key that the local agent belongs to (runtime identity). */
	activeFirmKey: 'launchdarkly.activeFirmKey',
	/** When true, contribute the active firm's configs into the agent customization UI. */
	contributeAgentCustomizations: 'launchdarkly.contributeAgentCustomizations',
} as const;

/** Secret-storage key under which the API access token is stored. */
export const LAUNCHDARKLY_TOKEN_SECRET_KEY = 'launchdarkly.accessToken';

export const DEFAULT_LAUNCHDARKLY_BASE_URL = 'https://app.launchdarkly.com';
export const DEFAULT_FIRM_CONTEXT_KIND = 'firm';

//#region DTOs

export interface ILaunchDarklyProject {
	readonly key: string;
	readonly name: string;
}

export interface ILaunchDarklyEnvironment {
	readonly key: string;
	readonly name: string;
	readonly color?: string;
}

export interface ILaunchDarklySegment {
	readonly key: string;
	readonly name: string;
	readonly description?: string;
}

/**
 * A "firm" — a customer tenant. Modeled either as a LaunchDarkly context
 * (context kind = the configured firm kind) or as a segment, depending on
 * the `launchdarkly.firmSource` setting.
 */
export interface ILaunchDarklyFirm {
	/** The context key / segment key that identifies the firm. */
	readonly key: string;
	/** Display name. */
	readonly name: string;
	/** Where this firm was sourced from. */
	readonly origin: 'contextKind' | 'segment';
	/** Optional attributes for context-sourced firms. */
	readonly attributes?: Readonly<Record<string, unknown>>;
}

export type LaunchDarklyVariationValue = boolean | string | number | Readonly<Record<string, unknown>> | ReadonlyArray<unknown>;

export interface ILaunchDarklyVariation {
	readonly _id?: string;
	readonly value: LaunchDarklyVariationValue;
	readonly name?: string;
	readonly description?: string;
}

/** A single condition within a targeting rule. */
export interface ILaunchDarklyClause {
	readonly _id?: string;
	/** Context kind the clause applies to; defaults to `user` server-side. */
	readonly contextKind?: string;
	/** Attribute reference, e.g. `country` or `/address/city`. */
	readonly attribute: string;
	/** LaunchDarkly operator, e.g. `in`, `segmentMatch`, `startsWith`. */
	readonly op: string;
	/** True when the clause result is inverted. */
	readonly negate: boolean;
	readonly values: ReadonlyArray<LaunchDarklyVariationValue>;
}

/** A weighted percentage rollout across variations. */
export interface ILaunchDarklyRollout {
	readonly variations: ReadonlyArray<{ readonly variationIndex: number; readonly weight: number }>;
	/** Attribute used for bucketing; defaults to the context key. */
	readonly bucketBy?: string;
	readonly contextKind?: string;
	readonly seed?: number;
	/** True when this rollout is an experiment allocation. */
	readonly isExperiment?: boolean;
}

/** A targeting rule, as returned by the flags endpoint with `summary=false`. */
export interface ILaunchDarklyFlagRule {
	readonly _id?: string;
	readonly description?: string;
	readonly clauses: ReadonlyArray<ILaunchDarklyClause>;
	/** Fixed variation index served by this rule, when it is not a rollout. */
	readonly variationIndex?: number;
	/** Rollout served by this rule, when it is not a fixed variation. */
	readonly rollout?: ILaunchDarklyRollout;
}

/** A single feature flag's per-environment targeting summary. */
export interface ILaunchDarklyFlagEnvironment {
	readonly on: boolean;
	/** Index into `variations` used when the flag is off. */
	readonly offVariation?: number;
	/** Fallthrough (default) rollout when the flag is on. */
	readonly fallthroughVariationIndex?: number;
	/** Explicit per-variation context-key targets. */
	readonly targets?: ReadonlyArray<ILaunchDarklyTarget>;
	/** Number of targeting rules (rules are not expanded here). */
	readonly ruleCount?: number;
	/**
	 * Full rule bodies in evaluation order. `undefined` means the flag came from
	 * a summary response so the rules are unknown, which is distinct from `[]`
	 * meaning the flag genuinely has no rules.
	 */
	readonly rules?: ReadonlyArray<ILaunchDarklyFlagRule>;
	/** Per-variation targets for non-user context kinds. */
	readonly contextTargets?: ReadonlyArray<ILaunchDarklyTarget>;
	/** Fallthrough rollout, when the default is a rollout rather than a fixed variation. */
	readonly fallthroughRollout?: ILaunchDarklyRollout;
	/** Prerequisite flags that must be satisfied before this flag is served. */
	readonly prerequisites?: ReadonlyArray<{ readonly key: string; readonly variationIndex: number }>;
}

export interface ILaunchDarklyTarget {
	readonly variationIndex: number;
	readonly contextKind?: string;
	readonly values: ReadonlyArray<string>;
}

export interface ILaunchDarklyFeatureFlag {
	readonly key: string;
	readonly name: string;
	readonly kind: 'boolean' | 'multivariate' | string;
	readonly description?: string;
	readonly tags?: ReadonlyArray<string>;
	readonly variations: ReadonlyArray<ILaunchDarklyVariation>;
	/** Keyed by environment key. */
	readonly environments: Readonly<Record<string, ILaunchDarklyFlagEnvironment>>;
}

/** Model parameters for an AI Config variation. */
export interface ILaunchDarklyModelConfig {
	readonly name: string;
	readonly parameters?: Readonly<Record<string, unknown>>;
	readonly custom?: Readonly<Record<string, unknown>>;
}

export interface ILaunchDarklyMessage {
	readonly role: 'system' | 'user' | 'assistant' | string;
	readonly content: string;
}

export interface ILaunchDarklyAIConfigVariation {
	readonly key: string;
	readonly name?: string;
	readonly modelConfigKey?: string;
	readonly model?: ILaunchDarklyModelConfig;
	readonly messages?: ReadonlyArray<ILaunchDarklyMessage>;
	/** Free-form model-independent settings. */
	readonly instructions?: string;
}

export interface ILaunchDarklyAIConfig {
	readonly key: string;
	readonly name: string;
	readonly description?: string;
	readonly tags?: ReadonlyArray<string>;
	readonly maintainerId?: string;
	readonly variations: ReadonlyArray<ILaunchDarklyAIConfigVariation>;
}

/**
 * The resolved assignment of an AI Config (or flag) for a specific firm:
 * which variation the firm would receive, and why.
 */
export interface ILaunchDarklyFirmAssignment {
	readonly configKey: string;
	readonly configName: string;
	/** The variation the firm receives, if it can be resolved. */
	readonly variationKey?: string;
	readonly variationName?: string;
	/** How the assignment was determined. */
	readonly reason: 'explicitTarget' | 'fallthrough' | 'off' | 'unknown';
	/** True when targeting is enabled for the environment. */
	readonly enabled: boolean;
	/** Fully identified variation, when it could be resolved. */
	readonly variation?: ILaunchDarklyVariationRef;
}

//#endregion

//#region Flag evaluation

/**
 * A fully identified variation. `displayValue` is always populated so that
 * boolean and unnamed JSON variations still render something meaningful.
 */
export interface ILaunchDarklyVariationRef {
	/** Index into the flag's `variations`, when it could be determined. */
	readonly index?: number;
	readonly _id?: string;
	/** Author-supplied variation name, when set. */
	readonly name?: string;
	/** The raw served value. */
	readonly value?: LaunchDarklyVariationValue;
	/** Short display form: `On`/`Off`, the string, the number, or truncated JSON. */
	readonly displayValue: string;
	/** `name` when set, otherwise `displayValue`. Safe to render directly. */
	readonly displayLabel: string;
}

/** Normalized form of LaunchDarkly's evaluation reason kinds. */
export type LaunchDarklyReasonKind =
	| 'off'
	| 'fallthrough'
	| 'targetMatch'
	| 'ruleMatch'
	| 'prerequisiteFailed'
	| 'error'
	| 'unknown';

/** The variation one firm receives for one flag, and why. */
export interface ILaunchDarklyFlagEvaluation {
	readonly flagKey: string;
	readonly flagName: string;
	readonly kind: 'boolean' | 'multivariate' | string;
	readonly tags?: ReadonlyArray<string>;
	/** The variation served; only absent when evaluation itself failed. */
	readonly variation?: ILaunchDarklyVariationRef;
	readonly reasonKind: LaunchDarklyReasonKind;
	/** Localized one-line explanation of the deciding rule. Never empty. */
	readonly explanation: string;
	/** Zero-based index of the matched rule, for `ruleMatch`. */
	readonly ruleIndex?: number;
	readonly ruleId?: string;
	/** The failing prerequisite flag key, for `prerequisiteFailed`. */
	readonly prerequisiteKey?: string;
	/** True when the value came from an experiment allocation. */
	readonly inExperiment?: boolean;
	/** LaunchDarkly's error kind, for `error`. */
	readonly errorKind?: string;
	/** True when environment targeting is on. */
	readonly enabled: boolean;
	/** False when this row was inferred locally rather than evaluated by LaunchDarkly. */
	readonly authoritative: boolean;
}

/** How a set of evaluations was produced. */
export type LaunchDarklyEvaluationSource = 'evaluate' | 'approximation' | 'segmentReference';

/** Why the authoritative evaluation path could not be used. */
export interface ILaunchDarklyEvaluationDegradation {
	readonly kind: 'forbidden' | 'notFound' | 'rateLimited' | 'segmentFirm' | 'error';
	readonly statusCode?: number;
	/** Localized, user-presentable explanation. */
	readonly message: string;
}

export interface ILaunchDarklyFirmEvaluations {
	readonly firmKey: string;
	readonly firmContextKind: string;
	readonly projectKey: string;
	readonly environmentKey: string;
	readonly source: LaunchDarklyEvaluationSource;
	/** Present exactly when `source !== 'evaluate'`. */
	readonly degradation?: ILaunchDarklyEvaluationDegradation;
	/** `Date.now()` when the underlying network data was fetched. */
	readonly evaluatedAt: number;
	readonly evaluations: ReadonlyArray<ILaunchDarklyFlagEvaluation>;
}

export interface ILaunchDarklyEvaluationOptions {
	/** Bypass the short-lived cache. */
	readonly forceRefresh?: boolean;
	/** Extra context attributes merged into the evaluated context instance. */
	readonly contextAttributes?: Readonly<Record<string, unknown>>;
}

//#endregion

/**
 * The resolved set of AI Configs and feature flags that apply to the active
 * firm — i.e. what a local agent for that firm should load.
 */
export interface ILaunchDarklyResolvedFirmConfig {
	readonly firmKey: string;
	readonly aiConfigs: ReadonlyArray<ILaunchDarklyFirmAssignment>;
	readonly flags: ReadonlyArray<ILaunchDarklyFirmAssignment>;
}

/** Snapshot of the current (non-secret) connection configuration. */
export interface ILaunchDarklyConnectionConfig {
	readonly baseUrl: string;
	readonly projectKey: string | undefined;
	readonly environmentKey: string | undefined;
	readonly firmSource: 'contextKind' | 'segment';
	readonly firmContextKind: string;
	/** True when an access token has been stored. */
	readonly hasToken: boolean;
}

export class LaunchDarklyError extends Error {
	constructor(
		message: string,
		readonly statusCode?: number,
	) {
		super(message);
		this.name = 'LaunchDarklyError';
	}
}

/**
 * Reads and manages LaunchDarkly AI Configs and feature flags for the
 * in-editor admin tool. All network access happens through this service
 * (node-backed `IRequestService` on desktop) so the access token never
 * leaves secure storage / the trusted workbench process.
 */
export interface ILaunchDarklyService {
	readonly _serviceBrand: undefined;

	/** Fires when connection configuration or the stored token changes. */
	readonly onDidChangeConfiguration: Event<void>;

	/** Returns the current (non-secret) connection configuration. */
	getConnectionConfig(): Promise<ILaunchDarklyConnectionConfig>;

	/** True when a token is present and a project key is configured. */
	isConfigured(): Promise<boolean>;

	/** Stores (or clears, when `undefined`) the API access token. */
	setAccessToken(token: string | undefined): Promise<void>;

	//#region Discovery

	listProjects(token: CancellationToken): Promise<ReadonlyArray<ILaunchDarklyProject>>;
	listEnvironments(projectKey: string, token: CancellationToken): Promise<ReadonlyArray<ILaunchDarklyEnvironment>>;
	listSegments(projectKey: string, environmentKey: string, token: CancellationToken): Promise<ReadonlyArray<ILaunchDarklySegment>>;
	listFirms(token: CancellationToken): Promise<ReadonlyArray<ILaunchDarklyFirm>>;

	//#endregion

	//#region Feature flags

	listFeatureFlags(token: CancellationToken): Promise<ReadonlyArray<ILaunchDarklyFeatureFlag>>;
	getFeatureFlag(flagKey: string, token: CancellationToken): Promise<ILaunchDarklyFeatureFlag>;
	setFlagTargeting(flagKey: string, on: boolean, token: CancellationToken): Promise<void>;
	createFeatureFlag(spec: { key: string; name: string; description?: string }, token: CancellationToken): Promise<ILaunchDarklyFeatureFlag>;

	//#endregion

	//#region AI Configs

	listAIConfigs(token: CancellationToken): Promise<ReadonlyArray<ILaunchDarklyAIConfig>>;
	getAIConfig(configKey: string, token: CancellationToken): Promise<ILaunchDarklyAIConfig>;
	createAIConfig(spec: { key: string; name: string; description?: string }, token: CancellationToken): Promise<ILaunchDarklyAIConfig>;
	updateAIConfig(configKey: string, patch: { name?: string; description?: string }, token: CancellationToken): Promise<ILaunchDarklyAIConfig>;
	deleteAIConfig(configKey: string, token: CancellationToken): Promise<void>;

	//#endregion

	//#region Firm assignment

	/**
	 * Best-effort resolution of which AI Config variations a firm receives in
	 * the active environment, based on explicit context targets and fallthrough.
	 * Complex targeting rules (segments/clauses) are reported as `unknown` and
	 * should be confirmed against SDK evaluation.
	 */
	getFirmAIConfigAssignments(firmKey: string, token: CancellationToken): Promise<ReadonlyArray<ILaunchDarklyFirmAssignment>>;

	/**
	 * Best-effort resolution of which feature flags are "on" and what variation
	 * a firm receives, used for flag-gated customizations.
	 */
	getFirmFlagAssignments(firmKey: string, token: CancellationToken): Promise<ReadonlyArray<ILaunchDarklyFirmAssignment>>;

	/**
	 * Resolves, for every flag in the active environment, which variation the
	 * firm receives and why. Prefers LaunchDarkly's authoritative evaluation
	 * endpoint and degrades to local approximation; inspect `source` and
	 * `degradation` on the result to see which path produced the data.
	 */
	getFirmFlagEvaluations(firmKey: string, options: ILaunchDarklyEvaluationOptions, token: CancellationToken): Promise<ILaunchDarklyFirmEvaluations>;

	/** Drops all cached flag and evaluation data. */
	invalidateCache(): void;

	//#endregion

	//#region Agent integration

	/** The firm key the local agent belongs to (from `launchdarkly.activeFirmKey`). */
	getActiveFirmKey(): Promise<string | undefined>;

	/**
	 * Resolves the AI Configs and feature flags that apply to the active firm.
	 * Returns `undefined` when no active firm is set or the service is not
	 * configured. This is the input for wiring LaunchDarkly into the agent
	 * customization pipeline.
	 */
	resolveActiveFirmAgentConfig(token: CancellationToken): Promise<ILaunchDarklyResolvedFirmConfig | undefined>;

	//#endregion
}
