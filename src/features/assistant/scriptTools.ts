import { betaTool } from '@anthropic-ai/sdk/helpers/beta/json-schema'
import { displayLabel, quoteLabel } from '../../core/entity/entity'
import { TypeRegistry } from '../../core/entity/typeRegistry'
import { describeOutputs, figureTitle, outputsOf } from '../../scripting/outputs'
import type { Output } from '../../scripting/types'
import { PY_API, SCRIPT_API, VIEW_API } from '../scripts/api'
import { detectLanguage } from '../../scripting/detect'
import type { Language } from '../../scripting/types'
import { runScript } from '../scripts/runner'
import { buildExprSchema } from '../expr/schema'
import { getLatestAnalysis } from '../analysis/latest'
import { isScript, isScriptSubtype, markScriptUse, saveScript, scriptKindOf, scriptsIn, subtypeOfOutputs, updateScriptDetails, SCRIPT_SUBTYPES } from '../scripts/script'
import { runFilterScript } from '../scripts/filters'
import { createConstraint } from '../../core/constraints/constraint'
import { graphHref } from '../../app/openIn'
import { SCRIPT_SCENE_TYPE, scriptSceneFrom, scriptSourceOf, type ProjectionData } from '../../core/graph/projection'
import { getScriptHandle, waitForScriptPage } from '../scripts/scriptHandle'
import { applyStyleScript } from '../scripts/styles'
import { applyLayoutScript } from '../scripts/layouts'
import { getExplorerHandle } from '../graph/explorerHandle'
import { describeRendering } from '../../core/graph/rendering'
import { json, openMade } from './toolkit'
import type { AppHost } from './tools'

/**
 * Scripts for the assistant: run code over the dataset — JavaScript in the
 * QuickJS sandbox, Python in Pyodide, or a Visual script in a sandboxed
 * iframe (no I/O; time and memory capped) — and get figures, tables and
 * scenes back — the flexible path when a plot spec or a finding does not
 * say what the user asked for.
 */
