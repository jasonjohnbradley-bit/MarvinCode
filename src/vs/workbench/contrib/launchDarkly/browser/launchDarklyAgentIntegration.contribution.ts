/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { AICustomizationSources } from '../../chat/common/aiCustomizationWorkspaceService.js';
import { ICustomizationHarnessService, IHarnessDescriptor } from '../../chat/common/customizationHarnessService.js';
import { ILaunchDarklyService, LaunchDarklyConfig } from '../common/launchDarklyService.js';
import { LaunchDarklyCustomizationItemProvider } from './launchDarklyCustomizationItemProvider.js';

const LAUNCHDARKLY_FIRM_HARNESS_ID = 'launchdarkly-firm';

/**
 * Contributes the active firm's LaunchDarkly configs into the AI Customization
 * system by registering an opt-in harness whose item provider surfaces the
 * firm's AI Configs and flag-gated customizations. Registration is gated by
 * `launchdarkly.contributeAgentCustomizations` and only active while the
 * service is configured, so it is inert by default.
 */
export class LaunchDarklyAgentIntegrationContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.launchDarklyAgentIntegration';

	private readonly harnessRegistration = this._register(new MutableDisposable<DisposableStore>());

	constructor(
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ILaunchDarklyService private readonly launchDarklyService: ILaunchDarklyService,
		@ICustomizationHarnessService private readonly harnessService: ICustomizationHarnessService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) {
		super();
		this._register(this.launchDarklyService.onDidChangeConfiguration(() => this.update()));
		this.update();
	}

	private async update(): Promise<void> {
		const enabled = this.configurationService.getValue(LaunchDarklyConfig.contributeAgentCustomizations) === true;
		const configured = enabled ? await this.launchDarklyService.isConfigured() : false;
		if (enabled && configured) {
			if (!this.harnessRegistration.value) {
				this.registerHarness();
			}
		} else {
			this.harnessRegistration.clear();
		}
	}

	private registerHarness(): void {
		const store = new DisposableStore();
		const itemProvider = store.add(this.instantiationService.createInstance(LaunchDarklyCustomizationItemProvider));
		const descriptor: IHarnessDescriptor = {
			id: LAUNCHDARKLY_FIRM_HARNESS_ID,
			label: localize('ld.harnessLabel', "LaunchDarkly (Firm)"),
			icon: Codicon.beaker,
			getStorageSourceFilter: () => ({ sources: AICustomizationSources.all }),
			itemProvider,
		};
		store.add(this.harnessService.registerExternalHarness(descriptor));
		this.harnessRegistration.value = store;
	}
}

registerWorkbenchContribution2(
	LaunchDarklyAgentIntegrationContribution.ID,
	LaunchDarklyAgentIntegrationContribution,
	WorkbenchPhase.AfterRestored
);
