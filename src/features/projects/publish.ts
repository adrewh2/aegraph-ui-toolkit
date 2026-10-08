import { isAssistantRecord } from '../../core/projects/bundle'
import { displayLabel } from '../../core/entity/entity'
import type { EntityStore } from '../../core/entity/store'
import type { TypeRegistry } from '../../core/entity/typeRegistry'
import { isRelationship, type AnyEntity, type EntityId, type Relationship } from '../../core/entity/types'
import { svgFromView } from '../../core/exchange/graph/svg'
import { applyFilter, describeFilter, emptyFilter, toFilterSpec, type FilterSpec } from '../../core/graph/filter'
import { DEFAULT_LAYOUT_PARAMS, computeLayout, isHeavyLayout, layoutInfo, resolvePositions, type LayoutAlgorithm, type Positions } from '../../core/graph/layouts'
import { buildPlot, isPlot, type PlotSpec } from '../../core/graph/plot'
import { isProject, projectMembers } from '../../core/graph/project'
import { DEFAULT_METRICS, indexOf as metricIndexOf, serializeSlice, sliceKey as sliceKeyOf, type MetricsResult } from '../../core/graph/metrics'
import { getCachedMetrics, putCachedMetrics } from '../../core/graph/metrics/cache'
import { computeMetrics } from '../../core/graph/metrics/compute'
import { renderingUsesMetrics } from '../../core/graph/pipeline'
import { DEFAULT_RENDERING, describeRendering, resolveEdgeStyle, resolveNodeStyle, styleContext, toRenderingSpec, type EdgeStyle, type NodeStyle, type RenderingData, type RenderingSpec } from '../../core/graph/rendering'
import { isGraphSceneType, type SceneData } from '../../core/graph/scene'
import type { FilterData, LayoutData } from '../../core/graph/types'
import { makeValueContext } from '../../core/graph/values'
import { projectLabel, scopeEntities } from '../../core/projects/project'
import { parseMarkdown, type MdAlign, type MdBlock, type MdInline } from '../../lib/markdown'
import { getLatestAnalysis } from '../analysis/latest'
import { contentOf, extOf, isDocument, isFolder } from '../documents/documents'
import { getExplorerHandle } from '../graph/explorerHandle'
import { edgeColor } from '../graph/style'
import { CLAIM_TYPE, COMMUNITY_TYPE, MEMBER_OF, SUPPORTS } from '../knowledge/claims'
import { plotContextFor } from '../plots/plotContext'
import { loadPlotly } from '../plots/PlotlyChart'
import { bundleStem } from './projectActions'
import { cssColor, isCssColor } from '../../lib/cssColor'

/**
 * Publish: a project as one self-contained, read-only HTML page anyone can
 * open — no app, no server. What is on it: the overview (types, tags), every
 * saved graph scene drawn as an SVG (and Unigraph's current view
 * when one is open on this project), every chart as a picture, the latest
 * findings and the claims kept from them, the documents, and a searchable
 * table of every entity with its relationships. The drawing goes through
 * the same code as the app — the filter, the saved positions, the style
 * rules, the SVG writer, the plot builder — so the page shows what the
 * app shows.
 */

export interface PublishOptions {
  /** Rows in the entity table (the rest is counted, not listed). Default 20,000. */
  maxEntities?: number
  /** Documents rendered in full. Default 60. */
  maxDocuments?: number
  /** Graph pictures: nodes beyond this are left out of the SVG. Default 4,000. */
  maxSceneNodes?: number
  /** Skip charts (they need Plotly loaded in the app). */
  skipCharts?: boolean
  /**
   * Include the assistant's chats and its memory document. Off by default: a published page is for other people, and
   * those are the user's conversation with the assistant, not the project's content.
   */
  assistant?: boolean
}

export interface PublishResult {
  html: string
  filename: string
  stats: { entities: number; relationships: number; scenes: number; charts: number; findings: number; claims: number; documents: number; bytes: number }
}

