/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize, localize2 } from '../../../../nls.js';
import { Categories } from '../../../../platform/action/common/actionCommonCategories.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { AGENT_GRAPH_CHANNEL, IAgentGraphService } from '../../../../platform/agentGraph/common/agentGraph.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { registerMainProcessRemoteService } from '../../../../platform/ipc/electron-browser/services.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { ChatAgentGraphListener } from './chatAgentGraphListener.js';

registerMainProcessRemoteService(IAgentGraphService, AGENT_GRAPH_CHANNEL);

registerWorkbenchContribution2(ChatAgentGraphListener.ID, ChatAgentGraphListener, WorkbenchPhase.AfterRestored);

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'agentGraph',
	title: localize('agentGraphConfigurationTitle', "Agent Graph"),
	type: 'object',
	properties: {
		'agentGraph.ingestPort': {
			type: 'number',
			default: 48620,
			scope: ConfigurationScope.APPLICATION,
			description: localize('agentGraph.ingestPort', "Localhost port the agent-event ingest server listens on. External agents (for example Claude Code hooks) POST events to http://127.0.0.1:<port>/ingest. Requires a restart.")
		}
	}
});

class DumpRecentAgentEventsAction extends Action2 {
	constructor() {
		super({
			id: 'agentGraph.dumpRecent',
			title: localize2('agentGraph.dumpRecent', "Agent Graph: Dump Recent Events"),
			category: Categories.Developer,
			f1: true
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const agentGraphService = accessor.get(IAgentGraphService);
		const notificationService = accessor.get(INotificationService);
		const events = await agentGraphService.getRecentEvents(20);
		console.log('[agentGraph] recent events', events);
		if (events.length === 0) {
			notificationService.info(localize('agentGraph.noEvents', "Agent Graph: no events stored yet."));
			return;
		}
		const lines = events.map(event => {
			const objects = event.objects.map(object => object.label).join(', ');
			return `${new Date(event.ts).toLocaleTimeString()} [${event.source}] ${event.verb}${objects ? ` → ${objects}` : ''}`;
		});
		notificationService.info(localize('agentGraph.recentEvents', "Agent Graph: {0} recent events (newest first, details in dev console):\n{1}", events.length, lines.slice(0, 8).join('\n')));
	}
}

registerAction2(DumpRecentAgentEventsAction);
