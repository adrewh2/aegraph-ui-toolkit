import { ChevronDown, ChevronRight, Code2, Play, Plus, Table2, X } from 'lucide-react'
import { useMemo, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react'
import { Menu, type MenuItem } from '../../components/ui/Menu'
import { displayLabel } from '../../core/entity/entity'
import { datasetTotals, DEFAULT_MAX_NODES, HIDDEN_CATEGORIES } from '../../core/graph/filter'
import { useEntityStore, useStoreVersion, useTypeRegistry } from '../../core/entity/hooks'
import { FIELD_OPS, sampleDataKeys, type FieldOp, type FieldPredicate } from '../../core/graph/fields'
import { hashColor } from '../../lib/format'
import { useToast } from '../../components/ui/useToast'
import { runFilterScript } from '../scripts/filters'
import { scriptKindOf, scriptsIn } from '../scripts/script'
import { useDatasetVersion } from '../scripts/snapshot'
import { useExplorer } from './explorerState'
import { Select } from '../../components/ui/Select'

/**
 * First-class filter controls. Every control edits the same FilterSpec that
 * `graph_save` persists, so what you see is exactly what gets saved.
 */
export function FilterPanel({ onOpenTable }: { /** A row's right-click: open every entity of the type / relationship type / tag as a table in the detail pane. */ onOpenTable?: (view: { kind: 'type' | 'rel' | 'tag'; value: string }) => void } = {}) {
  const store = useEntityStore()
  const version = useStoreVersion(store)
  const registry = useTypeRegistry()
  const { state, dispatch, slice, styles, members } = useExplorer()
  const dataVersion = useDatasetVersion(store)
  const f = state.filter
  const patch = (p: Partial<typeof f>) => dispatch({ type: 'patchFilter', patch: p })
  const toast = useToast()
  // Filter scripts: a saved script whose result is the entities to keep. Filter scripts first, then any other saved script.
  const scripts = useMemo(() => scriptsIn(store).sort((a, b) => Number(scriptKindOf(b.type) === 'filter') - Number(scriptKindOf(a.type) === 'filter') || displayLabel(a).localeCompare(displayLabel(b))), [store, version]) // eslint-disable-line react-hooks/exhaustive-deps -- a saved script appears with the next store version
  const [scriptPick, setScriptPick] = useState('')
  const [scriptRunning, setScriptRunning] = useState(false)
  const applyScript = async (id: string) => {
    if (!id || scriptRunning) return
    setScriptRunning(true)
    try {
      const r = await runFilterScript(store, registry, id)
      if (r.error) {
        toast(r.error)
        return
      }
      patch({ only: r.ids, script: r.script, roots: [] })
      dispatch({ type: 'select', ids: [], mode: 'replace' })
      toast(`Keeping ${r.ids.length.toLocaleString()} from the script · ${r.ms} ms`)
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e))
    } finally {
      setScriptRunning(false)
    }
  }
  // The right-click menu of a checklist row: the whole type / relationship type / tag as a table on the right, and the solo.
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null)
  const rowMenu = (e: ReactMouseEvent, view: { kind: 'type' | 'rel' | 'tag'; value: string; label: string; count: number }, solo: () => void) => {
    e.preventDefault()
    e.stopPropagation()
    const what = view.kind === 'rel' ? 'relationship' : 'entit'
    setMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        { kind: 'label', label: view.label },
        { kind: 'item', label: `Open as a table (${view.count.toLocaleString()} ${what === 'entit' ? (view.count === 1 ? 'entity' : 'entities') : view.count === 1 ? 'relationship' : 'relationships'})`, icon: Table2, disabled: !onOpenTable, onSelect: () => onOpenTable?.({ kind: view.kind, value: view.value }) },
        { kind: 'item', label: 'Show only this', onSelect: solo },
      ],
    })
  }
  const [typeQ, setTypeQ] = useState('')
  const [tagQ, setTagQ] = useState('')
  const [folded, setFolded] = useState<Set<string>>(readFolded)
  const toggleFold = (id: string) =>
    setFolded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      try {
        localStorage.setItem(FOLD_KEY, JSON.stringify([...next]))
      } catch {
        /* ignore */
      }
      return next
    })

  // Candidate types: anything browsable as a graph node.
  const types = useMemo(() => [...registry.inCategory('knowledge', { withInstancesOnly: true }), ...registry.inCategory('resource', { withInstancesOnly: true })], [registry])
  const relTypes = useMemo(() => registry.relationshipTypes(), [registry])
  const inSlice = useMemo(() => {
    const m = new Map<string, number>()
    for (const n of slice.nodes) m.set(n.type, (m.get(n.type) ?? 0) + 1)
    return m
  }, [slice])
  const relInSlice = useMemo(() => {
    const m = new Map<string, number>()
    for (const e of slice.edges) m.set(e.type, (m.get(e.type) ?? 0) + 1)
    return m
  }, [slice])
  // Each list's rows are shaded to their count against the list's largest: a histogram behind the checklist.
  const maxOf = (m: Map<string, number>) => Math.max(1, ...m.values())
  const typeMax = useMemo(() => maxOf(inSlice), [inSlice])
  const relMax = useMemo(() => maxOf(relInSlice), [relInSlice])

  /**
   * Checklist semantics: an empty list means "everything", so every visible row
   * shows checked. Unchecking makes the list explicit (all the others); re-checking
   * everything collapses back to "everything". The last checked row can't be
   * unchecked (that would mean "nothing"). Double-click a row to solo it.
   */
  const toggle = (list: string[] | undefined, v: string, all: string[]): string[] => {
    const current = list?.length ? list : all
    const next = current.includes(v) ? current.filter((x) => x !== v) : [...current, v]
    if (next.length === 0) return current
    return next.length === all.length && all.every((x) => next.includes(x)) ? [] : next
  }
  const isChecked = (list: string[] | undefined, v: string) => !list?.length || list.includes(v)
  const allTypeIds = types.map((t) => t.type)
  const allRelIds = relTypes.map((t) => t.type)
  const allTags = store.tags()
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({})
  const tagsInSlice = useMemo(() => {
    const m = new Map<string, number>()
    for (const n of slice.nodes) for (const t of n.tags) m.set(t, (m.get(t) ?? 0) + 1)
    return m
  }, [slice])
  const tagMax = useMemo(() => maxOf(tagsInSlice), [tagsInSlice])
  /**
   * Each row reads "x of y": x in view after the filter, y in the whole project (the dataset the explorer draws from,
   * `datasetTotals`). A tag's y counts what can be a node — entities outside the hidden categories — as x does, so an
   * unfiltered view reads "x of x".
   */
  const totals = useMemo(() => datasetTotals(store, registry, members), [members, store, dataVersion]) // eslint-disable-line react-hooks/exhaustive-deps -- follows the data, not the registry's identity
  const typeTotal = (t: { type: string }) => totals.types.get(t.type) ?? 0
  const relTotal = (t: { type: string }) => totals.rels.get(t.type) ?? 0
  // A tag's or a namespace's y: the entities that can be nodes carrying any of the tags, each once — kept per data version.
  const tagTotals = useMemo(() => new Map<string, number>(), [members, store, dataVersion]) // eslint-disable-line react-hooks/exhaustive-deps
  const groupTotal = (tags: string[]) => {
    const key = tags.join('\u0001')
    let n = tagTotals.get(key)
    if (n === undefined) {
      const seen = new Set<string>()
      for (const t of tags) for (const e of store.withTag(t)) if (e.kind === 'entity' && !HIDDEN_CATEGORIES.has(registry.categoryOf(e.type)) && (!members || members.has(e.id))) seen.add(e.id)
      tagTotals.set(key, (n = seen.size))
    }
    return n
  }
  const tagTotal = (t: string) => groupTotal([t])
  /**
   * Tags as a checklist beside the types. Checked = allowed. With nothing chosen every tag is checked and unchecking one
   * hides the nodes that carry it (`excludeTags`); "only" switches to an include list (`tags`), where checking adds a tag
   * to it. Namespaced tags (`tier:app`) fold under their prefix to keep the list short.
   */
  const includeSet = useMemo(() => new Set(f.tags ?? []), [f.tags])
  const excludeSet = useMemo(() => new Set(f.excludeTags ?? []), [f.excludeTags])
  const tagChecked = (t: string) => (includeSet.size ? includeSet.has(t) : !excludeSet.has(t))
  const toggleTag = (t: string) => {
    if (f.tags?.length) {
      const next = f.tags.includes(t) ? f.tags.filter((x) => x !== t) : [...f.tags, t]
      patch({ tags: next })
    } else {
      const ex = f.excludeTags ?? []
      patch({ excludeTags: ex.includes(t) ? ex.filter((x) => x !== t) : [...ex, t] })
    }
  }
  /** A namespace as one switch: on when every tag in it is checked, off when none is, mixed between. */
  const groupState = (tags: string[]): boolean | 'mixed' => {
    const n = tags.filter(tagChecked).length
    return n === tags.length ? true : n === 0 ? false : 'mixed'
  }
  const toggleGroup = (tags: string[]) => {
    const allOn = tags.every(tagChecked)
    if (f.tags?.length) {
      const next = allOn ? f.tags.filter((x) => !tags.includes(x)) : [...new Set([...f.tags, ...tags])]
      // Unchecking the last of an include list would mean "everything": hide the namespace instead.
      patch(next.length ? { tags: next } : { tags: [], excludeTags: tags })
    } else {
      const ex = f.excludeTags ?? []
      patch({ excludeTags: allOn ? [...new Set([...ex, ...tags])] : ex.filter((x) => !tags.includes(x)) })
    }
  }
  const groupSolo = (tags: string[]) => !!f.tags?.length && f.tags.length === tags.length && tags.every((t) => f.tags!.includes(t))
  const soloGroup = (tags: string[]) => patch({ tags: groupSolo(tags) ? [] : tags, excludeTags: [] })
  // Nodes in view carrying any tag of a namespace, counted once per namespace — a single pass over the slice,
  // rather than one per namespace (thousands of `entity:` tags made that a second of work per render).
  const carriersByPrefix = useMemo(() => {
    const m = new Map<string, number>()
    const seen = new Set<string>()
    for (const n of slice.nodes) {
      seen.clear()
      for (const t of n.tags) {
        const i = t.indexOf(':')
        if (i <= 0) continue
        const p = t.slice(0, i)
        if (seen.has(p)) continue
        seen.add(p)
        m.set(p, (m.get(p) ?? 0) + 1)
      }
    }
    return m
  }, [slice])
  const tagGroups = useMemo(() => {
    const q = tagQ.trim().toLowerCase()
    const visible = allTags.filter((t) => !q || t.toLowerCase().includes(q))
    const byPrefix = new Map<string, string[]>()
    for (const t of visible) {
      const i = t.indexOf(':')
      const prefix = i > 0 ? t.slice(0, i) : ''
      byPrefix.set(prefix, [...(byPrefix.get(prefix) ?? []), t])
    }
    // `count` is how many nodes in view carry the tag(s); `usage` is how many in the dataset do, which keeps the order
    // still while tags are toggled (a row must not jump away under the pointer).
    const groups: { prefix: string; tags: string[]; single: boolean; count: number; usage: number }[] = []
    for (const [prefix, tags] of byPrefix) {
      if (!prefix || tags.length < 2) groups.push(...tags.map((t) => ({ prefix: '', tags: [t], single: true, count: tagsInSlice.get(t) ?? 0, usage: store.tagUsage(t) })))
      else {
        // With a search only the matching tags of the namespace are listed, so count carriers of just those.
        let count = carriersByPrefix.get(prefix) ?? 0
        if (q) {
          const set = new Set(tags)
          count = 0
          for (const n of slice.nodes) if (n.tags.some((x) => set.has(x))) count++
        }
        groups.push({ prefix, tags: tags.sort(), single: false, count, usage: tags.reduce((a, t) => a + store.tagUsage(t), 0) })
      }
    }
    // Namespaces first (they are the structured ones), then loose tags; each by how many nodes carry them.
    return groups.sort((a, b) => Number(b.single === false) - Number(a.single === false) || b.usage - a.usage || a.tags[0].localeCompare(b.tags[0]))
  }, [allTags, tagQ, slice, tagsInSlice, carriersByPrefix, store])
  const tagHint = f.tags?.length ? `${f.tags.length} of ${allTags.length}` : f.excludeTags?.length ? `${allTags.length - f.excludeTags.length} of ${allTags.length}` : `all ${allTags.length}`
  // Attribute paths worth offering: sampled from the slice, or from the store when the slice is empty.
  const fieldKeys = useMemo(() => sampleDataKeys(slice.nodes.length ? slice.nodes : store.all().slice(0, 500)), [slice.nodes, store])
  const fields = f.fields ?? []
  const setField = (i: number, patchP: Partial<FieldPredicate>) => patch({ fields: fields.map((p, j) => (j === i ? { ...p, ...patchP } : p)) })

  return (
    <div className="gx-panel">
      <Fold id="text" title="Text" folded={folded.has('text')} onToggle={toggleFold} head={undefined}>
        <input className="input" style={{ width: '100%', height: 28 }} placeholder="Match label, description, data…" value={f.text ?? ''} onChange={(e) => patch({ text: e.target.value })} />
      </Fold>

      <Fold id="types" title="Types" folded={folded.has('types')} onToggle={toggleFold} head={<><span className="gx-panel__hint">{f.types?.length ? `${f.types.length} of ${types.length}` : `all ${types.length}`}</span>
          <HeadReset idle={!f.types?.length} onClick={() => patch({ types: [] })} /></>}>
        {types.length > 10 && <input className="input" style={{ width: '100%', height: 26, marginBottom: 4 }} placeholder="Find type…" value={typeQ} onChange={(e) => setTypeQ(e.target.value)} />}
        <div className="gx-checklist">
          {types
            .filter((t) => !typeQ || t.label.toLowerCase().includes(typeQ.toLowerCase()))
            .map((t) => {
              const on = isChecked(f.types, t.type)
              const solo = f.types?.length === 1 && f.types[0] === t.type
              return (
                <CheckRow
                  key={t.type}
                  on={on}
                  title="Click to toggle · double-click to show only this type · right-click for a table of them"
                  onToggle={() => patch({ types: toggle(f.types, t.type, allTypeIds) })}
                  onSolo={() => patch({ types: solo ? [] : [t.type] })}
                  onContextMenu={(e) => rowMenu(e, { kind: 'type', value: t.type, label: t.pluralLabel, count: t.count }, () => patch({ types: [t.type] }))}
                  share={(inSlice.get(t.type) ?? 0) / typeMax}
                  color={styles.typeColor(t.type)}
                >
                  {/* The colour the picture draws this type in (the legend's), not only the type's own. */}
                  <span className="gx-dot" style={{ background: styles.typeColor(t.type) }} />
                  <span className="gx-checklist__label">{t.pluralLabel}</span>
                  <button type="button" className="gx-only" onClick={(e) => (e.stopPropagation(), patch({ types: solo ? [] : [t.type] }))}>
                    {solo ? 'all' : 'only'}
                  </button>
                  <XofY x={inSlice.get(t.type) ?? 0} y={typeTotal(t)} />
                </CheckRow>
              )
            })}
        </div>
      </Fold>

      <Fold id="rels" title="Relationship types" folded={folded.has('rels')} onToggle={toggleFold} head={<><span className="gx-panel__hint">{f.relationshipTypes?.length ? `${f.relationshipTypes.length} of ${relTypes.length}` : `all ${relTypes.length}`}</span>
          <HeadReset idle={!f.relationshipTypes?.length} onClick={() => patch({ relationshipTypes: [] })} /></>}>
        <div className="gx-checklist">
          {relTypes.map((t) => {
            const on = isChecked(f.relationshipTypes, t.type)
            const solo = f.relationshipTypes?.length === 1 && f.relationshipTypes[0] === t.type
            return (
              <CheckRow
                key={t.type}
                on={on}
                title="Click to toggle · double-click to show only this relationship type · right-click for a table of them"
                onToggle={() => patch({ relationshipTypes: toggle(f.relationshipTypes, t.type, allRelIds) })}
                onSolo={() => patch({ relationshipTypes: solo ? [] : [t.type] })}
                onContextMenu={(e) => rowMenu(e, { kind: 'rel', value: t.type, label: t.type, count: t.relationshipCount }, () => patch({ relationshipTypes: [t.type] }))}
                share={(relInSlice.get(t.type) ?? 0) / relMax}
                color={hashColor(t.type)}
              >
                <span className="gx-dot gx-dot--edge" style={{ background: hashColor(t.type) }} />
                <span className="gx-checklist__label">{t.type}</span>
                <button type="button" className="gx-only" onClick={(e) => (e.stopPropagation(), patch({ relationshipTypes: solo ? [] : [t.type] }))}>
                  {solo ? 'all' : 'only'}
                </button>
                <XofY x={relInSlice.get(t.type) ?? 0} y={relTotal(t)} />
              </CheckRow>
            )
          })}
        </div>
      </Fold>

      <Fold id="tags" title="Tags" folded={folded.has('tags')} onToggle={toggleFold} head={<><span className="gx-panel__hint">{tagHint}</span>
          {/* Held in place while it does not apply (fewer than two tags chosen), so nothing beside it moves when it does. */}
          <Select className={`gx-select ${f.tags && f.tags.length > 1 ? '' : 'is-idle'}`} value={f.tagMode ?? 'any'} onChange={(e) => patch({ tagMode: e.target.value as 'any' | 'all' })} title="A node must carry any of the checked tags, or all of them" disabled={!(f.tags && f.tags.length > 1)} aria-hidden={!(f.tags && f.tags.length > 1)} tabIndex={f.tags && f.tags.length > 1 ? undefined : -1}>
            <option value="any">any of</option>
            <option value="all">all of</option>
          </Select>
          <HeadReset idle={!f.tags?.length && !f.excludeTags?.length} onClick={() => patch({ tags: [], excludeTags: [] })} /></>}>
        {allTags.length > 10 && <input className="input" style={{ width: '100%', height: 26, marginBottom: 4 }} placeholder="Find tag…" value={tagQ} onChange={(e) => setTagQ(e.target.value)} />}
        <div className="gx-checklist">
          {tagGroups.map((g) => {
            // A namespace opens by hand, while searching, or when only some of its tags are checked — the state its one row can't show.
            const state = g.single ? true : groupState(g.tags)
            const open = !!tagQ || g.single || openGroups[g.prefix] || state === 'mixed'
            // Rows exist only while shown: a namespace can hold thousands of tags.
            const rows = !open ? null : g.tags.map((t) => {
              const on = tagChecked(t)
              const solo = f.tags?.length === 1 && f.tags[0] === t
              return (
                <CheckRow key={t} on={on} title="Click to toggle · double-click to show only nodes with this tag · right-click for a table of them" onToggle={() => toggleTag(t)} onSolo={() => patch({ tags: solo ? [] : [t], excludeTags: [] })} onContextMenu={(e) => rowMenu(e, { kind: 'tag', value: t, label: t, count: store.tagUsage(t) }, () => patch({ tags: [t], excludeTags: [] }))} share={(tagsInSlice.get(t) ?? 0) / tagMax} color={store.getTagInfo(t).color ?? hashColor(t)}>
                  <span className="gx-dot" style={{ background: store.getTagInfo(t).color ?? hashColor(t) }} />
                  <span className="gx-checklist__label">{g.single ? t : t.slice(g.prefix.length + 1)}</span>
                  <button type="button" className="gx-only" onClick={(e) => (e.stopPropagation(), patch({ tags: solo ? [] : [t], excludeTags: [] }))}>
                    {solo ? 'all' : 'only'}
                  </button>
                  <XofY x={tagsInSlice.get(t) ?? 0} y={tagTotal(t)} />
                </CheckRow>
              )
            })
            if (g.single) return rows
            const preview = g.tags.slice(0, 12).map((t) => t.slice(g.prefix.length + 1)).join(', ') + (g.tags.length > 12 ? ', …' : '')
            // A namespace (tier:app, tier:platform …) is one row that toggles every tag in it — the chevron opens it for the
            // single tags; its count is how many nodes carry any of them.
            const solo = groupSolo(g.tags)
            return (
              <div key={g.prefix} className="gx-taggroup">
                <CheckRow className="gx-taggroup__head" on={state} title={`${g.tags.length} tags: ${preview} · click to toggle them all · double-click to show only nodes with one of them`} onToggle={() => toggleGroup(g.tags)} onSolo={() => soloGroup(g.tags)} share={g.count / Math.max(tagMax, g.count)} color="var(--text-faint)">
                  <button type="button" className="gx-taggroup__chev" onClick={(e) => (e.stopPropagation(), setOpenGroups((o) => ({ ...o, [g.prefix]: !open })))} onDoubleClick={(e) => e.stopPropagation()} title={open ? 'Fold the tags away' : 'Show the tags'} aria-expanded={open}>
                    {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  </button>
                  <span className="gx-checklist__label">{g.prefix}:</span>
                  <span className="faint">{g.tags.length}</span>
                  <button type="button" className="gx-only" onClick={(e) => (e.stopPropagation(), soloGroup(g.tags))}>
                    {solo ? 'all' : 'only'}
                  </button>
                  <XofY x={g.count} y={groupTotal(g.tags)} />
                </CheckRow>
                {open && <div className="gx-taggroup__rows">{rows}</div>}
              </div>
            )
          })}
        </div>
      </Fold>

      <Fold id="fields" title="Fields" folded={folded.has('fields')} onToggle={toggleFold} head={<>{fields.length > 0 && <span className="gx-panel__hint">{fields.length}</span>}
          <button className="btn btn--sm btn--ghost" onClick={() => patch({ fields: [...fields, { path: fieldKeys.find((k) => k.startsWith('data.')) ?? 'data.', op: 'exists' }] })} title="Add a condition on an attribute">
            <Plus size={12} />
          </button></>}>
        <datalist id="gx-field-keys">
          {fieldKeys.map((k) => (
            <option key={k} value={k} />
          ))}
        </datalist>
        {fields.map((p, i) => {
          const arity = FIELD_OPS.find((o) => o.id === p.op)?.arity ?? 1
          const v = p.value
          return (
            <div key={i} className="gx-field-row">
              <input className="input" list="gx-field-keys" value={p.path} placeholder="data.key" onChange={(e) => setField(i, { path: e.target.value })} />
              <Select className="gx-select" value={p.op} onChange={(e) => setField(i, { op: e.target.value as FieldOp, value: e.target.value === 'between' ? ['', ''] : e.target.value === 'exists' ? undefined : Array.isArray(v) ? v[0] : v })}>
                {FIELD_OPS.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label}
                  </option>
                ))}
              </Select>
              {arity === 1 && <input className="input" value={String(v ?? '')} placeholder="value" onChange={(e) => setField(i, { value: e.target.value })} />}
              {arity === 'list' && <input className="input" value={Array.isArray(v) ? v.join(', ') : String(v ?? '')} placeholder="a, b, c" onChange={(e) => setField(i, { value: e.target.value.split(/[,;|]/).map((x) => x.trim()).filter(Boolean) })} />}
              {arity === 2 && (
                <>
                  <input className="input" value={String((Array.isArray(v) ? v[0] : '') ?? '')} placeholder="from" onChange={(e) => setField(i, { value: [e.target.value, Array.isArray(v) ? v[1] : ''] })} />
                  <input className="input" value={String((Array.isArray(v) ? v[1] : '') ?? '')} placeholder="to" onChange={(e) => setField(i, { value: [Array.isArray(v) ? v[0] : '', e.target.value] })} />
                </>
              )}
              <button className="gx-chip-x" onClick={() => patch({ fields: fields.filter((_, j) => j !== i) })} aria-label="Remove condition">
                <X size={11} />
              </button>
            </div>
          )
        })}
        {fields.length === 0 && <p className="gx-panel__note">Conditions on attributes, e.g. data.year ≥ 1900 or meta.createdAt between two dates.</p>}
      </Fold>

      <Fold id="hood" title="Neighbourhood" folded={folded.has('hood')} onToggle={toggleFold} head={undefined}>
        {f.roots?.length ? (
          <>
            <div className="gx-tags">
              {f.roots.map((id) => {
                const e = store.get(id)
                return (
                  <span key={id} className="chip" style={{ background: 'var(--info-bg)', color: 'var(--info-text)' }}>
                    {e ? displayLabel(e) : id.slice(0, 8)}
                    <button className="gx-chip-x" onClick={() => patch({ roots: f.roots!.filter((x) => x !== id) })} aria-label="Remove root">
                      <X size={11} />
                    </button>
                  </span>
                )
              })}
            </div>
            <label className="gx-row">
              <span>Depth</span>
              <input type="range" min={1} max={6} value={f.depth ?? 1} onChange={(e) => patch({ depth: Number(e.target.value) })} />
              <span className="count">{f.depth ?? 1}</span>
            </label>
            <label className="gx-row">
              <span>Direction</span>
              <Select className="gx-select" value={f.direction ?? 'both'} onChange={(e) => patch({ direction: e.target.value as 'out' | 'in' | 'both' })}>
                <option value="both">Both ways</option>
                <option value="out">Outgoing only</option>
                <option value="in">Incoming only</option>
              </Select>
            </label>
          </>
        ) : (
          <p className="gx-panel__note">Select a node and use “Focus” to restrict the view to its neighbourhood.</p>
        )}
      </Fold>

      <Fold id="structure" title="Structure" folded={folded.has('structure')} onToggle={toggleFold} head={undefined}>
        <label className="gx-row">
          <span>Min degree</span>
          <input type="range" min={0} max={10} value={f.minDegree ?? 0} onChange={(e) => patch({ minDegree: Number(e.target.value) })} />
          <span className="count">{f.minDegree ?? 0}</span>
        </label>
        <label className="gx-row">
          <span>Max degree</span>
          <input type="range" min={0} max={50} value={f.maxDegree ?? 0} onChange={(e) => patch({ maxDegree: Number(e.target.value) })} />
          <span className="count">{f.maxDegree ? f.maxDegree : 'off'}</span>
        </label>
        <label className="gx-row">
          <input type="checkbox" checked={!!f.hideIsolated} onChange={(e) => patch({ hideIsolated: e.target.checked })} />
          <span>Hide isolated nodes</span>
        </label>
        <label className="gx-row" title="Keep only nodes with at least k neighbours that themselves have at least k neighbours">
          <span>k-core</span>
          <input type="range" min={0} max={10} value={f.kCore ?? 0} onChange={(e) => patch({ kCore: Number(e.target.value) })} />
          <span className="count">{f.kCore ? f.kCore : 'off'}</span>
        </label>
        <label className="gx-row">
          <input type="checkbox" checked={!!f.giantOnly} onChange={(e) => patch({ giantOnly: e.target.checked })} />
          <span>Largest component only</span>
        </label>
        {/* Stays while the largest component is all that is kept, only idle: a row that came and went moved everything under it. */}
        <label className={`gx-row ${f.giantOnly ? 'is-off' : ''}`} title={f.giantOnly ? 'Off while only the largest component is kept' : undefined}>
          <span>Min component size</span>
          <input className="input" type="number" min={0} style={{ width: 70, height: 26 }} value={f.componentMin ?? 0} disabled={!!f.giantOnly} onChange={(e) => patch({ componentMin: Math.max(0, Number(e.target.value) || 0) })} />
        </label>
        <label className="gx-row">
          <span>Max nodes</span>
          <Select className="gx-select" value={f.maxNodes ?? DEFAULT_MAX_NODES} onChange={(e) => patch({ maxNodes: Number(e.target.value) })}>
            {[...new Set([500, 1000, 2000, 5000, 10000, 20000, 50000, f.maxNodes ?? DEFAULT_MAX_NODES])].sort((a, b) => a - b).map((n) => (
              <option key={n} value={n}>
                {n.toLocaleString()}
              </option>
            ))}
          </Select>
        </label>
        <FilterStatus slice={slice} cap={f.maxNodes ?? DEFAULT_MAX_NODES} />
      </Fold>

      {(f.only?.length ?? 0) > 0 && (
        <section>
          <h4>
            Just these
            <span className="gx-panel__hint">{f.only!.length}</span>
            {f.script && store.has(f.script) && (
              <button className="btn btn--sm btn--ghost" disabled={scriptRunning} onClick={() => void applyScript(f.script!)} title="Run the filter script again over the data as it stands">
                <Play size={12} /> Re-run
              </button>
            )}
            <button className="btn btn--sm btn--ghost" onClick={() => patch({ only: [], script: undefined })} title="Show everything the other filters allow again">
              <X size={12} /> Lift
            </button>
          </h4>
          <p className="muted" style={{ margin: 0, fontSize: 11.5 }}>
            {f.script && store.has(f.script) ? (
              <>
                What the filter script <b>{displayLabel(store.get(f.script)!)}</b> returned. The other filters still apply on top; “add linked entities” brings more in.
              </>
            ) : (
              <>Only the entities this view was opened on — a table's rows, or a selection opened in a new graph. The other filters still apply on top; “add linked entities” brings more in.</>
            )}
          </p>
        </section>
      )}
      <Fold id="script" title="Script" folded={folded.has('script')} onToggle={toggleFold} head={f.script && store.has(f.script) ? <span className="gx-panel__hint">{displayLabel(store.get(f.script)!)}</span> : undefined}>
        <p className="muted" style={{ margin: '0 0 6px', fontSize: 11.5 }}>
          A saved script does the filtering: it returns the entities to keep — a collection, a list of ids, or a table with an id column — and the view keeps just those. Written on the Scripts page; a script applied here is a filter script.
        </p>
        <div className="gx-row" style={{ gap: 6 }}>
          <Select className="gx-select" style={{ flex: 1, minWidth: 0 }} value={scriptPick} onChange={(e) => setScriptPick(e.target.value)} disabled={!scripts.length} title="A saved script; filter scripts first">
            <option value="">{scripts.length ? 'Choose a script…' : 'No saved scripts yet'}</option>
            {scripts.map((s) => (
              <option key={s.id} value={s.id}>
                {displayLabel(s)}
                {scriptKindOf(s.type) ? ` · ${scriptKindOf(s.type)}` : ''}
              </option>
            ))}
          </Select>
          <button className="btn btn--sm" disabled={!scriptPick || scriptRunning} onClick={() => void applyScript(scriptPick)} title="Run the script and keep the entities it returns">
            {scriptRunning ? <Code2 size={12} /> : <Play size={12} />} {scriptRunning ? 'Running…' : 'Apply'}
          </button>
        </div>
      </Fold>
      {(f.include?.length ?? 0) > 0 && (
        <section>
          <h4>
            Added
            <span className="gx-panel__hint">{f.include!.length}</span>
            <button className="btn btn--sm btn--ghost" onClick={() => patch({ include: [] })} title="Take out the entities brought in by hand">
              Remove all
            </button>
          </h4>
          <p className="muted" style={{ margin: 0, fontSize: 11.5 }}>Linked entities brought in from the view, kept whatever the filters above say.</p>
          <div className="gx-tags">
            {f.include!.slice(0, 40).map((id) => {
              const e = store.get(id)
              return (
                <span key={id} className="chip">
                  {e ? displayLabel(e) : id.slice(0, 8)}
                  <button className="gx-chip-x" onClick={() => patch({ include: f.include!.filter((x) => x !== id) })} aria-label="Remove">
                    <X size={11} />
                  </button>
                </span>
              )
            })}
            {f.include!.length > 40 && <span className="faint">… {f.include!.length - 40} more</span>}
          </div>
        </section>
      )}
      {(f.exclude?.length ?? 0) > 0 && (
        <section>
          <h4>
            Hidden
            <span className="gx-panel__hint">{f.exclude!.length}</span>
            <button className="btn btn--sm btn--ghost" onClick={() => patch({ exclude: [] })}>
              Unhide all
            </button>
          </h4>
          <div className="gx-tags">
            {f.exclude!.slice(0, 40).map((id) => {
              const e = store.get(id)
              return (
                <span key={id} className="chip">
                  {e ? displayLabel(e) : id.slice(0, 8)}
                  <button className="gx-chip-x" onClick={() => patch({ exclude: f.exclude!.filter((x) => x !== id) })} aria-label="Unhide">
                    <X size={11} />
                  </button>
                </span>
              )
            })}
            {f.exclude!.length > 40 && <span className="faint">… {f.exclude!.length - 40} more</span>}
          </div>
        </section>
      )}
      {menu && <Menu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </div>
  )
}

