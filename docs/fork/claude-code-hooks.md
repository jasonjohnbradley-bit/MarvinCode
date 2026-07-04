# Streaming Claude Code sessions into the MarvinCode Agent Graph

MarvinCode's main process runs an ingest server on `http://127.0.0.1:48620/ingest`
(port configurable via the `agentGraph.ingestPort` setting). Claude Code can
stream everything it does into the graph using HTTP hooks — add this to
`~/.claude/settings.json` (merge with any existing `hooks` block):

```json
{
	"hooks": {
		"SessionStart": [{ "hooks": [{ "type": "http", "url": "http://127.0.0.1:48620/ingest", "async": true }] }],
		"SessionEnd": [{ "hooks": [{ "type": "http", "url": "http://127.0.0.1:48620/ingest", "async": true }] }],
		"UserPromptSubmit": [{ "hooks": [{ "type": "http", "url": "http://127.0.0.1:48620/ingest", "async": true }] }],
		"PostToolUse": [{ "hooks": [{ "type": "http", "url": "http://127.0.0.1:48620/ingest", "async": true }] }],
		"PostToolUseFailure": [{ "hooks": [{ "type": "http", "url": "http://127.0.0.1:48620/ingest", "async": true }] }],
		"SubagentStart": [{ "hooks": [{ "type": "http", "url": "http://127.0.0.1:48620/ingest", "async": true }] }],
		"SubagentStop": [{ "hooks": [{ "type": "http", "url": "http://127.0.0.1:48620/ingest", "async": true }] }]
	}
}
```

Notes:

- `async: true` keeps the hooks fire-and-forget: Claude Code never waits on
  MarvinCode, and if MarvinCode is not running the POST fails silently.
- `PreToolUse` is deliberately not hooked: `PostToolUse`/`PostToolUseFailure`
  carry the same tool information plus the outcome, and hooking only the
  "after" events halves the traffic.
- Events land in `<userData>/agentGraph/events.db` (SQLite). Inspect the
  latest ones in MarvinCode via **Agent Graph: Dump Recent Events**.
- The ingest server only binds `127.0.0.1` and accepts nothing but
  `POST /ingest` with a JSON body under 1 MB.
