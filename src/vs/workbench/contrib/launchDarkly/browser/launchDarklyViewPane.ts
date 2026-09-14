/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/launchDarkly.css';
import * as DOM from '../../../../base/browser/dom.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IQuickInputService, IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { defaultButtonStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { ViewPane } from '../../../browser/parts/views/viewPane.js';
import { IViewletViewOptions } from '../../../browser/parts/views/viewsViewlet.js';
import { IViewDescriptorService } from '../../../common/views.js';
import { ILaunchDarklyFirm, ILaunchDarklyService, LaunchDarklyConfig } from '../common/launchDarklyService.js';
import { LaunchDarklyCommands } from './launchDarklyManagement.js';

const $ = DOM.$;

interface IFirmQuickPickItem extends IQuickPickItem {
	readonly firmKey: string | undefined;
}

/**
 * Sidebar view (shown from the Activity Bar button) that surfaces the
 * LaunchDarkly connection status, the active firm, and the full firm list
 * without requiring the management editor to be opened. Firms are clickable
 * (opening their variant grid) and load failures are reported inline so an
 * empty list always explains itself.
 */
export class LaunchDarklyViewPane extends ViewPane {

	static readonly ID = 'workbench.view.launchDarkly.home';

	private statusEl: HTMLElement | undefined;
	private activeFirmEl: HTMLElement | undefined;
	private firmsCountEl: HTMLElement | undefined;
	private firmsListEl: HTMLElement | undefined;

	private readonly firmsRenderDisposables = this._register(new DisposableStore());
	private loadCts: CancellationTokenSource | undefined;
	private firms: ReadonlyArray<ILaunchDarklyFirm> = [];

	constructor(
		options: IViewletViewOptions,
		@IThemeService themeService: IThemeService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IOpenerService openerService: IOpenerService,
		@IHoverService hoverService: IHoverService,
		@ICommandService private readonly commandService: ICommandService,
		@IQuickInputService private readonly quickInputService: IQuickInputService,
		@ILaunchDarklyService private readonly launchDarklyService: ILaunchDarklyService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
		this._register({ dispose: () => this.loadCts?.dispose(true) });
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		container.classList.add('launchdarkly-view');
		const wrap = DOM.append(container, $('.launchdarkly-view-body'));

		this.statusEl = DOM.append(wrap, $('.ld-view-status'));

		const activeHeader = DOM.append(wrap, $('.ld-view-subheader'));
		activeHeader.textContent = localize('ld.activeFirm', "Active Firm");
		this.activeFirmEl = DOM.append(wrap, $('.ld-view-active-firm'));
		const changeFirmButton = this._register(new Button(wrap, { ...defaultButtonStyles, secondary: true, title: localize('ld.changeActiveFirmTitle', "Pick the firm whose AI Configs and flag-gated customizations the local agent loads") }));
		changeFirmButton.label = localize('ld.changeActiveFirm', "Change Active Firm…");
		this._register(changeFirmButton.onDidClick(() => this.pickActiveFirm()));

		const firmsHeader = DOM.append(wrap, $('.ld-view-subheader'));
		const firmsTitle = DOM.append(firmsHeader, $('span'));
		firmsTitle.textContent = localize('ld.firms', "Firms");
		this.firmsCountEl = DOM.append(firmsHeader, $('span.ld-view-count'));
		this.firmsListEl = DOM.append(wrap, $('.ld-view-firms'));

		const actionsHeader = DOM.append(wrap, $('.ld-view-subheader'));
		actionsHeader.textContent = localize('ld.actions', "Actions");
		const openButton = this._register(new Button(wrap, { ...defaultButtonStyles, title: localize('ld.openMgmtTitle', "Open the LaunchDarkly management editor") }));
		openButton.label = localize('ld.openMgmt', "Open Management");
		this._register(openButton.onDidClick(() => this.commandService.executeCommand(LaunchDarklyCommands.OpenEditor)));

		const tokenButton = this._register(new Button(wrap, { ...defaultButtonStyles, secondary: true }));
		tokenButton.label = localize('ld.setToken', "Set Access Token");
		this._register(tokenButton.onDidClick(() => this.commandService.executeCommand(LaunchDarklyCommands.SetAccessToken)));

		const configureButton = this._register(new Button(wrap, { ...defaultButtonStyles, secondary: true }));
		configureButton.label = localize('ld.configure', "Configure");
		this._register(configureButton.onDidClick(() => this.commandService.executeCommand('workbench.action.openSettings', 'launchdarkly')));

		this._register(this.launchDarklyService.onDidChangeConfiguration(() => this.refresh()));
		this.refresh();
	}

