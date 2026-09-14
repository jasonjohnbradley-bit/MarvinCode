/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Event } from '../../../../../base/common/event.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { AICustomizationSources } from '../../../chat/common/aiCustomizationWorkspaceService.js';
import { PromptsType } from '../../../chat/common/promptSyntax/promptTypes.js';
import { ILaunchDarklyResolvedFirmConfig, ILaunchDarklyService } from '../../common/launchDarklyService.js';
import { LaunchDarklyCustomizationItemProvider } from '../../browser/launchDarklyCustomizationItemProvider.js';

function stubService(resolved: ILaunchDarklyResolvedFirmConfig | undefined): ILaunchDarklyService {
	return {
		onDidChangeConfiguration: Event.None,
		async resolveActiveFirmAgentConfig() { return resolved; },
	} as unknown as ILaunchDarklyService;
}

suite('LaunchDarklyCustomizationItemProvider', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('returns no items when there is no active firm config', async () => {
		const provider = new LaunchDarklyCustomizationItemProvider(stubService(undefined), new NullLogService());
		const items = await provider.provideChatSessionCustomizations(URI.parse('session:/1'), CancellationToken.None);
		assert.strictEqual(items.length, 0);
		provider.dispose();
	});

	test('maps only enabled AI configs and flags into customization items', async () => {
		const resolved: ILaunchDarklyResolvedFirmConfig = {
			firmKey: 'firm-a',
			aiConfigs: [
				{ configKey: 'ai-on', configName: 'AI On', variationName: 'V1', reason: 'fallthrough', enabled: true },
				{ configKey: 'ai-off', configName: 'AI Off', reason: 'off', enabled: false },
			],
			flags: [
				{ configKey: 'flag-on', configName: 'Flag On', reason: 'explicitTarget', enabled: true },
				{ configKey: 'flag-off', configName: 'Flag Off', reason: 'off', enabled: false },
			],
		};
		const provider = new LaunchDarklyCustomizationItemProvider(stubService(resolved), new NullLogService());
		const items = await provider.provideChatSessionCustomizations(URI.parse('session:/1'), CancellationToken.None);

		assert.strictEqual(items.length, 2, 'only enabled entries should be surfaced');

		const ai = items.find(i => i.name === 'AI On')!;
		assert.strictEqual(ai.type, PromptsType.instructions);
		assert.strictEqual(ai.source, AICustomizationSources.plugin);
		assert.strictEqual(ai.badge, 'LaunchDarkly');
		assert.ok(ai.description?.includes('V1'));

		const flag = items.find(i => i.name === 'Flag On')!;
		assert.strictEqual(flag.badge, 'Flag');
		assert.strictEqual(flag.source, AICustomizationSources.plugin);

		provider.dispose();
	});
});
