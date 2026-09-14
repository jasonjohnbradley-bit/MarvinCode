/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { EditorInputCapabilities, IUntypedEditorInput } from '../../../common/editor.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { LAUNCHDARKLY_MANAGEMENT_EDITOR_INPUT_ID } from './launchDarklyManagement.js';

/**
 * Singleton-style editor input for the LaunchDarkly management editor.
 * It has no backing file resource.
 */
export class LaunchDarklyManagementEditorInput extends EditorInput {

	static readonly ID: string = LAUNCHDARKLY_MANAGEMENT_EDITOR_INPUT_ID;

	readonly resource = undefined;

	private static _instance: LaunchDarklyManagementEditorInput | undefined;

	static getOrCreate(): LaunchDarklyManagementEditorInput {
		if (!LaunchDarklyManagementEditorInput._instance || LaunchDarklyManagementEditorInput._instance.isDisposed()) {
			LaunchDarklyManagementEditorInput._instance = new LaunchDarklyManagementEditorInput();
		}
		return LaunchDarklyManagementEditorInput._instance;
	}

	override get capabilities(): EditorInputCapabilities {
		return super.capabilities | EditorInputCapabilities.Singleton;
	}

	override get typeId(): string {
		return LaunchDarklyManagementEditorInput.ID;
	}

	override matches(otherInput: EditorInput | IUntypedEditorInput): boolean {
		return super.matches(otherInput) || otherInput instanceof LaunchDarklyManagementEditorInput;
	}

	override getName(): string {
		return localize('launchDarklyManagementEditorName', "LaunchDarkly");
	}

	override getIcon(): ThemeIcon {
		return Codicon.beaker;
	}

	override async resolve(): Promise<null> {
		return null;
	}
}