	/** Re-reads the connection status and reloads the firm list. */
	refresh(): void {
		this.updateStatus();
		this.loadFirms();
	}

	private async updateStatus(): Promise<void> {
		if (!this.statusEl) {
			return;
		}
		const config = await this.launchDarklyService.getConnectionConfig();
		if (!this.statusEl) {
			return;
		}
		if (!config.hasToken) {
			this.statusEl.textContent = localize('ld.statusNoToken', "Not connected — set an access token to begin.");
		} else if (!config.projectKey) {
			this.statusEl.textContent = localize('ld.statusNoProject', "Connected. Set a project key in settings.");
		} else {
			this.statusEl.textContent = config.environmentKey
				? localize('ld.statusReady', "Project: {0} · Environment: {1}", config.projectKey, config.environmentKey)
				: localize('ld.statusNoEnv', "Project: {0} · No environment set", config.projectKey);
		}
	}

	private async loadFirms(): Promise<void> {
		if (!this.firmsListEl) {
			return;
		}
		this.loadCts?.dispose(true);
		const cts = this.loadCts = new CancellationTokenSource();

		const config = await this.launchDarklyService.getConnectionConfig();
		if (cts.token.isCancellationRequested || !this.firmsListEl) {
			return;
		}
		if (!config.hasToken || !config.projectKey) {
			this.firms = [];
			this.renderMessage(localize('ld.firmsNotConfigured', "Configure a token and project key to list firms."));
			this.updateActiveFirm();
			return;
		}

		this.renderMessage(localize('ld.firmsLoading', "Loading firms…"), true);
		try {
			this.firms = await this.launchDarklyService.listFirms(cts.token);
		} catch (error) {
			if (cts.token.isCancellationRequested || !this.firmsListEl) {
				return;
			}
			this.firms = [];
			this.renderLoadError(error, config.hasToken);
			this.updateActiveFirm();
			return;
		}
		if (cts.token.isCancellationRequested || !this.firmsListEl) {
			return;
		}
		if (this.firms.length === 0) {
			this.renderEmptyExplanation(config.firmSource, config.firmContextKind, config.projectKey, config.environmentKey);
		} else {
			this.renderFirms();
		}
		this.updateActiveFirm();
	}

	private clearFirmsList(loading?: boolean): HTMLElement {
		this.firmsRenderDisposables.clear();
		const list = this.firmsListEl!;
		DOM.clearNode(list);
		if (this.firmsCountEl) {
			this.firmsCountEl.textContent = loading ? '' : String(this.firms.length);
		}
		return list;
	}

	private renderMessage(message: string, loading?: boolean): void {
		const list = this.clearFirmsList(loading);
		const el = DOM.append(list, $('.ld-view-firms-message'));
		el.textContent = message;
	}

	private renderLoadError(error: unknown, hasToken: boolean): void {
		const list = this.clearFirmsList();
		const el = DOM.append(list, $('.ld-view-firms-message.ld-view-firms-error'));
		const statusCode = (error as { statusCode?: number }).statusCode;
		const detail = error instanceof Error ? error.message : String(error);
		if (statusCode === 401 || statusCode === 403) {
			el.textContent = localize('ld.firmsAuthError', "Could not load firms — the access token was rejected ({0}). Check that the token is valid and has reader access to the project. {1}", statusCode, detail);
		} else {
			el.textContent = localize('ld.firmsLoadError', "Could not load firms: {0}", detail);
		}
	}

