/**
 * Graphify bundle — Host half.
 *
 * Registers model-facing tools that drive the local `graphify` CLI
 * (code knowledge graph) inside the Session's working directory, plus the
 * shared graph discovery helpers. The Client half (client.js) renders the
 * resulting graph.json in a right-sidebar tab; both halves read the same
 * `<project>/graphify-out/graph.json` convention, so no cross-half RPC is
 * needed: tools write the graph, the UI reads it.
 *
 * Tool definitions are registered as plain objects with raw JSON Schema
 * (the subset enforced by ToolsService: type/oneOf/properties/required/
 * additionalProperties/items/enum/const + annotations), so this bundle has
 * zero npm dependencies.
 *
 * @module @local/dsh-graphify
 */
import { readdir, stat, readFile } from 'node:fs/promises';
import { join, isAbsolute, relative, resolve } from 'node:path';

export const inject = ['tools', 'subprocess', 'workingDirectory'];

const COMMAND = 'graphify';
const MAX_STDOUT_BYTES = 1 << 20; // 1 MiB
const MAX_STDERR_BYTES = 256 << 10; // 256 KiB
const GRACE_MS = 5000;
const GRAPH_FILE = join('graphify-out', 'graph.json');
const MAX_GRAPH_PARSE_BYTES = 64 << 20; // 64 MiB; larger files are reported without counts
const DISCOVERY_MAX_DEPTH = 3;

/** Characters we never want a positional CLI argument to start with (option smuggling). */
function cleanPositional(name, value, maxLen = 1000) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  if (value.startsWith('-')) throw new TypeError(`${name} must not start with "-"`);
  if (value.length > maxLen) throw new TypeError(`${name} is longer than ${maxLen} characters`);
  return value;
}

function cleanFlaggedPath(name, value, cwd) {
  const v = cleanPositional(name, value, 500);
  if (/[\n\r\t]/.test(v)) throw new TypeError(`${name} must be a single path without line breaks`);
  return isAbsolute(v) ? resolve(v) : resolve(cwd, v);
}

