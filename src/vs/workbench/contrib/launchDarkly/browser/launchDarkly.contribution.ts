/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, MenuId, MenuRegistry, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../browser/editor.js';
import { ViewPaneContainer } from '../../../browser/parts/views/viewPaneContainer.js';
import { EditorExtensions, IEditorFactoryRegistry, IEditorSerializer } from '../../../common/editor.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { Extensions as ViewContainerExtensions, IViewContainersRegistry, IViewsRegistry, ViewContainerLocation } from '../../../common/views.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import {
	DEFAULT_FIRM_CONTEXT_KIND,
	DEFAULT_LAUNCHDARKLY_BASE_URL,
	ILaunchDarklyService,
	LaunchDarklyConfig,
} from '../common/launchDarklyService.js';
import { CONTEXT_LAUNCHDARKLY_CONFIGURED, CONTEXT_LAUNCHDARKLY_EDITOR, CONTEXT_LAUNCHDARKLY_SECTION, LaunchDarklyCommands, LaunchDarklySection, LAUNCHDARKLY_MANAGEMENT_EDITOR_ID, LAUNCHDARKLY_MANAGEMENT_EDITOR_INPUT_ID } from './launchDarklyManagement.js';
import { LaunchDarklyManagementEditor } from './launchDarklyManagementEditor.js';
import { LaunchDarklyManagementEditorInput } from './launchDarklyManagementEditorInput.js';
import { LaunchDarklyViewPane } from './launchDarklyViewPane.js';

// Register the service singleton (side-effect import).
import './launchDarklyService.js';
// Register the opt-in agent-customization harness integration (side-effect import).
import './launchDarklyAgentIntegration.contribution.js';

const LAUNCHDARKLY_CATEGORY = localize2('launchDarkly.category', "LaunchDarkly");

//#region Editor registration

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(
		LaunchDarklyManagementEditor,
		LAUNCHDARKLY_MANAGEMENT_EDITOR_ID,
		localize('launchDarklyManagementEditor', "LaunchDarkly Management")
	),
	[
		new SyncDescriptor(LaunchDarklyManagementEditorInput as unknown as { new(): LaunchDarklyManagementEditorInput })
	]
);

class LaunchDarklyManagementEditorInputSerializer implements IEditorSerializer {
	canSerialize(editorInput: EditorInput): boolean {
		return editorInput instanceof LaunchDarklyManagementEditorInput;
	}
	serialize(_input: LaunchDarklyManagementEditorInput): string {
		return '';
	}
	deserialize(_instantiationService: IInstantiationService): LaunchDarklyManagementEditorInput {
		return LaunchDarklyManagementEditorInput.getOrCreate();
	}
}

Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).registerEditorSerializer(
	LAUNCHDARKLY_MANAGEMENT_EDITOR_INPUT_ID,
	LaunchDarklyManagementEditorInputSerializer
);

//#endregion

//#region Activity Bar view container + view

const LAUNCHDARKLY_VIEW_CONTAINER_ID = 'workbench.view.launchDarkly';

const launchDarklyViewIcon = registerIcon('launchdarkly-view-icon', Codicon.beaker, localize('launchDarklyViewIcon', "Icon for the LaunchDarkly activity bar view."));

const launchDarklyViewContainer = Registry.as<IViewContainersRegistry>(ViewContainerExtensions.ViewContainersRegistry).registerViewContainer({
	id: LAUNCHDARKLY_VIEW_CONTAINER_ID,
	title: LAUNCHDARKLY_CATEGORY,
	icon: launchDarklyViewIcon,
	ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [LAUNCHDARKLY_VIEW_CONTAINER_ID, { mergeViewWithContainerWhenSingleView: true }]),
	order: 7,
	hideIfEmpty: false,
	openCommandActionDescriptor: {
		id: LAUNCHDARKLY_VIEW_CONTAINER_ID,
		mnemonicTitle: localize({ key: 'miViewLaunchDarkly', comment: ['&& denotes a mnemonic'] }, "&&LaunchDarkly"),
		order: 7,
	},
}, ViewContainerLocation.Sidebar);

Registry.as<IViewsRegistry>(ViewContainerExtensions.ViewsRegistry).registerViews([{
	id: LaunchDarklyViewPane.ID,
	name: LAUNCHDARKLY_CATEGORY,
	ctorDescriptor: new SyncDescriptor(LaunchDarklyViewPane),
	containerIcon: launchDarklyViewIcon,
	canToggleVisibility: false,
	canMoveView: true,
	order: 0,
}], launchDarklyViewContainer);

