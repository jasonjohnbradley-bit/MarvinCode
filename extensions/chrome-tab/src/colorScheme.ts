/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

const SECTION = 'marvincode.chrome';
const SCHEME_SETTING = 'colorScheme';
const FORCE_SETTING = 'forceDark';

/** How Chrome Tabs ask pages to render. */
export interface ColorSchemeState {
	/** `prefers-color-scheme: dark`: sites that have a dark theme use it. */
	readonly dark: boolean;
	/** Chrome's Auto Dark Mode: sites without a dark theme are darkened as well. */
	readonly forceDark: boolean;
}

function themeIsDark(): boolean {
	const kind = vscode.window.activeColorTheme.kind;
	return kind === vscode.ColorThemeKind.Dark || kind === vscode.ColorThemeKind.HighContrast;
}

/** The current `marvincode.chrome.colorScheme` and `forceDark` settings, resolved. */
export function colorScheme(): ColorSchemeState {
	const config = vscode.workspace.getConfiguration(SECTION);
	const setting = config.get<string>(SCHEME_SETTING, 'light');
	const dark = setting === 'dark' || (setting === 'theme' && themeIsDark());
	return { dark, forceDark: dark && config.get<boolean>(FORCE_SETTING, false) };
}

/** Fires when either setting changes, or the color theme does while following it. */
export function onDidChangeColorScheme(listener: () => void): vscode.Disposable {
	return vscode.Disposable.from(
		vscode.workspace.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(`${SECTION}.${SCHEME_SETTING}`) || e.affectsConfiguration(`${SECTION}.${FORCE_SETTING}`)) {
				listener();
			}
		}),
		vscode.window.onDidChangeActiveColorTheme(() => {
			if (vscode.workspace.getConfiguration(SECTION).get<string>(SCHEME_SETTING, 'light') === 'theme') {
				listener();
			}
		}),
	);
}

/** Switches every Chrome Tab between light and dark (an explicit setting, so it no longer follows the theme). */
export async function toggleDarkMode(): Promise<void> {
	await vscode.workspace.getConfiguration(SECTION).update(SCHEME_SETTING, colorScheme().dark ? 'light' : 'dark', vscode.ConfigurationTarget.Global);
}
