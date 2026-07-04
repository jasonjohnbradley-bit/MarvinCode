/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { FileAccess } from '../../../../base/common/network.js';
import { asWebviewUri, webviewGenericCspSource } from '../../webview/common/webview.js';

export const AGENT_GRAPH_MEDIA_ROOT = 'vs/workbench/contrib/agentGraph/electron-browser/media';

/** The HTML document shared by the graph editor tab and the sidebar view. */
export function renderAgentGraphHtml(): string {
	const mediaRoot = asWebviewUri(FileAccess.asFileUri(AGENT_GRAPH_MEDIA_ROOT));
	const csp = webviewGenericCspSource;
	return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${csp} 'unsafe-inline'; script-src ${csp};">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<link href="${mediaRoot}/graphView.css" rel="stylesheet">
	<title>Agent Graph</title>
</head>
<body>
	<div id="toolbar">
		<select id="sessionFilter"><option value="">All sessions</option></select>
		<label id="liveLabel"><input type="checkbox" id="liveToggle" checked> Live</label>
		<span id="stats"></span>
	</div>
	<div id="graph"></div>
	<script src="${mediaRoot}/vendor/layout-base.js"></script>
	<script src="${mediaRoot}/vendor/cose-base.js"></script>
	<script src="${mediaRoot}/vendor/cytoscape.min.js"></script>
	<script src="${mediaRoot}/vendor/cytoscape-fcose.js"></script>
	<script src="${mediaRoot}/graphView.js"></script>
</body>
</html>`;
}