export async function publishProject(store: EntityStore, registry: TypeRegistry, projectId: EntityId | null, opts: PublishOptions = {}): Promise<PublishResult> {
  const maxEntities = opts.maxEntities ?? 20_000
  const maxDocuments = opts.maxDocuments ?? 60
  const maxSceneNodes = opts.maxSceneNodes ?? 4_000
  const project = projectId ? store.get(projectId) : undefined
  const title = projectLabel(store, projectId)
  const description = project?.description ?? (projectId ? '' : 'Everything in the Library.')

  // ── What is in scope ──
  const all = scopeEntities(store, projectId).filter((e) => opts.assistant || !isAssistantRecord(e))
  const hidden = new Set(['schema', 'project'])
  const nodes = all.filter((e) => !isRelationship(e) && !hidden.has(registry.categoryOf(e.type)))
  const nodeIds = new Set(nodes.map((n) => n.id))
  const edges = all.filter((e): e is Relationship => isRelationship(e) && nodeIds.has(e.source.id) && nodeIds.has(e.target.id))
  const members = projectId ? new Set(all.map((e) => e.id)) : undefined

  // ── Overview: types and tags ──
  const typeCounts = new Map<string, number>()
  for (const n of nodes) typeCounts.set(n.type, (typeCounts.get(n.type) ?? 0) + 1)
  const relTypeCounts = new Map<string, number>()
  for (const e of edges) relTypeCounts.set(e.type, (relTypeCounts.get(e.type) ?? 0) + 1)
  const tagCounts = new Map<string, number>()
  for (const n of nodes) for (const t of n.tags) tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1)
  const types = [...typeCounts].sort((a, b) => b[1] - a[1]).map(([type, count]) => ({ type, count, label: registry.get(type).pluralLabel, color: cssColor(registry.colorOf(type), '#94a3b8') }))
  const tags = [...tagCounts].sort((a, b) => b[1] - a[1]).slice(0, 40).map(([tag, count]) => ({ tag, count, color: isCssColor(store.getTagInfo(tag).color) ? store.getTagInfo(tag).color : undefined }))

  // ── Graph scenes ──
  const scenes: { title: string; caption: string; svg: string }[] = []
  for (const scene of all.filter((e) => isGraphSceneType(e.type) && !isRelationship(e)).sort((a, b) => a.meta.updatedAt.localeCompare(b.meta.updatedAt))) {
    try {
      const drawn = sceneSvg(store, registry, scene, members, maxSceneNodes)
      if (drawn) scenes.push({ title: displayLabel(scene), ...drawn })
    } catch (err) {
      console.warn('publish: scene skipped', scene.id, err)
    }
  }
  const live = await currentViewPicture(store, projectId, maxSceneNodes)
  if (live) scenes.push(live)

  // ── Charts ──
  const charts: { title: string; caption: string; src: string }[] = []
  const plots = all.filter(isPlot).sort((a, b) => a.meta.updatedAt.localeCompare(b.meta.updatedAt))
  if (plots.length && !opts.skipCharts) {
    const ctx = plotContextFor(store, registry, projectId ?? undefined)
    let Plotly: Awaited<ReturnType<typeof loadPlotly>> | undefined
    try {
      Plotly = await loadPlotly()
    } catch (err) {
      console.warn('publish: Plotly not available, charts skipped', err)
    }
    if (Plotly) {
      for (const p of plots) {
        try {
          const spec = p.data.spec as PlotSpec
          const built = buildPlot(spec, ctx)
          if (!built.data.length) continue
          const layout = { ...built.layout, width: 960, height: 520, paper_bgcolor: '#ffffff', plot_bgcolor: '#ffffff', font: { family: 'system-ui, sans-serif', size: 12 } }
          // toImage also takes a figure ({ data, layout }) and draws it in a hidden div; the typings only name the element form.
          const src = await Plotly.toImage({ data: built.data, layout } as unknown as HTMLElement, { format: 'svg', width: 960, height: 520 })
          if (!/^data:image\//i.test(src)) continue
          charts.push({ title: displayLabel(p), caption: `${p.description ?? ''}${built.stats.rows ? ` ${built.stats.rows.toLocaleString()} rows` : ''}`.trim(), src })
        } catch (err) {
          console.warn('publish: chart skipped', p.id, err)
        }
      }
    }
  }

  // ── Findings and claims ──
  const latest = getLatestAnalysis()
  const findings = latest && (latest.report.scope.projectId ?? null) === (projectId ?? null) ? latest.report.findings.slice(0, 12) : []
  const claims = all
    .filter((e) => !isRelationship(e) && e.type === CLAIM_TYPE)
    .sort((a, b) => b.meta.updatedAt.localeCompare(a.meta.updatedAt))
    .map((c) => ({ entity: c, evidence: store.relationshipsOf(c.id, 'in').filter((r) => r.type === SUPPORTS).map((r) => store.get(r.source.id)).filter((e): e is AnyEntity => !!e) }))
  const communities = all
    .filter((e) => !isRelationship(e) && e.type === COMMUNITY_TYPE)
    .sort((a, b) => b.meta.updatedAt.localeCompare(a.meta.updatedAt))
    .map((c) => ({ entity: c, size: store.relationshipsOf(c.id, 'in').filter((r) => r.type === MEMBER_OF).length }))

  // ── Documents ──
  const docs = all.filter((e) => isDocument(e) && !isFolder(e) && contentOf(e).trim()).sort((a, b) => a.meta.updatedAt.localeCompare(b.meta.updatedAt))

  // ── The page ──
  const labelOf = (id: EntityId) => {
    const e = store.get(id)
    return e ? displayLabel(e) : id
  }
  const listed = nodes.slice(0, maxEntities)
  const listedIds = new Set(listed.map((n) => n.id))
  const data = {
    nodes: listed.map((n) => ({ id: n.id, l: displayLabel(n), t: n.type, g: n.tags, d: (n.description ?? '').slice(0, 400) })),
    edges: edges.filter((e) => listedIds.has(e.source.id) && listedIds.has(e.target.id)).map((e) => ({ s: e.source.id, t: e.target.id, y: e.type, l: e.label ?? '' })),
    types: Object.fromEntries(types.map((t) => [t.type, { label: registry.get(t.type).label, color: t.color }])),
  }
  const parts: string[] = []
  const when = new Date()
  parts.push(`<header class="hd"><div class="wrap">
<p class="eyebrow">Published from aegraph · ${esc(when.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }))}</p>
<h1>${esc(title)}</h1>
${description ? `<p class="lead">${esc(description)}</p>` : ''}
<p class="meta">${nodes.length.toLocaleString()} entities · ${edges.length.toLocaleString()} relationships · ${types.length} types${scenes.length ? ` · ${scenes.length} graph${scenes.length === 1 ? '' : 's'}` : ''}${charts.length ? ` · ${charts.length} chart${charts.length === 1 ? '' : 's'}` : ''}${docs.length ? ` · ${docs.length} document${docs.length === 1 ? '' : 's'}` : ''}</p>
</div></header>`)
  const nav = [['overview', 'Overview'], scenes.length && ['graphs', 'Graphs'], charts.length && ['charts', 'Charts'], (findings.length || claims.length || communities.length) && ['findings', 'Findings'], docs.length && ['documents', 'Documents'], ['entities', 'Entities']].filter((x): x is [string, string] => Array.isArray(x))
  parts.push(`<nav class="nav"><div class="wrap">${nav.map(([id, label]) => `<a href="#${id}">${label}</a>`).join('')}</div></nav>`)

  parts.push(`<section id="overview" class="wrap"><h2>Overview</h2>
<div class="types">${types.map((t) => `<a class="type" href="#entities" data-type="${esc(t.type)}"><i style="background:${esc(t.color)}"></i><b>${t.count.toLocaleString()}</b><span>${esc(t.label)}</span></a>`).join('')}</div>
${relTypeCounts.size ? `<p class="muted">Relationships: ${[...relTypeCounts].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([t, n]) => `<span class="rel">${esc(t)} <b>${n.toLocaleString()}</b></span>`).join(' ')}</p>` : ''}
${tags.length ? `<div class="tags">${tags.map((t) => `<span class="tag" style="${t.color ? `--c:${esc(t.color)}` : ''}">${esc(t.tag)} <b>${t.count.toLocaleString()}</b></span>`).join('')}</div>` : ''}
</section>`)

  if (scenes.length) parts.push(`<section id="graphs" class="wrap"><h2>Graphs</h2>${scenes.map((s) => `<figure class="fig"><div class="fig__svg">${s.svg}</div><figcaption><b>${esc(s.title)}</b> · ${esc(s.caption)}</figcaption></figure>`).join('')}</section>`)
  if (charts.length) parts.push(`<section id="charts" class="wrap"><h2>Charts</h2>${charts.map((c) => `<figure class="fig"><img src="${esc(c.src)}" alt="${esc(c.title)}"><figcaption><b>${esc(c.title)}</b>${c.caption ? ` · ${esc(c.caption)}` : ''}</figcaption></figure>`).join('')}</section>`)

  if (findings.length || claims.length || communities.length) {
    const f = findings.map((x) => `<article class="finding"><h3>${esc(x.title)}</h3><p>${esc(x.detail)}</p>${x.entities?.length ? `<p class="chips">${x.entities.slice(0, 10).map((id) => `<a class="chip" href="#e-${esc(id)}">${esc(labelOf(id))}</a>`).join('')}</p>` : ''}</article>`)
    const c = claims.map(({ entity, evidence }) => `<article class="finding finding--claim"><h3>${esc(displayLabel(entity))}</h3>${entity.description ? `<p>${esc(entity.description)}</p>` : ''}<p class="chips"><span class="muted">${evidence.length ? `Supported by ${evidence.length}:` : 'No supporting entities'}</span>${evidence.slice(0, 10).map((e) => `<a class="chip" href="#e-${esc(e.id)}">${esc(displayLabel(e))}</a>`).join('')}</p></article>`)
    const m = communities.map(({ entity, size }) => `<article class="finding finding--community"><h3>${esc(displayLabel(entity))}</h3><p>${entity.description ? `${esc(entity.description)} · ` : ''}${size.toLocaleString()} member${size === 1 ? '' : 's'}</p></article>`)
    parts.push(`<section id="findings" class="wrap"><h2>Findings</h2>${claims.length ? `<h3 class="sub">Claims</h3>${c.join('')}` : ''}${communities.length ? `<h3 class="sub">Named communities</h3>${m.join('')}` : ''}${findings.length ? `<h3 class="sub">From the latest analysis${latest ? ` · ${esc(new Date(latest.report.computedAt).toLocaleString())}` : ''}</h3>${f.join('')}` : ''}</section>`)
  }

  if (docs.length) {
    parts.push(`<section id="documents" class="wrap"><h2>Documents</h2>${docs
      .slice(0, maxDocuments)
      .map((d) => {
        const text = contentOf(d)
        const body = extOf(d) === 'md' ? mdHtml(parseMarkdown(text.slice(0, 200_000))) : `<pre class="plain">${esc(text.slice(0, 200_000))}</pre>`
        return `<details class="doc" id="e-${esc(d.id)}"><summary>${esc(displayLabel(d))}<span class="muted"> · .${esc(extOf(d))} · ${text.length.toLocaleString()} chars</span></summary><div class="doc__body">${body}</div></details>`
      })
      .join('')}${docs.length > maxDocuments ? `<p class="muted">${docs.length - maxDocuments} more documents are listed under Entities.</p>` : ''}</section>`)
  }

  parts.push(`<section id="entities" class="wrap"><h2>Entities</h2>
<div class="bar"><input id="q" type="search" placeholder="Search label, type, tags, description…"><select id="ty"><option value="">Every type</option>${types.map((t) => `<option value="${esc(t.type)}">${esc(t.label)} (${t.count.toLocaleString()})</option>`).join('')}</select><span id="count" class="muted"></span></div>
${nodes.length > maxEntities ? `<p class="muted">The first ${maxEntities.toLocaleString()} of ${nodes.length.toLocaleString()} entities are listed.</p>` : ''}
<table class="et"><thead><tr><th>Label</th><th>Type</th><th>Tags</th><th>Description</th><th class="num">Links</th></tr></thead><tbody id="rows"></tbody></table>
<p class="more"><button id="more" type="button">Show more</button></p>
</section>`)
  parts.push(`<footer class="wrap muted">Published from aegraph on ${esc(when.toLocaleString())}. This page is a snapshot: it does not change when the project does.</footer>`)
  parts.push(`<script id="data" type="application/json">${JSON.stringify(data).replace(/</g, '\\u003c')}</script><script>${PAGE_SCRIPT}</script>`)

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${await publishedPolicy()}"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title><style>${PAGE_CSS}</style></head><body>${parts.join('\n')}</body></html>`
  return {
    html,
    filename: `${bundleStem(title)}.html`,
    stats: { entities: nodes.length, relationships: edges.length, scenes: scenes.length, charts: charts.length, findings: findings.length, claims: claims.length, documents: docs.length, bytes: new Blob([html]).size },
  }
}

