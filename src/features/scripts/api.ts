/**
 * The sandbox API, in prose: what the assistant reads before writing a
 * script and what the docs page shows. Mirrors src/scripting/prelude.js.
 */
export const SCRIPT_API = `A script is JavaScript (ES2020) run in a sandbox with no I/O; \`return\` its result. The dataset is read-only (frozen): copy before sorting or changing anything — sortBy, [...list], { ...entity }. Globals:

entities · relationships — the chained query API, the same in Python: arrays with a vocabulary, every step a new collection (the array itself — map, length, [i], for-of — still works).
  entities.types.person · entities.types['schema:type'] (a plural finds the singular: entities.types.documents) · .type('a', 'b') · .get(id) · .ids() · .labels() · .count() · .first() · .last() · .take(n) · .skip(n) · .sample(n)
  .filter(fn | spec) — spec keys (snake_case or camelCase): types, tags (any of), all_tags, text (in label/description), has (a data key), data ({ key: value | [values] | fn }), min_degree, max_degree, rel, ids, created_after/before, updated_after/before, where (fn) · .where(fn) · .exclude(spec | fn)
  .sort(key, desc?) (a field, a 'data.x' path or a function; a copy) · .top(key, n) · .unique(key) · .pluck(path) · .group(key) → { key: collection } · .rollup(key, value?, agg?) · .tags() · .properties() · .table(columns?) · .json() · .describe()
  graph steps: .out(rel?) · .into(rel?) · .links(rel?) → relationships touching members · .neighbors(rel?, dir?) → the entities at the other ends · .degrees(rel?) · .tagged(tag)
  relationships: .types.wrote · .filter({ types, source, target, source_type, target_type, directed, has, data, text, where }) · .sources() · .targets() · .ends() → entities · .from(id | entities) · .to(id | entities)
  e.g. entities.types.paper.filter({ min_degree: 2 }).neighbors('wrote').sort('label').table(['label', 'data.born'])
pathOf(key) — a reader for a field name, a 'data.x' path or a function (what sort, pluck and table use).

ds — the dataset snapshot (the open project, or the Library):
  ds.entities: [{ id, type, label, description?, tags: string[], data: {...}, createdAt, updatedAt }]  (ISO dates; strings over 1,000 chars are cut to a stub with their length, at any depth; an entity whose data would exceed ~4 KB has its largest values replaced by { $omitted: true, kind, items, bytes } — count fields beside them, such as messageCount, still tell the size)
  ds.relationships: [{ id, type, source, target, directed, data }]
  ds.get(id) · ds.byType('incident', 'deploy') · ds.types() · ds.tagged(tag) · ds.where(fn) · ds.count()
  ds.out(id, type?) / ds.in(id, type?) → relationships · ds.neighbors(id, type?) → entities · ds.degree(id, type?)
  ds.metric('pagerank' | 'betweenness' | 'community' | 'degree' | …, id) — from the latest Insights/analyze run, else undefined · ds.metricNames() → the metrics that run computed
  ds.compute(['pagerank', 'community', …], { seed?, alpha?, iterations?, exactBelow?, sources? }) → { name: { [id]: value } } — computes metrics here, in the sandbox, over the whole dataset (degree, inDegree, outDegree, pagerank, betweenness, closeness, clustering, component, componentSize, community — Louvain); afterwards ds.metric(name, id) reads them. Once per snapshot unless force: true.
  the project state — ds.project: the open project { id, label, description?, includes, createdAt, updatedAt }, null in the Library · ds.scope: { label, projectId? }
  ds.ontology: every type in use or declared, [{ type, label, category, kind, parent?, description?, color?, count, properties: [{ key, label?, kind?, description?, options?, required? }] }] · ds.type(name) → one definition · ds.properties(type) → [{ key, kind, count, coverage, declared, sample? }], what entities of the type carry, declared or seen
  ds.tags() → [{ tag, count, color?, description? }] · ds.describe() → everything a script can reach as one plain object (project, types with properties, relationship types and what they join, tags, metrics): log(ds.describe()) to look around

time: ms(v) → epoch ms · bin(v, 'hour'|'day'|'week'|'month'|'quarter'|'year') → ISO string of the floored period · daysBetween(a, b) · hoursBetween(a, b) · isoDate(v)

collections: groupBy(items, key) → Map · rollup(items, key, value?, agg = 'count'|'sum'|'mean'|'median'|'min'|'max'|'distinct'|fn) → [{ key, value, n, items }] sorted by key · sortBy(items, key, desc?) · topK(items, key, k) · rolling(xs, n) · range(a, b, step) — keys are field names or functions
stats: sum · count · mean · median · quantile(xs, p) · min · max · distinct · correlation(xs, ys)

outputs (return one object; it may carry several):
  figure(traces, layout) — Plotly traces via line(x, y, opts) · scatter · bar · area · box(y) · histogram(x) · heatmap(x, y, z) · pie(labels, values); opts merge into the trace (name, marker, text, …); layout is Plotly's (title, barmode, xaxis, yaxis, …)
  table(rows, columns?) — row objects or arrays
chart conventions (what a chart exported from Charts is written with, so it draws the same picture): axisValue(raw, ref) → { v, temporal } (dates by name or shape → epoch ms, numeric strings → numbers) · binAxis({ v, temporal }, unit | width) · axisOut(v, temporal) (ms → ISO) · sortScalars · seriesOf(rows, key) (largest series first, “other” past 24, “(none)” for missing) · plotColor(i) / PLOT_COLORS · markerSizes(values) · aggregate(values, 'count'|'sum'|'mean'|'median'|'min'|'max'|'distinct')
  scene(positions, { label?, groups?, scale? }) — positions: { [entityId]: { x, y, width?, height? } }; opens on the Scenes page
  layout(positions, { label?, dimensions? }) — positions: { [entityId]: { x, y, z? } } for the Graph Explorer: applied as the view's held positions and saved as a layout that remembers the script (Apply on the Scripts page, graph_layout {script}, script {action:"apply"}); a graph scene keeps it
  style(nodes, { edges?, legend?, label?, spec? }) — a style per entity id for the Graph Explorer: nodes { [id]: { color?, size?, opacity?, shape: 'circle'|'square'|'diamond'|'triangle'?, visible?, label? } }, edges { [id]: { color?, width?, opacity?, visible?, arrow? } }; legend { title, items: [{ label, color }] } or { title, palette, domain: [lo, hi] }; spec: an optional rendering spec for what the ids leave unset (defaults and type/tag rules, the shape graph_style takes). Applied as the view's style and saved as a style that remembers the script; a graph scene keeps it
  colour and scale helpers for styling by value: PALETTES.viridis | magma | blues | reds | redBlue | tableau10 (hex stops) · colorRamp(t 0–1, stops?) · colorOf(index | key, stops?) · scaleLinear(v, [d0, d1], [r0, r1]) · scaleSqrt · scaleLog · extent(values) → [min, max]
  { text: '…' } — prose; a bare string works too
log(...) collects lines shown with the result.

Example — colour by community, size by PageRank, computed here, applied on the Graph Explorer:
  const { pagerank, community } = ds.compute(['pagerank', 'community'])
  const [lo, hi] = extent(Object.values(pagerank))
  const nodes = {}
  for (const e of ds.entities) nodes[e.id] = { color: colorOf(community[e.id]), size: scaleSqrt(pagerank[e.id], [lo, hi], [3, 22]) }
  const k = new Set(Object.values(community)).size
  return style(nodes, { legend: { title: 'Community', items: Array.from({ length: Math.min(k, 10) }, (_, i) => ({ label: 'Community ' + i, color: colorOf(i) })) } })

Example — MTTR per month before and after 2025-11-14:
  const inc = ds.byType('incident')
  const m = rollup(inc, (e) => bin(e.data.startedAt, 'month'), (e) => e.data.duration_min, 'median')
  return figure([line(m.map((r) => r.key), m.map((r) => r.value), { name: 'median MTTR' })], { title: 'MTTR by month', shapes: [{ type: 'line', x0: '2025-11-14', x1: '2025-11-14', y0: 0, y1: 1, yref: 'paper', line: { dash: 'dot' } }] })`