export function createScriptTools(host: AppHost) {
  const { store } = host
  const registry = () => host.registry ?? new TypeRegistry(store)

  const summarise = (outs: Output[], points: number) =>
    outs.map((o) => {
      if (o.kind === 'figure') return { kind: 'figure', title: figureTitle(o.layout), traces: o.data.map((t) => ({ name: t.name, type: t.type, points: Array.isArray(t.x) ? t.x.length : Array.isArray(t.y) ? t.y.length : Array.isArray(t.labels) ? t.labels.length : undefined, x: Array.isArray(t.x) ? t.x.slice(0, points) : undefined, y: Array.isArray(t.y) ? t.y.slice(0, points) : undefined })) }
      if (o.kind === 'table') return { kind: 'table', columns: o.columns, rows: o.rows.length, head: o.rows.slice(0, points) }
      if (o.kind === 'scene') return { kind: 'scene', placed: Object.keys(o.positions).length, groups: o.groups ? Object.keys(o.groups).length : 0 }
      if (o.kind === 'layout') return { kind: 'layout', label: o.label, placed: Object.keys(o.positions).length, dimensions: o.dimensions ?? 2, hint: 'save it (kind "layout") and script {action:"apply"} or graph_layout {script} holds these positions on the Graph Explorer' }
      if (o.kind === 'style') return { kind: 'style', label: o.label, nodes: Object.keys(o.overlay.nodes ?? {}).length, edges: Object.keys(o.overlay.edges ?? {}).length, legend: o.overlay.legend?.title, spec: !!o.spec, hint: 'save it (kind "style") and script {action:"apply"} or graph_style {script} puts it on the Graph Explorer' }
      if (o.kind === 'text') return { kind: 'text', text: o.text.slice(0, 4000) }
      if (o.kind === 'image') return { kind: 'image', note: 'a rendered image (matplotlib); shown on the Scripts page' }
      return { kind: 'value', value: o.value }
    })

  const script = betaTool({
    name: 'script',
    description:
      'Run code over the dataset in a sandbox and get figures, tables, scenes, layouts or styles back — the most flexible way to answer an analysis question: any aggregation, join, before/after comparison, rolling window, custom Plotly figure (2D or 3D/WebGL), or layout the plot spec cannot express — and the way to drive the Graph Explorer by code: a script that computes metrics (ds.compute: pagerank, betweenness, community, …) and returns style(nodes) or layout(positions) is saved as a script entity (kind style / layout) and applied with action "apply" (or graph_style {script} / graph_layout {script}), which saves the result as the script\'s style / layout entity and opens the explorer with it; a graph scene (graph_save {kind:"scene"}) then keeps it. "Write a script that computes X and styles by it" = save (code returning style(...)) then apply. Three languages: JavaScript (QuickJS, instant, a small helper library), Python (Pyodide with numpy, pandas, plotly; matplotlib/scipy/scikit-learn/networkx/statsmodels on import — a notebook cell, a few seconds to boot the first time), and Visual (an ES module in a sandboxed iframe with a DOM, canvas and WebGL: three.js, d3, Plotly — for custom 3D scenes and hand-drawn visuals; the frame itself is what the user sees). Actions: api (the reference for a language — read it once before writing scripts), schema (what the dataset holds, as a script sees it: the project, every type with the properties its entities carry — kind, coverage, a sample — the relationship types and what they join, the tags, the metrics; read it before writing a script over unfamiliar data, and write `ds.describe()` / `describe()` in a script for the same at run time), run (execute code, return a summary of what it produced: traces with the first points, table head, logs, errors with a stack), show (open the Scripts page with the code and run it so the user sees the figure/table; pass save_as to keep it as a script entity; or pass id for a saved script), save (create or update a script entity; `kind` names what it is for, `locked` locks or unlocks it), edit (replace one unique piece of a saved script\'s text — a small fix without resending the code), list, get (a saved script\'s code and last run), delete, apply (put a saved script to use by its kind — see below). A **locked** script (`locked: true` — the scripts a demo ships with are) cannot be saved over, edited or deleted: save with a new name instead (a copy), or unlock it first with save {id, locked: false} — the same as the page\'s Details dialog. Scripts have kinds, subtypes of `script` in the ontology, assigned when a script is saved with one or first put to use: a **filter** (`script:filter`) returns the entities the Graph Explorer keeps (a collection, a list of ids, or a table with an id column — graph_filter {script} applies it); a **constraint** (`script:constraint`) judges the dataset for a constraint entity (constraint {define, rule: {script}} — true passes, false / a message / a list of {id, message} fails); a **scene** (`script:scene`) returns scene(positions) that becomes a scene on the Scenes page. A draft has no kind; save infers one from what the code returned when run (pass kind to choose, kind "none" to keep it plain). `apply` does the connection for a saved script: filter → runs it and opens the Graph Explorer on just the entities it returned; constraint → defines a constraint judged by it (name it with `name`); scene → runs it, saves the scene it returned and opens it on the Scenes page. Scripts have no I/O and are killed after timeout_ms (default 5000 for js, 30000 for python). Iterate: run, read the summary, fix, then show. Prefer python for pandas-shaped work, js for quick graph traversals.\n\nJavaScript reference:\n' +
      SCRIPT_API +
      '\n\nPython reference:\n' +
      PY_API +
      '\n\nVisual reference:\n' +
      VIEW_API,
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['api', 'schema', 'run', 'show', 'save', 'edit', 'list', 'get', 'delete', 'apply'] },
        kind: { type: 'string', enum: ['filter', 'constraint', 'scene', 'layout', 'style', 'none'], description: 'save / show with save_as: what the script is for (its subtype: script:filter, script:constraint, script:scene, script:layout, script:style); "none" keeps it a plain script. Default: read off what the code returns. apply: the kind to apply it as (default: the script\'s own kind)' },
        language: { type: 'string', enum: ['js', 'python', 'view'], description: 'run/show/save/api: the language (default: detected from the code)' },
        code: { type: 'string', description: 'run/show/save: the script (use `return` for the result); run may instead name a saved script with `id`; save with an id may omit it to rename or change the language' },
        id: { type: 'string', description: 'show/get/delete/apply, or save to update: a script entity id' },
        name: { type: 'string', description: 'save: the script name; apply as a constraint: the constraint\'s name (default: the script\'s)' },
        save_as: { type: 'string', description: 'show: also save the code as a script entity with this name' },
        description: { type: 'string', description: 'save / show with save_as: what the script shows and how to read it (Markdown) — kept on the script, shown in its Details. Without one, the comment block the code opens with stands in.' },
        locked: { type: 'boolean', description: 'save with an id: lock the script (true) so nothing can overwrite or delete it, or unlock it (false). A save that changes anything else on a locked script is refused unless it also passes locked: false.' },
        open: { type: 'boolean', description: 'save: show a new script on the Scripts page afterwards (default true); false to save it without leaving the page' },
        find: { type: 'string', description: 'edit: text that occurs exactly once in the saved script' },
        replace: { type: 'string', description: 'edit: what replaces it (empty deletes it)' },
        points: { type: 'integer', minimum: 1, maximum: 200, description: 'run/show: points per trace and table rows to return (default 12)' },
        full: { type: 'boolean', description: 'schema: every property of every type and every tag (the default keeps 24 properties per type by coverage and the 80 most used tags)' },
        timeout_ms: { type: 'integer', minimum: 100, maximum: 60000, description: 'run/show: wall-clock cap (default 5000)' },
        types: { type: 'array', items: { type: 'string' }, description: 'run/show/save: read only these entity types (and the relationships between them) instead of the whole project; subtypes come with their parent. A script sees everything by default, which a project of hundreds of thousands of entities does not fit into a sandbox — narrow it here ("the genera and wards of a city\'s trees", not its 688,000 trees), and any script loads faster for it. Saved with the script, so it keeps reading that much wherever it runs.' },
      },
      required: ['action'],
      additionalProperties: false,
    } as const,
    run: async ({ action, code, id, name, save_as, description, find, replace, points, timeout_ms, language, kind, locked, full, types, open }) => {
      const k = points ?? 12
      const lang = (l?: string, c?: string, saved?: { data: { language?: unknown } } | undefined): Language => (l === 'python' || l === 'js' || l === 'view' ? l : typeof saved?.data.language === 'string' && ['python', 'js', 'view'].includes(saved.data.language) ? (saved.data.language as Language) : c ? detectLanguage(c) : 'js')
      const brief = (e: ReturnType<typeof scriptsIn>[number]) => ({ id: e.id, label: displayLabel(e), type: e.type, kind: scriptKindOf(e.type), language: e.data.language ?? 'js', ...(e.data.locked ? { locked: true } : {}), ...(e.data.types?.length ? { types: e.data.types } : {}), lastRun: e.data.lastRun })
      /** The kind a save takes: the one asked for, else — for a script without one — what running the code returns. Async only when it has to run. */
      const kindFor = async (src: string, l: Language, existingKind?: string) => {
        if (kind === 'none') return null
        if (isScriptSubtype(kind)) return kind
        if (existingKind || l === 'view') return undefined
        try {
          const r = await runScript(store, registry(), src, { language: l, timeoutMs: timeout_ms })
          return r.error ? undefined : subtypeOfOutputs(outputsOf(r.value), store)
        } catch {
          return undefined
        }
      }
      if (action === 'schema') {
        const sc = buildExprSchema(store, registry())
        const project = store.scope ? store.get(store.scope) : undefined
        // Sized to be read in one go: a Library of thousands of tags and types with dozens of properties each was 177 KB
        // — which no caller could take in — so the tags come by use and a type's properties by coverage, `full` lifts it.
        const PROPS = full ? Infinity : 24
        const TAGS = full ? Infinity : 80
        const tagRows = sc.tags.map((tag) => ({ tag, count: store.tagUsage(tag) })).sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
        return json({
          project: project ? { id: project.id, label: displayLabel(project), description: project.description } : null,
          entities: sc.types.filter((t) => t.kind === 'entity').reduce((n, t) => n + t.count, 0),
          relationships: sc.relationshipTypes.reduce((n, r) => n + r.count, 0),
          // Types with entities; a declared type nobody uses would only be noise here (list_entity_types has them all).
          types: sc.types
            .filter((t) => t.kind === 'entity' && t.count > 0)
            .map((t) => {
              const props = (sc.properties.get(t.type) ?? []).slice().sort((a, b) => b.coverage - a.coverage)
              return {
                type: t.type,
                label: t.label,
                count: t.count,
                properties: props.slice(0, PROPS).map((p) => ({ key: p.key, kind: p.kind, coverage: Math.round(p.coverage * 100) / 100, ...(p.sample !== undefined ? { sample: String(p.sample).slice(0, full ? undefined : 60) } : {}), ...(p.description ? { description: p.description } : {}), ...(p.declared ? { declared: true } : {}) })),
                ...(props.length > PROPS ? { moreProperties: props.length - PROPS } : {}),
              }
            }),
          relationshipTypes: sc.relationshipTypes.map((r) => ({ type: r.type, count: r.count, joins: r.pairs })),
          tags: tagRows.slice(0, TAGS).map((t) => t.tag),
          ...(tagRows.length > TAGS ? { moreTags: tagRows.length - TAGS, hint_tags: 'the most used are listed; list_tags has them all, full: true lists every one here' } : {}),
          metrics: Object.keys(getLatestAnalysis()?.metrics.columns ?? {}),
          hint: "In a script: ds.byType(type), e.data.<key>, ds.out(id, rel), ds.tagged(tag), ds.metric(name, id); ds.ontology / ds.project / ds.tags() hold the same state; ds.describe() summarises it. Python: by_type, entities[...], out, ontology, project, tags, describe().",
        })
      }
      if (action === 'api') return language === 'python' ? PY_API : language === 'js' ? SCRIPT_API : language === 'view' ? VIEW_API : `JavaScript:\n${SCRIPT_API}\n\nPython:\n${PY_API}\n\nVisual:\n${VIEW_API}`
      if (action === 'list') return json({ kinds: SCRIPT_SUBTYPES.map((s) => ({ kind: s.id, type: s.type, what: s.hint })), scripts: scriptsIn(store).map((e) => ({ ...brief(e), lines: e.data.code.split('\n').length })) })
      if (action === 'get') {
        const e = store.get(id ?? '')
        if (!isScript(e)) throw new Error(`No script with id ${id}. Use script {action:"list"}.`)
        return json({ ...brief(e), code: e.data.code })
      }
      if (action === 'apply') {
        const e = store.get(id ?? '')
        if (!isScript(e)) throw new Error(`No script with id ${id}. Use script {action:"list"}.`)
        const as = isScriptSubtype(kind) ? kind : scriptKindOf(e.type)
        if (!as) throw new Error(`Script “${displayLabel(e)}” has no kind yet: pass kind (filter, constraint, scene, layout or style) to say what to apply it as.`)
        if (as === 'layout') {
          // The script's positions become its layout, held by the open explorer or opened with it.
          const h = getExplorerHandle()
          const applied = await applyLayoutScript(store, registry(), e.id, { timeoutMs: timeout_ms, dimensions: h?.dims })
          if (h) h.loadLayout(applied.layout.id, applied.positions, 'custom')
          else host.navigate(`/unigraph/${applied.dimensions === 3 ? '3d' : '2d'}?layout=${encodeURIComponent(applied.layout.id)}`)
          return json({ applied: 'layout', layout: { id: applied.layout.id, label: displayLabel(applied.layout), updated: applied.updated, placed: Object.keys(applied.positions).length, dimensions: applied.dimensions }, logs: applied.logs, ms: applied.ms, script: brief(store.get(e.id) as typeof e), hint: 'graph_layout {script: id} runs it again on the open view; graph_layout {layout_id} reloads the saved positions without running; graph_save {kind:"scene"} keeps it with the filter and style.' })
        }
        if (as === 'style') {
          // The script's styles become its rendering, loaded into the open explorer or opened with it.
          const h = getExplorerHandle()
          const applied = await applyStyleScript(store, registry(), e.id, { base: h?.getState().rendering, timeoutMs: timeout_ms })
          if (h) h.loadRendering(applied.rendering.id, applied.spec)
          else host.navigate(`/unigraph/2d?style=${encodeURIComponent(applied.rendering.id)}`)
          return json({ applied: 'style', rendering: { id: applied.rendering.id, label: displayLabel(applied.rendering), updated: applied.updated, style: describeRendering(applied.spec) }, nodes: Object.keys(applied.output.overlay.nodes ?? {}).length, edges: Object.keys(applied.output.overlay.edges ?? {}).length, legend: applied.output.overlay.legend?.title, logs: applied.logs, ms: applied.ms, script: brief(store.get(e.id) as typeof e), hint: 'graph_style {script: id} runs it again on the open view; graph_style {rendering_id} reloads the saved result without running; graph_save {kind:"scene"} keeps it with the filter and layout.' })
        }
        if (as === 'constraint') {
          const c = createConstraint({ label: name ?? displayLabel(e), description: e.description, scope: 'graph', rule: { script: e.id }, severity: 'warn' })
          store.upsert(c)
          markScriptUse(store, e.id, 'constraint')
          return json({ applied: 'constraint', constraint: { id: c.id, label: c.label }, script: brief(store.get(e.id) as typeof e), hint: 'constraint {action:"audit"} judges it; constraint {action:"update", id, severity:"reject"} makes it refuse writes.' })
        }
        if (as === 'filter') {
          const r = await runFilterScript(store, registry(), e.id, { timeoutMs: timeout_ms })
          if (r.error) return json({ applied: false, error: r.error, ms: r.ms })
          host.navigate(graphHref(r.ids, displayLabel(e), '2d', false, e.id))
          return json({ applied: 'filter', kept: r.ids.length, ids: r.ids.slice(0, k), ms: r.ms, script: brief(store.get(e.id) as typeof e), hint: 'Unigraph keeps just these; graph_filter {only: []} lifts it, graph_filter {script} runs it again.' })
        }
        // scene
        const r = await runScript(store, registry(), e.data.code, { scriptId: e.id, language: e.data.language ?? 'js', timeoutMs: timeout_ms })
        if (r.error) return json({ applied: false, error: r.error.message, logs: r.logs, ms: r.ms })
        const scene = outputsOf(r.value).find((o): o is Extract<Output, { kind: 'scene' }> => o.kind === 'scene')
        if (!scene) throw new Error(`The script returned no scene: return scene(positions) — it produced ${describeOutputs(outputsOf(r.value)) || 'nothing'}.`)
        // The same scene as the page's "Open on the Scenes page": a scene:script that remembers the script, updated on a rerun.
        const existing = store.ofType(SCRIPT_SCENE_TYPE).find((p) => scriptSourceOf(p.data as ProjectionData)?.scriptId === e.id && (!scene.label || displayLabel(p) === scene.label))
        const saved = scriptSceneFrom({ id: e.id, label: displayLabel(e) }, scene.positions, { scale: scene.scale, label: scene.label, existing })
        store.upsert(saved)
        markScriptUse(store, e.id, 'scene')
        host.navigate(`/scenes?id=${encodeURIComponent(saved.id)}`)
        return json({ applied: 'scene', scene: { id: saved.id, type: saved.type, label: saved.label, placed: Object.keys(scene.positions).length, updated: !!existing }, script: brief(store.get(e.id) as typeof e), hint: 'display {action:"state"} reads the Scenes page.' })
      }
      if (action === 'delete') {
        const e = store.get(id ?? '')
        if (!isScript(e)) throw new Error(`No script with id ${id}.`)
        if (e.data.locked) throw new Error(`“${displayLabel(e)}” is locked: unlock it first with script {action:"save", id, locked:false}.`)
        if (!(await host.confirm(`Delete the script ${quoteLabel(displayLabel(e))}?`, { yes: 'Delete', danger: true }))) return json({ deleted: false })
        store.remove([e.id])
        return json({ deleted: true, id: e.id })
      }
      if (action === 'edit') {
        // A small change to a saved script without resending it: `find` must match exactly once.
        const e = store.get(id ?? '')
        if (!isScript(e)) throw new Error(`No script with id ${id}.`)
        if (e.data.locked) throw new Error(`“${displayLabel(e)}” is locked: unlock it first with script {action:"save", id, locked:false}, or save a copy under a new name.`)
        if (!find) throw new Error('edit needs `find` (and `replace`).')
        const n = e.data.code.split(find).length - 1
        if (n !== 1) throw new Error(n === 0 ? 'find: not found in the script.' : `find: occurs ${n} times; make it unique.`)
        const next = e.data.code.replace(find, () => replace ?? '')
        saveScript(store, next, displayLabel(e), e.id, undefined, e.data.language ?? detectLanguage(next))
        return json({ id: e.id, label: displayLabel(e), lines: next.split('\n').length, hint: 'script {action:"show", id} runs it.' })
      }
      if (action === 'save') {
        const existing = id ? store.get(id) : undefined
        if (id && !isScript(existing)) throw new Error(`No script with id ${id}.`)
        // A locked script takes only its unlock; anything more on it is refused (unless the unlock comes with it).
        if (isScript(existing) && existing.data.locked) {
          const more = code !== undefined || name !== undefined || description !== undefined || language !== undefined || kind !== undefined
          if (locked !== false) throw new Error(`“${displayLabel(existing)}” is locked: ${more ? 'pass locked:false to unlock it, or save a copy under a new name (no id).' : 'it is locked already.'}`)
          updateScriptDetails(store, existing.id, { locked: false })
          if (!more) return json({ ...brief(store.get(existing.id) as typeof existing), updated: true, unlocked: true })
        }
        // With an id, code may be left out to rename, re-language, re-kind or lock a script as it is.
        const src = code ?? (isScript(existing) ? existing.data.code : undefined)
        if (!src) throw new Error('save needs code.')
        const l = language ? lang(language, src) : isScript(existing) ? (existing.data.language ?? lang(undefined, src)) : lang(undefined, src)
        const e = saveScript(store, src, name ?? (existing ? displayLabel(existing) : 'Script'), existing?.id, undefined, l, description, await kindFor(src, l, isScript(existing) ? scriptKindOf(existing.type) : undefined))
        if (locked || types) updateScriptDetails(store, e.id, { ...(locked ? { locked: true } : {}), ...(types ? { types: types.length ? types : null } : {}) })
        if (!existing && open !== false && getScriptHandle()?.getState().scriptId !== e.id) openMade(host, e.id, `/scripts?script=${encodeURIComponent(e.id)}`)
        return json({ ...brief(store.get(e.id) as typeof e), updated: !!existing })
      }
      if (action === 'run') {
        // A saved script runs by id: the code and its language come off the entity.
        const saved = id ? store.get(id) : undefined
        if (id && !isScript(saved)) throw new Error(`No script with id ${id}. Use script {action:"list"}.`)
        const src = code ?? (saved as { data: { code?: string } } | undefined)?.data.code
        if (!src) throw new Error('run needs code, or the id of a saved script.')
        const l = lang(language, src, saved)
        const scope = types ?? (isScript(saved) ? saved.data.types : undefined)
        const r = await runScript(store, registry(), src, { timeoutMs: timeout_ms, language: l, ...(scope?.length ? { types: scope } : {}) })
        if (r.error) return json({ error: r.error.message, stack: r.error.stack, logs: r.logs, ms: r.ms })
        let outputs: Output[]
        try {
          outputs = outputsOf(r.value)
        } catch (e) {
          return json({ error: e instanceof Error ? e.message : String(e), value: r.value, logs: r.logs, ms: r.ms })
        }
        return json({ ...(saved ? { id: saved.id, label: displayLabel(saved) } : {}), language: l, ...(scope?.length ? { types: scope } : {}), summary: l === 'view' ? `visual · loaded without errors${outputs.length ? ' + ' + describeOutputs(outputs) : ''}` : describeOutputs(outputs), outputs: summarise(outputs, k), logs: r.logs, ms: r.ms, hint: l === 'view' ? 'The frame ran hidden; script {action:"show", code} puts it on screen.' : 'script {action:"show", code} draws it for the user.' })
      }
      // show
      let src = code
      let scriptId = id
      let l: Language = lang(language, code)
      if (id) {
        const e = store.get(id)
        if (!isScript(e)) throw new Error(`No script with id ${id}.`)
        src = e.data.code
        l = e.data.language ?? detectLanguage(src)
      }
      if (!src) throw new Error('show needs code or a script id.')
      if (save_as) {
        const e = saveScript(store, src, save_as, undefined, undefined, l, description, await kindFor(src, l))
        scriptId = e.id
      }
      const current = getScriptHandle()
      if (!current || scriptId) host.navigate(scriptId ? `/scripts?script=${encodeURIComponent(scriptId)}` : '/scripts')
      const h = await waitForScriptPage()
      if (!h) throw new Error('The Scripts page did not open. Navigate to /scripts and try again.')
      // Attribute the run to the script shown (saved or just saved); an ad-hoc show writes to no script.
      const view = await h.run(src, l, scriptId ?? null)
      if (!view) return json({ shown: false, hint: 'The run was cancelled.' })
      if (view.error) return json({ shown: true, id: scriptId, error: view.error, logs: view.logs, ms: view.ms })
      return json({ shown: true, id: scriptId, summary: describeOutputs(view.outputs), outputs: summarise(view.outputs, k), logs: view.logs, ms: view.ms, hint: scriptId ? undefined : 'Pass save_as to keep this as a script entity.' })
    },
  })

  return [script]
}