// ── Graph pictures ─────────────────────────────────────────────────────

/** A saved scene drawn as the app would draw it: its filter over the scope, its layout's positions (the rest laid out with its algorithm), its style. */
export function sceneSvg(store: EntityStore, registry: TypeRegistry, scene: AnyEntity, members: Set<EntityId> | undefined, maxNodes: number): { caption: string; svg: string } | null {
  const d = scene.data as SceneData
  const filterEntity = d.filterId ? store.get(d.filterId) : undefined
  const layoutEntity = d.layoutId ? store.get(d.layoutId) : undefined
  const renderingEntity = d.renderingId ? store.get(d.renderingId) : undefined
  // The scene's own dataset stage — a loaded graph project — narrows the scope further.
  const sceneProject = d.projectId ? store.get(d.projectId) : undefined
  const scopeMembers = isProject(sceneProject) ? projectMembers(sceneProject) : members
  const filter: FilterSpec = filterEntity ? toFilterSpec(filterEntity.data as FilterData) : emptyFilter()
  filter.maxNodes = Math.min(filter.maxNodes ?? maxNodes, maxNodes)
  const slice = applyFilter(store, registry, filter, { members: scopeMembers })
  if (!slice.nodes.length) return null
  const layout = layoutEntity?.data as LayoutData | undefined
  const algorithm: LayoutAlgorithm = d.algorithm && layoutInfo(d.algorithm) ? d.algorithm : layout?.algorithm && layoutInfo(layout.algorithm as LayoutAlgorithm) ? (layout.algorithm as LayoutAlgorithm) : 'force'
  const positions = positionsFor(slice, layout?.positions, algorithm, d.params)
  const rendering = renderingEntity ? toRenderingSpec(renderingEntity.data as RenderingData) : DEFAULT_RENDERING
  // A style that reads metrics (colour by community, size by PageRank) needs them computed, as the explorer's auto analysis would.
  let metrics: MetricsResult | undefined
  if (renderingUsesMetrics(rendering)) {
    const options = { ...(d.analysis?.options ?? {}), metrics: d.analysis?.options?.metrics?.length ? d.analysis.options.metrics : DEFAULT_METRICS }
    const key = sliceKeyOf(slice)
    metrics = getCachedMetrics(key, options)
    if (!metrics) {
      metrics = computeMetrics(serializeSlice(slice, options.weightField), options, {}, key)
      putCachedMetrics(metrics)
    }
  }
  const styles = stylesFor(store, registry, slice, rendering, metrics)
  const svg = svgFromView(slice, positions, styles, { width: 1100, height: 700, labels: slice.nodes.length <= 150 ? 'all' : 'auto', edgeLabels: rendering.edgeLabels, curvedEdges: rendering.curvedEdges })
  const caption = `${slice.nodes.length.toLocaleString()} nodes, ${slice.edges.length.toLocaleString()} edges${slice.truncated ? ` (${slice.truncated.toLocaleString()} more not drawn)` : ''} · filter: ${describeFilter(filter)} · layout: ${layoutInfo(algorithm).label} · style: ${describeRendering(rendering)}`
  return { caption, svg }
}

