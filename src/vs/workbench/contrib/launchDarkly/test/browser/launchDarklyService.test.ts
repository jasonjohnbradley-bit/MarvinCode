/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Event } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { VSBuffer, bufferToStream } from '../../../../../base/common/buffer.js';
import { IRequestContext, IRequestOptions } from '../../../../../base/parts/request/common/request.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { IRequestService } from '../../../../../platform/request/common/request.js';
import { TestSecretStorageService } from '../../../../../platform/secrets/test/common/testSecretStorageService.js';
import { ILaunchDarklyFirmEvaluations, ILaunchDarklyFlagEvaluation, LAUNCHDARKLY_TOKEN_SECRET_KEY, LaunchDarklyConfig } from '../../common/launchDarklyService.js';
import { LaunchDarklyService } from '../../browser/launchDarklyService.js';

interface ICannedResponse {
	readonly statusCode: number;
	readonly body?: string;
}

type RequestHandler = (options: IRequestOptions) => ICannedResponse;

class FakeRequestService implements IRequestService {
	declare readonly _serviceBrand: undefined;
	readonly onDidCompleteRequest = Event.None;

	readonly requests: IRequestOptions[] = [];
	handler: RequestHandler = () => ({ statusCode: 200, body: '{}' });

	async request(options: IRequestOptions, _token: CancellationToken): Promise<IRequestContext> {
		this.requests.push(options);
		const { statusCode, body } = this.handler(options);
		return {
			res: { statusCode, headers: {} },
			stream: bufferToStream(VSBuffer.fromString(body ?? '')),
		};
	}
	async resolveProxy(): Promise<string | undefined> { return undefined; }
	async lookupAuthorization(): Promise<undefined> { return undefined; }
	async lookupKerberosAuthorization(): Promise<string | undefined> { return undefined; }
	async loadCertificates(): Promise<string[]> { return []; }
}

function flagsResponse(): string {
	return JSON.stringify({
		items: [
			{
				key: 'flag-off', name: 'Off Flag', kind: 'boolean',
				variations: [{ value: true, name: 'On' }, { value: false, name: 'Off' }],
				environments: { prod: { on: false, offVariation: 1, fallthrough: { variation: 0 } } },
			},
			{
				key: 'flag-target', name: 'Target Flag', kind: 'boolean',
				variations: [{ value: true, name: 'On' }, { value: false, name: 'Off' }],
				environments: { prod: { on: true, fallthrough: { variation: 1 }, targets: [{ variation: 0, contextKind: 'firm', values: ['firm-a'] }] } },
			},
			{
				key: 'flag-rules', name: 'Rules Flag', kind: 'boolean',
				variations: [{ value: true, name: 'On' }, { value: false, name: 'Off' }],
				environments: { prod: { on: true, fallthrough: { variation: 1 }, rules: [{ _id: 'r1' }] } },
			},
			{
				key: 'flag-fallthrough', name: 'Fallthrough Flag', kind: 'boolean',
				variations: [{ value: true, name: 'On' }, { value: false, name: 'Off' }],
				environments: { prod: { on: true, fallthrough: { variation: 0 } } },
			},
		],
	});
}

/**
 * The same four flags as {@link flagsResponse} with real rule bodies, plus
 * flags covering rollout, prerequisites, and unnamed boolean/JSON variations.
 */
