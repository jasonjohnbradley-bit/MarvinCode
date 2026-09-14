/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/launchDarkly.css';
import * as DOM from '../../../../base/browser/dom.js';
import { ActionBar } from '../../../../base/browser/ui/actionbar/actionbar.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { IListRenderer, IListVirtualDelegate } from '../../../../base/browser/ui/list/list.js';
import { Orientation, Sizing, SplitView } from '../../../../base/browser/ui/splitview/splitview.js';
import { Action, IAction } from '../../../../base/common/actions.js';
import { Delayer } from '../../../../base/common/async.js';
import { CancellationToken, CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Event } from '../../../../base/common/event.js';
import { KeyCode } from '../../../../base/common/keyCodes.js';
import { DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKey, IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextViewService } from '../../../../platform/contextview/browser/contextView.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { ContextScopedHistoryInputBox } from '../../../../platform/history/browser/contextScopedHistoryWidget.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { WorkbenchList } from '../../../../platform/list/browser/listService.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { defaultButtonStyles, defaultInputBoxStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { asCssVariable } from '../../../../platform/theme/common/colorUtils.js';
import { badgeBackground, badgeForeground } from '../../../../platform/theme/common/colors/miscColors.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { IEditorOpenContext } from '../../../common/editor.js';
import { IEditorGroup } from '../../../services/editor/common/editorGroupsService.js';
import {
	ILaunchDarklyAIConfig,
	ILaunchDarklyConnectionConfig,
	ILaunchDarklyFeatureFlag,
	ILaunchDarklyFirm,
	ILaunchDarklyFirmAssignment,
	ILaunchDarklyService,
	LaunchDarklyConfig,
} from '../common/launchDarklyService.js';
import { LaunchDarklyFirmVariantsGrid } from './launchDarklyFirmVariants.js';
import {
	CONTEXT_LAUNCHDARKLY_CONFIGURED,
	CONTEXT_LAUNCHDARKLY_EDITOR,
	CONTEXT_LAUNCHDARKLY_FIRM,
	CONTEXT_LAUNCHDARKLY_SECTION,
	CONTEXT_LAUNCHDARKLY_VARIANT_FILTER_FOCUSED,
	CONTEXT_LAUNCHDARKLY_VARIANTS_AUTHORITATIVE,
	CONTENT_MIN_WIDTH,
	LAUNCHDARKLY_MANAGEMENT_EDITOR_ID,
	LAUNCHDARKLY_SECTIONS,
	LAUNCHDARKLY_SELECTED_FIRM_KEY,
	LAUNCHDARKLY_SELECTED_SECTION_KEY,
	LAUNCHDARKLY_SIDEBAR_WIDTH_KEY,
	LAUNCHDARKLY_VARIANT_FILTER_HISTORY_KEY,
	LaunchDarklyCommands,
	LaunchDarklySection,
	SIDEBAR_DEFAULT_WIDTH,
	SIDEBAR_MAX_WIDTH,
	SIDEBAR_MIN_WIDTH,
} from './launchDarklyManagement.js';
import { LaunchDarklyManagementEditorInput } from './launchDarklyManagementEditorInput.js';

const $ = DOM.$;

const SECTION_HEIGHT = 30;
const ROW_HEIGHT = 44;

interface ISectionItem {
	readonly id: LaunchDarklySection;
	readonly label: string;
	readonly icon: ThemeIcon;
}

type RowKind = 'firm' | 'aiConfig' | 'flag' | 'environment' | 'assignment' | 'message';

interface IRow {
	readonly kind: RowKind;
	readonly id: string;
	readonly label: string;
	readonly description?: string;
	/** Right-aligned status/badge text (e.g. "On"/"Off", assignment reason). */
	readonly status?: string;
	readonly icon: ThemeIcon;
	readonly firm?: ILaunchDarklyFirm;
	readonly flag?: ILaunchDarklyFeatureFlag;
	readonly aiConfig?: ILaunchDarklyAIConfig;
	readonly assignment?: ILaunchDarklyFirmAssignment;
}

/** Handlers passed to the row renderer for inline actions. */
interface IRowActionHandler {
	toggleFlag(row: IRow): void;
	openInLaunchDarkly(row: IRow): void;
	deleteAIConfig(row: IRow): void;
}

//#region Section list

class SectionDelegate implements IListVirtualDelegate<ISectionItem> {
	getHeight(): number { return SECTION_HEIGHT; }
	getTemplateId(): string { return 'ldSection'; }
}

interface ISectionTemplate {
	readonly container: HTMLElement;
	readonly icon: HTMLElement;
	readonly label: HTMLElement;
}

class SectionRenderer implements IListRenderer<ISectionItem, ISectionTemplate> {
	readonly templateId = 'ldSection';
	renderTemplate(container: HTMLElement): ISectionTemplate {
		container.classList.add('launchdarkly-section-item');
		const icon = DOM.append(container, $('.section-icon'));
		const label = DOM.append(container, $('.section-label'));
		return { container, icon, label };
	}
	renderElement(element: ISectionItem, _index: number, data: ISectionTemplate): void {
		data.icon.className = 'section-icon';
		data.icon.classList.add(...ThemeIcon.asClassNameArray(element.icon));
		data.label.textContent = element.label;
	}
	disposeTemplate(): void { }
}

//#endregion

//#region Row list

class RowDelegate implements IListVirtualDelegate<IRow> {
	getHeight(): number { return ROW_HEIGHT; }
	getTemplateId(): string { return 'ldRow'; }
}

interface IRowTemplate {
	readonly container: HTMLElement;
	readonly icon: HTMLElement;
	readonly label: HTMLElement;
	readonly description: HTMLElement;
	readonly status: HTMLElement;
	readonly actionBar: ActionBar;
	readonly disposables: DisposableStore;
}

class RowRenderer implements IListRenderer<IRow, IRowTemplate> {
	readonly templateId = 'ldRow';

	constructor(private readonly handlers: IRowActionHandler) { }

