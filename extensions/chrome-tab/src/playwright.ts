/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import * as vscode from 'vscode';
import type * as playwright from 'playwright-core';

export type Playwright = typeof playwright;

let cached: Playwright | undefined;

/**
 * Loads the playwright-core copy that ships with the app (the Integrated Browser
 * drives its views with the same one), so this extension adds no npm dependency
 * and no entry to the build's install list.
 */
export function loadPlaywright(): Playwright {
	if (cached) {
		return cached;
	}
	const failures: string[] = [];
	for (const id of [path.join(vscode.env.appRoot, 'node_modules', 'playwright-core'), 'playwright-core']) {
		try {
			// The module is resolved at runtime from the app install, so it cannot be a static import.
			// eslint-disable-next-line no-restricted-syntax
			cached = require(id) as Playwright;
			return cached;
		} catch (error) {
			failures.push(`${id}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	throw new Error(`playwright-core is not available (${failures.join('; ')})`);
}
