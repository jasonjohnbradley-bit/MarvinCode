/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { AICustomizationSources } from '../../chat/common/aiCustomizationWorkspaceService.js';
import { ICustomizationItem, ICustomizationItemProvider } from '../../chat/common/customizationHarnessService.js';
import { PromptsType } from '../../chat/common/promptSyntax/promptTypes.js';
import { ILaunchDarklyService } from '../common/launchDarklyService.js';

/**
 * Surfaces the active firm's LaunchDarkly AI Configs and flag-gated
 * customizations as read-only agent customization items, so they appear
 * alongside local/plugin customizations in the AI Customization UI.
 *
 * The active firm is taken from `launchdarkly.activeFirmKey`.
 */
export class LaunchDarklyCustomizationItemProvider extends Disposable implements ICustomizationItemProvider {

	readonly onDidChange: Event<void>;

	constructor(
		@ILaunchDarklyService private readonly launchDarklyService: ILaunchDarklyService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this.onDidChange = this.launchDarklyService.onDidChangeConfiguration;
	}

	async provideChatSessionCustomizations(_sessionResource: URI, token: CancellationToken): Promise<ICustomizationItem[]> {
		try {
			const resolved = await this.launchDarklyService.resolveActiveFirmAgentConfig(token);
			if (!resolved) {
				return [];
			}
			const firmTooltip = localize('ld.servedToFirm', "Served to firm '{0}'", resolved.firmKey);
			const items: ICustomizationItem[] = [];

			for (const a of resolved.aiConfigs) {
				if (!a.enabled) {
					continue;
				}
				items.push({
					uri: URI.from({ scheme: 'launchdarkly', authority: 'ai-config', path: `/${a.configKey}` }),
					type: PromptsType.instructions,
					name: a.configName,
					description: a.variationName
						? localize('ld.variationDesc', "Variation: {0}", a.variationName)
						: localize('ld.reasonDesc', "Assignment: {0}", a.reason),
					source: AICustomizationSources.plugin,
					extensionId: undefined,
					pluginUri: undefined,
					enabled: true,
					badge: 'LaunchDarkly',
					badgeTooltip: firmTooltip,
				});
			}

			for (const f of resolved.flags) {
				if (!f.enabled) {
					continue;
				}
				items.push({
					uri: URI.from({ scheme: 'launchdarkly', authority: 'flag', path: `/${f.configKey}` }),
					type: PromptsType.instructions,
					name: f.configName,
					description: f.variationName
						? localize('ld.flagVariationDesc', "Flag variation: {0}", f.variationName)
						: localize('ld.flagOnDesc', "Feature flag enabled"),
					source: AICustomizationSources.plugin,
					extensionId: undefined,
					pluginUri: undefined,
					enabled: true,
					badge: 'Flag',
					badgeTooltip: firmTooltip,
				});
			}

			return items;
		} catch (err) {
			this.logService.warn(`[launchDarkly] failed to provide firm customizations: ${err}`);
			return [];
		}
	}
}