export const PY_API = `Python scripts run in Pyodide (CPython 3.12 in WebAssembly) with numpy, pandas and plotly loaded; matplotlib, scipy, scikit-learn, networkx and statsmodels load on first import. Jupyter-style: every statement runs and the value of a trailing expression is displayed (or assign \`result = …\`); top-level \`await\` works as in a notebook cell (asyncio, awaiting JS promises). print() output is collected as logs. Each run starts from a fresh namespace — nothing one run defines, rebinds or leaves in \`result\` is there in the next. No network, no files beyond the sandbox.

Globals:
  ds — the raw snapshot dict: ds['entities'] (id, type, label, tags, data, createdAt, updatedAt), ds['relationships'] (id, type, source, target, directed, data), ds.get('metrics')
  entities — the chained query API, the same as in JavaScript: a list of entity dicts with a vocabulary, every step a new collection; anything it does not define is asked of its DataFrame (.df), so entities['type'], entities.groupby(...), entities.head() work as before. entities.types.person · entities.types['schema:type'] (a plural finds the singular) · .type('a', 'b') · .get(id) · .ids() · .labels() · .count() · .first() · .last() · .take(n) · .skip(n) · .sample(n) · .filter(fn | spec dict | **keywords: types, tags, all_tags, text, has, data, min_degree, max_degree, rel, ids, created_after/before, updated_after/before, where) · .where(fn) · .exclude(...) · .sort(key, desc=False) (a field, a 'data.x' path or a function; a copy) · .top(key, n) · .unique(key) · .pluck(path) · .group(key) · .rollup(key, value=None, agg='count') · .tags() · .properties() · .table(columns=None) · .json() · .describe() · .df; graph steps .out(rel=None) · .into(rel=None) · .links(rel=None) · .neighbors(rel=None, dir='both') · .degrees(rel=None) · .tagged(tag). E.g. entities.types.paper.filter(min_degree=2).neighbors('wrote').sort('label').table(['label', 'data.born'])
  relationships — the same for relationships: .types.wrote · .filter(types=, source=, target=, source_type=, target_type=, directed=, has=, data=, text=, where=) · .sources() · .targets() · .ends() · .from_(id | entities) · .to(id | entities) · .df (id, type, source, target, directed + data fields)
  metrics — DataFrame indexed by entity id with the latest analysis columns (pagerank, betweenness, community, …), empty until Insights/analyze has run
  by_type('incident', 'deploy') → DataFrame with date-like columns (…At, …_at, week, month, due) parsed to UTC datetimes
  get(id) · out(id, type=None) · inn(id, type=None) → Relationships · neighbors(id, type=None) → Entities (collections, see below) · degree(id, type=None) · metric(name, id) · graph() → networkx.DiGraph
  project — the open project as a dict (id, label, description, includes), or None in the Library
  ontology — every type in use or declared, as dicts: type, label, category, kind, parent, description, count, properties [{ key, label, kind, description, options, required }] · type_def(name) → one definition · properties(name) → DataFrame of what entities of a type carry: key, kind, count, coverage, declared
  tags — the tags in use: [{ tag, count, color, description }] · describe() → everything a script can reach as one dict (project, types with properties, relationship types and what they join, tags, metrics): print(describe()) to look around
  the JavaScript helpers, in Python — time: ms(v) · bin(v, 'month') · days_between(a, b) · hours_between(a, b) · iso_date(v); collections: group_by(items, key) · rollup(items, key, value=None, agg='count') · sort_by(items, key, desc=False) · top_k(items, key, k) · rolling(xs, n); statistics: sum · count(xs) · mean(xs) · median(xs) · quantile(xs, p) · min · max · distinct(xs) · correlation(xs, ys); traces for figure(): line(x, y, **opts) · scatter(x, y, **opts) · bar(x, y, **opts) · area(x, y, **opts) · box(y, **opts) · histogram(x, **opts) · heatmap(x, y, z, **opts) · pie(labels, values, **opts); log(...) is print by the JavaScript name — so a script written in one language reads the same in the other

What to display (the trailing expression or \`result\`):
  a plotly figure (plotly.express or graph_objects, 2D or 3D — go.Scatter3d, go.Surface, go.Mesh3d render with WebGL) · a DataFrame or Series (a table) · a matplotlib figure or anything drawn with pyplot (an image) · a str (text) · a dict from figure(traces, layout) / table(rows) / scene(positions, label=…, groups=…) / layout(positions) / style(nodes, edges=…, legend=…) — the same contract as JavaScript scripts (graph() → networkx for pagerank, communities, betweenness; style(nodes={id: {'color': …, 'size': …}}) puts them on the Graph Explorer)

Example — median MTTR per month, before and after the alerting overhaul:
  import plotly.express as px
  inc = by_type('incident')
  inc['month'] = inc['startedAt'].dt.to_period('M').dt.to_timestamp()
  m = inc.groupby('month')['duration_min'].median().reset_index()
  fig = px.line(m, x='month', y='duration_min', title='Median MTTR by month')
  fig.add_vline(x='2025-11-14', line_dash='dot')
  fig`