	private renderEmptyExplanation(firmSource: 'contextKind' | 'segment', firmContextKind: string, projectKey: string | undefined, environmentKey: string | undefined): void {
		const list = this.clearFirmsList();
		const el = DOM.append(list, $('.ld-view-firms-message'));
		const scope = environmentKey ? `${projectKey} / ${environmentKey}` : projectKey ?? '';
		el.textContent = firmSource === 'segment'
			? localize('ld.firmsEmptySegments', "No segments were found in {0}. If firms are modeled as contexts instead, set launchdarkly.firmSource to 'contextKind'.", scope)
			: localize('ld.firmsEmptyContexts', "No contexts of kind '{0}' were found in {1}. Contexts only appear after the SDK has evaluated flags for them. If firms are modeled as segments instead, set launchdarkly.firmSource to 'segment'.", firmContextKind, scope);
	}

	private renderFirms(): void {
		const list = this.clearFirmsList();
		for (const firm of this.firms) {
			const row = DOM.append(list, $('.ld-view-firm-row'));
			row.setAttribute('role', 'button');
			row.tabIndex = 0;
			const name = DOM.append(row, $('span.ld-view-firm-name'));
			name.textContent = firm.name;
			if (firm.key !== firm.name) {
				const key = DOM.append(row, $('span.ld-view-firm-key'));
				key.textContent = firm.key;
			}
			const activeBadge = DOM.append(row, $(`span.ld-view-firm-active-badge${ThemeIcon.asCSSSelector(Codicon.starFull)}`));
			activeBadge.setAttribute('data-firm-key', firm.key);
			this.firmsRenderDisposables.add(this.hoverService.setupDelayedHover(row, {
				content: localize('ld.firmRowHover', "Show which flag variations {0} receives", firm.name),
			}));
			const open = () => this.commandService.executeCommand(LaunchDarklyCommands.OpenFirmVariants, firm.key);
			this.firmsRenderDisposables.add(DOM.addDisposableListener(row, DOM.EventType.CLICK, open));
			this.firmsRenderDisposables.add(DOM.addDisposableListener(row, DOM.EventType.KEY_DOWN, e => {
				if (e.key === 'Enter' || e.key === ' ') {
					e.preventDefault();
					open();
				}
			}));
		}
	}

	private async updateActiveFirm(): Promise<void> {
		if (!this.activeFirmEl) {
			return;
		}
		const activeKey = await this.launchDarklyService.getActiveFirmKey();
		if (!this.activeFirmEl) {
			return;
		}
		if (!activeKey) {
			this.activeFirmEl.textContent = localize('ld.noActiveFirm', "No active firm set.");
		} else {
			const firm = this.firms.find(f => f.key === activeKey);
			this.activeFirmEl.textContent = firm && firm.name !== firm.key ? `${firm.name} (${activeKey})` : activeKey;
		}
		const listEl = this.firmsListEl;
		if (listEl) {
			for (const badge of listEl.querySelectorAll('.ld-view-firm-active-badge')) {
				badge.classList.toggle('active', badge.getAttribute('data-firm-key') === activeKey);
			}
		}
	}

	private async pickActiveFirm(): Promise<void> {
		const activeKey = await this.launchDarklyService.getActiveFirmKey();
		const items: IFirmQuickPickItem[] = this.firms.map(firm => ({
			firmKey: firm.key,
			label: firm.name,
			description: firm.key !== firm.name ? firm.key : undefined,
			iconClass: firm.key === activeKey ? ThemeIcon.asClassName(Codicon.starFull) : undefined,
		}));
		if (activeKey) {
			items.push({ firmKey: undefined, label: localize('ld.clearActiveFirm', "Clear Active Firm"), iconClass: ThemeIcon.asClassName(Codicon.clearAll) });
		}
		if (items.length === 0) {
			return;
		}
		const picked = await this.quickInputService.pick(items, {
			placeHolder: localize('ld.pickActiveFirm', "Select the firm the local agent belongs to"),
		});
		if (picked) {
			await this.configurationService.updateValue(LaunchDarklyConfig.activeFirmKey, picked.firmKey ?? '');
		}
	}
}
