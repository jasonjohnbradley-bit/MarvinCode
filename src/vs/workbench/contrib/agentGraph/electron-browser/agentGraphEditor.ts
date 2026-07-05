/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { RunOnceScheduler } from '../../../../base/common/async.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { FileAccess } from '../../../../base/common/network.js';
import { URI } from '../../../../base/common/uri.js';
import { IAgentGraphService } from '../../../../platform/agentGraph/common/agentGraph.js';
import { WebviewInput } from '../../webviewPanel/browser/webviewEditorInput.js';
import { IWebviewWorkbenchService } from '../../webviewPanel/browser/webviewWorkbenchService.js';
import { IEditorGroupsService } from '../../../services/editor/common/editorGroupsService.js';
import { ACTIVE_GROUP, IEditorService } from '../../../services/editor/common/editorService.js';
import { AGENT_GRAPH_MEDIA_ROOT, renderAgentGraphHtml } from './agentGraphWebview.js';

/**
 * Hosts the knowledge-graph webview as an editor tab, modeled on the
 * release-notes editor. Pushes a fresh graph snapshot on every ingested
 * event (debounced) and opens files when nodes are activated.
 */
export class AgentGraphEditorManager extends Disposable {

	private current: WebviewInput | undefined;

	constructor(
		@IWebviewWorkbenchService private readonly webviewWorkbenchService: IWebviewWorkbenchService,
		@IEditorGroupsService private readonly editorGroupService: IEditorGroupsService,
		@IEditorService private readonly editorService: IEditorService,
		@IAgentGraphService private readonly agentGraphService: IAgentGraphService
	) {
		super();
	}

	async show(): Promise<void> {
		const title = 'Agent Graph';
		if (this.current) {
			this.webviewWorkbenchService.revealWebview(this.current, this.editorService.activeEditorPane?.group ?? this.editorGroupService.activeGroup, false);
			await this.pushData();
			return;
		}

		const mediaRoot = FileAccess.asFileUri(AGENT_GRAPH_MEDIA_ROOT);
		this.current = this.webviewWorkbenchService.openWebview(
			{
				title,
				options: { tryRestoreScrollPosition: false, enableFindWidget: false },
				contentOptions: { localResourceRoots: [mediaRoot], allowScripts: true },
				extension: undefined
			},
			'agentGraph',
			title,
			Codicon.typeHierarchy,
			{ group: ACTIVE_GROUP, preserveFocus: false });

		const disposables = new DisposableStore();
		const refresh = disposables.add(new RunOnceScheduler(() => this.pushData(), 1000));

		disposables.add(this.agentGraphService.onDidIngest(() => {
			if (!refresh.isScheduled()) {
				refresh.schedule();
			}
		}));

		disposables.add(this.current.webview.onMessage(async e => {
			const message = e.message as { type: string; path?: string };
			if (message.type === 'openFile' && typeof message.path === 'string') {
				try {
					await this.editorService.openEditor({ resource: URI.file(message.path) });
				} catch {
					// Non-file node keys (commands, tools) are not openable
				}
			} else if (message.type === 'ready' || message.type === 'refresh') {
				await this.pushData();
			}
		}));

		disposables.add(this.current.onWillDispose(() => {
			disposables.dispose();
			this.current = undefined;
		}));

		this.current.webview.setHtml(renderAgentGraphHtml());
	}

	private async pushData(): Promise<void> {
		if (!this.current) {
			return;
		}
		const [snapshot, sessions] = await Promise.all([
			this.agentGraphService.getGraph(),
			this.agentGraphService.getSessions()
		]);
		this.current.webview.postMessage({ type: 'graph', snapshot, sessions });
	}

}