function positionsFor(slice: ReturnType<typeof applyFilter>, saved: Positions | undefined, algorithm: LayoutAlgorithm, params: SceneData['params']): Positions {
  const p = { ...DEFAULT_LAYOUT_PARAMS, ...(params ?? {}), dimensions: 2 as const }
  // A heavy force run in the page would take seconds; the app's own fallback (a grid) is what it would show too.
  const fallback: LayoutAlgorithm = isHeavyLayout(algorithm, slice.nodes.length) ? 'grid' : algorithm
  if (saved && Object.keys(saved).length) return resolvePositions(slice, saved, fallback, p).positions
  return computeLayout(fallback, slice, p)
}

function stylesFor(store: EntityStore, registry: TypeRegistry, slice: ReturnType<typeof applyFilter>, rendering: RenderingSpec, metrics?: MetricsResult): { nodes: Map<EntityId, NodeStyle>; edges: Map<EntityId, EdgeStyle> } {
  const metricIndex = metrics ? metricIndexOf(metrics) : undefined
  const values = makeValueContext({ scope: 'view', store, slice, metrics, metricIndex })
  const ctx = styleContext(registry, slice.nodes, slice.degree, rendering, { edges: slice.edges, metrics, metricIndex, values, tagColor: (t) => store.getTagInfo(t).color })
  const nodes = new Map<EntityId, NodeStyle>()
  for (const n of slice.nodes) nodes.set(n.id, resolveNodeStyle(n, rendering, ctx))
  const edges = new Map<EntityId, EdgeStyle>()
  for (const e of slice.edges) edges.set(e.id, resolveEdgeStyle(e, rendering, edgeColor, ctx))
  return { nodes, edges }
}

