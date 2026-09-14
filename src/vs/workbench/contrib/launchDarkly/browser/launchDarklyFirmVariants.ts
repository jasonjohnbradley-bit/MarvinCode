/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, append, clearNode, Dimension } from '../../../../base/browser/dom.js';
import { ActionBar } from '../../../../base/browser/ui/actionbar/actionbar.js';
import { HighlightedLabel } from '../../../../base/browser/ui/highlightedlabel/highlightedLabel.js';
import { IManagedHover } from '../../../../base/browser/ui/hover/hover.js';
import { getDefaultHoverDelegate } from '../../../../base/browser/ui/hover/hoverDelegateFactory.js';
import { ProgressBar } from '../../../../base/browser/ui/progressbar/progressbar.js';
import { ITableRenderer, ITableVirtualDelegate } from '../../../../base/browser/ui/table/table.js';
import { Action } from '../../../../base/common/actions.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { IMatch, matchesFuzzy } from '../../../../base/common/filters.js';
import { stringHash } from '../../../../base/common/hash.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { WorkbenchTable } from '../../../../platform/list/browser/listService.js';
import { defaultProgressBarStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import {
	ILaunchDarklyFirmEvaluations,
	ILaunchDarklyFlagEvaluation,
	LaunchDarklyVariationValue,
} from '../common/launchDarklyService.js';
import { VARIANT_TONES, VariantTone } from './launchDarklyFirmVariantsColors.js';
import { VARIANT_HEADER_ROW_HEIGHT, VARIANT_ROW_HEIGHT } from './launchDarklyManagement.js';

//#region View model

/** How much to trust a row's resolved variant. */
export const enum VariantConfidence {
	/** Evaluated by LaunchDarkly — authoritative. */
	Evaluated = 1,
	/** Inferred locally from targeting configuration — best effort. */
	Inferred = 2,
	/** Could not be determined at all. */
	Unknown = 3,
}

/** One flag's resolved variant for the selected firm, ready to render. */
export interface IFirmVariantRow {
	readonly flagKey: string;
	readonly flagName: string;
	readonly flagKind: string;
	/** Environment-level targeting switch, independent of which variant is served. */
	readonly targetingOn: boolean;
	readonly variationIndex: number | undefined;
	readonly variationName: string | undefined;
	/** Always populated: `On`/`Off`, the value, or truncated JSON. */
	readonly variationDisplay: string;
	readonly variationValue: LaunchDarklyVariationValue | undefined;
	/** Set only when the served value is a boolean. */
	readonly booleanValue: boolean | undefined;
	readonly reasonKind: ILaunchDarklyFlagEvaluation['reasonKind'];
	/** Localized explanation of the deciding rule. */
	readonly reasonText: string;
	readonly confidence: VariantConfidence;
	/** True when this firm gets something other than the flag's default. */
	readonly isNonDefault: boolean;
}

/**
 * Adapts service evaluations into view rows. This is the only place coupled to
 * the service DTO, and it sorts non-default rows first so what is special about
 * the firm is visible without scrolling (the table itself cannot sort).
 */
export function toVariantRows(result: ILaunchDarklyFirmEvaluations): IFirmVariantRow[] {
	const rows = result.evaluations.map((evaluation): IFirmVariantRow => {
		const value = evaluation.variation?.value;
		const confidence = !evaluation.variation || evaluation.reasonKind === 'unknown'
			? VariantConfidence.Unknown
			: evaluation.authoritative ? VariantConfidence.Evaluated : VariantConfidence.Inferred;
		return {
			flagKey: evaluation.flagKey,
			flagName: evaluation.flagName,
			flagKind: evaluation.kind,
			targetingOn: evaluation.enabled,
			variationIndex: evaluation.variation?.index,
			variationName: evaluation.variation?.name,
			variationDisplay: evaluation.variation?.displayLabel ?? localize('ld.variantUnknown', "Unknown"),
			variationValue: value,
			booleanValue: typeof value === 'boolean' ? value : undefined,
			reasonKind: evaluation.reasonKind,
			reasonText: evaluation.explanation,
			confidence,
			// Default = the flag's fallthrough or being off; anything else is a
			// difference worth surfacing for this firm.
			isNonDefault: evaluation.reasonKind === 'targetMatch' || evaluation.reasonKind === 'ruleMatch',
		};
	});

	return rows.sort((a, b) =>
		Number(b.isNonDefault) - Number(a.isNonDefault) || a.flagName.localeCompare(b.flagName));
}

/** Colour bucket for a row's variant pill. */
export function variantTone(row: IFirmVariantRow): VariantTone {
	if (row.reasonKind === 'error') {
		return 'error';
	}
	if (row.confidence === VariantConfidence.Unknown || row.reasonKind === 'prerequisiteFailed') {
		return 'unknown';
	}
	if (!row.targetingOn || row.reasonKind === 'off' || row.booleanValue === false) {
		return 'off';
	}
	if (row.booleanValue === true) {
		return 'on';
	}
	// Keyed on the variation index so one variation keeps one colour across
	// firms, environments and sessions.
	const seed = row.variationIndex ?? stringHash(row.variationName ?? row.variationDisplay, 0);
	return VARIANT_TONES[Math.abs(seed) % VARIANT_TONES.length];
}

//#endregion

//#region Filtering

export interface IParsedVariantFilter {
	/** Free text matched against key, name, variant and reason. */
	readonly text: string;
	readonly variant?: string;
	readonly reason?: string;
	readonly onlyOn?: boolean;
	readonly onlyOff?: boolean;
	readonly onlyInferred?: boolean;
	readonly onlyNonDefault?: boolean;
}

/** Parses `@`-prefixed tokens out of the filter text. */
export function parseVariantFilter(raw: string): IParsedVariantFilter {
	const parsed: {
		text: string[];
		variant?: string;
		reason?: string;
		onlyOn?: boolean;
		onlyOff?: boolean;
		onlyInferred?: boolean;
		onlyNonDefault?: boolean;
	} = { text: [] };

	for (const token of raw.trim().split(/\s+/).filter(Boolean)) {
		const lower = token.toLowerCase();
		if (lower.startsWith('@variant:')) {
			parsed.variant = token.slice('@variant:'.length).toLowerCase();
		} else if (lower.startsWith('@reason:')) {
			parsed.reason = token.slice('@reason:'.length).toLowerCase();
		} else if (lower === '@on') {
			parsed.onlyOn = true;
		} else if (lower === '@off') {
			parsed.onlyOff = true;
		} else if (lower === '@inferred') {
			parsed.onlyInferred = true;
		} else if (lower === '@diff') {
			parsed.onlyNonDefault = true;
		} else {
			parsed.text.push(token);
		}
	}
	return { ...parsed, text: parsed.text.join(' ').toLowerCase() };
}

export function matchesVariantFilter(row: IFirmVariantRow, filter: IParsedVariantFilter): boolean {
	if (filter.onlyNonDefault && !row.isNonDefault) {
		return false;
	}
	if (filter.onlyInferred && row.confidence === VariantConfidence.Evaluated) {
		return false;
	}
	if (filter.onlyOn && !(row.targetingOn && row.reasonKind !== 'off' && row.booleanValue !== false)) {
		return false;
	}
	if (filter.onlyOff && (row.targetingOn && row.reasonKind !== 'off' && row.booleanValue !== false)) {
		return false;
	}
	if (filter.variant && !`${row.variationName ?? ''} ${row.variationDisplay}`.toLowerCase().includes(filter.variant)) {
		return false;
	}
	if (filter.reason && !`${row.reasonKind} ${row.reasonText}`.toLowerCase().includes(filter.reason)) {
		return false;
	}
	if (filter.text) {
		const haystack = `${row.flagName} ${row.flagKey} ${row.variationDisplay} ${row.reasonText}`.toLowerCase();
		if (!haystack.includes(filter.text)) {
			return false;
		}
	}
	return true;
}

//#endregion

//#region Renderers

interface IStateTemplate { readonly dot: HTMLElement }
interface IFlagTemplate { readonly name: HighlightedLabel; readonly key: HTMLElement; readonly hover: IManagedHover }
interface IValueTemplate { readonly pill: HTMLElement; readonly icon: HTMLElement; readonly label: HTMLElement; readonly value: HTMLElement; readonly hover: IManagedHover }
interface IReasonTemplate { readonly icon: HTMLElement; readonly text: HTMLElement; readonly badge: HTMLElement; readonly hover: IManagedHover }
interface IActionsTemplate { readonly bar: ActionBar; readonly disposables: DisposableStore }

/** Filter matches for the flag name, so the grid can highlight them. */
function nameMatches(row: IFirmVariantRow, filterText: string): IMatch[] | undefined {
	return filterText ? (matchesFuzzy(filterText, row.flagName, true) ?? undefined) : undefined;
}

class StateColumnRenderer implements ITableRenderer<IFirmVariantRow, IStateTemplate> {
	static readonly TEMPLATE_ID = 'ldVariantState';
	readonly templateId = StateColumnRenderer.TEMPLATE_ID;

	renderTemplate(container: HTMLElement): IStateTemplate {
		container.classList.add('ld-variant-state');
		return { dot: append(container, $('.ld-variant-dot')) };
	}

	renderElement(row: IFirmVariantRow, _index: number, template: IStateTemplate): void {
		const tone = variantTone(row);
		const live = row.targetingOn && row.reasonKind !== 'off' && row.booleanValue !== false;
		const icon = row.confidence === VariantConfidence.Unknown
			? Codicon.warning
			: live ? Codicon.circleLargeFilled : Codicon.circleLargeOutline;
		template.dot.className = `ld-variant-dot ld-tone-${tone} ${ThemeIcon.asClassName(icon)}`;
	}

	disposeTemplate(): void { }
}

class FlagColumnRenderer implements ITableRenderer<IFirmVariantRow, IFlagTemplate> {
	static readonly TEMPLATE_ID = 'ldVariantFlag';
	readonly templateId = FlagColumnRenderer.TEMPLATE_ID;

	constructor(
		private readonly filterText: () => string,
		@IHoverService private readonly hoverService: IHoverService,
	) { }

	renderTemplate(container: HTMLElement): IFlagTemplate {
		container.classList.add('ld-variant-flag');
		const name = new HighlightedLabel(append(container, $('.ld-flag-name')));
		const key = append(container, $('.ld-flag-key'));
		// Hovers are created once per template; creating them per element would
		// leak one hover for every row scrolled past.
		const hover = this.hoverService.setupManagedHover(getDefaultHoverDelegate('mouse'), container, '');
		return { name, key, hover };
	}

	renderElement(row: IFirmVariantRow, _index: number, template: IFlagTemplate): void {
		template.name.set(row.flagName, nameMatches(row, this.filterText()));
		template.key.textContent = row.flagKey;
		template.hover.update(`${row.flagName}\n${row.flagKey}`);
	}

	disposeTemplate(template: IFlagTemplate): void {
		template.name.dispose();
		template.hover.dispose();
	}
}

class ValueColumnRenderer implements ITableRenderer<IFirmVariantRow, IValueTemplate> {
	static readonly TEMPLATE_ID = 'ldVariantValue';
	readonly templateId = ValueColumnRenderer.TEMPLATE_ID;

	constructor(@IHoverService private readonly hoverService: IHoverService) { }

	renderTemplate(container: HTMLElement): IValueTemplate {
		container.classList.add('ld-variant-value');
		const pill = append(container, $('span.ld-variant-pill'));
		const icon = append(pill, $('span.ld-pill-icon'));
		const label = append(pill, $('span.ld-pill-label'));
		const value = append(pill, $('span.ld-pill-value'));
		const hover = this.hoverService.setupManagedHover(getDefaultHoverDelegate('mouse'), pill, '');
		return { pill, icon, label, value, hover };
	}

	renderElement(row: IFirmVariantRow, _index: number, template: IValueTemplate): void {
		const tone = variantTone(row);
		template.pill.className = `ld-variant-pill ld-tone-${tone}`;
		if (row.confidence !== VariantConfidence.Evaluated) {
			template.pill.classList.add('ld-degraded');
		}

		if (row.booleanValue !== undefined) {
			template.icon.className = `ld-pill-icon ${ThemeIcon.asClassName(row.booleanValue ? Codicon.check : Codicon.close)}`;
			template.label.textContent = row.booleanValue ? localize('ld.on', "On") : localize('ld.off', "Off");
			template.value.textContent = row.booleanValue ? '(true)' : '(false)';
		} else {
			const unresolved = row.confidence === VariantConfidence.Unknown;
			template.icon.className = unresolved ? `ld-pill-icon ${ThemeIcon.asClassName(Codicon.question)}` : 'ld-pill-icon';
			template.label.textContent = row.variationDisplay;
			template.value.textContent = '';
		}

		const raw = row.variationValue === undefined ? undefined : JSON.stringify(row.variationValue);
		template.hover.update(raw ? `${row.variationDisplay}\n${raw.slice(0, 400)}` : row.variationDisplay);
	}

	disposeTemplate(template: IValueTemplate): void {
		template.hover.dispose();
	}
}

function reasonIcon(reasonKind: IFirmVariantRow['reasonKind']): ThemeIcon {
	switch (reasonKind) {
		case 'targetMatch': return Codicon.pinned;
		case 'ruleMatch': return Codicon.listFilter;
		case 'fallthrough': return Codicon.arrowRight;
		case 'off': return Codicon.circleSlash;
		case 'prerequisiteFailed': return Codicon.debugBreakpointData;
		case 'error': return Codicon.error;
		default: return Codicon.question;
	}
}

class ReasonColumnRenderer implements ITableRenderer<IFirmVariantRow, IReasonTemplate> {
	static readonly TEMPLATE_ID = 'ldVariantReason';
	readonly templateId = ReasonColumnRenderer.TEMPLATE_ID;

	constructor(@IHoverService private readonly hoverService: IHoverService) { }

	renderTemplate(container: HTMLElement): IReasonTemplate {
		container.classList.add('ld-variant-reason');
		const icon = append(container, $('.ld-reason-icon'));
		const text = append(container, $('.ld-reason-text'));
		const badge = append(container, $('span.ld-reason-badge'));
		const hover = this.hoverService.setupManagedHover(getDefaultHoverDelegate('mouse'), container, '');
		return { icon, text, badge, hover };
	}

	renderElement(row: IFirmVariantRow, _index: number, template: IReasonTemplate): void {
		template.icon.className = `ld-reason-icon ${ThemeIcon.asClassName(reasonIcon(row.reasonKind))}`;
		template.text.textContent = row.reasonText;

		if (row.confidence === VariantConfidence.Evaluated) {
			template.badge.textContent = '';
			template.badge.style.display = 'none';
			template.hover.update(row.reasonText);
		} else {
			template.badge.style.display = '';
			template.badge.textContent = row.confidence === VariantConfidence.Inferred
				? localize('ld.inferred', "Inferred")
				: localize('ld.unverified', "Unverified");
			template.hover.update(`${row.reasonText}\n\n${localize('ld.inferredTip', "Computed locally from targeting configuration rather than LaunchDarkly's evaluation API. Verify in LaunchDarkly before relying on it.")}`);
		}
	}

	disposeTemplate(template: IReasonTemplate): void {
		template.hover.dispose();
	}
}

class ActionsColumnRenderer implements ITableRenderer<IFirmVariantRow, IActionsTemplate> {
	static readonly TEMPLATE_ID = 'ldVariantActions';
	readonly templateId = ActionsColumnRenderer.TEMPLATE_ID;

	constructor(private readonly grid: LaunchDarklyFirmVariantsGrid) { }

	renderTemplate(container: HTMLElement): IActionsTemplate {
		container.classList.add('ld-variant-actions');
		const disposables = new DisposableStore();
		const bar = disposables.add(new ActionBar(container));
		return { bar, disposables };
	}

	renderElement(row: IFirmVariantRow, _index: number, template: IActionsTemplate): void {
		template.bar.clear();
		template.bar.push([
			new Action('ld.openTargeting', localize('ld.openTargeting', "Open Targeting in LaunchDarkly"), ThemeIcon.asClassName(Codicon.linkExternal), true,
				async () => this.grid.requestOpenFlag(row.flagKey)),
			new Action('ld.copyFlagKey', localize('ld.copyFlagKey', "Copy Flag Key"), ThemeIcon.asClassName(Codicon.copy), true,
				async () => this.grid.requestCopyFlagKey(row.flagKey)),
			new Action('ld.toggleTargeting', row.targetingOn ? localize('ld.turnOff', "Turn Off") : localize('ld.turnOn', "Turn On"),
				ThemeIcon.asClassName(row.targetingOn ? Codicon.circleFilled : Codicon.circle), true,
				async () => this.grid.requestToggleFlag(row.flagKey, !row.targetingOn)),
		], { icon: true, label: false });
	}

	disposeElement(_row: IFirmVariantRow, _index: number, template: IActionsTemplate): void {
		template.bar.clear();
	}

	disposeTemplate(template: IActionsTemplate): void {
		template.disposables.dispose();
	}
}

class VariantsTableDelegate implements ITableVirtualDelegate<IFirmVariantRow> {
	readonly headerRowHeight = VARIANT_HEADER_ROW_HEIGHT;
	getHeight(): number { return VARIANT_ROW_HEIGHT; }
}

//#endregion

/**
 * The firm → variant grid: which variation the selected firm receives for every
 * flag in the environment, and why.
 */
export class LaunchDarklyFirmVariantsGrid extends Disposable {

	private readonly _onDidRequestOpenFlag = this._register(new Emitter<string>());
	readonly onDidRequestOpenFlag: Event<string> = this._onDidRequestOpenFlag.event;

	private readonly _onDidRequestCopyFlagKey = this._register(new Emitter<string>());
	readonly onDidRequestCopyFlagKey: Event<string> = this._onDidRequestCopyFlagKey.event;

	private readonly _onDidRequestToggleFlag = this._register(new Emitter<{ flagKey: string; on: boolean }>());
	readonly onDidRequestToggleFlag: Event<{ flagKey: string; on: boolean }> = this._onDidRequestToggleFlag.event;

	private readonly bannersContainer: HTMLElement;
	private readonly progressContainer: HTMLElement;
	private readonly tableContainer: HTMLElement;
	private readonly emptyMessage: HTMLElement;
	private readonly progressBar: ProgressBar;
	private readonly table: WorkbenchTable<IFirmVariantRow>;
	private readonly bannerDisposables = this._register(new DisposableStore());

	private allRows: IFirmVariantRow[] = [];
	private filterText = '';
	private parsedFilter: IParsedVariantFilter = { text: '' };
	private ariaContext = { firmName: '', environmentKey: '' };

	constructor(
		container: HTMLElement,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super();

		this.bannersContainer = append(container, $('.ld-variants-banners'));
		this.progressContainer = append(container, $('.ld-variants-progress'));
		this.progressBar = this._register(new ProgressBar(this.progressContainer, defaultProgressBarStyles));
		this.progressBar.hide();

		const tableWrapper = append(container, $('.ld-variants-table'));
		this.tableContainer = append(tableWrapper, $('.ld-variants-table-body'));
		this.emptyMessage = append(tableWrapper, $('.ld-variants-empty'));
		this.emptyMessage.style.display = 'none';

		this.table = this._register(instantiationService.createInstance(
			WorkbenchTable,
			'LaunchDarklyFirmVariants',
			this.tableContainer,
			new VariantsTableDelegate(),
			[
				{
					label: '',
					tooltip: '',
					weight: 0.04,
					minimumWidth: 36,
					maximumWidth: 36,
					templateId: StateColumnRenderer.TEMPLATE_ID,
					project(row: IFirmVariantRow): IFirmVariantRow { return row; },
				},
				{
					label: localize('ld.col.flag', "Flag"),
					tooltip: localize('ld.col.flagTip', "The feature flag name and key."),
					weight: 0.34,
					minimumWidth: 220,
					templateId: FlagColumnRenderer.TEMPLATE_ID,
					project(row: IFirmVariantRow): IFirmVariantRow { return row; },
				},
				{
					label: localize('ld.col.variant', "Variant"),
					tooltip: localize('ld.col.variantTip', "The variation this firm receives in the selected environment."),
					weight: 0.22,
					minimumWidth: 150,
					templateId: ValueColumnRenderer.TEMPLATE_ID,
					project(row: IFirmVariantRow): IFirmVariantRow { return row; },
				},
				{
					label: localize('ld.col.why', "Why"),
					tooltip: localize('ld.col.whyTip', "Why LaunchDarkly serves this variation to this firm."),
					weight: 0.32,
					minimumWidth: 200,
					templateId: ReasonColumnRenderer.TEMPLATE_ID,
					project(row: IFirmVariantRow): IFirmVariantRow { return row; },
				},
				{
					label: '',
					tooltip: '',
					weight: 0.08,
					minimumWidth: 72,
					maximumWidth: 72,
					templateId: ActionsColumnRenderer.TEMPLATE_ID,
					project(row: IFirmVariantRow): IFirmVariantRow { return row; },
				},
			],
			[
				new StateColumnRenderer(),
				instantiationService.createInstance(FlagColumnRenderer, () => this.filterText),
				instantiationService.createInstance(ValueColumnRenderer),
				instantiationService.createInstance(ReasonColumnRenderer),
				new ActionsColumnRenderer(this),
			],
			{
				horizontalScrolling: false,
				alwaysConsumeMouseWheel: false,
				openOnSingleClick: false,
				multipleSelectionSupport: false,
				identityProvider: { getId: (row: IFirmVariantRow) => row.flagKey },
				accessibilityProvider: {
					// The table emits no ARIA grid roles, so each row has to speak
					// its whole story in one sentence.
					getAriaLabel: (row: IFirmVariantRow) => {
						const variant = row.booleanValue === true ? localize('ld.ariaOn', "On, true")
							: row.booleanValue === false ? localize('ld.ariaOff', "Off, false")
								: localize('ld.ariaVariant', "Variation {0}", row.variationDisplay);
						const parts = [`${row.flagName}, ${row.flagKey}`, variant, row.reasonText];
						if (row.confidence !== VariantConfidence.Evaluated) {
							parts.push(localize('ld.ariaInferred', "Inferred, not verified"));
						}
						return parts.join('. ');
					},
					getWidgetAriaLabel: () => localize('ld.variantsGridAria', "Feature flag variants for firm {0} in environment {1}", this.ariaContext.firmName, this.ariaContext.environmentKey),
				},
			},
		) as WorkbenchTable<IFirmVariantRow>);

		this._register(this.table.onDidOpen(event => {
			if (event.element) {
				this.requestOpenFlag(event.element.flagKey);
			}
		}));
	}

	requestOpenFlag(flagKey: string): void {
		this._onDidRequestOpenFlag.fire(flagKey);
	}

	requestCopyFlagKey(flagKey: string): void {
		this._onDidRequestCopyFlagKey.fire(flagKey);
	}

	requestToggleFlag(flagKey: string, on: boolean): void {
		this._onDidRequestToggleFlag.fire({ flagKey, on });
	}

	setLoading(loading: boolean): void {
		if (loading) {
			this.progressBar.infinite().show();
		} else {
			this.progressBar.stop().hide();
		}
	}

	/** Replaces the grid contents and rebuilds any degradation banners. */
	setResult(result: ILaunchDarklyFirmEvaluations, firmName: string): void {
		this.ariaContext = { firmName, environmentKey: result.environmentKey };
		this.allRows = toVariantRows(result);
		this.renderBanners(result, firmName);
		this.applyFilter();
	}

	clear(): void {
		this.allRows = [];
		this.bannerDisposables.clear();
		clearNode(this.bannersContainer);
		this.applyFilter();
	}

	setFilter(text: string): void {
		this.filterText = text.trim();
		this.parsedFilter = parseVariantFilter(this.filterText);
		this.applyFilter();
	}

	/** Number of rows currently shown, and the total available. */
	get counts(): { shown: number; total: number } {
		return { shown: this.table.length, total: this.allRows.length };
	}

	private applyFilter(): void {
		const rows = this.allRows.filter(row => matchesVariantFilter(row, this.parsedFilter));
		this.table.splice(0, this.table.length, rows);

		if (rows.length) {
			this.emptyMessage.style.display = 'none';
		} else {
			this.emptyMessage.style.display = '';
			this.emptyMessage.textContent = this.allRows.length
				? localize('ld.noFlagsMatch', "No flags match the current filter.")
				: localize('ld.noFlags', "No feature flags in this project.");
		}
	}

	private renderBanners(result: ILaunchDarklyFirmEvaluations, firmName: string): void {
		this.bannerDisposables.clear();
		clearNode(this.bannersContainer);

		const addBanner = (text: string): void => {
			const banner = append(this.bannersContainer, $('.ld-variants-banner.warning'));
			append(banner, $(`.banner-icon${ThemeIcon.asCSSSelector(Codicon.warning)}`));
			append(banner, $('.banner-text')).textContent = text;
		};

		if (result.degradation) {
			addBanner(result.degradation.kind === 'segmentFirm'
				? localize('ld.segmentFirmNotice', "'{0}' is a LaunchDarkly segment rather than a context, so variants are inferred from which rules target the segment and may differ from what the SDK serves an individual member.", firmName)
				: result.degradation.message);
		} else {
			const inferred = this.allRows.filter(row => row.confidence !== VariantConfidence.Evaluated).length;
			if (inferred > 0) {
				addBanner(localize('ld.someInferred', "{0} of {1} results were inferred locally rather than evaluated by LaunchDarkly.", inferred, this.allRows.length));
			}
		}
	}

	focus(): void {
		this.table.domFocus();
		if (this.table.length && this.table.getFocus().length === 0) {
			this.table.setFocus([0]);
		}
	}

	/** Gives the table whatever height is left after the surrounding chrome. */
	layout(dimension: Dimension): void {
		const chrome = this.bannersContainer.offsetHeight + this.progressContainer.offsetHeight;
		const height = Math.max(0, dimension.height - chrome);
		this.tableContainer.style.height = `${height}px`;
		this.table.layout(height, dimension.width);
	}
}
