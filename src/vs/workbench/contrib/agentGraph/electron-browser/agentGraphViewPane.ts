/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { getWindow } from '../../../../base/browser/dom.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { FileAccess } from '../../../../base/common/network.js';
import { URI } from '../../../../base/common/uri.js';
import { IAgentGraphService } from '../../../../platform/agentGraph/common/agentGraph.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { ViewPane } from '../../../browser/parts/views/viewPane.js';
import { IViewletViewOptions } from '../../../browser/parts/views/viewsViewlet.js';
import { IViewDescriptorService } from '../../../common/views.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IWebviewElement, IWebviewService } from '../../webview/browser/webview.js';
import { AGENT_GRAPH_MEDIA_ROOT, renderAgentGraphHtml } from './agentGraphWebview.js';

/** Sidebar view hosting the knowledge graph, opened from the activity bar. */
export class AgentGraphViewPane extends ViewPane {

	static readonly ID = 'agentGraph.graphView';

	private webview: IWebviewElement | undefined;

	constructor(
		options: IViewletViewOptions,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IKeybindingService keybindingService: IKeybindingService,
		@IOpenerService openerService: IOpenerService,
		@IHoverService hoverService: IHoverService,
		@IThemeService themeService: IThemeService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IWebviewService private readonly webviewService: IWebviewService,
		@IAgentGraphService private readonly agentGraphService: IAgentGraphService,
		@IEditorService private readonly editorService: IEditorService
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		container.style.height = '100%';

		const webview = this._register(this.webviewService.createWebviewElement({
			title: this.title,
			options: {},
			contentOptions: {
				allowScripts: true,
				localResourceRoots: [FileAccess.asFileUri(AGENT_GRAPH_MEDIA_ROOT)]
			},
			extension: undefined
		}));
		this.webview = webview;
		webview.mountTo(container, getWindow(container));

		const refresh = this._register(new RunOnceScheduler(() => this.pushData(), 1000));
		this._register(this.agentGraphService.onDidIngest(() => {
			if (!refresh.isScheduled()) {
				refresh.schedule();
			}
		}));

		this._register(webview.onMessage(async e => {
			const message = e.message as { type: string; path?: string };
			if (message.type === 'openFile' && typeof message.path === 'string') {
				try {
					await this.editorService.openEditor({ resource: URI.file(message.path) });
				} catch {
					// Non-file node keys are not openable
				}
			} else if (message.type === 'ready' || message.type === 'refresh') {
				await this.pushData();
			}
		}));

		webview.setHtml(renderAgentGraphHtml());
	}

	private async pushData(): Promise<void> {
		if (!this.webview) {
			return;
		}
		const [snapshot, sessions] = await Promise.all([
			this.agentGraphService.getGraph(),
			this.agentGraphService.getSessions()
		]);
		this.webview.postMessage({ type: 'graph', snapshot, sessions });
	}
}