function flagsResponseWithRules(): string {
	return JSON.stringify({
		items: [
			{
				key: 'flag-off', name: 'Off Flag', kind: 'boolean',
				variations: [{ value: true, name: 'On' }, { value: false, name: 'Off' }],
				environments: { prod: { on: false, offVariation: 1, fallthrough: { variation: 0 } } },
			},
			{
				key: 'flag-target', name: 'Target Flag', kind: 'boolean',
				variations: [{ value: true, name: 'On' }, { value: false, name: 'Off' }],
				environments: { prod: { on: true, fallthrough: { variation: 1 }, targets: [{ variation: 0, contextKind: 'firm', values: ['firm-a'] }] } },
			},
			{
				key: 'flag-rules', name: 'Rules Flag', kind: 'boolean',
				variations: [{ value: true, name: 'On' }, { value: false, name: 'Off' }],
				environments: {
					prod: {
						on: true, fallthrough: { variation: 1 },
						rules: [
							{ _id: 'r1', description: 'Tier 1 firms', clauses: [{ attribute: 'segmentKey', op: 'segmentMatch', values: ['tier-1'], negate: false }], variation: 0 },
							{ _id: 'r2', clauses: [{ attribute: 'country', op: 'in', values: ['GB'], negate: false }], variation: 0 },
						],
					},
				},
			},
			{
				key: 'flag-fallthrough', name: 'Fallthrough Flag', kind: 'boolean',
				variations: [{ value: true, name: 'On' }, { value: false, name: 'Off' }],
				environments: { prod: { on: true, fallthrough: { variation: 0 } } },
			},
			{
				key: 'flag-rollout', name: 'Rollout Flag', kind: 'boolean',
				variations: [{ value: true, name: 'On' }, { value: false, name: 'Off' }],
				environments: { prod: { on: true, fallthrough: { rollout: { variations: [{ variation: 0, weight: 20000 }, { variation: 1, weight: 80000 }] } } } },
			},
			{
				key: 'flag-prereq', name: 'Prereq Flag', kind: 'boolean',
				variations: [{ value: true, name: 'On' }, { value: false, name: 'Off' }],
				environments: { prod: { on: true, offVariation: 1, fallthrough: { variation: 0 }, prerequisites: [{ key: 'parent-flag', variation: 0 }] } },
			},
			{
				key: 'flag-bool-unnamed', name: 'Unnamed Boolean', kind: 'boolean',
				variations: [{ value: true }, { value: false }],
				environments: { prod: { on: true, fallthrough: { variation: 0 } } },
			},
			{
				key: 'flag-json', name: 'Json Flag', kind: 'multivariate',
				variations: [{ value: { a: 1 } }, { value: { b: 2 } }],
				environments: { prod: { on: true, fallthrough: { variation: 0 } } },
			},
		],
	});
}

function evaluateResponse(items: ReadonlyArray<Record<string, unknown>>): string {
	return JSON.stringify({ items, totalCount: items.length });
}

/** Routes flags / evaluate / ai-config requests to their canned bodies. */
function routingHandler(evaluate: () => ICannedResponse, flags: () => ICannedResponse = () => ({ statusCode: 200, body: flagsResponseWithRules() })): RequestHandler {
	return options => {
		const url = options.url ?? '';
		if (url.includes('/flags/evaluate')) {
			return evaluate();
		}
		if (url.includes('/ai-configs')) {
			return { statusCode: 200, body: aiConfigsResponse() };
		}
		return flags();
	};
}

function aiConfigsResponse(): string {
	return JSON.stringify({
		items: [
			{
				key: 'cfg1', name: 'Cfg 1', description: 'first',
				variations: [
					{ key: 'v1', name: 'Variation 1', modelConfigKey: 'gpt-4o', model: { name: 'gpt-4o', parameters: { temperature: 0.2 } }, messages: [{ role: 'system', content: 'hi' }] },
				],
			},
		],
	});
}