/** Unigraph's current view, when one is open on this scope: the canvas as a picture, or the view as SVG when the renderer can't snapshot. */
async function currentViewPicture(store: EntityStore, projectId: EntityId | null, maxNodes: number): Promise<{ title: string; caption: string; svg: string } | null> {
  const h = getExplorerHandle()
  if (!h || (store.scope ?? null) !== (projectId ?? null)) return null
  const slice = h.getSlice()
  if (!slice.nodes.length) return null
  const st = h.getState()
  const caption = `${slice.nodes.length.toLocaleString()} nodes, ${slice.edges.length.toLocaleString()} edges · filter: ${describeFilter(st.filter)} · layout: ${layoutInfo(st.algorithm).label} · style: ${describeRendering(st.rendering)}`
  try {
    const blob = await h.snapshot({ width: 1600, height: 1000, background: '#ffffff' })
    if (blob) {
      const src = await new Promise<string>((resolve, reject) => {
        const r = new FileReader()
        r.onload = () => resolve(String(r.result))
        r.onerror = () => reject(r.error)
        r.readAsDataURL(blob)
      })
      return { title: 'Current view in Unigraph', caption, svg: `<img src="${src}" alt="Current view">` }
    }
  } catch (err) {
    console.warn('publish: snapshot failed, drawing SVG', err)
  }
  if (h.dims === 3 || slice.nodes.length > maxNodes) return null
  const svg = svgFromView(slice, h.getPositions(), h.getStyles(), { width: 1100, height: 700, labels: st.labels, edgeLabels: st.rendering.edgeLabels, curvedEdges: st.rendering.curvedEdges })
  return { title: 'Current view in Unigraph', caption, svg }
}