//#endregion

//#region Configuration

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'launchdarkly',
	order: 200,
	type: 'object',
	title: localize('launchDarkly.configTitle', "LaunchDarkly"),
	properties: {
		[LaunchDarklyConfig.baseUrl]: {
			type: 'string',
			default: DEFAULT_LAUNCHDARKLY_BASE_URL,
			scope: ConfigurationScope.APPLICATION,
			markdownDescription: localize('launchDarkly.baseUrl', "Base origin for the LaunchDarkly REST API and app deep links (e.g. `https://app.launchdarkly.com`, or a Federal/dedicated instance)."),
		},
		[LaunchDarklyConfig.projectKey]: {
			type: 'string',
			default: '',
			scope: ConfigurationScope.APPLICATION,
			markdownDescription: localize('launchDarkly.projectKey', "The LaunchDarkly project key to manage."),
		},
		[LaunchDarklyConfig.environmentKey]: {
			type: 'string',
			default: '',
			scope: ConfigurationScope.APPLICATION,
			markdownDescription: localize('launchDarkly.environmentKey', "The LaunchDarkly environment key used to read targeting and resolve firm assignments."),
		},
		[LaunchDarklyConfig.firmSource]: {
			type: 'string',
			enum: ['contextKind', 'segment'],
			enumDescriptions: [
				localize('launchDarkly.firmSource.contextKind', "Firms are modeled as LaunchDarkly contexts of a specific context kind."),
				localize('launchDarkly.firmSource.segment', "Firms are modeled as LaunchDarkly segments."),
			],
			default: 'contextKind',
			scope: ConfigurationScope.APPLICATION,
			markdownDescription: localize('launchDarkly.firmSourceDesc', "How firms are enumerated in the LaunchDarkly management editor."),
		},
		[LaunchDarklyConfig.firmContextKind]: {
			type: 'string',
			default: DEFAULT_FIRM_CONTEXT_KIND,
			scope: ConfigurationScope.APPLICATION,
			markdownDescription: localize('launchDarkly.firmContextKind', "The context kind that represents a firm when `#launchdarkly.firmSource#` is `contextKind`."),
		},
		[LaunchDarklyConfig.activeFirmKey]: {
			type: 'string',
			default: '',
			scope: ConfigurationScope.APPLICATION,
			markdownDescription: localize('launchDarkly.activeFirmKey', "The firm key the local agent belongs to. Used to resolve which AI Configs and feature-flag-gated customizations load for this firm."),
		},
		[LaunchDarklyConfig.contributeAgentCustomizations]: {
			type: 'boolean',
			default: false,
			scope: ConfigurationScope.APPLICATION,
			markdownDescription: localize('launchDarkly.contributeAgentCustomizations', "When enabled, the active firm's LaunchDarkly AI Configs and flag-gated customizations are surfaced in the AI Customization editor (as a \"LaunchDarkly (Firm)\" harness). Requires `#launchdarkly.activeFirmKey#` and a configured connection."),
		},
	}
});

//#endregion