suite('LaunchDarklyService', () => {

	const ds = ensureNoDisposablesAreLeakedInTestSuite();

	function createService(configuration: Record<string, unknown>, handler?: RequestHandler): { service: LaunchDarklyService; request: FakeRequestService; secrets: TestSecretStorageService } {
		const store = ds.add(new DisposableStore());
		const request = new FakeRequestService();
		if (handler) {
			request.handler = handler;
		}
		const secrets = store.add(new TestSecretStorageService());
		const configService = new TestConfigurationService(configuration);
		const service = store.add(new LaunchDarklyService(configService, secrets, request, new NullLogService()));
		return { service, request, secrets };
	}

	const CONFIGURED = {
		[LaunchDarklyConfig.baseUrl]: 'https://app.launchdarkly.com',
		[LaunchDarklyConfig.projectKey]: 'proj',
		[LaunchDarklyConfig.environmentKey]: 'prod',
	};

	test('isConfigured requires both a token and a project key', async () => {
		const { service, secrets } = createService({ [LaunchDarklyConfig.projectKey]: 'proj' });
		assert.strictEqual(await service.isConfigured(), false, 'no token -> not configured');

		await secrets.set(LAUNCHDARKLY_TOKEN_SECRET_KEY, 'api-token');
		assert.strictEqual(await service.isConfigured(), true, 'token + project -> configured');
	});

	test('isConfigured is false when project key is missing', async () => {
		const { service, secrets } = createService({});
		await secrets.set(LAUNCHDARKLY_TOKEN_SECRET_KEY, 'api-token');
		assert.strictEqual(await service.isConfigured(), false);
	});

	test('setAccessToken stores and clears the token in secret storage', async () => {
		const { service, secrets } = createService({});
		await service.setAccessToken('api-token');
		assert.strictEqual(await secrets.get(LAUNCHDARKLY_TOKEN_SECRET_KEY), 'api-token');

		await service.setAccessToken(undefined);
		assert.strictEqual(await secrets.get(LAUNCHDARKLY_TOKEN_SECRET_KEY), undefined);
	});

	test('operations without a token throw a descriptive error', async () => {
		const { service } = createService(CONFIGURED);
		await assert.rejects(() => service.listFeatureFlags(CancellationToken.None), /access token/i);
	});

	test('requests carry the Authorization header and hit the v2 API base', async () => {
		const { service, request, secrets } = createService(CONFIGURED, () => ({ statusCode: 200, body: flagsResponse() }));
		await secrets.set(LAUNCHDARKLY_TOKEN_SECRET_KEY, 'api-token');

		await service.listFeatureFlags(CancellationToken.None);

		assert.strictEqual(request.requests.length, 1);
		const req = request.requests[0];
		assert.strictEqual(req.headers?.['Authorization'], 'api-token');
		assert.ok(req.url?.startsWith('https://app.launchdarkly.com/api/v2/flags/proj'), `unexpected url: ${req.url}`);
	});

	test('listFeatureFlags maps environments, variations and targets', async () => {
		const { service, secrets } = createService(CONFIGURED, () => ({ statusCode: 200, body: flagsResponse() }));
		await secrets.set(LAUNCHDARKLY_TOKEN_SECRET_KEY, 'api-token');

		const flags = await service.listFeatureFlags(CancellationToken.None);
		assert.strictEqual(flags.length, 4);

		const target = flags.find(f => f.key === 'flag-target')!;
		assert.strictEqual(target.environments['prod'].on, true);
		assert.strictEqual(target.environments['prod'].fallthroughVariationIndex, 1);
		assert.strictEqual(target.environments['prod'].targets?.[0].values[0], 'firm-a');
		assert.strictEqual(target.variations.length, 2);
	});

	test('getFirmFlagAssignments resolves off / explicit target / rules / fallthrough', async () => {
		const { service, secrets } = createService(CONFIGURED, () => ({ statusCode: 200, body: flagsResponse() }));
		await secrets.set(LAUNCHDARKLY_TOKEN_SECRET_KEY, 'api-token');

		const assignments = await service.getFirmFlagAssignments('firm-a', CancellationToken.None);
		const byKey = new Map(assignments.map(a => [a.configKey, a]));

		assert.strictEqual(byKey.get('flag-off')!.reason, 'off');
		assert.strictEqual(byKey.get('flag-off')!.enabled, false);
		assert.strictEqual(byKey.get('flag-off')!.variationName, 'Off');

		assert.strictEqual(byKey.get('flag-target')!.reason, 'explicitTarget');
		assert.strictEqual(byKey.get('flag-target')!.enabled, true);
		assert.strictEqual(byKey.get('flag-target')!.variationName, 'On');

		assert.strictEqual(byKey.get('flag-rules')!.reason, 'unknown');
		assert.strictEqual(byKey.get('flag-rules')!.enabled, true);

		assert.strictEqual(byKey.get('flag-fallthrough')!.reason, 'fallthrough');
		assert.strictEqual(byKey.get('flag-fallthrough')!.variationName, 'On');
	});

	test('listAIConfigs maps variations and sends the beta API header', async () => {
		const { service, request, secrets } = createService(CONFIGURED, () => ({ statusCode: 200, body: aiConfigsResponse() }));
		await secrets.set(LAUNCHDARKLY_TOKEN_SECRET_KEY, 'api-token');

		const configs = await service.listAIConfigs(CancellationToken.None);
		assert.strictEqual(configs.length, 1);
		assert.strictEqual(configs[0].key, 'cfg1');
		assert.strictEqual(configs[0].variations.length, 1);
		assert.strictEqual(configs[0].variations[0].model?.name, 'gpt-4o');

		assert.strictEqual(request.requests[0].headers?.['LD-API-Version'], 'beta');
	});

	test('createAIConfig POSTs the key/name with the beta header', async () => {
		const { service, request, secrets } = createService(CONFIGURED, () => ({ statusCode: 201, body: JSON.stringify({ key: 'audit', name: 'Audit' }) }));
		await secrets.set(LAUNCHDARKLY_TOKEN_SECRET_KEY, 'api-token');

		await service.createAIConfig({ key: 'audit', name: 'Audit' }, CancellationToken.None);
		const req = request.requests[0];
		assert.strictEqual(req.type, 'POST');
		assert.strictEqual(req.headers?.['LD-API-Version'], 'beta');
		const body = JSON.parse(req.data ?? '{}');
		assert.strictEqual(body.key, 'audit');
		assert.strictEqual(body.name, 'Audit');
	});

	test('setFlagTargeting issues a semantic-patch instruction', async () => {
		const { service, request, secrets } = createService(CONFIGURED, () => ({ statusCode: 200, body: '{}' }));
		await secrets.set(LAUNCHDARKLY_TOKEN_SECRET_KEY, 'api-token');

		await service.setFlagTargeting('flag-target', false, CancellationToken.None);
		const req = request.requests[0];
		assert.strictEqual(req.type, 'PATCH');
		assert.ok(req.headers?.['Content-Type']?.toString().includes('semanticpatch'));
		const body = JSON.parse(req.data ?? '{}');
		assert.strictEqual(body.environmentKey, 'prod');
		assert.strictEqual(body.instructions[0].kind, 'turnFlagOff');
	});

	test('a 401 response produces a friendly error', async () => {
		const { service, secrets } = createService(CONFIGURED, () => ({ statusCode: 401, body: JSON.stringify({ message: 'invalid token' }) }));
		await secrets.set(LAUNCHDARKLY_TOKEN_SECRET_KEY, 'bad-token');
		await assert.rejects(() => service.listFeatureFlags(CancellationToken.None), /401/);
	});

	test('resolveActiveFirmAgentConfig returns undefined without an active firm', async () => {
		const { service, secrets } = createService(CONFIGURED);
		await secrets.set(LAUNCHDARKLY_TOKEN_SECRET_KEY, 'api-token');
		assert.strictEqual(await service.resolveActiveFirmAgentConfig(CancellationToken.None), undefined);
	});

	test('resolveActiveFirmAgentConfig resolves AI configs and flags for the active firm', async () => {
		const handler: RequestHandler = (options) => {
			const url = options.url ?? '';
			if (url.includes('/ai-configs')) {
				return { statusCode: 200, body: aiConfigsResponse() };
			}
			if (/\/flags\/proj\/[^?]/.test(url)) {
				// single flag GET for AI-config-backed targeting
				return { statusCode: 200, body: JSON.stringify({ key: 'cfg1', name: 'Cfg 1', variations: [{ value: 'v1', name: 'Variation 1' }], environments: { prod: { on: true, fallthrough: { variation: 0 } } } }) };
			}
			return { statusCode: 200, body: flagsResponse() };
		};
		const { service, secrets } = createService({ ...CONFIGURED, [LaunchDarklyConfig.activeFirmKey]: 'firm-a' }, handler);
		await secrets.set(LAUNCHDARKLY_TOKEN_SECRET_KEY, 'api-token');

		const resolved = await service.resolveActiveFirmAgentConfig(CancellationToken.None);
		assert.ok(resolved, 'expected a resolved config');
		assert.strictEqual(resolved!.firmKey, 'firm-a');
		assert.strictEqual(resolved!.aiConfigs.length, 1);
		assert.strictEqual(resolved!.flags.length, 4);
	});

	//#region Flag evaluation

	/** Creates a configured service with a token already stored. */
	async function createEvaluationService(handler: RequestHandler, configuration: Record<string, unknown> = {}) {
		const created = createService({ ...CONFIGURED, ...configuration }, handler);
		await created.secrets.set(LAUNCHDARKLY_TOKEN_SECRET_KEY, 'api-token');
		return created;
	}

	function findEvaluation(result: ILaunchDarklyFirmEvaluations, flagKey: string): ILaunchDarklyFlagEvaluation {
		const found = result.evaluations.find(e => e.flagKey === flagKey);
		assert.ok(found, `expected an evaluation for ${flagKey}`);
		return found!;
	}

	test('getFirmFlagEvaluations posts the firm context to the evaluate endpoint', async () => {
		const { service, request } = await createEvaluationService(routingHandler(() => ({ statusCode: 200, body: evaluateResponse([]) })));

		await service.getFirmFlagEvaluations('firm-a', {}, CancellationToken.None);

		const evaluateRequest = request.requests.find(r => (r.url ?? '').includes('/flags/evaluate'));
		assert.ok(evaluateRequest, 'expected an evaluate request');
		assert.strictEqual(evaluateRequest!.url, 'https://app.launchdarkly.com/api/v2/projects/proj/environments/prod/flags/evaluate?limit=-1');
		assert.strictEqual(evaluateRequest!.type, 'POST');
		assert.strictEqual(evaluateRequest!.headers?.['Authorization'], 'api-token');
		assert.deepStrictEqual(JSON.parse(evaluateRequest!.data as string), { kind: 'firm', key: 'firm-a' });
	});

	test('getFirmFlagEvaluations maps each reason kind to a variation and explanation', async () => {
		const { service } = await createEvaluationService(routingHandler(() => ({
			statusCode: 200,
			body: evaluateResponse([
				{ key: 'flag-off', _value: false, reason: { kind: 'OFF' } },
				{ key: 'flag-target', _value: true, reason: { kind: 'TARGET_MATCH' } },
				{ key: 'flag-fallthrough', _value: true, reason: { kind: 'FALLTHROUGH' } },
			]),
		})));

		const result = await service.getFirmFlagEvaluations('firm-a', {}, CancellationToken.None);
		assert.strictEqual(result.source, 'evaluate');
		assert.strictEqual(result.degradation, undefined);

		assert.deepStrictEqual(
			['flag-off', 'flag-target', 'flag-fallthrough'].map(key => {
				const e = findEvaluation(result, key);
				return { key, reason: e.reasonKind, index: e.variation?.index, label: e.variation?.displayLabel, explanation: e.explanation, authoritative: e.authoritative };
			}),
			[
				{ key: 'flag-off', reason: 'off', index: 1, label: 'Off', explanation: 'Targeting is off', authoritative: true },
				{ key: 'flag-target', reason: 'targetMatch', index: 0, label: 'On', explanation: 'Individual target', authoritative: true },
				{ key: 'flag-fallthrough', reason: 'fallthrough', index: 0, label: 'On', explanation: 'Default rule', authoritative: true },
			],
		);
	});

	test('getFirmFlagEvaluations names the matched rule, falling back to its clauses', async () => {
		const { service } = await createEvaluationService(routingHandler(() => ({
			statusCode: 200,
			body: evaluateResponse([
				{ key: 'flag-rules', _value: true, reason: { kind: 'RULE_MATCH', ruleIndex: 0, ruleID: 'r1' } },
			]),
		})));

		const described = findEvaluation(await service.getFirmFlagEvaluations('firm-a', {}, CancellationToken.None), 'flag-rules');
		assert.strictEqual(described.reasonKind, 'ruleMatch');
		assert.strictEqual(described.explanation, 'Rule 1: Tier 1 firms');
		assert.strictEqual(described.ruleId, 'r1');

		const { service: service2 } = await createEvaluationService(routingHandler(() => ({
			statusCode: 200,
			body: evaluateResponse([
				{ key: 'flag-rules', _value: true, reason: { kind: 'RULE_MATCH', ruleIndex: 1, ruleID: 'r2' } },
			]),
		})));
		const summarized = findEvaluation(await service2.getFirmFlagEvaluations('firm-a', {}, CancellationToken.None), 'flag-rules');
		assert.strictEqual(summarized.explanation, 'Rule 2: country is GB');
	});

	test('getFirmFlagEvaluations resolves a rollout variation from the served value', async () => {
		const { service } = await createEvaluationService(routingHandler(() => ({
			statusCode: 200,
			body: evaluateResponse([{ key: 'flag-rollout', _value: true, reason: { kind: 'FALLTHROUGH' } }]),
		})));

		const rollout = findEvaluation(await service.getFirmFlagEvaluations('firm-a', {}, CancellationToken.None), 'flag-rollout');
		assert.strictEqual(rollout.variation?.index, 0, 'value match should recover the served variation');
		assert.strictEqual(rollout.explanation, 'Default rollout (20%)');
	});

	test('getFirmFlagEvaluations reports prerequisite failures, errors and experiments', async () => {
		const { service } = await createEvaluationService(routingHandler(() => ({
			statusCode: 200,
			body: evaluateResponse([
				{ key: 'flag-prereq', _value: false, reason: { kind: 'PREREQUISITE_FAILED', prerequisiteKey: 'parent-flag' } },
				{ key: 'flag-fallthrough', reason: { kind: 'ERROR', errorKind: 'FLAG_NOT_FOUND' } },
				{ key: 'flag-target', _value: true, reason: { kind: 'FALLTHROUGH', inExperiment: true } },
			]),
		})));

		const result = await service.getFirmFlagEvaluations('firm-a', {}, CancellationToken.None);
		const prereq = findEvaluation(result, 'flag-prereq');
		assert.strictEqual(prereq.reasonKind, 'prerequisiteFailed');
		assert.strictEqual(prereq.prerequisiteKey, 'parent-flag');
		assert.strictEqual(prereq.variation?.index, 1, 'prerequisite failure serves the off variation');
		assert.strictEqual(prereq.explanation, 'Prerequisite not met: parent-flag');

		const errored = findEvaluation(result, 'flag-fallthrough');
		assert.strictEqual(errored.reasonKind, 'error');
		assert.ok(errored.explanation.includes('FLAG_NOT_FOUND'), `unexpected explanation: ${errored.explanation}`);

		const experiment = findEvaluation(result, 'flag-target');
		assert.strictEqual(experiment.inExperiment, true);
		assert.ok(experiment.explanation.includes('in experiment'), `unexpected explanation: ${experiment.explanation}`);
	});

	test('getFirmFlagEvaluations formats unnamed boolean and JSON variations', async () => {
		const { service } = await createEvaluationService(routingHandler(() => ({
			statusCode: 200,
			body: evaluateResponse([
				{ key: 'flag-bool-unnamed', _value: false, reason: { kind: 'FALLTHROUGH' } },
				{ key: 'flag-json', _value: { a: 1 }, reason: { kind: 'FALLTHROUGH' } },
			]),
		})));

		const result = await service.getFirmFlagEvaluations('firm-a', {}, CancellationToken.None);
		const boolean = findEvaluation(result, 'flag-bool-unnamed');
		assert.deepStrictEqual(
			{ name: boolean.variation?.name, displayValue: boolean.variation?.displayValue, displayLabel: boolean.variation?.displayLabel },
			{ name: undefined, displayValue: 'Off', displayLabel: 'Off' },
			'an unnamed boolean variation must still render as On/Off',
		);

		const json = findEvaluation(result, 'flag-json');
		assert.strictEqual(json.variation?.index, 0, 'JSON variation resolved by deep equality');
		assert.strictEqual(json.variation?.displayValue, '{"a":1}');
	});

	test('getFirmFlagEvaluations falls back to approximation when evaluation is refused', async () => {
		for (const [statusCode, expectedKind] of [[403, 'forbidden'], [404, 'notFound'], [429, 'rateLimited']] as const) {
			const { service } = await createEvaluationService(routingHandler(() => ({ statusCode, body: '{"message":"nope"}' })));
			const result = await service.getFirmFlagEvaluations('firm-a', {}, CancellationToken.None);

			assert.strictEqual(result.source, 'approximation', `status ${statusCode}`);
			assert.strictEqual(result.degradation?.kind, expectedKind);
			assert.strictEqual(result.degradation?.statusCode, statusCode);
			assert.ok(result.evaluations.length > 0, 'the grid must still be populated');
			assert.ok(result.evaluations.every(e => !e.authoritative), 'approximated rows must not claim authority');

			// Targets are still resolvable locally; rules are not, but now explain why.
			assert.strictEqual(findEvaluation(result, 'flag-target').variation?.displayLabel, 'On');
			const rules = findEvaluation(result, 'flag-rules');
			assert.strictEqual(rules.reasonKind, 'unknown');
			assert.ok(rules.explanation.includes('in segment tier-1'), `unexpected explanation: ${rules.explanation}`);
		}
	});

	test('getFirmFlagEvaluations rejects on 401 rather than degrading', async () => {
		const { service } = await createEvaluationService(routingHandler(() => ({ statusCode: 401, body: '{}' })));
		await assert.rejects(() => service.getFirmFlagEvaluations('firm-a', {}, CancellationToken.None), /401/);
	});

	test('getFirmFlagEvaluations reports segment references without evaluating', async () => {
		const { service, request } = await createEvaluationService(
			routingHandler(() => ({ statusCode: 500, body: 'evaluate must not be called' })),
			{ [LaunchDarklyConfig.firmSource]: 'segment' },
		);

		const result = await service.getFirmFlagEvaluations('tier-1', {}, CancellationToken.None);
		assert.strictEqual(result.source, 'segmentReference');
		assert.strictEqual(result.degradation?.kind, 'segmentFirm');
		assert.ok(!request.requests.some(r => (r.url ?? '').includes('/flags/evaluate')), 'a segment cannot be evaluated as a context');

		const referencing = findEvaluation(result, 'flag-rules');
		assert.ok(referencing.explanation.includes('targets this segment'), `unexpected explanation: ${referencing.explanation}`);
		assert.strictEqual(referencing.variation?.displayLabel, 'On');
		assert.strictEqual(findEvaluation(result, 'flag-fallthrough').explanation, 'Does not target this segment');
	});

	test('getFirmFlagEvaluations approximates only the rows the response omitted', async () => {
		const { service } = await createEvaluationService(routingHandler(() => ({
			statusCode: 200,
			// One flag deliberately missing from an otherwise complete response.
			body: JSON.stringify({
				items: [
					{ key: 'flag-off', _value: false, reason: { kind: 'OFF' } },
					{ key: 'flag-target', _value: true, reason: { kind: 'TARGET_MATCH' } },
				],
				totalCount: 3,
			}),
		})));

		const result = await service.getFirmFlagEvaluations('firm-a', {}, CancellationToken.None);
		assert.strictEqual(result.source, 'evaluate');
		assert.strictEqual(findEvaluation(result, 'flag-off').authoritative, true);
		assert.strictEqual(findEvaluation(result, 'flag-fallthrough').authoritative, false);
	});

	test('mapFlag preserves rule bodies, rollouts and prerequisites alongside ruleCount', async () => {
		const { service } = await createEvaluationService(routingHandler(() => ({ statusCode: 200, body: evaluateResponse([]) })));
		const flags = await service.listFeatureFlags(CancellationToken.None);

		const rules = flags.find(f => f.key === 'flag-rules')!.environments['prod'];
		assert.strictEqual(rules.ruleCount, 2, 'ruleCount must keep working for the shallow resolver');
		assert.strictEqual(rules.rules?.length, 2);
		assert.strictEqual(rules.rules?.[0].clauses[0].op, 'segmentMatch');

		const rollout = flags.find(f => f.key === 'flag-rollout')!.environments['prod'];
		assert.strictEqual(rollout.fallthroughRollout?.variations[0].weight, 20000);

		const prereq = flags.find(f => f.key === 'flag-prereq')!.environments['prod'];
		assert.deepStrictEqual(prereq.prerequisites, [{ key: 'parent-flag', variationIndex: 0 }]);

		// A flag with no rules array at all reports `undefined`, not `[]`.
		assert.strictEqual(flags.find(f => f.key === 'flag-off')!.environments['prod'].rules, undefined);
	});

	test('flag data is cached, de-duplicated, and refetched on demand', async () => {
		const { service, request } = await createEvaluationService(routingHandler(() => ({ statusCode: 200, body: evaluateResponse([]) })));

		await service.getFirmFlagEvaluations('firm-a', {}, CancellationToken.None);
		const afterFirst = request.requests.length;

		await service.getFirmFlagEvaluations('firm-a', {}, CancellationToken.None);
		assert.strictEqual(request.requests.length, afterFirst, 'a cached evaluation must not hit the network');

		await service.getFirmFlagEvaluations('firm-a', { forceRefresh: true }, CancellationToken.None);
		assert.ok(request.requests.length > afterFirst, 'forceRefresh must bypass the cache');

		const beforeInvalidate = request.requests.length;
		service.invalidateCache();
		await service.getFirmFlagEvaluations('firm-a', {}, CancellationToken.None);
		assert.ok(request.requests.length > beforeInvalidate, 'invalidateCache must force a refetch');
	});

	test('concurrent evaluations share one round of requests', async () => {
		const { service, request } = await createEvaluationService(routingHandler(() => ({ statusCode: 200, body: evaluateResponse([]) })));

		await Promise.all([
			service.getFirmFlagEvaluations('firm-a', {}, CancellationToken.None),
			service.getFirmFlagEvaluations('firm-a', {}, CancellationToken.None),
		]);

		assert.strictEqual(request.requests.length, 2, 'expected one flags request and one evaluate request');
	});

	test('a failed evaluation is not cached', async () => {
		let attempt = 0;
		const { service } = await createEvaluationService(routingHandler(() => {
			attempt++;
			return attempt === 1 ? { statusCode: 429, body: '{}' } : { statusCode: 200, body: evaluateResponse([]) };
		}));

		assert.strictEqual((await service.getFirmFlagEvaluations('firm-a', {}, CancellationToken.None)).source, 'approximation');
		assert.strictEqual((await service.getFirmFlagEvaluations('firm-a', { forceRefresh: true }, CancellationToken.None)).source, 'evaluate');
	});

	test('setFlagTargeting invalidates cached evaluations', async () => {
		const { service, request } = await createEvaluationService(routingHandler(() => ({ statusCode: 200, body: evaluateResponse([]) })));

		await service.getFirmFlagEvaluations('firm-a', {}, CancellationToken.None);
		await service.setFlagTargeting('flag-target', false, CancellationToken.None);
		const afterPatch = request.requests.length;

		await service.getFirmFlagEvaluations('firm-a', {}, CancellationToken.None);
		assert.ok(request.requests.length > afterPatch, 'a targeting change must invalidate the cache');
	});

	test('getFirmAIConfigAssignments no longer fetches one flag per config', async () => {
		const { service, request } = await createEvaluationService(routingHandler(() => ({ statusCode: 200, body: evaluateResponse([]) })));

		await service.getFirmAIConfigAssignments('firm-a', CancellationToken.None);

		const singleFlagGets = request.requests.filter(r => /\/flags\/proj\/[^?]/.test(r.url ?? ''));
		assert.deepStrictEqual(singleFlagGets.map(r => r.url), [], 'AI Config resolution must reuse the cached flag list');
	});

	//#endregion
});