export const VIEW_API = `Visual scripts are JavaScript ES modules run in a sandboxed iframe with a DOM, a canvas and WebGL — for anything drawn by hand. The iframe is the output; it fills the output pane and keeps animating. Libraries (served locally): three.js — \`import * as THREE from 'three'\` and addons such as \`import { OrbitControls } from 'three/addons/controls/OrbitControls.js'\`; d3 and Plotly via \`const d3 = await aegraph.load('d3')\` / \`const Plotly = await aegraph.load('plotly')\`. No network beyond this origin, no access to the app.

In scope: \`ds\` and every JavaScript-script helper (ds.byType, ds.neighbors, ds.metric, bin, rollup, groupBy, sortBy, topK, stats …), \`document\` with an empty \`#app\` div filling the frame, \`aegraph.width()\` / \`aegraph.height()\`, \`aegraph.result(value)\` to also send a figure/table/scene back (same contract as JavaScript scripts), and \`aegraph.remember(key, value)\` / \`aegraph.recall(key, fallback)\` for anything the scene should keep between runs and reloads — a camera position, a chosen metric — stored per script in this browser, up to 256 KB of JSON (save the camera on the controls' change event, recall it before the first render). The frame is resized with its pane — listen for \`resize\` and re-fit the renderer (see the example). console.log goes to the logs. Top-level await is fine.

Example — entities as spheres in 3D, edges as lines, orbit to look around:
  import * as THREE from 'three'
  import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
  const scene = new THREE.Scene(); scene.background = new THREE.Color('#faf9f6')
  const camera = new THREE.PerspectiveCamera(60, aegraph.width() / aegraph.height(), 0.1, 5000); camera.position.set(0, 0, 400)
  const renderer = new THREE.WebGLRenderer({ antialias: true }); renderer.setSize(aegraph.width(), aegraph.height()); document.getElementById('app').appendChild(renderer.domElement)
  const controls = new OrbitControls(camera, renderer.domElement)
  window.addEventListener('resize', () => { camera.aspect = aegraph.width() / aegraph.height(); camera.updateProjectionMatrix(); renderer.setSize(aegraph.width(), aegraph.height()) })
  const cam = aegraph.recall('camera'); if (cam) { camera.position.fromArray(cam.p); controls.target.fromArray(cam.t) }
  controls.addEventListener('change', () => aegraph.remember('camera', { p: camera.position.toArray(), t: controls.target.toArray() }))
  const types = ds.types(); const pos = new Map()
  ds.entities.forEach((e, i) => { const r = 40 + 8 * Math.sqrt(i); const a = i * 2.4; const p = new THREE.Vector3(r * Math.cos(a), (types.indexOf(e.type) - types.length / 2) * 30, r * Math.sin(a)); pos.set(e.id, p)
    const m = new THREE.Mesh(new THREE.SphereGeometry(2 + Math.sqrt(ds.degree(e.id)), 12, 12), new THREE.MeshStandardMaterial({ color: new THREE.Color().setHSL(types.indexOf(e.type) / types.length, 0.6, 0.5) })); m.position.copy(p); scene.add(m) })
  const pts = []; for (const r of ds.relationships) { const a = pos.get(r.source), b = pos.get(r.target); if (a && b) pts.push(a, b) }
  scene.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: 0x999999, transparent: true, opacity: 0.3 })))
  scene.add(new THREE.AmbientLight(0xffffff, 0.8), Object.assign(new THREE.DirectionalLight(0xffffff, 0.8), { position: new THREE.Vector3(1, 1, 1) }))
  ;(function frame() { requestAnimationFrame(frame); controls.update(); renderer.render(scene, camera) })()`