	renderTemplate(container: HTMLElement): IRowTemplate {
		const disposables = new DisposableStore();
		container.classList.add('launchdarkly-row');
		const icon = DOM.append(container, $('.row-icon'));
		const text = DOM.append(container, $('.row-text'));
		const label = DOM.append(text, $('.row-label'));
		const description = DOM.append(text, $('.row-description'));
		const status = DOM.append(container, $('.row-status'));
		const actionsContainer = DOM.append(container, $('.row-actions'));
		const actionBar = disposables.add(new ActionBar(actionsContainer));
		return { container, icon, label, description, status, actionBar, disposables };
	}

	renderElement(element: IRow, _index: number, data: IRowTemplate): void {
		data.icon.className = 'row-icon';
		data.icon.classList.add(...ThemeIcon.asClassNameArray(element.icon));
		data.label.textContent = element.label;
		data.description.textContent = element.description ?? '';
		data.description.style.display = element.description ? '' : 'none';
		data.status.textContent = element.status ?? '';
		data.status.style.display = element.status ? '' : 'none';
		data.status.className = 'row-status' + (element.flag ? (element.flag.environments && Object.values(element.flag.environments).some(e => e.on) ? ' on' : ' off') : '');

		data.actionBar.clear();
		const actions = this.buildActions(element);
		data.actionBar.push(actions, { icon: true, label: false });
	}

	private buildActions(row: IRow): IAction[] {
		const actions: IAction[] = [];
		if (row.kind === 'flag') {
			const anyOn = !!row.flag && Object.values(row.flag.environments).some(e => e.on);
			actions.push(new Action('ld.toggle', anyOn ? localize('ld.turnOff', "Turn Off") : localize('ld.turnOn', "Turn On"),
				ThemeIcon.asClassName(anyOn ? Codicon.circleFilled : Codicon.circle), true, async () => this.handlers.toggleFlag(row)));
		}
		if (row.kind === 'aiConfig') {
			actions.push(new Action('ld.delete', localize('ld.delete', "Delete"), ThemeIcon.asClassName(Codicon.trash), true, async () => this.handlers.deleteAIConfig(row)));
		}
		if (row.kind === 'flag' || row.kind === 'aiConfig' || row.kind === 'firm' || row.kind === 'environment') {
			actions.push(new Action('ld.open', localize('ld.openExternal', "Open in LaunchDarkly"), ThemeIcon.asClassName(Codicon.linkExternal), true, async () => this.handlers.openInLaunchDarkly(row)));
		}
		return actions;
	}

	disposeElement(_element: IRow, _index: number, data: IRowTemplate): void {
		data.actionBar.clear();
	}

	disposeTemplate(data: IRowTemplate): void {
		data.disposables.dispose();
	}
}

//#endregion

export class LaunchDarklyManagementEditor extends EditorPane implements IRowActionHandler {

	static readonly ID = LAUNCHDARKLY_MANAGEMENT_EDITOR_ID;

	private container!: HTMLElement;
	private splitViewContainer!: HTMLElement;
	private splitView!: SplitView<number>;
	private sidebarContainer!: HTMLElement;
	private sectionsList!: WorkbenchList<ISectionItem>;
	private contentContainer!: HTMLElement;
	private headerContainer!: HTMLElement;
	private headerTitle!: HTMLElement;
	private headerToolbar!: ActionBar;
	private noticeContainer!: HTMLElement;
	private listContainer!: HTMLElement;
	private list!: WorkbenchList<IRow>;
	private variantsContainer!: HTMLElement;
	private variantsFirmBar!: HTMLElement;
	private variantsFilterBar!: HTMLElement;
	private variantsCount!: HTMLElement;
	private variantsGrid!: LaunchDarklyFirmVariantsGrid;
	private variantsFilterInput!: ContextScopedHistoryInputBox;

	private dimension: DOM.Dimension | undefined;
	private selectedSection: LaunchDarklySection = LaunchDarklySection.FirmVariants;
	private mode: 'list' | 'firmDetail' = 'list';
	private detailFirm: ILaunchDarklyFirm | undefined;
	/** The firm whose variants the grid shows; outlives section changes. */
	private selectedFirm: ILaunchDarklyFirm | undefined;

	private loadCts: CancellationTokenSource | undefined;
	private connectionConfig: ILaunchDarklyConnectionConfig | undefined;

	private readonly editorDisposables = this._register(new DisposableStore());
	private readonly inEditorContextKey: IContextKey<boolean>;
	private readonly sectionContextKey: IContextKey<string>;
	private readonly configuredContextKey: IContextKey<boolean>;
	private readonly firmContextKey: IContextKey<string>;
	private readonly variantsAuthoritativeContextKey: IContextKey<boolean>;
	private readonly variantFilterFocusedContextKey: IContextKey<boolean>;