//#region Commands

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: LaunchDarklyCommands.OpenEditor,
			title: localize2('launchDarkly.open', "Open LaunchDarkly Management"),
			category: LAUNCHDARKLY_CATEGORY,
			f1: true,
		});
	}
	async run(accessor: ServicesAccessor, section?: LaunchDarklySection): Promise<void> {
		const editorService = accessor.get(IEditorService);
		const pane = await editorService.openEditor(LaunchDarklyManagementEditorInput.getOrCreate(), { pinned: true });
		if (section && pane instanceof LaunchDarklyManagementEditor) {
			pane.selectSectionById(section);
		}
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: LaunchDarklyCommands.OpenFirmVariants,
			title: localize2('launchDarkly.openFirmVariants', "Show Firm Variants"),
			category: LAUNCHDARKLY_CATEGORY,
			f1: true,
		});
	}
	async run(accessor: ServicesAccessor, firmKey?: string): Promise<void> {
		const editorService = accessor.get(IEditorService);
		// Resolved before any await — the accessor is only valid synchronously.
		const launchDarklyService = accessor.get(ILaunchDarklyService);
		const pane = await editorService.openEditor(LaunchDarklyManagementEditorInput.getOrCreate(), { pinned: true });
		if (!(pane instanceof LaunchDarklyManagementEditor)) {
			return;
		}
		if (firmKey) {
			const firms = await launchDarklyService.listFirms(CancellationToken.None);
			const firm = firms.find(f => f.key === firmKey);
			if (firm) {
				pane.setSelectedFirm(firm);
			}
		}
		pane.selectSectionById(LaunchDarklySection.FirmVariants);
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: LaunchDarklyCommands.ChangeFirm,
			title: localize2('launchDarkly.changeFirm', "Change Firm"),
			category: LAUNCHDARKLY_CATEGORY,
			f1: true,
			precondition: CONTEXT_LAUNCHDARKLY_CONFIGURED,
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const editorService = accessor.get(IEditorService);
		const pane = await editorService.openEditor(LaunchDarklyManagementEditorInput.getOrCreate(), { pinned: true });
		if (pane instanceof LaunchDarklyManagementEditor) {
			await pane.pickFirm();
		}
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: LaunchDarklyCommands.FocusVariantFilter,
			title: localize2('launchDarkly.focusVariantFilter', "Focus Variant Filter"),
			category: LAUNCHDARKLY_CATEGORY,
			f1: false,
			keybinding: {
				weight: KeybindingWeight.WorkbenchContrib,
				primary: KeyMod.CtrlCmd | KeyCode.KeyF,
				when: ContextKeyExpr.and(
					CONTEXT_LAUNCHDARKLY_EDITOR,
					CONTEXT_LAUNCHDARKLY_SECTION.isEqualTo(LaunchDarklySection.FirmVariants),
				),
			},
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const pane = accessor.get(IEditorService).activeEditorPane;
		if (pane instanceof LaunchDarklyManagementEditor) {
			pane.focusVariantFilter();
		}
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: LaunchDarklyCommands.Refresh,
			title: localize2('launchDarkly.refresh', "Refresh"),
			category: LAUNCHDARKLY_CATEGORY,
			icon: Codicon.refresh,
			f1: true,
			menu: {
				id: MenuId.ViewTitle,
				when: ContextKeyExpr.equals('view', LaunchDarklyViewPane.ID),
				group: 'navigation',
			},
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		accessor.get(ILaunchDarklyService).invalidateCache();
		accessor.get(IViewsService).getViewWithId<LaunchDarklyViewPane>(LaunchDarklyViewPane.ID)?.refresh();
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: LaunchDarklyCommands.SetAccessToken,
			title: localize2('launchDarkly.setAccessToken', "Set Access Token"),
			category: LAUNCHDARKLY_CATEGORY,
			f1: true,
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const quickInputService = accessor.get(IQuickInputService);
		const launchDarklyService = accessor.get(ILaunchDarklyService);
		const notificationService = accessor.get(INotificationService);
		const token = await quickInputService.input({
			password: true,
			ignoreFocusLost: true,
			prompt: localize('launchDarkly.tokenPrompt', "Paste a LaunchDarkly API access token. It is stored in the OS secret store."),
			placeHolder: localize('launchDarkly.tokenPlaceholder', "api-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"),
		});
		if (token === undefined) {
			return;
		}
		await launchDarklyService.setAccessToken(token.trim() || undefined);
		notificationService.info(token.trim()
			? localize('launchDarkly.tokenStored', "LaunchDarkly access token stored.")
			: localize('launchDarkly.tokenCleared', "LaunchDarkly access token cleared."));
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: LaunchDarklyCommands.ClearAccessToken,
			title: localize2('launchDarkly.clearAccessToken', "Clear Access Token"),
			category: LAUNCHDARKLY_CATEGORY,
			f1: true,
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const launchDarklyService = accessor.get(ILaunchDarklyService);
		const notificationService = accessor.get(INotificationService);
		await launchDarklyService.setAccessToken(undefined);
		notificationService.info(localize('launchDarkly.tokenCleared', "LaunchDarkly access token cleared."));
	}
});

MenuRegistry.appendMenuItem(MenuId.CommandPalette, {
	command: {
		id: LaunchDarklyCommands.OpenEditor,
		title: localize2('launchDarkly.open', "Open LaunchDarkly Management"),
		category: LAUNCHDARKLY_CATEGORY,
	},
});

MenuRegistry.appendMenuItem(MenuId.CommandPalette, {
	command: {
		id: LaunchDarklyCommands.OpenFirmVariants,
		title: localize2('launchDarkly.openFirmVariants', "Show Firm Variants"),
		category: LAUNCHDARKLY_CATEGORY,
	},
});

//#endregion
