/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';

export const LAUNCHDARKLY_MANAGEMENT_EDITOR_ID = 'workbench.editor.launchDarklyManagement';
export const LAUNCHDARKLY_MANAGEMENT_EDITOR_INPUT_ID = 'workbench.input.launchDarklyManagement';

/** Sidebar sections of the LaunchDarkly management editor. */
export const LaunchDarklySection = {
	Firms: 'firms',
	FirmVariants: 'firmVariants',
	AIConfigs: 'aiConfigs',
	Flags: 'flags',
	Environments: 'environments',
} as const;

export type LaunchDarklySection = typeof LaunchDarklySection[keyof typeof LaunchDarklySection];

export const LAUNCHDARKLY_SECTIONS: readonly LaunchDarklySection[] = [
	LaunchDarklySection.Firms,
	LaunchDarklySection.FirmVariants,
	LaunchDarklySection.AIConfigs,
	LaunchDarklySection.Flags,
	LaunchDarklySection.Environments,
];

export const LaunchDarklyCommands = {
	OpenEditor: 'launchDarkly.openManagement',
	SetAccessToken: 'launchDarkly.setAccessToken',
	ClearAccessToken: 'launchDarkly.clearAccessToken',
	Refresh: 'launchDarkly.refresh',
	OpenFirmVariants: 'launchDarkly.openFirmVariants',
	ChangeFirm: 'launchDarkly.changeFirm',
	FocusVariantFilter: 'launchDarkly.focusVariantFilter',
} as const;

//#region Context keys

export const CONTEXT_LAUNCHDARKLY_EDITOR = new RawContextKey<boolean>('launchDarklyManagementEditorFocused', false);
export const CONTEXT_LAUNCHDARKLY_SECTION = new RawContextKey<string>('launchDarklyManagementSection', '');
export const CONTEXT_LAUNCHDARKLY_CONFIGURED = new RawContextKey<boolean>('launchDarklyConfigured', false);
/** Key of the firm whose variants are on screen, empty when none is selected. */
export const CONTEXT_LAUNCHDARKLY_FIRM = new RawContextKey<string>('launchDarklyManagementFirm', '');
/** False when the variant grid is showing locally inferred rather than evaluated data. */
export const CONTEXT_LAUNCHDARKLY_VARIANTS_AUTHORITATIVE = new RawContextKey<boolean>('launchDarklyVariantsAuthoritative', false);
export const CONTEXT_LAUNCHDARKLY_VARIANT_FILTER_FOCUSED = new RawContextKey<boolean>('launchDarklyVariantFilterFocused', false);

//#endregion

//#region Storage keys

export const LAUNCHDARKLY_SIDEBAR_WIDTH_KEY = 'launchDarkly.management.sidebarWidth';
export const LAUNCHDARKLY_SELECTED_SECTION_KEY = 'launchDarkly.management.selectedSection';
export const LAUNCHDARKLY_SELECTED_FIRM_KEY = 'launchDarkly.management.selectedFirm';
export const LAUNCHDARKLY_VARIANT_FILTER_HISTORY_KEY = 'launchDarkly.management.variantFilterHistory';

//#endregion

//#region Layout constants

export const SIDEBAR_DEFAULT_WIDTH = 220;
export const SIDEBAR_MIN_WIDTH = 170;
export const SIDEBAR_MAX_WIDTH = 400;
export const CONTENT_MIN_WIDTH = 400;
export const VARIANT_ROW_HEIGHT = 40;
export const VARIANT_HEADER_ROW_HEIGHT = 24;

//#endregion
