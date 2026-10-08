/**
 * Writes the Conversation atlas project template:
 *
 *   npx vite-node scripts/conversation-atlas/build.ts   → public/templates/conversation-atlas.template.ae.json
 *
 * The analytics for a ChatGPT export run through the atlas pipeline (a
 * separate, private tool)
 * (segments, conversations, topics, domains, themes, personas, named
 * entities, clusters, regions; `facet:value` tags and `data.facets`) —
 * charts, scripts, graph scenes, a guide, and the Analytics / Workstation
 * arrangements that show them — with no data. Every chart and script
 * selects rows by type and reads fields the pipeline always writes, so it
 * draws over anyone's export. Ids are fixed (`tpl:conversation-atlas:…`) and
 * rewritten per project on apply; re-building and re-applying updates.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { createEntity } from '../../src/core/entity/entity'
import type { AnyEntity, TagInfo } from '../../src/core/entity/types'
import type { PlotSpec } from '../../src/core/graph/plot'
import type { TemplateDocument } from '../../src/core/projects/template'

const TPL = 'conversation-atlas'
const T = '2026-09-15T00:00:00.000Z'
const id = (name: string) => `tpl:${TPL}:${name}`
const meta = { createdAt: T, updatedAt: T, source: `template:${TPL}` }
const entities: AnyEntity[] = []
const add = (e: AnyEntity) => (entities.push(e), e)

// ── Charts ─────────────────────────────────────────────────────────────
const seg = { types: ['segment'], scope: 'dataset' as const }
const conv = { types: ['conversation'], scope: 'dataset' as const }
const chart = (name: string, label: string, description: string, spec: PlotSpec, tags: string[] = []) =>
  add(createEntity({ id: id(`chart-${name}`), type: 'plot', label, description, tags: ['atlas', 'chart', ...tags], data: { spec: { ...spec, layout: { title: label, ...spec.layout } } }, meta }))

chart('conversations-per-month', 'Conversations per month', 'How much you talked to it, month by month: one bar per month of conversations started.', { selector: conv, traces: [{ kind: 'bar', x: 'data.startedAt', bin: 'month' }] }, ['activity'])
chart('conversations-cumulative', 'Conversations, cumulative', 'The running total of conversations by week — the slope is the pace.', { selector: conv, traces: [{ kind: 'line', x: 'data.startedAt', bin: 'week', agg: 'count', cumulative: true }] }, ['activity'])
chart('segments-by-region', 'Segments per month by region', 'What the conversations were about, over time: segments per month stacked by the atlas region they cluster into.', { selector: seg, traces: [{ kind: 'bar', x: 'data.created', bin: 'month', group: 'data.region' }], layout: { barmode: 'stack' } }, ['subject'])
chart('month-by-region', 'Month × region', 'The same as a heat grid: rows are regions, columns months; the colour is how many segments. Bright bands are the seasons of a subject.', { selector: seg, traces: [{ kind: 'heatmap', x: 'data.created', bin: 'month', y: 'data.region', palette: 'viridis' }] }, ['subject'])
chart('stakes-per-quarter', 'Stakes per quarter', 'How much was riding on the exchanges, per quarter: segments stacked by the stakes facet.', { selector: seg, traces: [{ kind: 'bar', x: 'data.created', bin: 'quarter', group: 'data.stakes' }], layout: { barmode: 'stack' } }, ['facets'])
chart('modes', 'Modes', 'The register of the exchanges — the mode facet — as shares of all segments.', { selector: seg, traces: [{ kind: 'pie', x: 'data.mode' }] }, ['facets'])
chart('stakes', 'Stakes', 'The stakes facet as shares of all segments.', { selector: seg, traces: [{ kind: 'pie', x: 'data.stakes' }] }, ['facets'])
chart('mode-per-month', 'Modes per month', 'Modes over time: segments per month stacked by mode.', { selector: seg, traces: [{ kind: 'bar', x: 'data.created', bin: 'month', group: 'data.mode' }], layout: { barmode: 'stack' } }, ['facets'])
chart('segment-length', 'Segment length', 'How long the segments are, in characters — a histogram.', { selector: seg, traces: [{ kind: 'histogram', x: 'data.chars' }] }, ['shape'])
chart('messages-vs-length', 'Messages vs length', 'Each segment as a point: messages across, characters up, coloured by salience. Long low ones are monologues; tall short ones are rapid back-and-forth.', { selector: seg, traces: [{ kind: 'scatter', x: 'data.n_messages', y: 'data.chars', color: 'data.salience', palette: 'viridis', text: 'label', opacity: 0.6 }] }, ['shape'])
chart('salience-per-month', 'Mean salience per month', 'The mean salience of segments per month — when the conversations mattered more.', { selector: seg, traces: [{ kind: 'line', x: 'data.created', bin: 'month', y: 'data.salience', agg: 'mean' }] }, ['shape'])
chart('models-over-time', 'Models over time', 'Which model the conversations ran on, per month.', { selector: conv, traces: [{ kind: 'bar', x: 'data.startedAt', bin: 'month', group: 'data.model' }], layout: { barmode: 'stack' } }, ['activity'])
chart('regions-by-size', 'Regions by size', 'The atlas regions — the coarse clusters — by how many segments they hold.', { selector: { types: ['region'], scope: 'dataset' }, traces: [{ kind: 'bar', x: 'label', y: 'data.size' }] }, ['subject'])
chart('conversation-length-by-model', 'Conversation length by model', 'The spread of conversation length (characters) per model, as boxes.', { selector: conv, traces: [{ kind: 'box', y: 'data.charLength', x: 'data.model' }] }, ['shape'])

// ── Scripts ────────────────────────────────────────────────────────────
const script = (name: string, label: string, description: string, code: string, tags: string[] = []) =>
  // A recorded run makes the Scripts page run it on arrival, so a tab opens on its figure rather than on "Run".
  add(createEntity({ id: id(`script-${name}`), type: 'script', label, description, tags: ['atlas', 'script', ...tags], data: { code: code.trim() + '\n', language: 'js', lastRun: { at: T, summary: 'figure', ms: 0 } }, meta }))

script('top-topics', 'Top topics', 'The thirty topics with the most segments, as a horizontal bar — the vocabulary of the corpus at a glance.', `
// Top topics: the thirty with the most segments.
const topics = topK(ds.byType('topic'), (t) => t.data.segment_count ?? 0, 30).reverse()
return figure(bar(topics.map((t) => t.data.segment_count ?? 0), topics.map((t) => t.label ?? t.id), { orientation: 'h', marker: { color: plotColor(0) }, text: topics.map((t) => t.data.segment_count ?? 0), textposition: 'outside' }), { title: 'Top topics', xaxis: { title: 'segments' }, margin: { l: 220 }, height: 720 })
`, ['subject'])

script('domain-x-theme', 'Domain × theme', 'How often each domain (the subject area) meets each theme (the current underneath): a heat grid over the segments’ facets. The bright cells are what this corpus is really about.', `
// Domain × theme: co-occurrence over the segments' facets.
const cells = new Map()
const dom = new Map(), thm = new Map()
for (const s of ds.byType('segment')) {
  const f = s.data.facets ?? {}
  for (const d of f.domain ?? []) {
    dom.set(d, (dom.get(d) ?? 0) + 1)
    for (const t of f.theme ?? []) {
      thm.set(t, (thm.get(t) ?? 0) + 1)
      const k = d + '\\u0000' + t
      cells.set(k, (cells.get(k) ?? 0) + 1)
    }
  }
}
const domains = sortBy([...dom.keys()], (d) => dom.get(d), true).slice(0, 25)
const themes = sortBy([...thm.keys()], (t) => thm.get(t), true)
const z = themes.map((t) => domains.map((d) => cells.get(d + '\\u0000' + t) ?? 0))
return figure(heatmap(domains, themes, z, { colorscale: 'Viridis', hovertemplate: '%{x} × %{y}: %{z}<extra></extra>' }), { title: 'Domain × theme', margin: { l: 180, b: 140 }, xaxis: { tickangle: -45 }, height: 640 })
`, ['subject'])

script('topic-emergence', 'Topic emergence', 'When each topic first appeared, and how many distinct topics the corpus had touched by each month — the growth of what you talk about.', `
// Topic emergence: the month a topic is first seen, and the running number of distinct topics.
const first = new Map()
for (const s of ds.byType('segment')) {
  const m = bin(s.data.created, 'month')
  if (!m) continue
  for (const r of ds.out(s.id, 'on-topic')) if (!first.has(r.target) || m < first.get(r.target)) first.set(r.target, m)
}
const perMonth = groupBy([...first.values()], (m) => m)
const months = sortBy([...perMonth.keys()], (m) => m)
let running = 0
const cum = months.map((m) => (running += perMonth.get(m).length))
return figure([bar(months, months.map((m) => perMonth.get(m).length), { name: 'new topics', marker: { color: plotColor(1) } }), line(months, cum, { name: 'topics so far', yaxis: 'y2', line: { color: plotColor(0), width: 2 } })], { title: 'Topic emergence', yaxis: { title: 'new topics in the month' }, yaxis2: { title: 'distinct topics so far', overlaying: 'y', side: 'right' }, legend: { orientation: 'h', y: 1.08 } })
`, ['subject'])

script('length-trend', 'Conversation length trend', 'The median length of a segment per month, with a three-month rolling median — are the exchanges getting longer or shorter?', `
// Median segment length per month, and a 3-month rolling median.
const m = rollup(ds.byType('segment'), (s) => bin(s.data.created, 'month'), (s) => s.data.chars, 'median').filter((r) => r.key)
const xs = m.map((r) => r.key), ys = m.map((r) => r.value)
const roll = ys.map((_, i) => median(ys.slice(Math.max(0, i - 2), i + 1)))
return figure([bar(xs, ys, { name: 'median chars', marker: { color: plotColor(0) }, opacity: 0.5 }), line(xs, roll, { name: '3-month rolling', line: { color: plotColor(2), width: 3 } })], { title: 'Segment length trend', yaxis: { title: 'characters' } })
`, ['shape'])

script('hubs', 'Hubs', 'The most connected named entities, topics, personas and themes — by how many conversations and segments point at them — as a table.', `
// Hubs: the most connected things the conversations point at.
const rows = []
for (const type of ['named-entity', 'topic', 'persona', 'theme', 'domain']) {
  for (const h of topK(ds.byType(type), (e) => ds.degree(e.id), 8)) rows.push({ type, label: h.label ?? h.id, links: ds.degree(h.id), segments: h.data.segment_count ?? '' })
}
return table(sortBy(rows, (r) => r.links, true), ['type', 'label', 'links', 'segments'])
`, ['subject'])

script('intent-mix', 'Intent mix over time', 'What you wanted from the exchanges — the intent facet — as shares per quarter, stacked to 100%.', `
// Intent mix: the share of each intent per quarter.
const by = new Map()
for (const s of ds.byType('segment')) {
  const q = bin(s.data.created, 'quarter')
  if (!q) continue
  for (const i of (s.data.facets ?? {}).intent ?? []) {
    if (!by.has(i)) by.set(i, new Map())
    by.get(i).set(q, (by.get(i).get(q) ?? 0) + 1)
  }
}
const quarters = sortBy([...new Set([...by.values()].flatMap((m) => [...m.keys()]))], (q) => q)
const totals = quarters.map((q) => [...by.values()].reduce((n, m) => n + (m.get(q) ?? 0), 0))
const intents = sortBy([...by.keys()], (i) => [...by.get(i).values()].reduce((a, b) => a + b, 0), true)
const traces = intents.map((i, k) => area(quarters, quarters.map((q, j) => (totals[j] ? (by.get(i).get(q) ?? 0) / totals[j] : 0)), { name: i, stackgroup: 'one', line: { color: plotColor(k), width: 0.5 } }))
return figure(traces, { title: 'Intent mix over time', yaxis: { title: 'share', tickformat: '.0%' } })
`, ['facets'])

script('region-timelines', 'Region timelines', 'Each region as a line of segments per month — which subjects rose, which faded.', `
// Region timelines: segments per month, one line per region.
const by = groupBy(ds.byType('segment').filter((s) => s.data.region), (s) => s.data.region)
const regions = sortBy([...by.keys()], (r) => by.get(r).length, true).slice(0, 12)
const traces = regions.map((r, k) => {
  const m = rollup(by.get(r), (s) => bin(s.data.created, 'month'), () => 1, 'count').filter((x) => x.key)
  return line(m.map((x) => x.key), m.map((x) => x.value), { name: r, line: { color: plotColor(k), width: 2 } })
})
return figure(traces, { title: 'Region timelines', yaxis: { title: 'segments' } })
`, ['subject'])

script('starred-and-salient', 'Starred and salient', 'The segments that stood out: starred ones, and the most salient, with when and what — a table to read from.', `
// The segments that stood out.
const segs = ds.byType('segment')
const pick = sortBy(segs.filter((s) => s.data.starred || (s.data.salience ?? 0) >= 4), (s) => (s.data.starred ? 10 : 0) + (s.data.salience ?? 0), true).slice(0, 60)
return table(pick.map((s) => ({ when: isoDate(s.data.created), conversation: s.data.conversation_title, region: s.data.region, salience: s.data.salience, starred: s.data.starred ? '★' : '', summary: (s.data.summary ?? '').slice(0, 160) })), ['when', 'conversation', 'region', 'salience', 'starred', 'summary'])
`, ['shape'])

// ── Graph scenes ────────────────────────────────────────────────────────
const FILTER_DEFAULTS = { tags: [], tagMode: 'any', text: '', minDegree: 0, hideIsolated: true, roots: [], depth: 1, maxNodes: 5000, maxDegree: 0, kCore: 0, componentMin: 0, giantOnly: false, exclude: [], fields: [], direction: 'both' }
const PARAMS = { spacing: 1, iterations: 400, direction: 'TB', seed: 7, gravity: 1.5, scalingRatio: 20 }
const style = (types: Record<string, string>) => ({
  precedence: 'type',
  nodes: { default: { color: { mode: 'constant' }, size: { mode: 'ranking', attr: { kind: 'degree' }, log: true, min: 2, max: 18 }, opacity: { mode: 'constant', value: 1 }, shape: { mode: 'constant', value: 'circle' }, visible: true, label: true }, types: Object.fromEntries(Object.entries(types).map(([t, c]) => [t, { color: { mode: 'constant', value: c } }])), tags: {} },
  edges: { default: { color: { mode: 'constant' }, width: { mode: 'constant', value: 1 }, opacity: { mode: 'constant', value: 0.25 }, visible: true, arrow: true }, types: {}, tags: {} },
  edgeLabels: false,
  curvedEdges: true,
})
const scene = (name: string, label: string, description: string, types: string[], relationshipTypes: string[], colours: Record<string, string>, extra: Record<string, unknown> = {}) => {
  const f = add(createEntity({ id: id(`filter-${name}`), type: 'filter', label: `${label} · filter`, tags: ['atlas'], data: { ...FILTER_DEFAULTS, types, relationshipTypes, ...extra }, meta }))
  const l = add(createEntity({ id: id(`layout-${name}`), type: 'layout', label: `${label} · layout`, tags: ['atlas'], data: { positions: {}, algorithm: 'force', params: PARAMS }, meta }))
  const r = add(createEntity({ id: id(`style-${name}`), type: 'rendering', label: `${label} · style`, tags: ['atlas'], data: style(colours), meta }))
  return add(createEntity({ id: id(`scene-${name}`), type: 'scene', label, description, tags: ['atlas', 'scene'], data: { renderer: '2d', filterId: f.id, layoutId: l.id, renderingId: r.id, algorithm: 'force', params: PARAMS, analysis: { auto: false, options: { metrics: ['degree', 'inDegree', 'outDegree', 'pagerank', 'clustering', 'component', 'componentSize', 'community'] } } }, meta }))
}
const S_CLUSTERS = scene('regions-clusters', 'Regions and clusters', 'The atlas’s two levels of clustering: regions (coarse) with their clusters (fine) nested in them. Size is how many things point at each.', ['region', 'cluster'], ['nested-in'], { region: '#7a4fbf', cluster: '#e07a3f' })
const S_CONVS = scene('conversations-by-cluster', 'Conversations by cluster', 'Every conversation pulled to the clusters its segments fall in, and the clusters to their regions — the map of the corpus.', ['conversation', 'cluster', 'region'], ['in-cluster', 'nested-in'], { conversation: '#9ec5e8', cluster: '#e07a3f', region: '#7a4fbf' })
const S_TOPICS = scene('topics-and-domains', 'Topics, domains and themes', 'The hub vocabulary — topics, domains, themes, personas — linked through the conversations that share them.', ['conversation', 'topic', 'domain', 'theme', 'persona'], ['on-topic', 'in-domain', 'has-theme', 'about-persona'], { conversation: '#cfd8dc', topic: '#0f766e', domain: '#2563eb', theme: '#e11d48', persona: '#ca8a04' }, { minDegree: 2 })
const S_SIMILAR = scene('segments-similar', 'Similar segments', 'Segments joined to the segments most like them (the pipeline’s similar-to links): the fine texture of the corpus, communities and all.', ['segment'], ['similar-to'], { segment: '#0891b2' }, { maxNodes: 6000 })

// ── The guide ───────────────────────────────────────────────────────────
add(createEntity({
  id: id('guide'),
  type: 'document',
  label: 'Reading the conversation atlas',
  tags: ['atlas', 'guide'],
  data: { extension: 'md', content: `# Reading the conversation atlas

This project holds a ChatGPT export run through the atlas pipeline (a separate, private tool): every *conversation* is split into *segments* (one coherent stretch each), and every segment is labelled against a fixed ontology — **domain**, **topic**, **theme**, **intent**, **mode**, **register**, **persona**, **entity**, **artifact**, **stakes** — as \`facet:value\` tags and \`data.facets\`. The segments are then clustered in the space of those labels into **clusters** and, above them, **regions**.

The analytics here are the Conversation atlas template, and they are all yours to change: a chart is a spec you can edit in its Charts tab, a script is code you can read and run, a scene is a filter and a style you can adjust in the Graph Explorer.

## Where to look

- **Analytics** — the tabs on the left are the charts, the tabs on the right the scripts. *Conversations per month* and *cumulative* are the pace; *Segments per month by region* and *Month × region* are what it was about and when; *Stakes*, *Modes* and *Intent mix* are how; *Segment length*, *Messages vs length* and *Salience* are the shape of the exchanges; *Top topics*, *Domain × theme*, *Topic emergence*, *Hubs* are the vocabulary.
- **Graph Explorer** — *Regions and clusters*, *Conversations by cluster*, *Topics, domains and themes*, *Similar segments* are saved scenes; open one from the scene picker.
- **Entities** — every segment, conversation, topic, region… as tables; the Tags rail filters by any facet value.
- **Insights** — the analytics harness finds hubs, communities, bursts and anomalies over the whole thing.

## Reproducing this

Run the pipeline over an export (\`acp all\`) and open the bundle it writes, \`data/out/conversation-atlas.ae.json\` (Open bundle…, or \`/open?url=…\`): it arrives as a project with these charts, scripts and scenes already in place. Open a fresh run of it and the data updates while your pictures stay.
` },
  meta,
}))

// ── Arrangements ─────────────────────────────────────────────────────────
const tab = (i: number, path: string, title: string) => ({ id: `t${i}`, path, title, back: [], forward: [] })
const chartTab = (i: number, name: string, title: string) => tab(i, `/analytics/charts?plot=${id(`chart-${name}`)}`, title)
const scriptTab = (i: number, name: string, title: string) => tab(i, `/analytics/scripts?script=${id(`script-${name}`)}`, title)
const analytics = {
  ws: {
    root: {
      kind: 'split', id: 's0', dir: 'row', ratio: 0.5,
      children: [
        { kind: 'pane', id: 'p0', active: 0, tabs: [chartTab(0, 'conversations-per-month', 'Pace'), chartTab(1, 'segments-by-region', 'Subjects over time'), chartTab(2, 'month-by-region', 'Month × region'), chartTab(3, 'stakes-per-quarter', 'Stakes'), chartTab(4, 'mode-per-month', 'Modes'), chartTab(5, 'messages-vs-length', 'Shape'), chartTab(6, 'salience-per-month', 'Salience'), chartTab(7, 'models-over-time', 'Models')] },
        { kind: 'pane', id: 'p1', active: 0, tabs: [scriptTab(10, 'top-topics', 'Top topics'), scriptTab(11, 'domain-x-theme', 'Domain × theme'), scriptTab(12, 'topic-emergence', 'Topic emergence'), scriptTab(13, 'intent-mix', 'Intent mix'), scriptTab(14, 'region-timelines', 'Region timelines'), scriptTab(15, 'length-trend', 'Length trend'), scriptTab(16, 'hubs', 'Hubs'), scriptTab(17, 'starred-and-salient', 'Stood out')] },
      ],
    },
    focused: 'p0',
  },
  dirty: false,
}
const workstation = add(createEntity({
  id: id('workstation'),
  type: 'workstation',
  label: 'Conversation atlas',
  description: 'The guide and the tables beside the map and the charts.',
  tags: ['atlas'],
  data: {
    root: {
      kind: 'split', id: 's0', dir: 'row', ratio: 0.42,
      children: [
        { kind: 'pane', id: 'p0', active: 0, tabs: [tab(0, `/documents/${id('guide')}`, 'Guide'), tab(1, '/entities?category=resource&type=conversation', 'Conversations'), tab(2, '/entities?category=knowledge&type=region', 'Regions'), tab(3, '/entities?category=knowledge&type=topic', 'Topics')] },
        { kind: 'pane', id: 'p1', active: 0, tabs: [tab(4, `/graph/2d?scene=${S_CONVS.id}`, 'Conversations by cluster'), tab(5, `/graph/2d?scene=${S_CLUSTERS.id}`, 'Regions and clusters'), tab(6, `/graph/2d?scene=${S_TOPICS.id}`, 'Topics and domains'), tab(7, `/graph/2d?scene=${S_SIMILAR.id}`, 'Similar segments'), tab(8, '/analytics', 'Analytics')] },
      ],
    },
    focused: 'p0',
  },
  meta,
}))

const tags: TagInfo[] = [
  { tag: 'atlas', color: '#0f766e', description: 'Part of the Conversation atlas template' },
  { tag: 'chart', color: '#0891b2' },
  { tag: 'script', color: '#7c3aed' },
  { tag: 'scene', color: '#7a4fbf' },
  { tag: 'guide', color: '#ca8a04' },
]

const doc: TemplateDocument = {
  $schema: 'aegraph/v1',
  exportedAt: T,
  template: {
    id: TPL,
    label: 'Conversation atlas',
    description: 'Analytics over a ChatGPT export run through the atlas pipeline: the pace of conversations, what they were about and how that shifted, stakes, modes and intents, the shape of the exchanges, the vocabulary and its hubs, the regions and clusters — as charts, scripts and graph scenes, arranged in Analytics tabs and a Workstation.',
    requires: ['segment', 'conversation'],
    adopts: ['segment', 'conversation', 'topic', 'named-entity', 'cluster', 'domain', 'theme', 'persona', 'region'],
    home: '/analytics',
    hint: 'for a ChatGPT export labelled as a conversation atlas',
  },
  tags,
  entities,
  state: { route: '/analytics', ui: { 'aegraph:analytics:v1': JSON.stringify(analytics), 'aegraph:workstation:v1': JSON.stringify({ ws: workstation.data.root ? { root: workstation.data.root, focused: 'p0' } : undefined, presetId: workstation.id, dirty: false }) } },
}
mkdirSync('public/templates', { recursive: true })
writeFileSync(`public/templates/${TPL}.template.ae.json`, JSON.stringify(doc, null, 1) + '\n')
console.log(`wrote public/templates/${TPL}.template.ae.json: ${entities.length} entities (${entities.filter((e) => e.type === 'plot').length} charts, ${entities.filter((e) => e.type === 'script').length} scripts, ${entities.filter((e) => e.type === 'scene').length} scenes)`)