// ── Markdown → HTML (escaped; the parser never yields raw HTML) ────────

export function mdHtml(blocks: MdBlock[]): string {
  return blocks.map(block).join('')
}
function block(b: MdBlock): string {
  switch (b.t) {
    case 'heading':
      return `<h${b.level + 1}>${inline(b.c)}</h${b.level + 1}>`
    case 'paragraph':
      return `<p>${inline(b.c)}</p>`
    case 'code':
      return `<pre><code${b.lang ? ` class="lang-${esc(b.lang)}"` : ''}>${esc(b.v)}</code></pre>`
    case 'quote':
      return `<blockquote>${mdHtml(b.c)}</blockquote>`
    case 'list':
      return `<${b.ordered ? `ol${b.start && b.start !== 1 ? ` start="${b.start}"` : ''}` : 'ul'}>${b.items.map((it) => `<li>${it.checked !== undefined ? `<input type="checkbox" disabled${it.checked ? ' checked' : ''}> ` : ''}${mdHtml(it.c)}</li>`).join('')}</${b.ordered ? 'ol' : 'ul'}>`
    case 'hr':
      return '<hr>'
    case 'table':
      return `<table><thead><tr>${b.head.map((c, i) => `<th${align(b.align[i])}>${inline(c)}</th>`).join('')}</tr></thead><tbody>${b.rows.map((r) => `<tr>${r.map((c, i) => `<td${align(b.align[i])}>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`
  }
}
const align = (a: MdAlign) => (a ? ` style="text-align:${a}"` : '')
function inline(nodes: MdInline[]): string {
  return nodes
    .map((n) => {
      switch (n.t) {
        case 'text':
          return esc(n.v)
        case 'code':
          return `<code>${esc(n.v)}</code>`
        case 'strong':
        case 'em':
        case 'del':
          return `<${n.t}>${inline(n.c)}</${n.t}>`
        case 'link':
          return /^(https?:|mailto:|#)/i.test(n.href) ? `<a href="${esc(n.href)}" rel="noopener">${inline(n.c)}</a>` : inline(n.c)
        case 'image':
          // A remote picture is a link: the page loads nothing from another host (its policy says so, `img-src data:`).
          return /^https?:/i.test(n.src) ? `<a href="${esc(n.src)}" rel="noopener noreferrer">${esc(n.alt || 'image')}</a>` : esc(n.alt)
        case 'br':
          return '<br>'
      }
    })
    .join('')
}

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

// ── The page's own style and script ────────────────────────────────────

const PAGE_CSS = `
:root{--bg:#faf9f6;--surface:#fff;--text:#1a1a1a;--muted:#6b6b6b;--border:#e5e2dc;--accent:#8a4b2a;--radius:8px}
*{box-sizing:border-box}html{scroll-behavior:smooth}
body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
.wrap{max-width:1160px;margin:0 auto;padding:0 24px}
.hd{padding:40px 0 24px;border-bottom:1px solid var(--border);background:var(--surface)}
.eyebrow{margin:0 0 8px;font-size:12px;letter-spacing:.04em;text-transform:uppercase;color:var(--muted)}
h1{margin:0;font:600 34px/1.15 Georgia,"Times New Roman",serif}
.lead{font-size:16px;margin:12px 0 0;max-width:760px}
.meta,.muted{color:var(--muted)}
.nav{position:sticky;top:0;z-index:2;background:rgba(250,249,246,.94);backdrop-filter:blur(6px);border-bottom:1px solid var(--border)}
.nav .wrap{display:flex;gap:4px;overflow-x:auto}
.nav a{padding:10px 12px;color:var(--text);text-decoration:none;font-weight:500;border-bottom:2px solid transparent;white-space:nowrap}
.nav a:hover{border-color:var(--accent)}
section.wrap{padding:36px 24px 12px}
h2{font:600 22px/1.2 Georgia,"Times New Roman",serif;margin:0 0 14px}
h3.sub{font-size:13px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);margin:22px 0 8px}
.types{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:12px}
.type{display:inline-flex;align-items:center;gap:8px;padding:6px 12px;border:1px solid var(--border);border-radius:var(--radius);background:var(--surface);color:inherit;text-decoration:none}
.type i{width:10px;height:10px;border-radius:50%}
.type b{font-variant-numeric:tabular-nums}
.rel{display:inline-block;margin-right:8px;padding:1px 6px;border:1px solid var(--border);border-radius:4px;background:var(--surface);font-size:12px}
.tags{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px}
.tag{--c:#e5e2dc;padding:1px 8px;border-radius:4px;background:color-mix(in srgb,var(--c) 28%,white);border:1px solid color-mix(in srgb,var(--c) 55%,white);font-size:12px}
.tag b{font-weight:500;color:var(--muted)}
.fig{margin:0 0 24px;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);overflow:hidden}
.fig__svg svg,.fig img{display:block;width:100%;height:auto}
.fig figcaption{padding:10px 14px;border-top:1px solid var(--border);color:var(--muted);font-size:13px}
.fig figcaption b{color:var(--text)}
.finding{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:12px 14px;margin-bottom:8px}
.finding h3{margin:0 0 4px;font-size:15px}
.finding p{margin:4px 0}
.finding--claim{border-left:3px solid #fca5a5}
.finding--community{border-left:3px solid #f9a8d4}
.chips{display:flex;flex-wrap:wrap;gap:4px;align-items:center}
.chip{display:inline-block;padding:1px 7px;border-radius:4px;background:var(--bg);border:1px solid var(--border);font-size:12px;color:inherit;text-decoration:none}
.doc{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);margin-bottom:8px}
.doc summary{padding:10px 14px;cursor:pointer;font-weight:500}
.doc__body{padding:4px 18px 16px;max-width:820px}
.doc__body pre,.plain{white-space:pre-wrap;background:var(--bg);padding:10px;border-radius:6px;font-size:12.5px}
.doc__body table{border-collapse:collapse}.doc__body td,.doc__body th{border:1px solid var(--border);padding:4px 8px}
.doc__body blockquote{margin:0;padding-left:12px;border-left:3px solid var(--border);color:var(--muted)}
.bar{display:flex;gap:8px;align-items:center;margin-bottom:10px;flex-wrap:wrap}
.bar input,.bar select{font:inherit;padding:6px 10px;border:1px solid var(--border);border-radius:6px;background:var(--surface)}
.bar input{flex:1;min-width:220px}
.et{width:100%;border-collapse:collapse;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);font-size:13px}
.et th,.et td{text-align:left;padding:6px 10px;border-bottom:1px solid var(--border);vertical-align:top}
.et th{font-size:12px;color:var(--muted);font-weight:500;position:sticky;top:42px;background:var(--surface)}
.et .num{text-align:right;font-variant-numeric:tabular-nums}
.et tr.row{cursor:pointer}.et tr.row:hover{background:var(--bg)}
.et tr.is-open{background:#f3efe8}
.et .t{display:inline-flex;align-items:center;gap:6px;white-space:nowrap}.et .t i{width:8px;height:8px;border-radius:50%}
.et .g{font-size:11.5px;color:var(--muted)}
.et .d{color:var(--muted);max-width:480px}
.et tr.links td{background:#fbfaf7;padding:8px 10px 10px 28px}
.links ul{margin:0;padding:0;list-style:none;columns:2;column-gap:24px}
.links li{padding:2px 0;break-inside:avoid}.links li a{color:inherit}
.links .y{color:var(--muted);font-size:12px}
.more{text-align:center;margin:12px 0}.more button{font:inherit;padding:6px 14px;border:1px solid var(--border);border-radius:6px;background:var(--surface);cursor:pointer}
footer{padding:24px;font-size:12px;border-top:1px solid var(--border);margin-top:20px}
@media (max-width:700px){.links ul{columns:1}.et .d{display:none}h1{font-size:26px}}
`

/**
 * The published page's own Content-Security-Policy. The page is opened from a
 * disk, a share or someone else's host, where no header protects it, and it
 * holds text other people wrote: so it runs its one script (by hash) and
 * nothing else, and loads nothing from anywhere — pictures are carried in it,
 * a remote image is a link.
 */
export async function publishedPolicy(): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(PAGE_SCRIPT))
  const hash = btoa(String.fromCharCode(...new Uint8Array(digest)))
  return `default-src 'none'; script-src 'sha256-${hash}'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'`
}

export const PAGE_SCRIPT = `
(function(){
var D=JSON.parse(document.getElementById('data').textContent);
var byId={};D.nodes.forEach(function(n){byId[n.id]=n});
var links={};D.edges.forEach(function(e){(links[e.s]=links[e.s]||[]).push({o:e.t,y:e.y,d:'→',l:e.l});(links[e.t]=links[e.t]||[]).push({o:e.s,y:e.y,d:'←',l:e.l})});
var q=document.getElementById('q'),ty=document.getElementById('ty'),rows=document.getElementById('rows'),count=document.getElementById('count'),more=document.getElementById('more');
var PAGE=200,shown=0,list=D.nodes,open=null;
function esc(s){return String(s).replace(/[&<>"']/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
function type(t){var d=D.types[t]||{label:t,color:'#94a3b8'};return '<span class="t"><i style="background:'+esc(d.color)+'"></i>'+esc(d.label)+'</span>'}
function row(n){var k=(links[n.id]||[]).length;return '<tr class="row" id="e-'+esc(n.id)+'" data-id="'+esc(n.id)+'"><td>'+esc(n.l)+'</td><td>'+type(n.t)+'</td><td class="g">'+n.g.map(esc).join(', ')+'</td><td class="d">'+esc(n.d)+'</td><td class="num">'+k+'</td></tr>'}
function render(reset){if(reset){rows.innerHTML='';shown=0;open=null}var end=Math.min(list.length,shown+PAGE),h='';for(var i=shown;i<end;i++)h+=row(list[i]);rows.insertAdjacentHTML('beforeend',h);shown=end;more.style.display=shown<list.length?'':'none';count.textContent=list.length.toLocaleString()+(list.length===D.nodes.length?' entities':' of '+D.nodes.length.toLocaleString())}
function filter(){var s=q.value.trim().toLowerCase(),t=ty.value,words=s?s.split(/\\s+/):[];list=D.nodes.filter(function(n){if(t&&n.t!==t)return false;if(!words.length)return true;var hay=(n.l+' '+n.t+' '+n.g.join(' ')+' '+n.d).toLowerCase();return words.every(function(w){return hay.indexOf(w)>=0})});render(true)}
q.addEventListener('input',filter);ty.addEventListener('change',filter);more.addEventListener('click',function(){render(false)});
rows.addEventListener('click',function(e){var tr=e.target.closest('tr.row');if(!tr||e.target.closest('a'))return;var id=tr.getAttribute('data-id');var was=open;if(open){var o=rows.querySelector('tr.links');if(o)o.remove();var ot=rows.querySelector('tr.is-open');if(ot)ot.classList.remove('is-open');open=null}if(was===id)return;var L=(links[id]||[]).slice(0,200);var html='<tr class="links"><td colspan="5">'+(L.length?'<ul>'+L.map(function(x){var o=byId[x.o];return '<li><span class="y">'+esc(x.d)+' '+esc(x.y)+(x.l?' · '+esc(x.l):'')+'</span> <a href="#e-'+esc(x.o)+'" data-go="'+esc(x.o)+'">'+esc(o?o.l:x.o)+'</a></li>'}).join('')+'</ul>'+((links[id]||[]).length>200?'<p class="muted">'+((links[id]||[]).length-200)+' more…</p>':''):'<span class="muted">No relationships.</span>')+'</td></tr>';tr.insertAdjacentHTML('afterend',html);tr.classList.add('is-open');open=id});
function reveal(id){if(!byId[id])return;q.value='';ty.value='';list=D.nodes;var i=list.findIndex(function(n){return n.id===id});if(i<0)return;if(i>=shown){render(true);while(shown<=i)render(false)}var tr=document.getElementById('e-'+id);if(tr){tr.scrollIntoView({block:'center'});if(open!==id)tr.click()}}
document.addEventListener('click',function(e){var a=e.target.closest('a[href^="#e-"]');if(!a)return;var id=a.getAttribute('href').slice(3);if(document.getElementById('e-'+id)&&!byId[id])return;e.preventDefault();reveal(id)});
document.querySelectorAll('.type[data-type]').forEach(function(a){a.addEventListener('click',function(e){e.preventDefault();ty.value=a.getAttribute('data-type');filter();document.getElementById('entities').scrollIntoView()})});
render(true);
if(location.hash.indexOf('#e-')===0)reveal(decodeURIComponent(location.hash.slice(3)));
})();
`
