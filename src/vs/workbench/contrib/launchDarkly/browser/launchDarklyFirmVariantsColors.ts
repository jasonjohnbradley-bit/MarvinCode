/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { chartsOrange, chartsYellow } from '../../../../platform/theme/common/colors/chartsColors.js';
import { listFilterMatchHighlight } from '../../../../platform/theme/common/colors/listColors.js';
import { registerColor } from '../../../../platform/theme/common/colorUtils.js';

/**
 * Foreground for variant values that were inferred from targeting configuration
 * rather than evaluated by LaunchDarkly, so the grid can be honest about which
 * rows are best-effort.
 */
export const firmVariantDegradedForeground = registerColor('launchDarkly.variantDegradedForeground',
	{ dark: chartsYellow, light: chartsOrange, hcDark: chartsYellow, hcLight: chartsOrange },
	localize('launchDarkly.variantDegradedForeground', "Foreground for firm variant values that were inferred locally rather than evaluated by LaunchDarkly."));

/** Highlight behind filter matches in the firm variant grid. */
export const firmVariantFilterMatchBackground = registerColor('launchDarkly.variantFilterMatchBackground',
	{ dark: listFilterMatchHighlight, light: listFilterMatchHighlight, hcDark: null, hcLight: null },
	localize('launchDarkly.variantFilterMatchBackground', "Background of filter match highlights in the firm variant grid."));

/**
 * Tone applied to a variant pill. Booleans and off states get fixed tones; other
 * variations cycle through `v1`–`v5` so a given variation keeps one colour.
 */
export type VariantTone = 'on' | 'off' | 'v1' | 'v2' | 'v3' | 'v4' | 'v5' | 'unknown' | 'error';

/** Tones assigned to non-boolean variations, in variation-index order. */
export const VARIANT_TONES: readonly VariantTone[] = ['v1', 'v2', 'v3', 'v4', 'v5'];
