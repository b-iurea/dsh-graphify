/**
 * Graphify bundle — Client half: the "Graphify" right-sidebar tab.
 *
 * Reads every `<project>/graphify-out/graph.json` visible in the Session
 * workspace through the workspaceFiles remote, lays the graph out with a
 * small self-written force simulation, and renders it as an interactive
 * SVG: pan/zoom, drag, search, click-for-details, community colors, and
 * automatic community-level aggregation above NODE_LIMIT (the same idea
 * graphify's own graph.html uses). "Refresh" re-stats the files, so a graph
 * rebuilt by the graphify_update tool shows up with one click.
 *
 * React renders only the tab chrome; the graph itself is managed
 * imperatively for speed (thousands of SVG nodes repositioned per drag).
 * No JSX, no npm dependencies — plain ESM via window.__ModuleLoader__.
 *
 * @module @local/dsh-graphify
 */
(function () {
  'use strict';
  var mod = window.__ModuleLoader__;
  if (!mod || typeof mod.load !== 'function') return;
  mod.load({
    id: '@local/dsh-graphify',
    factory: function (require) {
      var React = require('react');
      var exports = {};

      var NS = 'graphifyTab';
      var TAB_ID = '@local/dsh-graphify';
      var TAB_KIND = 'graphify-graph';

      var CHUNK_BYTES = 1 << 20;   // 1 MiB byte-window per readBytes call
      var MAX_FILE_BYTES = 48 << 20; // refuse graphs above 48 MiB
      var NODE_LIMIT = 450;        // per view: above this, aggregate or subsample
      var EDGE_RENDER_LIMIT = 3000;
      var LABEL_LIMIT = 260;       // show text labels only for small views
      var PREHEAT_TICKS = 90;

      var COPY = {
        en: {
          'title': 'Graphify',
          'guide.title': 'Code graph',
          'guide.desc': 'Interactive view of the graphify knowledge graph of this workspace.',
          'refresh': 'Refresh',
          'loading': 'Loading graph…',
          'parse.error': 'Could not parse graph.json',
          'read.error': 'Could not read the graph',
          'empty.title': 'No graph in this workspace yet',
          'empty.body': 'Ask the agent to “run graphify update .”, then press Refresh.',
          'search': 'Search nodes…',
          'agg.note': 'Too many nodes to show individually — communities are shown; click one to drill in.',
          'all.communities': 'All communities',
          'neighbors': 'Connections',
          'community': 'community',
          'degree': 'links',
          'members': 'members',
          'edges': 'edges',
          'nodes': 'nodes',
          'communities': 'communities',
          'tip': 'drag to pan · scroll to zoom · click a node for details',
          'mode.html.missing': 'graph.html not found — SVG view only',
        },
        it: {
          'title': 'Graphify',
          'guide.title': 'Grafo del codice',
          'guide.desc': 'Vista interattiva del grafo di conoscenza graphify di questo workspace.',
          'refresh': 'Aggiorna',
          'loading': 'Caricamento del grafo…',
          'parse.error': 'Impossibile analizzare graph.json',
          'read.error': 'Impossibile leggere il grafo',
          'empty.title': 'Nessun grafo in questo workspace',
          'empty.body': 'Chiedi all’agente di “eseguire graphify update .”, poi premi Aggiorna.',
          'search': 'Cerca nodi…',
          'agg.note': 'Troppi nodi per mostrarli singolarmente: vedi le comunità, cliccane una per esplorarla.',
          'all.communities': 'Tutte le comunità',
          'neighbors': 'Connessioni',
          'community': 'comunità',
          'degree': 'link',
          'members': 'membri',
          'edges': 'archi',
          'nodes': 'nodi',
          'communities': 'comunità',
          'tip': 'trascina per panoramizzare · rotella per zoom · clic su un nodo per i dettagli',
          'mode.html.missing': 'graph.html non trovato — solo vista SVG',
        },
      };

      var CSS = [
        '.gfp-pane{position:absolute;inset:0;display:flex;flex-direction:column;overflow:hidden;' +
          'background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:13px/1.4 system-ui,-apple-system,sans-serif;}',
        '.gfp-bar{display:flex;align-items:center;gap:8px;padding:8px 10px;flex-wrap:wrap;' +
          'border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);}',
        '.gfp-bar select,.gfp-bar input{font:inherit;color:inherit;background:var(--dsw-alias-bg-base);' +
          'border:1px solid var(--dsw-alias-border-l1);border-radius:6px;padding:3px 7px;min-width:0;}',
        '.gfp-search{flex:1 1 120px;max-width:200px;}',
        '.gfp-btn{font:inherit;color:inherit;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);' +
          'border-radius:6px;padding:3px 10px;cursor:pointer;}',
        '.gfp-btn:hover{border-color:var(--dsw-alias-brand-primary);}',
        '.gfp-btn:disabled{opacity:.5;cursor:default;}',
        '.gfp-stat{margin-left:auto;color:var(--dsw-alias-label-secondary);font-size:11.5px;white-space:nowrap;}',
        '.gfp-stage{position:relative;flex:1;min-height:0;overflow:hidden;}',
        '.gfp-canvas{position:absolute;inset:0;}',
        '.gfp-stage svg{position:absolute;inset:0;width:100%;height:100%;display:block;touch-action:none;cursor:grab;}',
        '.gfp-frame{position:absolute;inset:0;width:100%;height:100%;border:0;display:block;background:var(--dsw-alias-bg-base);}',
        '.gfp-seg{display:inline-flex;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;overflow:hidden;}',
        '.gfp-seg button{font:inherit;font-size:11.5px;padding:3px 9px;background:var(--dsw-alias-bg-layer-1);' +
          'color:var(--dsw-alias-label-secondary);border:0;cursor:pointer;}',
        '.gfp-seg button.on{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);}',
        '.gfp-seg button:disabled{opacity:.45;cursor:default;}',
        '.gfp-note{position:absolute;top:8px;left:10px;right:10px;color:var(--dsw-alias-label-secondary);' +
          'font-size:11.5px;pointer-events:none;text-shadow:0 1px 2px var(--dsw-alias-bg-base);}',
        '.gfp-mid{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:var(--dsw-alias-label-secondary);}',
        '.gfp-mid .box{display:flex;align-items:center;gap:9px;}',
        '.gfp-spin{width:15px;height:15px;border:2px solid var(--dsw-alias-border-l2);border-top-color:var(--dsw-alias-brand-primary);' +
          'border-radius:50%;animation:gfp-rot .8s linear infinite;}',
        '@keyframes gfp-rot{to{transform:rotate(360deg)}}',
        '.gfp-empty{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;' +
          'gap:6px;padding:28px;text-align:center;color:var(--dsw-alias-label-secondary);}',
        '.gfp-empty b{color:var(--dsw-alias-label-primary);font-size:14px;}',
        '.gfp-card{position:absolute;right:10px;top:38px;width:240px;max-height:calc(100% - 48px);overflow:auto;' +
          'background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l2);border-radius:10px;' +
          'padding:10px 12px;box-shadow:0 6px 22px rgba(0,0,0,.28);}',
        '.gfp-card h4{margin:0 22px 2px 0;font-size:13px;overflow-wrap:anywhere;}',
        '.gfp-card .sub{color:var(--dsw-alias-label-secondary);font-size:11.5px;overflow-wrap:anywhere;}',
        '.gfp-card .sec{margin:9px 0 3px;color:var(--dsw-alias-label-secondary);font-size:10.5px;' +
          'text-transform:uppercase;letter-spacing:.4px;}',
        '.gfp-card ul{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:2px;}',
        '.gfp-card li button{display:block;width:100%;text-align:left;border:0;background:none;cursor:pointer;' +
          'color:var(--dsw-alias-brand-primary);font:11.5px ui-monospace,SFMono-Regular,monospace;padding:1px 0;' +
          'overflow-wrap:anywhere;}',
        '.gfp-card li button:hover{text-decoration:underline;}',
        '.gfp-card li .rel{color:var(--dsw-alias-label-secondary);}',
        '.gfp-x{position:absolute;right:6px;top:6px;border:0;background:none;color:var(--dsw-alias-label-secondary);' +
          'font-size:15px;line-height:1;cursor:pointer;padding:2px 6px;}',
        '.gfp-legend{position:absolute;left:10px;bottom:10px;width:200px;max-height:44%;overflow:auto;' +
          'background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l1);border-radius:10px;' +
          'padding:8px 10px;display:flex;flex-direction:column;gap:3px;}',
        '.gfp-legend button{display:flex;align-items:center;gap:7px;border:0;background:none;padding:0;cursor:pointer;' +
          'font:11.5px system-ui,sans-serif;color:var(--dsw-alias-label-secondary);min-width:0;text-align:left;}',
        '.gfp-legend button:hover,.gfp-legend button.on{color:var(--dsw-alias-label-primary);}',
        '.gfp-legend i{flex:none;width:10px;height:10px;border-radius:3px;}',
        '.gfp-legend span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
        'g.gfp-node{cursor:pointer;}',
        'g.gfp-node circle{stroke-width:.6;stroke:rgba(0,0,0,.4);}',
        'g.gfp-node.sel circle{stroke:var(--dsw-alias-brand-primary);stroke-width:2.4;}',
        'g.gfp-node.faded{opacity:.14;}',
        'text.gfp-lbl{font-size:9px;fill:var(--dsw-alias-label-primary);pointer-events:none;text-anchor:middle;' +
          'paint-order:stroke;stroke:var(--dsw-alias-bg-base);stroke-width:2.5px;}',
        'line.gfp-edge{stroke:var(--dsw-alias-border-l2);}',
        'text.gfp-elabel{font-size:10px;fill:var(--dsw-alias-label-primary);paint-order:stroke;' +
          'stroke:var(--dsw-alias-bg-base);stroke-width:3px;text-anchor:middle;pointer-events:none;}',
      ].join('\n');
      if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css="' + TAB_ID + '"]') === null) {
        var styleEl = document.createElement('style');
        styleEl.setAttribute('data-plugin-css', TAB_ID);
        styleEl.textContent = CSS;
        document.head.appendChild(styleEl);
      }

      // ---------------------------------------------------------- helpers
      function svgEl(name, attrs) {
        var el = document.createElementNS('http://www.w3.org/2000/svg', name);
        for (var k in attrs) if (Object.prototype.hasOwnProperty.call(attrs, k)) el.setAttribute(k, attrs[k]);
        return el;
      }
      function truncate(s, n) { return s.length > n ? s.slice(0, n - 1) + '…' : s; }
      function hue(community) { return ((community * 137.508) % 360); }
      function nodeColor(community, dark) {
        return 'hsl(' + hue(community).toFixed(1) + ' ' + (dark ? '58%' : '48%') + ' ' + (dark ? '60%' : '42%') + ')';
      }

      /** Read one whole file through the chunked byte window. */
      async function readWholeFile(remote, sessionId, path, signal) {
        var chunks = [];
        var offset = 0;
        var chunk = CHUNK_BYTES;
        for (;;) {
          if (signal && signal.aborted) throw new Error('aborted');
          var res = await remote.workspaceFiles.readBytes(sessionId, path, { range: { offset: offset, length: chunk } }, signal);
          if (!res.ok) {
            var msg = (res.error && res.error.message) || 'read failed';
            // The Host caps one readBytes window (e.g. 2 MiB); adapt and retry
            // the same offset instead of failing when our window is too big.
            var capMatch = /exceed(?:s)?\s+(?:\d+\s+bytes?\s+of\s+)?["']?[^"']*?(\d+)\s+byte(?:s)?\s+cap/i.exec(msg);
            if (capMatch && chunk > Number(capMatch[1])) {
              chunk = Math.max(64 << 10, Number(capMatch[1]));
              continue;
            }
            var e = new Error(msg); e.code = res.error && res.error.code; throw e;
          }
          var data = res.value.data;
          var bytes = typeof data === 'string' ? (function () { var a = new Uint8Array(data.length); for (var i = 0; i < data.length; i++) a[i] = data.charCodeAt(i) & 0xff; return a; })() : data;
          if (bytes.length === 0) break;
          chunks.push(bytes);
          offset += bytes.length;
          if (offset > MAX_FILE_BYTES) throw new Error('graph.json exceeds ' + (MAX_FILE_BYTES >> 20) + ' MiB');
          if (res.value.eof) break;
        }
        var buf = new Uint8Array(offset);
        var p = 0;
        for (var c = 0; c < chunks.length; c++) { buf.set(chunks[c], p); p += chunks[c].length; }
        return new TextDecoder('utf-8').decode(buf);
      }

      /** Make graph.html runnable inside an opaque-origin sandboxed iframe: its
       *  theme persistence uses localStorage, which THROWS there — shadow it
       *  with an in-memory stub via a shim that runs before the page scripts. */
      function patchGraphHtml(text) {
        var shim = '<script>(function(){try{var s=new Map();Object.defineProperty(window,"localStorage",' +
          '{configurable:true,value:{getItem:function(k){k=String(k);return s.has(k)?s.get(k):null;},' +
          'setItem:function(k,v){s.set(String(k),String(v));},removeItem:function(k){s.delete(String(k));},' +
          'clear:function(){s.clear();},key:function(i){var a=Array.from(s.keys());return i<a.length?a[i]:null;},length:0}});}catch(e){}})();</script>';
        return text.replace(/<head[^>]*>/i, function (m) { return m + shim; });
      }

      /** Session workspace paths of every project holding graphify-out/graph.json. */
      async function discoverGraphs(remote, sessionId, signal) {
        var probes = ['graphify-out/graph.json'];
        try {
          var top = await remote.workspaceFiles.list(sessionId, '', signal);
          if (top.ok) {
            var entries = top.value.entries || [];
            for (var i = 0; i < entries.length && i < 80; i++) {
              var ent = entries[i];
              if (!ent || ent.type !== 'directory') continue;
              var name = ent.name;
              if (!name || name.charAt(0) === '.' || name === 'node_modules') continue;
              probes.push(name + '/graphify-out/graph.json');
            }
          }
        } catch (err) { /* fall back to root probe only */ }
        var found = [];
        for (var j = 0; j < probes.length; j++) {
          if (signal && signal.aborted) break;
          try {
            var st = await remote.workspaceFiles.stat(sessionId, probes[j], signal);
            if (st && st.ok) {
              var rec = { file: probes[j], bytes: st.value.bytes, version: st.value.version, htmlFile: null };
              var htmlPath = probes[j].slice(0, -'graph.json'.length) + 'graph.html';
              try {
                var sth = await remote.workspaceFiles.stat(sessionId, htmlPath, signal);
                if (sth && sth.ok) rec.htmlFile = htmlPath;
              } catch (err2) { /* no HTML view for this project */ }
              found.push(rec);
            }
          } catch (err) { /* not here */ }
        }
        return found;
      }

      // ---------------------------------------------------- force layout
      function forceLayout(nodes, links, w, h) {
        var n = nodes.length;
        if (n === 0) return;
        var idx = new Map();
        for (var i = 0; i < n; i++) {
          idx.set(nodes[i].id, i);
          var a = i * 2.39996;
          var r = Math.min(w, h) * 0.44 * Math.sqrt((i + 0.5) / n);
          nodes[i].x = w / 2 + r * Math.cos(a);
          nodes[i].y = h / 2 + r * Math.sin(a);
          nodes[i].vx = 0; nodes[i].vy = 0;
        }
        var pairs = [];
        for (var k = 0; k < links.length; k++) {
          var s = idx.get(links[k].s), t = idx.get(links[k].t);
          if (s === undefined || t === undefined || s === t) continue;
          pairs.push(s, t);
        }
        var rep = Math.max(320, 1600 - n * 1.6);
        var cutoff = Math.min(w, h) * 0.6, cutoff2 = cutoff * cutoff;
        var alpha = 1;
        for (var tick = 0; tick < PREHEAT_TICKS; tick++) {
          for (var p = 0; p < n; p++) {
            var A = nodes[p];
            for (var q = p + 1; q < n; q++) {
              var B = nodes[q];
              var dx = B.x - A.x, dy = B.y - A.y;
              var d2 = dx * dx + dy * dy;
              if (d2 > cutoff2) continue;
              if (d2 < 0.01) { dx = 0.1; dy = 0.05; d2 = 0.0125; }
              var f = rep * alpha / d2;
              var fx = dx * f, fy = dy * f;
              A.vx -= fx; A.vy -= fy; B.vx += fx; B.vy += fy;
            }
          }
          for (var e = 0; e < pairs.length; e += 2) {
            var S = nodes[pairs[e]], T = nodes[pairs[e + 1]];
            var ddx = T.x - S.x, ddy = T.y - S.y;
            var dist = Math.sqrt(ddx * ddx + ddy * ddy) || 1;
            var fs = (dist - 52) / dist * 0.08 * alpha;
            S.vx += ddx * fs; S.vy += ddy * fs; T.vx -= ddx * fs; T.vy -= ddy * fs;
          }
          for (var m = 0; m < n; m++) {
            var N = nodes[m];
            N.vx += (w / 2 - N.x) * 0.005 * alpha;
            N.vy += (h / 2 - N.y) * 0.005 * alpha;
            N.vx *= 0.6; N.vy *= 0.6;
            N.x += Math.max(-28, Math.min(28, N.vx));
            N.y += Math.max(-28, Math.min(28, N.vy));
          }
          alpha *= 0.96;
        }
      }

      /** Subsample to NODE_LIMIT, preferring distinct communities and high degree. */
      function subsample(graph, limit) {
        var byCommunity = new Map();
        for (var i = 0; i < graph.nodes.length; i++) {
          var nd = graph.nodes[i];
          var key = nd.community == null ? -1 : nd.community;
          if (!byCommunity.has(key)) byCommunity.set(key, []);
          byCommunity.get(key).push(nd);
        }
        var groups = Array.from(byCommunity.values()).sort(function (a, b) { return b.length - a.length; });
        var picked = [];
        var round = 0;
        while (picked.length < limit) {
          var added = false;
          for (var g = 0; g < groups.length && picked.length < limit; g++) {
            if (round < groups[g].length) { picked.push(groups[g][round]); added = true; }
          }
          if (!added) break;
          round++;
        }
        var keep = new Set(picked.map(function (n) { return n.id; }));
        var links = graph.links.filter(function (l) { return keep.has(l.s) && keep.has(l.t); });
        return { nodes: picked, links: links, sampled: true };
      }

      // ----------------------------------------------------- graph view
      /**
       * Imperative SVG canvas: owns positions, zoom/pan, drag, selection.
       * React only mounts the container and chrome; callbacks bridge back.
       */
      function GraphView(svg, opts) {
        this.svg = svg;
        this.opts = opts; // {dark, onSelect, onDrill}
        this.w = svg.clientWidth || 800;
        this.h = svg.clientHeight || 600;
        this.scale = 1; this.tx = 0; this.ty = 0;
        this.root = svgEl('g', {});
        this.gEdges = svgEl('g', { opacity: 0.55 });
        this.gNodes = svgEl('g', {});
        this.gLabels = svgEl('g', {});
        this.gHot = svgEl('g', {});
        this.root.appendChild(this.gEdges);
        this.root.appendChild(this.gNodes);
        this.root.appendChild(this.gLabels);
        this.root.appendChild(this.gHot);
        svg.appendChild(this.root);
        this.data = null; // {nodes, links}
        this.nodeEls = [];
        this.edgeEls = [];
        this.selected = null;
        this.pinned = new Set();
        this.bindEvents();
      }
      GraphView.prototype.setData = function (nodes, links, communityOf) {
        while (this.gEdges.firstChild) this.gEdges.removeChild(this.gEdges.firstChild);
        while (this.gNodes.firstChild) this.gNodes.removeChild(this.gNodes.firstChild);
        while (this.gLabels.firstChild) this.gLabels.removeChild(this.gLabels.firstChild);
        this.clearHot();
        this.data = { nodes: nodes, links: links };
        this.communityOf = communityOf;
        forceLayout(nodes, links, this.w, this.h);
        // fit
        var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (var i = 0; i < nodes.length; i++) {
          minX = Math.min(minX, nodes[i].x); maxX = Math.max(maxX, nodes[i].x);
          minY = Math.min(minY, nodes[i].y); maxY = Math.max(maxY, nodes[i].y);
        }
        var bw = Math.max(1, maxX - minX), bh = Math.max(1, maxY - minY);
        this.scale = Math.min(this.w / (bw + 80), this.h / (bh + 80), 2);
        this.tx = (this.w - bw * this.scale) / 2 - minX * this.scale;
        this.ty = (this.h - bh * this.scale) / 2 - minY * this.scale;

        for (var e = 0; e < links.length; e++) {
          var line = svgEl('line', { 'stroke-width': Math.min(3, 0.6 + (links[e].count || 1) * 0.12).toFixed(2) });
          line.setAttribute('data-i', String(e));
          line.setAttribute('class', 'gfp-edge');
          line.__link = links[e];
          this.gEdges.appendChild(line);
        }
        var showLabels = nodes.length <= LABEL_LIMIT;
        for (var k = 0; k < nodes.length; k++) {
          var nd = nodes[k];
          var g = svgEl('g', { class: 'gfp-node', transform: 'translate(0,0)' });
          var circle = svgEl('circle', { r: nd.r.toFixed(1), fill: nodeColor(communityOf(nd), this.opts.dark) });
          g.appendChild(circle);
          var title = svgEl('title', {});
          title.textContent = nd.label + (typeof nd.members === 'number' ? ' — ' + nd.members + ' nodes' : '');
          g.appendChild(title);
          g.__node = nd;
          g.setAttribute('data-i', String(k));
          this.gNodes.appendChild(g);
          this.nodeEls[k] = g;
          if (showLabels) {
            var txt = svgEl('text', { class: 'gfp-lbl' });
            txt.textContent = truncate(nd.label, 22);
            txt.__node = nd;
            this.gLabels.appendChild(txt);
          }
        }
        this.render();
      };
      GraphView.prototype.render = function () {
        var tr = 'translate(' + this.tx.toFixed(1) + ',' + this.ty.toFixed(1) + ') scale(' + this.scale.toFixed(3) + ')';
        this.root.setAttribute('transform', tr);
        var d = this.data; if (!d) return;
        for (var i = 0; i < d.nodes.length; i++) {
          var n = d.nodes[i];
          var el = this.nodeEls[i];
          el.setAttribute('transform', 'translate(' + n.x.toFixed(1) + ',' + n.y.toFixed(1) + ')');
        }
        var byId = new Map();
        for (var s = 0; s < d.nodes.length; s++) byId.set(d.nodes[s].id, d.nodes[s]);
        var lines = this.gEdges.childNodes;
        for (var k = 0; k < lines.length; k++) {
          var ln = lines[k];
          var a = byId.get(ln.__link.s), b = byId.get(ln.__link.t);
          if (!a || !b) { ln.setAttribute('x1', 0); ln.setAttribute('y1', 0); ln.setAttribute('x2', 0); ln.setAttribute('y2', 0); continue; }
          ln.setAttribute('x1', a.x.toFixed(1)); ln.setAttribute('y1', a.y.toFixed(1));
          ln.setAttribute('x2', b.x.toFixed(1)); ln.setAttribute('y2', b.y.toFixed(1));
        }
        var labels = this.gLabels.childNodes;
        for (var q = 0; q < labels.length; q++) {
          var t = labels[q].__node;
          labels[q].setAttribute('x', t.x.toFixed(1));
          labels[q].setAttribute('y', (t.y + t.r + 9).toFixed(1));
        }
        this.renderHot(byId);
      };
      GraphView.prototype.neighborsOf = function (node, limit) {
        if (!this.data) return [];
        var out = [];
        for (var i = 0; i < this.data.links.length && out.length < limit; i++) {
          var l = this.data.links[i];
          if (l.s === node.id) out.push({ id: l.t, rel: l.relation });
          else if (l.t === node.id) out.push({ id: l.s, rel: l.relation });
        }
        return out;
      };
      GraphView.prototype.highlightCommunity = function (community) {
        for (var i = 0; i < this.nodeEls.length; i++) {
          var nd = this.nodeEls[i].__node;
          var on = community == null || this.communityOf(nd) === community;
          this.nodeEls[i].classList.toggle('faded', !on);
        }
      };
      GraphView.prototype.select = function (node) {
        for (var i = 0; i < this.nodeEls.length; i++) this.nodeEls[i].classList.remove('sel');
        this.selected = node || null;
        if (node) {
          for (var k = 0; k < this.nodeEls.length; k++) if (this.nodeEls[k].__node === node) this.nodeEls[k].classList.add('sel');
        }
        this.render();
      };
      GraphView.prototype.centerOn = function (node) {
        this.tx = this.w / 2 - node.x * this.scale;
        this.ty = this.h / 2 - node.y * this.scale;
        this.select(node);
        this.render();
      };
      GraphView.prototype.clearHot = function () {
        while (this.gHot.firstChild) this.gHot.removeChild(this.gHot.firstChild);
      };
      GraphView.prototype.renderHot = function () {
        this.clearHot();
        var node = this.selected;
        if (!node || !this.data) return;
        var byId = new Map();
        for (var i = 0; i < this.data.nodes.length; i++) byId.set(this.data.nodes[i].id, this.data.nodes[i]);
        for (var k = 0; k < this.data.links.length; k++) {
          var l = this.data.links[k];
          var a = byId.get(l.s), b = byId.get(l.t);
          if (!a || !b || (a !== node && b !== node)) continue;
          this.gHot.appendChild(svgEl('line', {
            class: 'gfp-edge', x1: a.x.toFixed(1), y1: a.y.toFixed(1), x2: b.x.toFixed(1), y2: b.y.toFixed(1),
            stroke: 'var(--dsw-alias-brand-primary)', 'stroke-width': '1.6', 'stroke-opacity': '0.9',
          }));
          var mid = svgEl('text', { class: 'gfp-elabel', x: ((a.x + b.x) / 2).toFixed(1), y: ((a.y + b.y) / 2 - 4).toFixed(1) });
          mid.textContent = l.relation + (l.count && l.count > 1 ? ' ×' + l.count : '');
          this.gHot.appendChild(mid);
        }
      };
      GraphView.prototype.setDark = function (dark) {
        this.opts.dark = dark;
        for (var i = 0; i < this.nodeEls.length; i++) {
          var nd = this.nodeEls[i].__node;
          this.nodeEls[i].firstChild.setAttribute('fill', nodeColor(this.communityOf(nd), dark));
        }
      };
      GraphView.prototype.bindEvents = function () {
        var self = this;
        var drag = null; // {mode:'pan'|'node', node?, sx, sy, ox, oy, moved}
        this.svg.addEventListener('pointerdown', function (ev) {
          if (ev.button !== 0) return;
          var target = ev.target;
          var nodeG = null;
          for (var el = target; el && el !== self.svg; el = el.parentNode) {
            if (el.__node) { nodeG = el; break; }
          }
          self.svg.setPointerCapture(ev.pointerId);
          if (nodeG) drag = { mode: 'node', node: nodeG.__node, sx: ev.clientX, sy: ev.clientY, ox: nodeG.__node.x, oy: nodeG.__node.y, moved: false };
          else drag = { mode: 'pan', sx: ev.clientX, sy: ev.clientY, ox: self.tx, oy: self.ty, moved: false };
        });
        this.svg.addEventListener('pointermove', function (ev) {
          if (!drag) return;
          var dx = ev.clientX - drag.sx, dy = ev.clientY - drag.sy;
          if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 4) return;
          drag.moved = true;
          if (drag.mode === 'pan') { self.tx = drag.ox + dx; self.ty = drag.oy + dy; }
          else { drag.node.x = drag.ox + dx / self.scale; drag.node.y = drag.oy + dy / self.scale; }
          self.render();
        });
        this.svg.addEventListener('pointerup', function (ev) {
          if (!drag) return;
          try { self.svg.releasePointerCapture(ev.pointerId); } catch (err) { /* ignore */ }
          var d = drag; drag = null;
          if (d.moved) return;
          if (d.mode === 'node') { self.opts.onSelect(d.node); }
          else if (d.mode === 'pan' && self.selected) { self.opts.onSelect(null); }
        });
        this.svg.addEventListener('dblclick', function (ev) {
          var forEl = ev.target;
          for (var el = forEl; el && el !== self.svg; el = el.parentNode) {
            if (el.__node && el.__node.members) { self.opts.onDrill(el.__node); return; }
            if (el.__node) return;
          }
        });
        this.svg.addEventListener('wheel', function (ev) {
          ev.preventDefault();
          var rect = self.svg.getBoundingClientRect();
          var px = ev.clientX - rect.left, py = ev.clientY - rect.top;
          var factor = ev.deltaY < 0 ? 1.15 : 1 / 1.15;
          var ns = Math.max(0.05, Math.min(8, self.scale * factor));
          self.tx = px - ((px - self.tx) / self.scale) * ns;
          self.ty = py - ((py - self.ty) / self.scale) * ns;
          self.scale = ns;
          self.render();
        }, { passive: false });
      };

      // -------------------------------------------------------- apply
      exports.inject = ['slots', 'locale', 'sidebarRightTabs', 'remote', 'remote.workspaceFiles'];
      exports.apply = function (ctx) {
        var t = ctx.locale.bind(NS);

        function GraphBody(props) {
          var sessionId = props.sessionId;
          var remote = ctx.remote;
          var _nonce = React.useState(0);
          var reloadNonce = _nonce[0], setReloadNonce = _nonce[1];
          var _state = React.useState({ phase: 'idle' });
          var state = _state[0], setState = _state[1];
          var _projects = React.useState([]);
          var projects = _projects[0], setProjects = _projects[1];
          var _projIdx = React.useState(0);
          var projIdx = _projIdx[0], setProjIdx = _projIdx[1];
          var _query2 = React.useState('');
          var query = _query2[0], setQuery = _query2[1];
          var _drill = React.useState(null);
          var drill = _drill[0], setDrill = _drill[1];
          var _dark = React.useState(function () { return readDark(); });
          var dark = _dark[0], setDark = _dark[1];
          var stageRef = React.useRef(null);
          var canvasRef = React.useRef(null);
          var viewRef = React.useRef(null);
          var rawRef = React.useRef(null);
          var ctrlRef = React.useRef(null);
          var _mode = React.useState(function () {
            try { return window.localStorage.getItem('graphify.viewMode') || null; } catch (e) { return null; }
          });
          var mode = _mode[0], setMode = _mode[1];
          var _html = React.useState({ phase: 'idle' });
          var htmlState = _html[0], setHtmlState = _html[1];
          var htmlUrlRef = React.useRef(null);
          var proj = projects.length ? projects[Math.min(projIdx, projects.length - 1)] : null;
          var wantHtml = mode ? mode === 'html' : !!(proj && proj.htmlFile);
          function chooseMode(m) {
            setMode(m);
            try { window.localStorage.setItem('graphify.viewMode', m); } catch (e) { /* private mode */ }
          }

          function readDark() {
            try {
              var probe = document.createElement('span');
              probe.style.color = 'var(--dsw-alias-label-primary)';
              probe.style.display = 'none';
              document.body.appendChild(probe);
              var c = getComputedStyle(probe).color;
              document.body.removeChild(probe);
              var m = c.match(/(\d+),\s*(\d+),\s*(\d+)/);
              if (!m) return true;
              var lum = (0.2126 * +m[1] + 0.7152 * +m[2] + 0.0722 * +m[3]) / 255;
              return lum < 0.5;
            } catch (err) { return true; }
          }

          React.useEffect(function () {
            var l = function () { setDark(readDark()); };
            window.addEventListener('resize', l);
            var obs = typeof MutationObserver !== 'undefined' ? new MutationObserver(l) : null;
            if (obs) obs.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme', 'style'] });
            return function () { window.removeEventListener('resize', l); if (obs) obs.disconnect(); };
          }, []);

          // discover projects whenever the session or refresh nonce changes
          React.useEffect(function () {
            if (!sessionId || !remote) return undefined;
            var ctrl = new AbortController();
            ctrlRef.current = ctrl;
            setState({ phase: 'loading' });
            discoverGraphs(remote, sessionId, ctrl.signal).then(function (found) {
              setProjects(found);
              setProjIdx(0);
              if (found.length === 0) setState({ phase: 'empty' });
            }).catch(function (err) {
              if (String(err && err.message) !== 'aborted') setState({ phase: 'error', message: t('read.error') + ' — ' + (err.message || err) });
            });
            return function () { ctrl.abort(); };
          }, [sessionId, reloadNonce]);

          // load + render the selected project graph
          React.useEffect(function () {
            if (!sessionId || !remote || projects.length === 0) return undefined;
            var proj = projects[Math.min(projIdx, projects.length - 1)];
            if (!proj) return undefined;
            var ctrl = new AbortController();
            setState({ phase: 'loading' });
            readWholeFile(remote, sessionId, proj.file, ctrl.signal).then(function (text) {
              var graph;
              try { graph = JSON.parse(text); }
              catch (err) { setState({ phase: 'error', message: t('parse.error') }); return; }
              rawRef.current = graph;
              buildAndShow(null);
              setState({ phase: 'ready', stats: summaryOf(graph) });
            }).catch(function (err) {
              if (String(err && err.message) !== 'aborted') setState({ phase: 'error', message: t('read.error') + ' — ' + (err.message || err) });
            });
            return function () { ctrl.abort(); };
          }, [sessionId, projects, projIdx, reloadNonce]);

          // HTML view: fetch + patch graph.html into a sandboxed blob iframe
          React.useEffect(function () {
            function revoke() {
              if (htmlUrlRef.current) { URL.revokeObjectURL(htmlUrlRef.current); htmlUrlRef.current = null; }
            }
            if (!sessionId || !remote || !proj || !proj.htmlFile || !wantHtml) {
              revoke();
              setHtmlState({ phase: 'idle' });
              return revoke;
            }
            var ctrl = new AbortController();
            revoke();
            setHtmlState({ phase: 'loading' });
            readWholeFile(remote, sessionId, proj.htmlFile, ctrl.signal).then(function (text) {
              var url = URL.createObjectURL(new Blob([patchGraphHtml(text)], { type: 'text/html;charset=utf-8' }));
              htmlUrlRef.current = url;
              setHtmlState({ phase: 'ready', url: url });
            }).catch(function (err) {
              if (String(err && err.message) !== 'aborted') setHtmlState({ phase: 'error', message: t('read.error') + ' — ' + (err.message || err) });
            });
            return function () { ctrl.abort(); revoke(); };
          }, [sessionId, projects, projIdx, reloadNonce, wantHtml]);

          // returning to the SVG view needs a (re)build — the canvas remounts empty
          React.useEffect(function () {
            if (!wantHtml && rawRef.current && state.phase === 'ready') buildAndShow(drill);
          }, [wantHtml]);

          function summaryOf(graph) {
            var nodes = Array.isArray(graph.nodes) ? graph.nodes : [];
            var links = Array.isArray(graph.links) ? graph.links : [];
            var comms = new Set();
            for (var i = 0; i < nodes.length; i++) if (nodes[i] && nodes[i].community != null) comms.add(nodes[i].community);
            return { nodes: nodes.length, links: links.length, communities: comms.size };
          }

          /** Normalize raw graph.json into view nodes/links for a community drill or the whole graph. */
          function normalize(graph, community) {
            var rawNodes = Array.isArray(graph.nodes) ? graph.nodes : [];
            var rawLinks = Array.isArray(graph.links) ? graph.links : [];
            var nodes = [];
            var byId = new Map();
            for (var i = 0; i < rawNodes.length; i++) {
              var rn = rawNodes[i];
              if (!rn || rn.id == null) continue;
              if (community != null && rn.community !== community) continue;
              var node = { id: String(rn.id), label: rn.label != null ? String(rn.label) : String(rn.id),
                community: rn.community, source_file: rn.source_file, source_location: rn.source_location,
                file_type: rn.file_type, community_name: rn.community_name, deg: 0 };
              nodes.push(node); byId.set(node.id, node);
            }
            var links = [];
            var seen = new Set();
            for (var k = 0; k < rawLinks.length; k++) {
              var rl = rawLinks[k];
              if (!rl) continue;
              var s = String(rl.source != null ? rl.source : rl.from), d = String(rl.target != null ? rl.target : rl.to);
              if (!byId.has(s) || !byId.has(d) || s === d) continue;
              var rel = String(rl.relation || rl.rel || 'edge');
              var key = s < d ? s + '\u0001' + d + '\u0001' + rel : d + '\u0001' + s + '\u0001' + rel;
              if (seen.has(key)) continue;
              seen.add(key);
              links.push({ s: s, t: d, relation: rel });
              byId.get(s).deg++; byId.get(d).deg++;
            }
            return { nodes: nodes, links: links, byId: byId };
          }

          /** Aggregate the whole graph into community nodes + cross links. */
          function aggregate(graph) {
            var rawNodes = Array.isArray(graph.nodes) ? graph.nodes : [];
            var rawLinks = Array.isArray(graph.links) ? graph.links : [];
            var members = new Map(); // community -> {count, names}
            var nodeComm = new Map();
            for (var i = 0; i < rawNodes.length; i++) {
              var rn = rawNodes[i];
              if (!rn || rn.id == null) continue;
              var c = rn.community == null ? -1 : rn.community;
              nodeComm.set(String(rn.id), c);
              var rec = members.get(c);
              if (!rec) { rec = { community: c, count: 0, label: rn.community_name || ('community ' + c) }; members.set(c, rec); }
              rec.count++;
            }
            var cross = new Map();
            for (var k = 0; k < rawLinks.length; k++) {
              var rl = rawLinks[k];
              if (!rl) continue;
              var cs = nodeComm.get(String(rl.source != null ? rl.source : rl.from));
              var cd = nodeComm.get(String(rl.target != null ? rl.target : rl.to));
              if (cs == null || cd == null || cs === cd) continue;
              var key = cs < cd ? cs + '\u0001' + cd : cd + '\u0001' + cs;
              cross.set(key, (cross.get(key) || 0) + 1);
            }
            var big = Math.max(1, Math.max.apply(null, Array.from(members.values()).map(function (m) { return m.count; })));
            var nodes = Array.from(members.values()).map(function (m) {
              return { id: 'c:' + m.community, label: truncate(m.label, 28), community: m.community, members: m.count,
                deg: 0, r: 6 + 20 * Math.sqrt(m.count / big), isCommunity: true };
            });
            var links = [];
            cross.forEach(function (count, key) {
              var parts = key.split('\u0001');
              links.push({ s: 'c:' + parts[0], t: 'c:' + parts[1], relation: '×' + count, count: count });
            });
            return { nodes: nodes, links: links };
          }

          function buildAndShow(community) {
            var graph = rawRef.current;
            var canvas = canvasRef.current;
            if (!graph || !canvas) return;
            var stage = stageRef.current || canvas;
            var w = stage.clientWidth || 800, h = stage.clientHeight || 600;
            var view = viewRef.current;
            if (!view || view.svg.parentNode !== canvas) {
              canvas.innerHTML = '';
              var svg = svgEl('svg', { xmlns: 'http://www.w3.org/2000/svg' });
              canvas.appendChild(svg);
              view = new GraphView(svg, {
                dark: readDark(),
                onSelect: function (node) { setSelectedNode(node); },
                onDrill: function (node) { if (node.isCommunity) { setDrill(node.community); setSelectedNode(null); } },
              });
              viewRef.current = view;
            } else {
              view.opts.dark = readDark();
            }
            var model;
            var communityOf;
            if (community != null) {
              var pre = normalize(graph, community);
              if (pre.nodes.length === 0) { setDrill(null); return; }
            }
            if (community != null) {
              model = normalize(graph, community);
              communityOf = function () { return community; };
            } else {
              var total = (graph.nodes || []).length;
              if (total > NODE_LIMIT) {
                model = aggregate(graph);
                communityOf = function (nd) { return nd.community; };
              } else {
                model = normalize(graph, null);
                if (model.nodes.length > NODE_LIMIT) model = subsample(model, NODE_LIMIT);
                communityOf = function (nd) { return nd.community == null ? 0 : nd.community; };
              }
            }
            for (var i = 0; i < model.nodes.length; i++) {
              var nd = model.nodes[i];
              if (nd.r == null) nd.r = 3.5 + Math.min(9, Math.sqrt(nd.deg || 0) * 1.6);
            }
            var links = model.links.length > EDGE_RENDER_LIMIT
              ? model.links.slice(0, EDGE_RENDER_LIMIT)
              : model.links;
            view.w = w; view.h = h;
            view.setData(model.nodes, links, communityOf);
            view.setDark(readDark());
            setSelectedNode(null);
          }

          var _sel = React.useState(null);
          var selectedNode = _sel[0], setSelectedNode = _sel[1];

          React.useEffect(function () { buildAndShow(drill); }, [drill, dark]);

          var neighbors = React.useMemo(function () {
            if (!selectedNode || !viewRef.current) return [];
            var nb = viewRef.current.neighborsOf(selectedNode, 24);
            return nb;
          }, [selectedNode, state]);

          var legend = React.useMemo(function () {
            var graph = rawRef.current;
            if (!graph || drill != null) return [];
            var total = (graph.nodes || []).length;
            if (total <= NODE_LIMIT) return [];
            var m = new Map();
            var rawNodes = graph.nodes || [];
            var rawLinks = graph.links || [];
            var nodeComm = new Map();
            for (var i = 0; i < rawNodes.length; i++) {
              var rn = rawNodes[i];
              if (!rn || rn.id == null) continue;
              var c = rn.community == null ? -1 : rn.community;
              nodeComm.set(String(rn.id), c);
              if (!m.has(c)) m.set(c, { community: c, count: 0, label: rn.community_name || ('community ' + c) });
              m.get(c).count++;
            }
            for (var k = 0; k < rawLinks.length; k++) {
              var rl = rawLinks[k];
              if (!rl) continue;
              var cs = nodeComm.get(String(rl.source)), cd = nodeComm.get(String(rl.target));
              if (cs == null || cd == null || cs === cd) continue;
              if (m.has(cs)) m.get(cs).deg = (m.get(cs).deg || 0) + 1;
            }
            return Array.from(m.values()).sort(function (a, b) { return b.count - a.count; }).slice(0, 16);
          }, [state, drill]);

          function onSearchChange(v) {
            setQuery(v);
            var view = viewRef.current;
            if (!view || !view.data) return;
            var needle = v.trim().toLowerCase();
            if (needle.length < 2) { view.highlightCommunity(drill == null ? null : drill); return; }
            var hit = null;
            for (var i = 0; i < view.data.nodes.length; i++) {
              var n = view.data.nodes[i];
              if ((n.label + ' ' + n.id + ' ' + (n.source_file || '')).toLowerCase().indexOf(needle) !== -1) { hit = n; break; }
            }
            if (hit) view.centerOn(hit);
          }

          var projName = function (p) {
            var f = p.file;
            var idx = f.indexOf('/graphify-out/graph.json');
            return idx === -1 ? t('title') : f.slice(0, idx);
          };

          return React.createElement('div', { class: 'gfp-pane' },
            React.createElement('div', { class: 'gfp-bar' },
              projects.length > 1 ? React.createElement('select', {
                value: projIdx,
                onChange: function (ev) { setProjIdx(+ev.target.value); setDrill(null); },
              }, projects.map(function (p, i) { return React.createElement('option', { key: i, value: i }, projName(p)); })) : null,
              drill != null && !wantHtml ? React.createElement('button', { class: 'gfp-btn', onClick: function () { setDrill(null); } }, t('all.communities')) : null,
              state.phase === 'ready' && !wantHtml ? React.createElement('input', {
                class: 'gfp-search', type: 'search', placeholder: t('search'), value: query,
                onChange: function (ev) { onSearchChange(ev.target.value); },
              }) : null,
              state.phase === 'ready' ? React.createElement('div', { class: 'gfp-seg' },
                React.createElement('button', {
                  class: wantHtml ? 'on' : '', disabled: !proj || !proj.htmlFile,
                  title: proj && proj.htmlFile ? 'HTML' : t('mode.html.missing'),
                  onClick: function () { chooseMode('html'); },
                }, 'HTML'),
                React.createElement('button', {
                  class: !wantHtml ? 'on' : '', onClick: function () { chooseMode('svg'); },
                }, 'SVG')) : null,
              React.createElement('button', {
                class: 'gfp-btn', disabled: state.phase === 'loading',
                onClick: function () { setReloadNonce(function (n) { return n + 1; }); },
              }, t('refresh')),
              state.phase === 'ready' && state.stats ? React.createElement('span', { class: 'gfp-stat' },
                state.stats.nodes + ' ' + t('nodes') + ' · ' + state.stats.links + ' ' + t('edges') + ' · ' + state.stats.communities + ' ' + t('communities')) : null),
            React.createElement('div', { class: 'gfp-stage', ref: stageRef },
              wantHtml && htmlState.phase === 'ready' ? React.createElement('iframe', {
                class: 'gfp-frame', src: htmlState.url, sandbox: 'allow-scripts allow-popups', title: 'graphify',
              }) : null,
              !wantHtml ? React.createElement('div', { class: 'gfp-canvas', ref: canvasRef }) : null,
              state.phase === 'loading' || (wantHtml && htmlState.phase === 'loading') ? React.createElement('div', { class: 'gfp-mid' },
                React.createElement('div', { class: 'box' }, React.createElement('div', { class: 'gfp-spin' }), t('loading'))) : null,
              state.phase === 'error' ? React.createElement('div', { class: 'gfp-mid' }, state.message) : null,
              wantHtml && htmlState.phase === 'error' ? React.createElement('div', { class: 'gfp-mid' }, htmlState.message) : null,
              state.phase === 'empty' ? React.createElement('div', { class: 'gfp-empty' },
                React.createElement('b', null, t('empty.title')),
                React.createElement('span', null, t('empty.body'))) : null,
              state.phase === 'ready' && !wantHtml ? React.createElement('div', { class: 'gfp-note' },
                drill == null && state.stats && state.stats.nodes > NODE_LIMIT ? t('agg.note') : t('tip')) : null,
              !wantHtml && selectedNode ? React.createElement('div', { class: 'gfp-card' },
                React.createElement('button', { class: 'gfp-x', onClick: function () { setSelectedNode(null); viewRef.current && viewRef.current.select(null); } }, '×'),
                React.createElement('h4', null, selectedNode.label),
                React.createElement('div', { class: 'sub' },
                  selectedNode.isCommunity
                    ? selectedNode.members + ' ' + t('members')
                    : [selectedNode.source_file, selectedNode.source_location].filter(Boolean).join(' ') || selectedNode.id),
                !selectedNode.isCommunity && selectedNode.community != null ? React.createElement('div', { class: 'sub' },
                  t('community') + ': ' + (selectedNode.community_name || selectedNode.community) + ' · ' + selectedNode.deg + ' ' + t('degree')) : null,
                neighbors.length > 0 ? React.createElement('div', null,
                  React.createElement('div', { class: 'sec' }, t('neighbors')),
                  React.createElement('ul', null, neighbors.map(function (nb, i) {
                    return React.createElement('li', { key: i },
                      React.createElement('button', {
                        onClick: function () {
                          var view = viewRef.current;
                          if (!view || !view.data) return;
                          for (var q = 0; q < view.data.nodes.length; q++) {
                            if (view.data.nodes[q].id === nb.id) { view.centerOn(view.data.nodes[q]); return; }
                          }
                        },
                      }, truncate(nb.id, 40)),
                      React.createElement('span', { class: 'rel' }, ' ' + nb.rel));
                  }))) : null) : null,
              !wantHtml && legend.length > 0 ? React.createElement('div', { class: 'gfp-legend' },
                legend.map(function (c) {
                  return React.createElement('button', {
                    key: c.community, onClick: function () { setDrill(c.community); }, title: c.label,
                  },
                    React.createElement('i', { style: { background: nodeColor(c.community, dark) } }),
                    React.createElement('span', null, truncate(c.label, 22) + ' · ' + c.count));
                })) : null));
        }

        ctx.effect(function () {
          return ctx.locale.register(NS, COPY);
        }, 'graphify.locale');

        ctx.effect(function () {
          return ctx.sidebarRightTabs.register({
            id: TAB_ID,
            kind: TAB_KIND,
            multiple: false,
            title: function () { return t('title'); },
            guide: [{
              id: 'graphify',
              order: 30,
              title: function () { return t('guide.title'); },
              description: function () { return t('guide.desc'); },
            }],
          });
        }, 'graphify.type');

        ctx.effect(function () {
          return ctx.slots.inject('sidebar.right.pane.tab', function () {
            return ctx.slots.register({
              name: 'sidebar.right.pane.tab',
              key: TAB_ID,
              locale: NS,
              inject: function () { return {}; },
            }, GraphBody);
          });
        }, 'graphify.body');
      };
      return exports;
    },
  });
})();