/**
 * A checklist row that owns its clicks: one click toggles, the second click of
 * a double-click solos. (A <label> would forward clicks to the checkbox and
 * fire a second toggle after the solo.) Space toggles, Enter solos.
 */
const FOLD_KEY = 'aegraph:graph:filter:folded'
const readFolded = (): Set<string> => {
  try {
    return new Set(JSON.parse(localStorage.getItem(FOLD_KEY) ?? '[]') as string[])
  } catch {
    return new Set()
  }
}

/** A panel section that folds to its heading (the chevron or the title toggles it); what is folded is remembered. */
/**
 * A heading's "all" (put every type, relationship type or tag back). It is always there and only hidden while there is
 * nothing to put back, so the heading keeps its height and what sits beside it keeps its place as the filter changes.
 */
function HeadReset({ idle, onClick }: { idle: boolean; onClick: () => void }) {
  return (
    <button className={`btn btn--sm btn--ghost ${idle ? 'is-idle' : ''}`} onClick={onClick} disabled={idle} aria-hidden={idle} tabIndex={idle ? -1 : undefined}>
      all
    </button>
  )
}

/**
 * One line, always there, at the foot of Structure: how many nodes the filter matches and how many are drawn, with the
 * components when they are counted — in the warning colour when Max nodes leaves some out, the whole story on hover.
 * A note that came and went (and a warning three lines long) moved every control below it as the filter changed.
 */