	private readonly sections: ISectionItem[] = [
		{ id: LaunchDarklySection.Firms, label: localize('ld.firms', "Firms"), icon: Codicon.organization },
		{ id: LaunchDarklySection.FirmVariants, label: localize('ld.firmVariants', "Firm Variants"), icon: Codicon.table },
		{ id: LaunchDarklySection.AIConfigs, label: localize('ld.aiConfigs', "AI Configs"), icon: Codicon.sparkle },
		{ id: LaunchDarklySection.Flags, label: localize('ld.flags', "Feature Flags"), icon: Codicon.flag },
		{ id: LaunchDarklySection.Environments, label: localize('ld.environments', "Environments"), icon: Codicon.globe },
	];

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService private readonly storageService: IStorageService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@ILaunchDarklyService private readonly launchDarklyService: ILaunchDarklyService,
		@INotificationService private readonly notificationService: INotificationService,
		@IOpenerService private readonly openerService: IOpenerService,
		@IQuickInputService private readonly quickInputService: IQuickInputService,
		@IDialogService private readonly dialogService: IDialogService,
		@ICommandService private readonly commandService: ICommandService,
		@IClipboardService private readonly clipboardService: IClipboardService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IContextViewService private readonly contextViewService: IContextViewService,
	) {
		super(LaunchDarklyManagementEditor.ID, group, telemetryService, themeService, storageService);
		this.inEditorContextKey = CONTEXT_LAUNCHDARKLY_EDITOR.bindTo(contextKeyService);
		this.sectionContextKey = CONTEXT_LAUNCHDARKLY_SECTION.bindTo(contextKeyService);
		this.configuredContextKey = CONTEXT_LAUNCHDARKLY_CONFIGURED.bindTo(contextKeyService);
		this.firmContextKey = CONTEXT_LAUNCHDARKLY_FIRM.bindTo(contextKeyService);
		this.variantsAuthoritativeContextKey = CONTEXT_LAUNCHDARKLY_VARIANTS_AUTHORITATIVE.bindTo(contextKeyService);
		this.variantFilterFocusedContextKey = CONTEXT_LAUNCHDARKLY_VARIANT_FILTER_FOCUSED.bindTo(contextKeyService);

		const saved = this.storageService.get(LAUNCHDARKLY_SELECTED_SECTION_KEY, StorageScope.PROFILE);
		if (saved && LAUNCHDARKLY_SECTIONS.includes(saved as LaunchDarklySection)) {
			this.selectedSection = saved as LaunchDarklySection;
		}

		this._register(this.launchDarklyService.onDidChangeConfiguration(() => this.refresh()));
	}

	protected override createEditor(parent: HTMLElement): void {
		this.editorDisposables.clear();
		this.container = DOM.append(parent, $('.launchdarkly-management-editor'));
		this.createSplitView();
	}

	private createSplitView(): void {
		this.splitViewContainer = DOM.append(this.container, $('.management-split-view'));
		this.sidebarContainer = $('.management-sidebar');
		this.contentContainer = $('.management-content');

		this.createSidebar();
		this.createContent();

		this.splitView = this.editorDisposables.add(new SplitView(this.splitViewContainer, {
			orientation: Orientation.HORIZONTAL,
			proportionalLayout: true,
		}));

		const savedWidth = this.storageService.getNumber(LAUNCHDARKLY_SIDEBAR_WIDTH_KEY, StorageScope.PROFILE, SIDEBAR_DEFAULT_WIDTH);

		this.splitView.addView({
			onDidChange: Event.None,
			element: this.sidebarContainer,
			minimumSize: SIDEBAR_MIN_WIDTH,
			maximumSize: SIDEBAR_MAX_WIDTH,
			layout: (width, _, height) => {
				this.sidebarContainer.style.width = `${width}px`;
				if (height !== undefined) {
					this.sectionsList.layout(Math.max(0, height - 8), width);
				}
			},
		}, savedWidth, undefined, true);

		this.splitView.addView({
			onDidChange: Event.None,
			element: this.contentContainer,
			minimumSize: CONTENT_MIN_WIDTH,
			maximumSize: Number.POSITIVE_INFINITY,
			layout: (width, _, height) => {
				this.contentContainer.style.width = `${width}px`;
				if (height === undefined) {
					return;
				}
				const available = Math.max(0, height - this.headerContainer.offsetHeight);
				if (this.variantsContainer.style.display !== 'none') {
					const chrome = this.variantsFirmBar.offsetHeight + this.variantsFilterBar.offsetHeight;
					this.variantsContainer.style.height = `${available}px`;
					this.variantsGrid.layout(new DOM.Dimension(width - 16, Math.max(0, available - chrome)));
				} else {
					this.listContainer.style.height = `${available}px`;
					this.list.layout(Math.max(0, available - 8), width - 16);
				}
			},
		}, Sizing.Distribute, undefined, true);

		this.editorDisposables.add(this.splitView.onDidSashChange(() => {
			this.storageService.store(LAUNCHDARKLY_SIDEBAR_WIDTH_KEY, this.splitView.getViewSize(0), StorageScope.PROFILE, StorageTarget.USER);
		}));
	}

	private createSidebar(): void {
		const sidebarContent = DOM.append(this.sidebarContainer, $('.sidebar-content'));
		const header = DOM.append(sidebarContent, $('.sidebar-header'));
		header.textContent = localize('ld.title', "LaunchDarkly");
		const listContainer = DOM.append(sidebarContent, $('.sidebar-sections-list'));
		this.sectionsList = this.editorDisposables.add(this.instantiationService.createInstance(
			WorkbenchList<ISectionItem>,
			'LaunchDarklySections',
			listContainer,
			new SectionDelegate(),
			[new SectionRenderer()],
			{
				multipleSelectionSupport: false,
				horizontalScrolling: false,
				openOnSingleClick: true,
				identityProvider: { getId: (item: ISectionItem) => item.id },
				accessibilityProvider: {
					getWidgetAriaLabel: () => localize('ld.sections', "LaunchDarkly Sections"),
					getAriaLabel: (item: ISectionItem) => item.label,
				},
			}
		) as WorkbenchList<ISectionItem>);
		this.sectionsList.splice(0, 0, this.sections);
		this.editorDisposables.add(this.sectionsList.onDidOpen(e => {
			if (e.element) {
				this.selectSection(e.element.id);
			}
		}));
	}

	private createContent(): void {
		const inner = DOM.append(this.contentContainer, $('.content-inner'));
		this.headerContainer = DOM.append(inner, $('.content-header'));
		this.headerTitle = DOM.append(this.headerContainer, $('.content-title'));
		const toolbarContainer = DOM.append(this.headerContainer, $('.content-toolbar'));
		this.headerToolbar = this.editorDisposables.add(new ActionBar(toolbarContainer));

		this.noticeContainer = DOM.append(inner, $('.content-notice'));
		this.noticeContainer.style.display = 'none';

		this.listContainer = DOM.append(inner, $('.content-list'));
		this.list = this.editorDisposables.add(this.instantiationService.createInstance(
			WorkbenchList<IRow>,
			'LaunchDarklyRows',
			this.listContainer,
			new RowDelegate(),
			[new RowRenderer(this)],
			{
				multipleSelectionSupport: false,
				openOnSingleClick: false,
				identityProvider: { getId: (row: IRow) => `${row.kind}:${row.id}` },
				accessibilityProvider: {
					getWidgetAriaLabel: () => localize('ld.items', "LaunchDarkly Items"),
					getAriaLabel: (row: IRow) => row.status ? `${row.label}, ${row.status}` : row.label,
				},
			}
		) as WorkbenchList<IRow>);
		this.editorDisposables.add(this.list.onDidOpen(e => {
			if (e.element) {
				this.onRowOpen(e.element);
			}
		}));

		this.createVariantsGrid(inner);
	}

	/**
	 * The firm variant grid lives beside the row list rather than replacing it:
	 * the other sections are homogeneous single-line lists that a table would
	 * only add chrome to, and keeping both alive preserves filter/scroll state.
	 */
	private createVariantsGrid(inner: HTMLElement): void {
		this.variantsContainer = DOM.append(inner, $('.ld-variants-container'));
		this.variantsContainer.style.display = 'none';

		this.variantsFirmBar = DOM.append(this.variantsContainer, $('.ld-variants-firm-bar'));

		this.variantsFilterBar = DOM.append(this.variantsContainer, $('.ld-variants-filter-bar'));
		const inputContainer = DOM.append(this.variantsFilterBar, $('.ld-variants-filter-input'));
		this.variantsFilterInput = this.editorDisposables.add(this.instantiationService.createInstance(
			ContextScopedHistoryInputBox,
			inputContainer,
			this.contextViewService,
			{
				placeholder: localize('ld.filterPlaceholder', "Filter flags — try @diff, @inferred, @off"),
				ariaLabel: localize('ld.filterAria', "Filter feature flag variants"),
				history: new Set(this.storageService.getObject<string[]>(LAUNCHDARKLY_VARIANT_FILTER_HISTORY_KEY, StorageScope.PROFILE, [])),
				inputBoxStyles: defaultInputBoxStyles,
			},
		));
		const filterDelayer = this.editorDisposables.add(new Delayer<void>(300));
		this.editorDisposables.add(this.variantsFilterInput.onDidChange(() => {
			filterDelayer.trigger(() => {
				this.variantsGrid.setFilter(this.variantsFilterInput.value);
				this.updateVariantsCount();
			});
		}));
		const focusTracker = this.editorDisposables.add(DOM.trackFocus(this.variantsFilterInput.inputElement));
		this.editorDisposables.add(focusTracker.onDidFocus(() => this.variantFilterFocusedContextKey.set(true)));
		this.editorDisposables.add(focusTracker.onDidBlur(() => this.variantFilterFocusedContextKey.set(false)));
		this.editorDisposables.add(toDisposable(() => this.variantFilterFocusedContextKey.reset()));
		// Down-arrow moves from the filter into the grid.
		this.editorDisposables.add(DOM.addStandardDisposableListener(this.variantsFilterInput.inputElement, DOM.EventType.KEY_DOWN, e => {
			if (e.keyCode === KeyCode.DownArrow) {
				e.preventDefault();
				this.variantsGrid.focus();
			}
		}));

		const filterActions = DOM.append(this.variantsFilterBar, $('.ld-variants-filter-actions'));
		this.variantsCount = DOM.append(filterActions, $('.ld-variants-count'));
		this.variantsCount.setAttribute('aria-live', 'polite');
		this.variantsCount.style.backgroundColor = asCssVariable(badgeBackground);
		this.variantsCount.style.color = asCssVariable(badgeForeground);
		const filterToolbar = this.editorDisposables.add(new ActionBar(filterActions));
		filterToolbar.push([
			new Action('ld.onlyDiff', localize('ld.onlyDiff', "Only Differences"), ThemeIcon.asClassName(Codicon.filter), true, async () => this.appendFilterToken('@diff')),
			new Action('ld.onlyInferred', localize('ld.onlyInferred', "Only Inferred"), ThemeIcon.asClassName(Codicon.warning), true, async () => this.appendFilterToken('@inferred')),
			new Action('ld.clearFilter', localize('ld.clearFilter', "Clear Filter"), ThemeIcon.asClassName(Codicon.clearAll), true, async () => {
				this.variantsFilterInput.value = '';
				this.variantsGrid.setFilter('');
				this.updateVariantsCount();
			}),
		], { icon: true, label: false });

		this.variantsGrid = this.editorDisposables.add(this.instantiationService.createInstance(LaunchDarklyFirmVariantsGrid, this.variantsContainer));
		this.editorDisposables.add(this.variantsGrid.onDidRequestOpenFlag(flagKey => this.openFlagInLaunchDarkly(flagKey)));
		this.editorDisposables.add(this.variantsGrid.onDidRequestCopyFlagKey(async flagKey => {
			await this.clipboardService.writeText(flagKey);
			this.notificationService.info(localize('ld.flagKeyCopied', "Flag key copied."));
		}));
		this.editorDisposables.add(this.variantsGrid.onDidRequestToggleFlag(({ flagKey, on }) => this.confirmToggleFlag(flagKey, on)));
	}

	/** Toggles a `@token` in the filter box, keeping the free text intact. */
	private appendFilterToken(token: string): void {
		const current = this.variantsFilterInput.value;
		const has = current.split(/\s+/).includes(token);
		this.variantsFilterInput.value = has
			? current.split(/\s+/).filter(part => part !== token).join(' ').trim()
			: `${current} ${token}`.trim();
		this.variantsGrid.setFilter(this.variantsFilterInput.value);
		this.updateVariantsCount();
	}

	private updateVariantsCount(): void {
		const { shown, total } = this.variantsGrid.counts;
		this.variantsCount.textContent = total ? localize('ld.variantCount', "{0} of {1}", shown, total) : '';
	}

	//#region Section navigation

	/** Public entry point used by the Open command / sidebar view to jump to a section. */
	selectSectionById(section: LaunchDarklySection): void {
		this.selectSection(section);
	}

	/** Shows the given firm's variants, remembering it across section changes. */
	setSelectedFirm(firm: ILaunchDarklyFirm): void {
		this.selectedFirm = firm;
		this.firmContextKey.set(firm.key);
		this.storageService.store(LAUNCHDARKLY_SELECTED_FIRM_KEY, firm.key, StorageScope.PROFILE, StorageTarget.USER);
	}

	private selectSection(section: LaunchDarklySection): void {
		this.selectedSection = section;
		this.mode = 'list';
		// The firm survives navigation; only the legacy detail mode is reset.
		this.detailFirm = undefined;
		this.sectionContextKey.set(section);
		this.storageService.store(LAUNCHDARKLY_SELECTED_SECTION_KEY, section, StorageScope.PROFILE, StorageTarget.USER);
		const idx = this.sections.findIndex(s => s.id === section);
		if (idx >= 0) {
			this.sectionsList.setSelection([idx]);
			this.sectionsList.setFocus([idx]);
		}
		this.refresh();
	}

	//#endregion

	//#region Loading

	async refresh(): Promise<void> {
		if (!this.list) {
			return;
		}
		this.loadCts?.cancel();
		this.loadCts = new CancellationTokenSource();
		const token = this.loadCts.token;

		this.connectionConfig = await this.launchDarklyService.getConnectionConfig();
		const configured = await this.launchDarklyService.isConfigured();
		// A newer refresh may have started while the config was resolving; if this
		// flow is stale it must not touch the UI at all, or the two flows
		// interleave and leave the wrong widget visible for the section.
		if (token.isCancellationRequested) {
			return;
		}
		this.configuredContextKey.set(configured);
		this.updateHeader();

		if (!configured) {
			this.showNotConfiguredNotice();
			return;
		}
		this.hideNotice();

		if (this.selectedSection === LaunchDarklySection.FirmVariants) {
			await this.loadFirmVariants(token);
			return;
		}

		this.showWidget('list');
		try {
			const rows = this.mode === 'firmDetail' && this.detailFirm
				? await this.loadFirmDetail(this.detailFirm, token)
				: await this.loadSection(this.selectedSection, token);
			if (token.isCancellationRequested) {
				return;
			}
			this.setRows(rows);
		} catch (err) {
			if (!token.isCancellationRequested) {
				this.showErrorNotice(err);
			}
		}
	}

	/** Shows only one of the row list, the variant grid, or the notice. */
	private showWidget(kind: 'list' | 'variants' | 'notice'): void {
		this.listContainer.style.display = kind === 'list' ? '' : 'none';
		this.variantsContainer.style.display = kind === 'variants' ? '' : 'none';
		this.noticeContainer.style.display = kind === 'notice' ? '' : 'none';
		if (this.dimension) {
			this.layout(this.dimension);
		}
	}

	/**
	 * Resolves which firm to show — the last one opened, else the persisted one,
	 * else the configured active firm — and loads its variants. A firm is never
	 * auto-picked, because silently showing another firm's data is worse than
	 * showing nothing.
	 */
	private async loadFirmVariants(token: CancellationToken): Promise<void> {
		const firm = await this.resolveSelectedFirm(token);
		if (token.isCancellationRequested) {
			return;
		}
		if (!firm) {
			this.showChooseFirmNotice();
			return;
		}

		this.setSelectedFirm(firm);
		this.renderFirmBar(firm);
		this.showWidget('variants');
		this.variantsGrid.setLoading(true);
		try {
			const result = await this.launchDarklyService.getFirmFlagEvaluations(
				firm.key,
				{ contextAttributes: firm.attributes },
				token);
			if (token.isCancellationRequested) {
				return;
			}
			this.variantsAuthoritativeContextKey.set(result.source === 'evaluate');
			this.variantsGrid.setResult(result, firm.name);
			this.updateVariantsCount();
			this.updateHeader();
			if (this.dimension) {
				this.layout(this.dimension);
			}
		} catch (err) {
			if (!token.isCancellationRequested) {
				this.showErrorNotice(err);
			}
		} finally {
			this.variantsGrid.setLoading(false);
		}
	}

	private async resolveSelectedFirm(token: CancellationToken): Promise<ILaunchDarklyFirm | undefined> {
		if (this.selectedFirm) {
			return this.selectedFirm;
		}
		const remembered = this.storageService.get(LAUNCHDARKLY_SELECTED_FIRM_KEY, StorageScope.PROFILE)
			?? await this.launchDarklyService.getActiveFirmKey();
		if (!remembered) {
			return undefined;
		}
		const firms = await this.launchDarklyService.listFirms(token);
		return firms.find(f => f.key === remembered);
	}

	/** Opens a quick pick over the available firms. */
	async pickFirm(): Promise<void> {
		const firms = await this.launchDarklyService.listFirms(CancellationToken.None);
		if (!firms.length) {
			this.notificationService.info(localize('ld.noFirms', "No firms were found in this environment."));
			return;
		}
		const picked = await this.quickInputService.pick(
			firms.map(firm => ({ label: firm.name, description: firm.key, firm })),
			{
				placeHolder: localize('ld.pickFirm', "Select a firm to inspect"),
				matchOnDescription: true,
			});
		if (picked) {
			this.setSelectedFirm(picked.firm);
			this.selectSection(LaunchDarklySection.FirmVariants);
		}
	}

	/** Makes the shown firm the one agents load customizations for. */
	private async setActiveFirm(): Promise<void> {
		if (!this.selectedFirm) {
			return;
		}
		await this.configurationService.updateValue(LaunchDarklyConfig.activeFirmKey, this.selectedFirm.key);
		this.notificationService.info(localize('ld.activeFirmSet', "'{0}' is now the active firm.", this.selectedFirm.name));
	}

	private renderFirmBar(firm: ILaunchDarklyFirm): void {
		DOM.clearNode(this.variantsFirmBar);
		DOM.append(this.variantsFirmBar, $('.ld-firm-label')).textContent = localize('ld.firmLabel', "Firm");
		DOM.append(this.variantsFirmBar, $('.ld-firm-name')).textContent = firm.name;
		DOM.append(this.variantsFirmBar, $('.ld-firm-key')).textContent = firm.key;
		if (this.connectionConfig?.environmentKey) {
			DOM.append(this.variantsFirmBar, $('.ld-firm-env')).textContent = this.connectionConfig.environmentKey;
		}
	}

	private showChooseFirmNotice(): void {
		this.showWidget('notice');
		DOM.clearNode(this.noticeContainer);
		DOM.append(this.noticeContainer, $('.notice-title')).textContent = localize('ld.chooseFirmTitle', "Choose a Firm");
		DOM.append(this.noticeContainer, $('.notice-body')).textContent = this.connectionConfig?.environmentKey
			? localize('ld.chooseFirmBody', "Pick a firm to see which variation it receives for every feature flag in {0}.", this.connectionConfig.environmentKey)
			: localize('ld.chooseFirmBodyNoEnv', "Pick a firm to see which variation it receives for every feature flag.");
		const actions = DOM.append(this.noticeContainer, $('.notice-actions'));
		const chooseButton = this.editorDisposables.add(new Button(actions, defaultButtonStyles));
		chooseButton.label = localize('ld.chooseFirmAction', "Choose Firm…");
		this.editorDisposables.add(chooseButton.onDidClick(() => this.pickFirm()));
	}

	private async loadSection(section: LaunchDarklySection, token: CancellationToken): Promise<IRow[]> {
		switch (section) {
			case LaunchDarklySection.Firms: {
				const firms = await this.launchDarklyService.listFirms(token);
				return firms.map((f): IRow => ({ kind: 'firm', id: f.key, label: f.name, description: f.key, icon: Codicon.organization, firm: f }));
			}
			case LaunchDarklySection.AIConfigs: {
				const configs = await this.launchDarklyService.listAIConfigs(token);
				return configs.map((c): IRow => ({ kind: 'aiConfig', id: c.key, label: c.name, description: c.description ?? `${c.variations.length} variation(s)`, icon: Codicon.sparkle, aiConfig: c }));
			}
			case LaunchDarklySection.Flags: {
				const flags = await this.launchDarklyService.listFeatureFlags(token);
				return flags.map((f): IRow => {
					const env = this.connectionConfig?.environmentKey ? f.environments[this.connectionConfig.environmentKey] : undefined;
					const on = env?.on ?? Object.values(f.environments).some(e => e.on);
					return { kind: 'flag', id: f.key, label: f.name, description: f.key, status: on ? localize('ld.on', "On") : localize('ld.off', "Off"), icon: Codicon.flag, flag: f };
				});
			}
			case LaunchDarklySection.Environments: {
				const projectKey = this.connectionConfig?.projectKey;
				if (!projectKey) {
					return [];
				}
				const envs = await this.launchDarklyService.listEnvironments(projectKey, token);
				return envs.map((e): IRow => ({ kind: 'environment', id: e.key, label: e.name, description: e.key, icon: Codicon.globe }));
			}
			default:
				return [];
		}
	}

	private async loadFirmDetail(firm: ILaunchDarklyFirm, token: CancellationToken): Promise<IRow[]> {
		const [aiAssignments, flagAssignments] = await Promise.all([
			this.launchDarklyService.getFirmAIConfigAssignments(firm.key, token),
			this.launchDarklyService.getFirmFlagAssignments(firm.key, token),
		]);
		const rows: IRow[] = [];
		rows.push({ kind: 'message', id: 'hdr-ai', label: localize('ld.attachedAiConfigs', "Attached AI Configs"), icon: Codicon.sparkle });
		for (const a of aiAssignments) {
			rows.push(this.assignmentRow(a));
		}
		rows.push({ kind: 'message', id: 'hdr-flags', label: localize('ld.gatedCustomizations', "Feature Flags (gated customizations)"), icon: Codicon.flag });
		for (const a of flagAssignments) {
			rows.push(this.assignmentRow(a));
		}
		return rows;
	}

	private assignmentRow(a: ILaunchDarklyFirmAssignment): IRow {
		const reason = a.reason === 'explicitTarget' ? localize('ld.explicit', "Targeted")
			: a.reason === 'fallthrough' ? localize('ld.default', "Default")
				: a.reason === 'off' ? localize('ld.disabled', "Off")
					: localize('ld.rulesUnknown', "Rule-based (verify)");
		const variation = a.variationName ? ` → ${a.variationName}` : '';
		return {
			kind: 'assignment',
			id: a.configKey,
			label: a.configName,
			description: `${a.configKey}${variation}`,
			status: reason,
			icon: a.enabled ? Codicon.pass : Codicon.circleSlash,
			assignment: a,
		};
	}

	private setRows(rows: IRow[]): void {
		this.list.splice(0, this.list.length, rows);
		if (this.dimension) {
			this.layout(this.dimension);
		}
	}

	//#endregion

	//#region Header + notices

	private updateHeader(): void {
		this.headerToolbar.clear();
		if (this.mode === 'firmDetail' && this.detailFirm) {
			this.headerTitle.textContent = localize('ld.firmDetailTitle', "Firm: {0}", this.detailFirm.name);
			this.headerToolbar.push(new Action('ld.back', localize('ld.back', "Back"), ThemeIcon.asClassName(Codicon.arrowLeft), true, async () => {
				this.mode = 'list';
				this.detailFirm = undefined;
				this.refresh();
			}));
		} else if (this.selectedSection === LaunchDarklySection.FirmVariants) {
			this.headerTitle.textContent = this.selectedFirm
				? localize('ld.firmVariantsTitleFor', "Firm Variants: {0}", this.selectedFirm.name)
				: localize('ld.firmVariants', "Firm Variants");
			this.headerToolbar.push(new Action('ld.changeFirm', localize('ld.changeFirm', "Change Firm…"), ThemeIcon.asClassName(Codicon.organization), true, async () => this.pickFirm()));
			if (this.selectedFirm) {
				this.headerToolbar.push(new Action('ld.setActiveFirm', localize('ld.setActiveFirm', "Set as Active Firm"), ThemeIcon.asClassName(Codicon.star), true, async () => this.setActiveFirm()));
			}
		} else {
			const section = this.sections.find(s => s.id === this.selectedSection);
			this.headerTitle.textContent = section?.label ?? localize('ld.title', "LaunchDarkly");
			if (this.selectedSection === LaunchDarklySection.AIConfigs) {
				this.headerToolbar.push(new Action('ld.create', localize('ld.newAiConfig', "New AI Config"), ThemeIcon.asClassName(Codicon.add), true, async () => this.createAIConfig()));
			} else if (this.selectedSection === LaunchDarklySection.Flags) {
				this.headerToolbar.push(new Action('ld.create', localize('ld.newFlag', "New Feature Flag"), ThemeIcon.asClassName(Codicon.add), true, async () => this.createFlag()));
			}
		}
		this.headerToolbar.push(new Action('ld.refresh', localize('ld.refresh', "Refresh"), ThemeIcon.asClassName(Codicon.refresh), true, async () => this.refresh()));
		this.headerToolbar.push(new Action('ld.setToken', localize('ld.setToken', "Set Access Token"), ThemeIcon.asClassName(Codicon.key), true, async () => {
			await this.commandService.executeCommand(LaunchDarklyCommands.SetAccessToken);
		}));
		this.headerToolbar.push(new Action('ld.configure', localize('ld.configure', "Configure"), ThemeIcon.asClassName(Codicon.settingsGear), true, async () => {
			await this.commandService.executeCommand('workbench.action.openSettings', 'launchdarkly');
		}));
	}

	private showNotConfiguredNotice(): void {
		this.list.splice(0, this.list.length, []);
		this.showWidget('notice');
		DOM.clearNode(this.noticeContainer);
		const title = DOM.append(this.noticeContainer, $('.notice-title'));
		title.textContent = localize('ld.notConfiguredTitle', "Connect to LaunchDarkly");
		const body = DOM.append(this.noticeContainer, $('.notice-body'));
		body.textContent = localize('ld.notConfiguredBody', "Set an API access token and a project key to browse AI Configs, feature flags, and firms.");
		const actions = DOM.append(this.noticeContainer, $('.notice-actions'));
		const setToken = DOM.append(actions, $('a.notice-link')) as HTMLAnchorElement;
		setToken.textContent = localize('ld.setToken', "Set Access Token");
		this.editorDisposables.add(DOM.addDisposableListener(setToken, 'click', () => {
			this.commandService.executeCommand(LaunchDarklyCommands.SetAccessToken);
		}));
		const configure = DOM.append(actions, $('a.notice-link')) as HTMLAnchorElement;
		configure.textContent = localize('ld.openSettings', "Open Settings");
		this.editorDisposables.add(DOM.addDisposableListener(configure, 'click', () => {
			this.commandService.executeCommand('workbench.action.openSettings', 'launchdarkly');
		}));
	}

	private showErrorNotice(err: unknown): void {
		const message = err instanceof Error ? err.message : String(err);
		this.list.splice(0, this.list.length, [{ kind: 'message', id: 'err', label: localize('ld.errorRow', "Failed to load: {0}", message), icon: Codicon.error }]);
		this.notificationService.error(message);
	}

	private hideNotice(): void {
		this.noticeContainer.style.display = 'none';
		this.listContainer.style.display = '';
	}

	//#endregion

	//#region Row open + actions (IRowActionHandler)

	private onRowOpen(row: IRow): void {
		if (row.kind === 'firm' && row.firm) {
			// Opening a firm goes straight to its variant grid.
			this.setSelectedFirm(row.firm);
			this.selectSection(LaunchDarklySection.FirmVariants);
		} else if (row.kind === 'flag' || row.kind === 'aiConfig' || row.kind === 'environment' || row.kind === 'assignment') {
			this.openInLaunchDarkly(row);
		}
	}

	toggleFlag(row: IRow): void {
		if (!row.flag) {
			return;
		}
		const env = this.connectionConfig?.environmentKey ? row.flag.environments[this.connectionConfig.environmentKey] : undefined;
		const currentlyOn = env?.on ?? false;
		(async () => {
			try {
				await this.launchDarklyService.setFlagTargeting(row.flag!.key, !currentlyOn, CancellationToken.None);
				this.notificationService.info(localize('ld.flagToggled', "Turned {0} '{1}'.", currentlyOn ? localize('ld.off', "Off") : localize('ld.on', "On"), row.flag!.name));
				this.refresh();
			} catch (err) {
				this.notificationService.error(err instanceof Error ? err.message : String(err));
			}
		})();
	}

	openInLaunchDarkly(row: IRow): void {
		const url = this.buildDeepLink(row);
		if (url) {
			this.openerService.open(URI.parse(url), { openExternal: true });
		}
	}

	/** Opens a flag's targeting page, used by the variant grid. */
	private openFlagInLaunchDarkly(flagKey: string): void {
		const url = this.buildFlagDeepLink(flagKey);
		if (url) {
			this.openerService.open(URI.parse(url), { openExternal: true });
		}
	}

	/**
	 * Toggling targeting affects every context in the environment, not just the
	 * firm on screen, so the confirmation has to say so explicitly.
	 */
	private async confirmToggleFlag(flagKey: string, on: boolean): Promise<void> {
		const environmentKey = this.connectionConfig?.environmentKey ?? '';
		const { confirmed } = await this.dialogService.confirm({
			type: 'warning',
			message: on
				? localize('ld.confirmTurnOn', "Turn on '{0}' for every context in {1}?", flagKey, environmentKey)
				: localize('ld.confirmTurnOff', "Turn off '{0}' for every context in {1}?", flagKey, environmentKey),
			detail: localize('ld.confirmToggleDetail', "Targeting is environment-wide. This affects all firms, not just '{0}'.", this.selectedFirm?.name ?? ''),
			primaryButton: on ? localize('ld.turnOn', "Turn On") : localize('ld.turnOff', "Turn Off"),
		});
		if (!confirmed) {
			return;
		}
		try {
			await this.launchDarklyService.setFlagTargeting(flagKey, on, CancellationToken.None);
			this.notificationService.info(localize('ld.flagToggled', "Turned {0} '{1}'.", on ? localize('ld.on', "On") : localize('ld.off', "Off"), flagKey));
			this.refresh();
		} catch (err) {
			this.notificationService.error(err instanceof Error ? err.message : String(err));
		}
	}

	deleteAIConfig(row: IRow): void {
		if (row.kind !== 'aiConfig' || !row.aiConfig) {
			return;
		}
		(async () => {
			const { confirmed } = await this.dialogService.confirm({
				type: 'warning',
				message: localize('ld.confirmDeleteAiConfig', "Delete AI Config '{0}'?", row.aiConfig!.name),
				detail: localize('ld.confirmDeleteAiConfigDetail', "This permanently deletes the AI Config '{0}' in LaunchDarkly. This cannot be undone.", row.aiConfig!.key),
				primaryButton: localize('ld.delete', "Delete"),
			});
			if (!confirmed) {
				return;
			}
			try {
				await this.launchDarklyService.deleteAIConfig(row.aiConfig!.key, CancellationToken.None);
				this.notificationService.info(localize('ld.aiConfigDeleted', "Deleted AI Config '{0}'.", row.aiConfig!.name));
				this.refresh();
			} catch (err) {
				this.notificationService.error(err instanceof Error ? err.message : String(err));
			}
		})();
	}

	private async createAIConfig(): Promise<void> {
		const name = await this.quickInputService.input({
			prompt: localize('ld.aiConfigName', "Name for the new AI Config"),
			placeHolder: localize('ld.aiConfigNamePlaceholder', "e.g. Audit Assistant"),
		});
		if (!name) {
			return;
		}
		const key = slugify(name);
		try {
			await this.launchDarklyService.createAIConfig({ key, name }, CancellationToken.None);
			this.notificationService.info(localize('ld.aiConfigCreated', "Created AI Config '{0}'.", name));
			this.refresh();
		} catch (err) {
			this.notificationService.error(err instanceof Error ? err.message : String(err));
		}
	}

	private async createFlag(): Promise<void> {
		const name = await this.quickInputService.input({
			prompt: localize('ld.flagName', "Name for the new feature flag"),
			placeHolder: localize('ld.flagNamePlaceholder', "e.g. Enable Firm Skill Pack"),
		});
		if (!name) {
			return;
		}
		const key = slugify(name);
		try {
			await this.launchDarklyService.createFeatureFlag({ key, name }, CancellationToken.None);
			this.notificationService.info(localize('ld.flagCreated', "Created feature flag '{0}'.", name));
			this.refresh();
		} catch (err) {
			this.notificationService.error(err instanceof Error ? err.message : String(err));
		}
	}

	/** Targeting page for one flag. */
	private buildFlagDeepLink(flagKey: string): string | undefined {
		const config = this.connectionConfig;
		if (!config?.projectKey) {
			return undefined;
		}
		const appBase = config.baseUrl.replace(/\/+$/, '');
		const env = config.environmentKey ?? 'production';
		return `${appBase}/${config.projectKey}/${env}/features/${flagKey}/targeting`;
	}

	private buildDeepLink(row: IRow): string | undefined {
		const config = this.connectionConfig;
		if (!config?.projectKey) {
			return undefined;
		}
		const appBase = config.baseUrl.replace(/\/+$/, '');
		const env = config.environmentKey ?? 'production';
		switch (row.kind) {
			case 'flag':
				return this.buildFlagDeepLink(row.id);
			case 'assignment':
				// Flag-gated assignments link to the flag; AI Config assignments are
				// distinguished by the section they were loaded for.
				return this.selectedSection === LaunchDarklySection.AIConfigs
					? `${appBase}/${config.projectKey}/${env}/ai-configs/${row.id}`
					: this.buildFlagDeepLink(row.id);
			case 'aiConfig':
				return `${appBase}/${config.projectKey}/${env}/ai-configs/${row.id}`;
			case 'environment':
				return `${appBase}/${config.projectKey}/${row.id}`;
			case 'firm':
				return `${appBase}/${config.projectKey}/${env}/context/${config.firmContextKind}/${row.id}`;
			default:
				return undefined;
		}
	}

	//#endregion

	override async setInput(input: LaunchDarklyManagementEditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		this.inEditorContextKey.set(true);
		const idx = this.sections.findIndex(s => s.id === this.selectedSection);
		if (idx >= 0) {
			this.sectionsList.setSelection([idx]);
			this.sectionsList.setFocus([idx]);
		}
		await this.refresh();
	}

	override clearInput(): void {
		this.inEditorContextKey.set(false);
		this.loadCts?.cancel();
		super.clearInput();
	}

	override layout(dimension: DOM.Dimension): void {
		this.dimension = dimension;
		if (this.container && this.splitView) {
			this.splitViewContainer.style.height = `${dimension.height}px`;
			this.splitView.layout(dimension.width, dimension.height);
		}
	}

	override focus(): void {
		super.focus();
		if (this.selectedSection === LaunchDarklySection.FirmVariants && this.variantsContainer?.style.display !== 'none') {
			this.variantsGrid.focus();
		} else {
			this.list?.domFocus();
		}
	}

	/** Moves keyboard focus to the variant filter box. */
	focusVariantFilter(): void {
		if (this.selectedSection === LaunchDarklySection.FirmVariants) {
			this.variantsFilterInput?.focus();
		}
	}
}

function slugify(name: string): string {
	return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || `config-${Date.now()}`;
}
