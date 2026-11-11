# dsh-graphify

[Graphify](https://pypi.org/project/graphifyy/) integration for [DeepSeek Harness](https://deepseek-ai.github.io/) (DSH): gives the coding agent a full set of `graphify_*` tools and adds an interactive **Graphify tab** to the Harness Web UI that visualizes the knowledge graph of the current workspace.

One Cordis bundle, two halves:

- **Host half** — eight agent tools wrapping the `graphify` CLI, executed in the session's working directory via the harness subprocess service.
- **Client half** — a right-sidebar tab in the Web UI that renders `graphify-out/graph.json` / `graph.html` of the session workspace. No iframe of harness pages, no extra server: files are read through the existing `workspaceFiles` remote and drawn locally.

## Requirements

- [DeepSeek Harness](https://deepseek-ai.github.io/) (the `dsh` runtime) with the Web UI.
- `graphify` on `PATH` (e.g. `uv tool install graphifyy`) or at `~/.local/bin/graphify`.
- A graph built once per project: ask the agent `run graphify update .` (or run the CLI yourself). Every run writes `graphify-out/graph.json` (and `graph.html` unless `--no-viz`).

## Install

1. Clone this repository anywhere on the machine running the harness:

   ```bash
   git clone https://github.com/b-iurea/dsh-graphify.git
   ```

2. Install the bundle into your harness profile — ask your DSH agent (or use the plugin manager):

   > install the bundle at /absolute/path/to/dsh-graphify

   which runs `plugin_manager` → `install_bundle` with that path. The package installs as a `link:`, so the clone stays your edit source.

3. Refresh the browser. The tab appears in the right sidebar (also as "Code graph" on the tab guide page); the tools are live immediately.

Uninstall with `plugin_manager remove_bundle` (or ask the agent).

## Agent tools

| Tool | Wraps | Notes |
| --- | --- | --- |
| `graphify_status` | (fs + `--version`) | working dir, graph files, node/edge/community counts, age |
| `graphify_update` | `graphify update <path>` | re-extracts code (no LLM); `force`, `no_cluster` args; 10-min timeout |
| `graphify_query` | `graphify query "<question>"` | BFS over the graph; passes through exit codes (0 answer, 3 ambiguous, 4 no match) |
| `graphify_path` | `graphify path "A" "B"` | shortest path between two nodes; `undirected` arg |
| `graphify_explain` | `graphify explain "X"` | node + neighbors; `all` arg |
| `graphify_affected` | `graphify affected "X"` | reverse traversal / blast radius; `relation`, `depth` args |
| `graphify_god_nodes` | `graphify god-nodes` | most-connected hubs, JSON |
| `graphify_diagnose` | `graphify diagnose multigraph` | structural diagnostics, JSON |

All tools default `path`/`graph` args to the session's working directory and discover `graphify-out/graph.json` up to three levels deep; positional args are sanitized (no option smuggling), and every tool reports a clean error when no graph exists yet, suggesting `graphify update .`.

## Graph tab

- **HTML view (default when `graph.html` exists)** — serves graphify's own vis-network visualization in a sandboxed `<iframe>` (`allow-scripts`, opaque origin). Because sandboxed frames throw on `localStorage`, the plugin injects a tiny in-memory shim before the page scripts so the graph's own theme toggle keeps working. First load needs internet access (vis-network comes from unpkg, then it is browser-cached).
- **SVG view (built-in, always available)** — a dependency-free force-directed renderer: community colours, pan/drag/zoom, click-for-details with neighbour list, search box, community drill-down for large graphs (aggregates to communities above ~450 nodes), and it follows the harness light/dark theme.
- Bar controls: project selector (multi-root workspaces), search (SVG view), HTML/SVG switch, Refresh, stats.
- Refresh re-reads everything, so a `graphify update` by the agent is one click away from the new graph.

## Development

The clone is `link:`-installed, so editing files edits the plugin:

- `client.js` changes are picked up automatically (the harness hot-reload poller recomposes client bundles and notifies open pages — F5 is enough).
- `index.js` (host half) changes require a harness restart / new session activation.
- The ModuleLoader id in `client.js` **must stay equal to the package name** (`@local/dsh-graphify`): the composition row id is the package name, and a mismatch silently skips registration.

Only Node/React-as-provided APIs are used: both halves are dependency-free (no npm installs, no JSX, no d3).

## Layout

```
package.json      bundle manifest (dsh.bundle.patch + dsh.client)
cordis.patch.yml  profile patch row inserted at install
index.js          host half: 8 graphify_* tools
client.js         client half: Graphify right-sidebar tab (HTML + SVG views)
locale/en.json    bundle metadata (en)
locale/it.json    bundle metadata (it)
icon.svg          bundle icon
```

## License

MIT © 2026 b-iurea