function FilterStatus({ slice, cap }: { slice: { candidates: number; truncated: number; components?: number }; cap: number }) {
  const comps = slice.components !== undefined ? ` · ${slice.components.toLocaleString()} component${slice.components === 1 ? '' : 's'}` : ''
  if (slice.truncated > 0)
    return (
      <p
        className="gx-panel__status gx-panel__warn"
        title={`The filter matches ${slice.candidates.toLocaleString()} nodes; only the ${cap.toLocaleString()} best-connected are drawn, and the other ${slice.truncated.toLocaleString()} are left out of the picture, the tables and the layout (the filter still matches them). Raise Max nodes, or narrow the filter.`}
      >
        {cap.toLocaleString()} of {slice.candidates.toLocaleString()} drawn — raise Max nodes or narrow the filter{comps}
      </p>
    )
  return (
    <p className="gx-panel__status">
      {slice.candidates === 1 ? '1 node matches' : `${slice.candidates.toLocaleString()} nodes match`}, all drawn{comps}
    </p>
  )
}

function Fold({ id, title, folded, onToggle, head, children }: { id: string; title: string; folded: boolean; onToggle: (id: string) => void; head?: ReactNode; children: ReactNode }) {
  return (
    <section className={folded ? 'is-folded' : ''}>
      <h4>
        <button type="button" className="gx-fold" onClick={() => onToggle(id)} title={folded ? 'Open' : 'Fold'} aria-expanded={!folded}>
          {folded ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
          {title}
        </button>
        {head}
      </h4>
      {!folded && children}
    </section>
  )
}

/** A checklist row: click toggles, double-click (or Enter) shows only it. `on` may be 'mixed' for a group with some of its members checked. */
/** A checklist row; `share` (0–1) shades it to that fraction of its width in `color`, the row's bar of the histogram. */
function CheckRow({ on, title, onToggle, onSolo, onContextMenu, className = '', share, color, children }: { on: boolean | 'mixed'; title: string; onToggle: () => void; onSolo: () => void; onContextMenu?: (e: ReactMouseEvent) => void; className?: string; share?: number; color?: string; children: ReactNode }) {
  return (
    <div
      className={`gx-check ${on ? '' : 'is-off'} ${className}`}
      role="checkbox"
      aria-checked={on === 'mixed' ? 'mixed' : on}
      tabIndex={0}
      title={title}
      onClick={(e) => (e.detail >= 2 ? onSolo() : onToggle())}
      onContextMenu={onContextMenu}
      onKeyDown={(e) => {
        if (e.key !== ' ' && e.key !== 'Enter') return
        e.preventDefault()
        if (e.key === ' ') onToggle()
        else onSolo()
      }}
    >
      {share !== undefined && share > 0 && <span className="gx-check__bar" style={{ width: `${Math.min(100, share * 100)}%`, background: color }} aria-hidden />}
      <input type="checkbox" checked={on === true} ref={(el) => {
          if (el) el.indeterminate = on === 'mixed'
        }} readOnly tabIndex={-1} aria-hidden />
      {children}
    </div>
  )
}

/** A checklist row's count: how many are in view, of how many the project holds. */
function XofY({ x, y }: { x: number; y: number }) {
  return (
    <span className="count gx-xofy" title={`${x.toLocaleString()} in view of ${y.toLocaleString()} in the project`}>
      {x.toLocaleString()}
      <span className="gx-xofy__of">of {y.toLocaleString()}</span>
    </span>
  )
}