function intOpt(name, value, min, max) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new TypeError(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

export function apply(ctx) {
  /** @type {string | null} */
  let cachedExecutable = null;

  async function graphifyPath(signal) {
    if (cachedExecutable !== null) return cachedExecutable;
    try {
      cachedExecutable = await ctx.subprocess.resolveExecutable(COMMAND, undefined, signal);
    } catch {
      // Common install location not on the scrubbed PATH: try the default uv tools bin dir.
      const home = process.env.HOME ?? process.env.USERPROFILE ?? '';
      const candidate = home ? join(home, '.local', 'bin', COMMAND) : '';
      if (!candidate) throw new Error(`\`${COMMAND}\` was not found on PATH`);
      cachedExecutable = await ctx.subprocess.resolveExecutable(candidate, undefined, signal);
    }
    return cachedExecutable;
  }

  async function workspaceOf(exec) {
    if (exec.agent) return await ctx.workingDirectory.ensure(exec.agent, exec.signal);
    return ctx.workingDirectory.defaultDirectory;
  }

  /**
   * Spawn one graphify run and collect its output.
   * @returns resolved facts: exitCode (null on signal), stdout, stderr.
   */
  async function run(args, cwd, signal) {
    const exe = await graphifyPath(signal);
    const handle = ctx.subprocess.spawn({
      argv: [exe, ...args],
      cwd,
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: MAX_STDOUT_BYTES },
        stderr: { maxBytes: MAX_STDERR_BYTES },
      },
      graceMs: GRACE_MS,
      signal,
    });
    const outcome = await handle.done;
    const stdout = handle.collected.stdout?.readFrom(0).text ?? '';
    const stderr = handle.collected.stderr?.readFrom(0).text ?? '';
    return { exitCode: outcome.exitCode, signal: outcome.signal, stdout, stderr };
  }

  /** List directories at `dir` that are worth descending into for discovery. */
  async function childDirs(dir) {
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      return entries
        .filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules')
        .map((e) => join(dir, e.name));
    } catch {
      return [];
    }
  }

  /**
   * Find every `<dir>/graphify-out/graph.json` under `cwd`, shallowest and
   * newest first. Used by status and to pick the default graph for queries.
   */
  async function discoverGraphs(cwd) {
    const found = [];
    const queue = [{ dir: cwd, depth: 0 }];
    while (queue.length > 0) {
      const { dir, depth } = queue.shift();
      const candidate = join(dir, GRAPH_FILE);
      try {
        const st = await stat(candidate);
        if (st.isFile()) found.push({ dir, graphJson: candidate, mtimeMs: st.mtimeMs, size: st.size });
      } catch { /* not here */ }
      if (depth < DISCOVERY_MAX_DEPTH) {
        for (const child of await childDirs(dir)) queue.push({ dir: child, depth: depth + 1 });
      }
    }
    found.sort((a, b) => a.dir.length - b.dir.length || b.mtimeMs - a.mtimeMs);
    return found;
  }

  /** Read node/link/community counts out of one graph.json. */
  async function graphCounts(graphJson) {
    try {
      const st = await stat(graphJson);
      if (st.size > MAX_GRAPH_PARSE_BYTES) {
        return { parsed: false, sizeBytes: st.size, mtimeMs: st.mtimeMs };
      }
      const g = JSON.parse(await readFile(graphJson, 'utf8'));
      const communities = new Set();
      for (const n of g.nodes ?? []) {
        if (n && n.community !== undefined) communities.add(n.community);
      }
      return {
        parsed: true,
        sizeBytes: st.size,
        mtimeMs: st.mtimeMs,
        nodes: (g.nodes ?? []).length,
        links: (g.links ?? []).length,
        communities: communities.size,
        version: g.graph?.graphify_version ?? null,
      };
    } catch {
      return { parsed: false };
    }
  }

  /** Human one-liner for a discovered graph, shared by status and post-update output. */
  function describeGraph(entry) {
    const c = entry.counts;
    const rel = relative(entry.dir, entry.dir) === '' ? '.' : entry.dir;
    if (!c.parsed) return `graph: ${entry.graphJson} (${c.sizeBytes ?? '?'} bytes)`;
    return `graph: ${entry.graphJson} — ${c.nodes} nodes, ${c.links} links, ${c.communities} communities, ` +
      `updated ${new Date(c.mtimeMs).toISOString()}, graphify ${c.version ?? '?'}`;
  }

  /** Resolve the project dir whose graphify-out to query (`path` arg, else auto-discover). */
  async function targetGraphDir(cwd, pathArg) {
    if (pathArg !== undefined && pathArg !== '') {
      const dir = cleanFlaggedPath('path', pathArg, cwd);
      const probe = join(dir, GRAPH_FILE);
      try {
        if ((await stat(probe)).isFile()) return { dir, graphJson: probe };
      } catch { /* fall through to error below */ }
      // Also accept a direct path to a graph.json file.
      if (dir.endsWith('graph.json')) {
        try {
          if ((await stat(dir)).isFile()) return { dir: resolve(dir, '..', '..'), graphJson: dir };
        } catch { /* ignore */ }
      }
      throw new Error(`no graphify-out/graph.json under ${dir} — run graphify_update first or pass the project path`);
    }
    const found = await discoverGraphs(cwd);
    if (found.length === 0) {
      throw new Error('no graphify-out/graph.json found under the working directory — call graphify_update first');
    }
    return { dir: found[0].dir, graphJson: found[0].graphJson };
  }

  /** Build one canonical command-result object; also the shape every tool returns. */
  function commandResult(r, extra) {
    const text = [r.stdout, r.stderr && r.stderr.trim() ? `--- stderr ---\n${r.stderr}` : '']
      .filter(Boolean).join('\n').trim();
    return { ok: r.exitCode === 0, exitCode: r.exitCode, signal: r.signal, text, ...extra };
  }

  const renderText = (_args, value) => [{ type: 'text', text: value?.text ?? JSON.stringify(value) }];
  const objectOutput = { schema: { type: 'object' }, render: renderText };

  /** Shared definition factory. */
  function tool(def) {
    return {
      output: objectOutput,
      presentCall: (args) => ({ card: 'generic', kind: def.write ? 'execute' : 'read', title: def.uiTitle ?? def.name, args }),
      ...def.spec,
    };
  }

  const tools = [
    tool({
      write: false,
      uiTitle: 'Graphify: status',
      spec: {
        name: 'graphify_status',
        description:
          'Report the graphify CLI and every knowledge graph found under the Session working directory ' +
          '(graph.json path, node/link/community counts, last update). Call this first; use graphify_update ' +
          'to build or refresh a graph. The Harness right-sidebar "Graphify" tab visualizes these graphs.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        timeoutMs: 30_000,
        async execute(_args, exec) {
          const cwd = await workspaceOf(exec);
          let cli = null;
          try {
            const exe = await graphifyPath(exec.signal);
            const probe = await run(['--version'], cwd, exec.signal);
            cli = { path: exe, version: probe.exitCode === 0 ? probe.stdout.trim() : null };
          } catch (error) {
            cli = { error: String(error?.message ?? error) };
          }
          const found = await discoverGraphs(cwd);
          const graphs = [];
          for (const entry of found.slice(0, 10)) {
            graphs.push({ project: entry.dir, graphJson: entry.graphJson, ...(await graphCounts(entry.graphJson)) });
          }
          const lines = [];
          lines.push(cli.error ? `graphify CLI: ${cli.error}` : `graphify CLI: ${cli.path}${cli.version ? ` (${cli.version})` : ''}`);
          lines.push(`working directory: ${cwd}`);
          if (graphs.length === 0) lines.push('no graphs found — run graphify_update <project-dir> to build one');
          for (const g of graphs) {
            lines.push(`- ${g.project}: ` + (g.parsed
              ? `${g.nodes} nodes, ${g.links} links, ${g.communities} communities, updated ${new Date(g.mtimeMs).toISOString()}`
              : `graph.json present (${g.sizeBytes ?? '?'} bytes)`));
          }
          return { ok: true, exitCode: 0, text: lines.join('\n'), cwd, cli, graphs };
        },
      },
    }),
    tool({
      write: true,
      uiTitle: 'Graphify: update graph',
      spec: {
        name: 'graphify_update',
        description:
          'Build or refresh a code knowledge graph: `graphify update <path>` (AST extraction, no LLM needed). ' +
          'Writes <path>/graphify-out/graph.json and regenerates graph.html + GRAPH_REPORT.md. Use --no-cluster ' +
          'for the fastest raw pass, --force after refactors that deleted files. On large folders this can take ' +
          'several minutes. After it finishes, tell the user they can open the "Graphify" tab in the right sidebar ' +
          'and press Refresh to see the graph.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Project directory to index (default: "." = Session working directory).' },
            force: { type: 'boolean', description: 'Overwrite graph.json even if the rebuild has fewer nodes (--force).' },
            no_cluster: { type: 'boolean', description: 'Skip community clustering, write raw extraction only (--no-cluster).' },
          },
          additionalProperties: false,
        },
        timeoutMs: 600_000,
        async execute(args, exec) {
          const cwd = await workspaceOf(exec);
          const target = args.path === undefined ? '.' : cleanFlaggedPath('path', args.path, cwd);
          const argv = ['update', target];
          if (args.force === true) argv.push('--force');
          if (args.no_cluster === true) argv.push('--no-cluster');
          const r = await run(argv, cwd, exec.signal);
          const projectDir = target === '.' ? cwd : target;
          const entry = { dir: projectDir, graphJson: join(projectDir, GRAPH_FILE), ...(await stat(join(projectDir, GRAPH_FILE)).catch(() => ({}))) };
          const counts = r.exitCode === 0 ? await graphCounts(entry.graphJson) : { parsed: false };
          const extra = r.exitCode === 0 && counts.parsed
            ? { nodes: counts.nodes, links: counts.links, communities: counts.communities, graphJson: entry.graphJson }
            : {};
          const note = r.exitCode === 0 && counts.parsed
            ? `\n${describeGraph({ ...entry, counts })}\nThe Graphify sidebar tab (right sidebar) shows this graph after Refresh.`
            : '';
          return commandResult(r, { extra, note, text: r.stdout + note, hint: r.exitCode === 0 ? undefined : 'graphify update failed — check stderr above' });
        },
      },
    }),
    tool({
      write: false,
      uiTitle: 'Graphify: query',
      spec: {
        name: 'graphify_query',
        description:
          'Ask a keyword question against the code graph: BFS traversal (`graphify query`). Returns related ' +
          'nodes/edges as text. Exit 0 = answer, 3 = ambiguous (candidates listed), 4 = no match. ' +
          'Needs a graph built by graphify_update.',
        parameters: {
          type: 'object',
          properties: {
            question: { type: 'string', description: 'Keywords to search the graph for.' },
            depth: { type: 'integer', description: 'Traversal depth 1-6 (default 2).' },
            budget: { type: 'integer', description: 'Output token budget (default 2000).' },
            seeds: {
              type: 'array', items: { type: 'string' },
              description: 'Explicit start nodes (id, label or file path); repeatable --seed.',
            },
            dfs: { type: 'boolean', description: 'Depth-first instead of breadth-first.' },
            path: { type: 'string', description: 'Project directory holding graphify-out (default: auto-discover under the working directory).' },
          },
          required: ['question'],
          additionalProperties: false,
        },
        timeoutMs: 60_000,
        isConcurrencySafe: () => true,
        async execute(args, exec) {
          const cwd = await workspaceOf(exec);
          const question = cleanPositional('question', args.question);
          const argv = ['query', question];
          const graph = targetGraphDir(cwd, args.path);
          const g = await graph;
          argv.push('--graph', g.graphJson);
          const d = intOpt('depth', args.depth, 1, 6); if (d !== undefined) argv.push('--depth', String(d));
          const b = intOpt('budget', args.budget, 100, 100_000); if (b !== undefined) argv.push('--budget', String(b));
          if (args.dfs === true) argv.push('--dfs');
          for (const s of args.seeds ?? []) argv.push('--seed', cleanPositional('seed', s, 300));
          const r = await run(argv, cwd, exec.signal);
          const meaning = { 0: 'answer found', 3: 'ambiguous — candidate nodes are listed', 4: 'no matching node' }[r.exitCode] ?? null;
          return commandResult(r, { graphJson: g.graphJson, exitMeaning: meaning });
        },
      },
    }),
    tool({
      write: false,
      uiTitle: 'Graphify: path',
      spec: {
        name: 'graphify_path',
        description: 'Shortest path between two graph nodes (`graphify path "A" "B"`). Names may be ids, labels or file paths; exit 3 means a name was ambiguous.',
        parameters: {
          type: 'object',
          properties: {
            from: { type: 'string', description: 'Start node.' },
            to: { type: 'string', description: 'End node.' },
            undirected: { type: 'boolean', description: 'Ignore edge direction.' },
            path: { type: 'string', description: 'Project directory holding graphify-out (default: auto-discover).' },
          },
          required: ['from', 'to'],
          additionalProperties: false,
        },
        timeoutMs: 60_000,
        isConcurrencySafe: () => true,
        async execute(args, exec) {
          const cwd = await workspaceOf(exec);
          const g = await targetGraphDir(cwd, args.path);
          const argv = ['path', cleanPositional('from', args.from, 300), cleanPositional('to', args.to, 300),
            '--graph', g.graphJson];
          if (args.undirected === true) argv.push('--undirected');
          const r = await run(argv, cwd, exec.signal);
          const meaning = { 0: 'path found', 3: 'ambiguous name', 4: 'no path / no match' }[r.exitCode] ?? null;
          return commandResult(r, { graphJson: g.graphJson, exitMeaning: meaning });
        },
      },
    }),
    tool({
      write: false,
      uiTitle: 'Graphify: explain',
      spec: {
        name: 'graphify_explain',
        description: 'Plain-language explanation of one node and its neighbors (`graphify explain "X"`). Default shows the 20 most connected neighbors; all=true shows every connection.',
        parameters: {
          type: 'object',
          properties: {
            node: { type: 'string', description: 'Node id, label or file path.' },
            all: { type: 'boolean', description: 'List every connection (--all).' },
            path: { type: 'string', description: 'Project directory holding graphify-out (default: auto-discover).' },
          },
          required: ['node'],
          additionalProperties: false,
        },
        timeoutMs: 60_000,
        isConcurrencySafe: () => true,
        async execute(args, exec) {
          const cwd = await workspaceOf(exec);
          const g = await targetGraphDir(cwd, args.path);
          const argv = ['explain', cleanPositional('node', args.node, 300), '--graph', g.graphJson];
          if (args.all === true) argv.push('--all');
          const r = await run(argv, cwd, exec.signal);
          return commandResult(r, { graphJson: g.graphJson });
        },
      },
    }),
    tool({
      write: false,
      uiTitle: 'Graphify: affected',
      spec: {
        name: 'graphify_affected',
        description: 'Reverse traversal: which nodes are impacted by a node (`graphify affected "X"`) — use for blast-radius questions before editing code.',
        parameters: {
          type: 'object',
          properties: {
            node: { type: 'string', description: 'Node id, label or file path.' },
            relations: { type: 'array', items: { type: 'string' }, description: 'Edge relations to traverse in reverse (repeatable --relation).' },
            depth: { type: 'integer', description: 'Reverse traversal depth (default 2).' },
            path: { type: 'string', description: 'Project directory holding graphify-out (default: auto-discover).' },
          },
          required: ['node'],
          additionalProperties: false,
        },
        timeoutMs: 60_000,
        isConcurrencySafe: () => true,
        async execute(args, exec) {
          const cwd = await workspaceOf(exec);
          const g = await targetGraphDir(cwd, args.path);
          const argv = ['affected', cleanPositional('node', args.node, 300), '--graph', g.graphJson];
          for (const rel of args.relations ?? []) argv.push('--relation', cleanPositional('relation', rel, 100));
          const d = intOpt('depth', args.depth, 1, 6); if (d !== undefined) argv.push('--depth', String(d));
          const r = await run(argv, cwd, exec.signal);
          return commandResult(r, { graphJson: g.graphJson });
        },
      },
    }),
    tool({
      write: false,
      uiTitle: 'Graphify: god nodes',
      spec: {
        name: 'graphify_god_nodes',
        description: 'List the most connected nodes (architectural hubs, `graphify god-nodes --json`).',
        parameters: {
          type: 'object',
          properties: {
            top: { type: 'integer', description: 'How many hubs to show (default 10).' },
            path: { type: 'string', description: 'Project directory holding graphify-out (default: auto-discover).' },
          },
          additionalProperties: false,
        },
        timeoutMs: 60_000,
        isConcurrencySafe: () => true,
        async execute(args, exec) {
          const cwd = await workspaceOf(exec);
          const g = await targetGraphDir(cwd, args.path);
          const argv = ['god-nodes', '--json', '--graph', g.graphJson];
          const t = intOpt('top', args.top, 1, 200); if (t !== undefined) argv.push('--top', String(t));
          const r = await run(argv, cwd, exec.signal);
          return commandResult(r, { graphJson: g.graphJson });
        },
      },
    }),
    tool({
      write: false,
      uiTitle: 'Graphify: diagnose',
      spec: {
        name: 'graphify_diagnose',
        description: 'Structural diagnostics of the current graph (`graphify diagnose multigraph --json`): same-endpoint edge-collapse risk, isolated nodes, version. Useful after an update.',
        parameters: {
          type: 'object',
          properties: {
            max_examples: { type: 'integer', description: 'Max same-endpoint examples to print (default 5).' },
            path: { type: 'string', description: 'Project directory holding graphify-out (default: auto-discover).' },
          },
          additionalProperties: false,
        },
        timeoutMs: 60_000,
        isConcurrencySafe: () => true,
        async execute(args, exec) {
          const cwd = await workspaceOf(exec);
          const g = await targetGraphDir(cwd, args.path);
          const argv = ['diagnose', 'multigraph', '--json', '--graph', g.graphJson];
          const m = intOpt('max_examples', args.max_examples, 1, 100); if (m !== undefined) argv.push('--max-examples', String(m));
          const r = await run(argv, cwd, exec.signal);
          return commandResult(r, { graphJson: g.graphJson });
        },
      },
    }),
  ];

  for (const definition of tools) {
    ctx.effect(() => ctx.tools.register(definition), `graphify.tool.${definition.name}`);
  }
}
