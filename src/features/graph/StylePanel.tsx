import { ChevronDown, ChevronRight, Eye, EyeOff, Plus, RotateCcw, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useEntityStore, useStoreVersion, useTypeRegistry } from '../../core/entity/hooks'
import type { AnyEntity, Relationship } from '../../core/entity/types'
import { METRICS, type NodeMetricId } from '../../core/graph/metrics/types'
import { categoricalColor, PALETTES, paletteGradient, type PaletteId } from '../../core/graph/palettes'
import {
  attrKey,
  attrLabel,
  edgeAttrValue,
  isCategoricalAttr,
  nodeAttrValue,
  NODE_SHAPES,
  type Attr,
  type Channel,
  type ColorChannel,
  type EdgeAppearance,
  type NodeAppearance,
  type NodeShape,
  type NumberChannel,
  type RenderingSpec,
  type ShapeChannel,
} from '../../core/graph/rendering'
import { categories } from '../../core/graph/scales'
import { hashColor } from '../../lib/format'
import { useExplorer } from './explorerState'
import { columnLabel, datasetsIn, inferColumnKind } from '../../core/datasets/dataset'
import { datasetRef, keyColumnOf } from '../../core/datasets/join'
import { ScriptSource } from './ScriptSource'
import { edgeColor } from './style'
import { Select } from '../../components/ui/Select'

/**
 * Style: the defaults, then the overrides. Every node (or edge) gets the
 * default for each channel — colour, size, opacity, shape; colour, width,
 * opacity — as a constant, a ranking over a number or a partition over a
 * category. An override is one row for one type or one tag, setting only
 * the channels it names; the rest inherit. Rows are short; a row opens
 * into its editor when clicked. Everything edits the RenderingSpec that
 * the Style picker saves.
 */

type Element = 'nodes' | 'edges'
type Scope = { by: 'all' } | { by: 'types' | 'tags'; key: string }
type NodeChannelId = 'color' | 'size' | 'opacity' | 'shape'
type EdgeChannelId = 'color' | 'width' | 'opacity'
type ChannelId = NodeChannelId | EdgeChannelId
type Rule = NodeAppearance & EdgeAppearance

const NODE_CHANNELS: { id: NodeChannelId; label: string }[] = [
  { id: 'color', label: 'Colour' },
  { id: 'size', label: 'Size' },
  { id: 'opacity', label: 'Opacity' },
  { id: 'shape', label: 'Shape' },
]
const EDGE_CHANNELS: { id: EdgeChannelId; label: string }[] = [
  { id: 'color', label: 'Colour' },
  { id: 'width', label: 'Width' },
  { id: 'opacity', label: 'Opacity' },
]
const RANGE: Record<string, [number, number, number, number]> = {
  // [min-of-min, max-of-max, step, default-max]
  size: [1, 60, 0.5, 14],
  width: [0.25, 12, 0.25, 4],
  opacity: [0.05, 1, 0.05, 1],
}
const scopeKey = (s: Scope) => (s.by === 'all' ? 'all' : `${s.by}:${s.key}`)
const sameScope = (a: Scope, b: Scope) => scopeKey(a) === scopeKey(b)

export function StylePanel() {
  const store = useEntityStore()
  useStoreVersion(store)
  const registry = useTypeRegistry()
  const { state, dispatch, slice, metricIndex, values } = useExplorer()
  const r = state.rendering
  const patch = (p: Partial<RenderingSpec>) => dispatch({ type: 'patchRendering', patch: p })
  const setRule = (scope: Element, by: 'types' | 'tags', key: string, p: Rule | null) => dispatch({ type: 'setRule', scope, by, key, patch: p })

  const [element, setElement] = useState<Element>('nodes')
  // What is open for editing: a scope and a channel; null = every row folded.
  const [open, setOpen] = useState<{ scope: Scope; channel: ChannelId } | null>(null)
  // Override rows added with + that have no channel set yet (nothing in the spec until they do).
  const [pending, setPending] = useState<Scope[]>([])
  const [adding, setAdding] = useState(false)
  const [options, setOptions] = useState(false)

  const channels = element === 'nodes' ? NODE_CHANNELS : EDGE_CHANNELS
  const spec = r[element]
  const defaults = spec.default as Rule

  // Keys in the slice (with counts) plus anything that already has a rule.
  const nodeTypes = useMemo(() => countKeys(slice.nodes.map((n) => n.type), r.nodes.types), [slice, r.nodes.types])
  const nodeTags = useMemo(() => countKeys(slice.nodes.flatMap((n) => n.tags), r.nodes.tags), [slice, r.nodes.tags])
  const edgeTypes = useMemo(() => countKeys(slice.edges.map((e) => e.type), r.edges.types), [slice, r.edges.types])
  const edgeTags = useMemo(() => countKeys(slice.edges.flatMap((e) => e.tags), r.edges.tags), [slice, r.edges.tags])
  const nodeFields = useMemo(() => sampleFields(slice.nodes), [slice])
  const edgeFields = useMemo(() => sampleFields(slice.edges), [slice])
  const computedMetrics = useMemo(() => new Set(state.metrics ? (Object.keys(state.metrics.columns) as NodeMetricId[]) : []), [state.metrics])
  const types = element === 'nodes' ? nodeTypes : edgeTypes
  const tags = element === 'nodes' ? nodeTags : edgeTags
  const countOf = (by: 'types' | 'tags', key: string) => (by === 'types' ? types : tags).find(([k]) => k === key)?.[1] ?? 0

  const labelOf = (by: 'types' | 'tags', key: string) => (by === 'tags' ? `#${key}` : element === 'nodes' ? registry.get(key).pluralLabel : key)
  const fallbackColor = (by: 'types' | 'tags', key: string) => (by === 'tags' ? (store.getTagInfo(key).color ?? hashColor(key)) : element === 'nodes' ? (registry.get(key).color ?? hashColor(key)) : edgeColor(key))

  const ruleOf = (s: Scope): Rule => (s.by === 'all' ? defaults : ((spec[s.by][s.key] ?? {}) as Rule))
  const own = (s: Scope, ch: ChannelId): Channel | undefined => (ruleOf(s) as unknown as Record<string, Channel | undefined>)[ch]
  const effective = (s: Scope, ch: ChannelId): Channel => own(s, ch) ?? (defaults as unknown as Record<string, Channel>)[ch]
  const setChannelValue = (s: Scope, ch: ChannelId, value: Channel | undefined) => {
    if (s.by === 'all') {
      if (!value) return
      patch({ [element]: { ...spec, default: { ...spec.default, [ch]: value } } } as Partial<RenderingSpec>)
    } else setRule(element, s.by, s.key, { [ch]: value } as Rule)
  }
  const patchScope = (s: Scope, p: Rule) => {
    if (s.by === 'all') patch({ [element]: { ...spec, default: { ...spec.default, ...p } } } as Partial<RenderingSpec>)
    else setRule(element, s.by, s.key, p)
  }

  // Members of a scope, for partition previews.
  const members = (s: Scope): (AnyEntity | Relationship)[] => {
    const all = element === 'nodes' ? slice.nodes : slice.edges
    if (s.by === 'all') return all
    return s.by === 'types' ? all.filter((e) => e.type === s.key) : all.filter((e) => e.tags.includes(s.key))
  }
  const valueOf = (e: AnyEntity | Relationship, attr: Attr) => (element === 'nodes' ? nodeAttrValue(e, attr, { degree: slice.degree, metrics: state.metrics, metricIndex, values }) : edgeAttrValue(e as Relationship, attr))

  // The override rows: every scope with a rule in the spec, then the pending ones.
  const overrides: Scope[] = [
    ...Object.keys(spec.types).map((key) => ({ by: 'types', key }) as Scope),
    ...Object.keys(spec.tags).map((key) => ({ by: 'tags', key }) as Scope),
    ...pending.filter((p) => p.by !== 'all' && !spec[p.by][p.key]),
  ]
  const taken = new Set(overrides.map(scopeKey))
  const addable = [...types.map(([k, n]) => ({ scope: { by: 'types', key: k } as Scope, n })), ...tags.map(([k, n]) => ({ scope: { by: 'tags', key: k } as Scope, n }))].filter((o) => !taken.has(scopeKey(o.scope)))

  const switchElement = (el: Element) => {
    setElement(el)
    setOpen(null)
    setAdding(false)
  }
  const toggleOpen = (scope: Scope, channel: ChannelId) => setOpen(open && sameScope(open.scope, scope) && open.channel === channel ? null : { scope, channel })
  const removeOverride = (s: Scope) => {
    if (s.by === 'all') return
    setRule(element, s.by, s.key, null)
    setPending((p) => p.filter((x) => !sameScope(x, s)))
    if (open && sameScope(open.scope, s)) setOpen(null)
  }

  const editor = (scope: Scope) => {
    if (!open || !sameScope(open.scope, scope)) return null
    const ch = open.channel
    if (!channels.some((c) => c.id === ch)) return null
    const isOwn = !!own(scope, ch)
    const value = effective(scope, ch)
    return (
      <div className="gx-st__editor">
        <div className="gx-st__editor-head">
          <span className="gx-seg gx-seg--sm">
            {channels.map((c) => (
              <button key={c.id} className={`${c.id === ch ? 'is-active' : ''} ${scope.by !== 'all' && own(scope, c.id) ? 'is-own' : ''}`} onClick={() => setOpen({ scope, channel: c.id })} title={summarize(effective(scope, c.id))}>
                {c.label}
              </button>
            ))}
          </span>
          {scope.by !== 'all' && isOwn && (
            <button className="btn btn--sm btn--ghost" onClick={() => setChannelValue(scope, ch, undefined)} title="Drop this override; follow the default again">
              <RotateCcw size={11} /> Inherit
            </button>
          )}
        </div>
        {scope.by !== 'all' && !isOwn ? (
          <p className="gx-panel__note gx-st__inherit">
            Inherits the default: {summarize(value)}.{' '}
            <button className="gx-link" onClick={() => setChannelValue(scope, ch, value)}>
              Override
            </button>
          </p>
        ) : (
          <ChannelEditor
            element={element}
            channel={ch}
            value={value}
            onChange={(v) => setChannelValue(scope, ch, v)}
            fields={element === 'nodes' ? nodeFields : edgeFields}
            computedMetrics={computedMetrics}
            members={members(scope)}
            valueOf={valueOf}
            registry={registry}
            fallbackColor={scope.by === 'all' ? undefined : fallbackColor(scope.by, scope.key)}
          />
        )}
      </div>
    )
  }

  const all: Scope = { by: 'all' }
  const isOpen = (scope: Scope, channel?: ChannelId) => !!open && sameScope(open.scope, scope) && (!channel || open.channel === channel)

  return (
    <div className="gx-panel gx-st">
      <section>
        <h4>
          Style
          <span className="gx-toggle" style={{ marginLeft: 'auto' }}>
            <button className={element === 'nodes' ? 'is-active' : ''} onClick={() => switchElement('nodes')}>
              Nodes
            </button>
            <button className={element === 'edges' ? 'is-active' : ''} onClick={() => switchElement('edges')}>
              Edges
            </button>
          </span>
        </h4>
        {r.overlay?.source && <ScriptSource kind="style" source={r.overlay.source} />}
        {r.overlay && (Object.keys(r.overlay.nodes ?? {}).length > 0 || Object.keys(r.overlay.edges ?? {}).length > 0) && (
          <p className="gx-panel__note gx-st__overlay">
            {[r.overlay.nodes ? `${Object.keys(r.overlay.nodes).length.toLocaleString()} nodes` : '', r.overlay.edges ? `${Object.keys(r.overlay.edges).length.toLocaleString()} edges` : ''].filter(Boolean).join(' and ')} are styled by the script, over what the rows below say.{' '}
            <button className="gx-link" onClick={() => patch({ overlay: undefined })}>
              Drop them
            </button>
          </p>
        )}
        <div className="gx-st__rows">
          {channels.map((c) => {
            const v = effective(all, c.id)
            const o = isOpen(all, c.id)
            return (
              <div key={c.id}>
                <div className={`gx-st__row ${o ? 'is-open' : ''}`}>
                  <button className="gx-st__name" onClick={() => toggleOpen(all, c.id)} title={summarize(v)}>
                    {o ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                    {c.label}
                  </button>
                  <span className="gx-st__cell">
                    <QuickCell channel={c.id} value={v} fallback={element === 'nodes' ? '#9aa6b2' : '#bcbab3'} onConstant={(ch) => setChannelValue(all, c.id, ch)} onOpen={() => toggleOpen(all, c.id)} defaultRow />
                  </span>
                </div>
                {o && editor(all)}
              </div>
            )
          })}
          {element === 'nodes' ? (
            <div className="gx-st__row">
              <span className="gx-st__name gx-st__name--plain">Labels</span>
              <span className="gx-st__cell">
                <Switch on={defaults.label !== false} onChange={(on) => patchScope(all, { label: on })} title="Draw node labels" />
              </span>
            </div>
          ) : (
            <div className="gx-st__row">
              <span className="gx-st__name gx-st__name--plain">Arrows</span>
              <span className="gx-st__cell">
                <Switch on={defaults.arrow !== false} onChange={(on) => patchScope(all, { arrow: on })} title="Arrowheads on directed edges" />
              </span>
            </div>
          )}
        </div>
      </section>

      <section>
        <h4>
          Overrides
          <span className="faint" style={{ fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>
            by type or tag
          </span>
          <button className="btn btn--sm btn--icon" style={{ marginLeft: 'auto' }} disabled={addable.length === 0} onClick={() => setAdding((a) => !a)} title={addable.length ? 'Add an override for a type or a tag' : 'Every type and tag in view already has a row'}>
            <Plus size={12} />
          </button>
        </h4>
        {adding && (
          <Select
            className="gx-select gx-st__add"
            autoFocus
            value=""
            onBlur={() => setAdding(false)}
            onChange={(e) => {
              const s = parseScope(e.target.value)
              if (s.by === 'all') return
              setPending((p) => [...p, s])
              setAdding(false)
              setOpen({ scope: s, channel: 'color' })
            }}
          >
            <option value="" disabled>
              Choose a type or a tag…
            </option>
            <optgroup label="Types">
              {addable
                .filter((o) => o.scope.by === 'types')
                .map((o) => (
                  <option key={scopeKey(o.scope)} value={scopeKey(o.scope)}>
                    {labelOf('types', (o.scope as { key: string }).key)} ({o.n})
                  </option>
                ))}
            </optgroup>
            <optgroup label="Tags">
              {addable
                .filter((o) => o.scope.by === 'tags')
                .map((o) => (
                  <option key={scopeKey(o.scope)} value={scopeKey(o.scope)}>
                    {labelOf('tags', (o.scope as { key: string }).key)} ({o.n})
                  </option>
                ))}
            </optgroup>
          </Select>
        )}
        {overrides.length === 0 && !adding && <p className="gx-panel__note">None — every {element === 'nodes' ? 'node' : 'edge'} follows the defaults. Add one with +.</p>}
        <div className="gx-st__rows">
          {overrides.map((s) => {
            if (s.by === 'all') return null
            const rule = ruleOf(s)
            const o = isOpen(s)
            const hidden = rule.visible === false
            const setCount = channels.filter((c) => !!own(s, c.id)).length
            return (
              <div key={scopeKey(s)} className={`gx-st__override ${o ? 'is-open' : ''} ${hidden ? 'is-hidden' : ''}`}>
                <div className="gx-st__row">
                  <button className="gx-st__name" onClick={() => toggleOpen(s, open && sameScope(open.scope, s) ? open.channel : 'color')} title={`${s.by === 'types' ? 'Type' : 'Tag'} · ${countOf(s.by, s.key)} in view — click to edit`}>
                    {o ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                    <span className="gx-st__scope">{labelOf(s.by, s.key)}</span>
                    <span className="faint">{countOf(s.by, s.key)}</span>
                  </button>
                  <span className="gx-st__cells">
                    {setCount === 0 && !hidden && <span className="faint gx-st__none">inherits all</span>}
                    <button className={`gx-icon ${hidden ? 'is-off' : ''}`} title={hidden ? 'Hidden — click to show' : 'Hide these'} onClick={() => patchScope(s, { visible: hidden ? undefined : false })}>
                      {hidden ? <EyeOff size={12} /> : <Eye size={12} />}
                    </button>
                    <button className="gx-icon" title="Remove this override" onClick={() => removeOverride(s)}>
                      <X size={12} />
                    </button>
                  </span>
                </div>
                {/* Only the channels this row sets, on a line of their own; the rest inherit and say nothing. The editor adds more. */}
                {setCount > 0 && (
                  <div className="gx-st__set">
                    {channels.map((c) => {
                      const v = own(s, c.id)
                      if (!v) return null
                      return (
                        <span key={c.id} className="gx-st__cell is-own" title={`${c.label}: ${summarize(v)}`}>
                          <span className="gx-st__cell-name">{c.label.toLowerCase()}</span>
                          <QuickCell channel={c.id} value={v} fallback={fallbackColor(s.by, s.key)} onConstant={(ch) => setChannelValue(s, c.id, ch)} onOpen={() => setOpen({ scope: s, channel: c.id })} />
                        </span>
                      )
                    })}
                  </div>
                )}
                {o && editor(s)}
              </div>
            )
          })}
        </div>
      </section>

      <section className={options ? '' : 'is-folded'}>
        <h4>
          <button className="gx-st__name gx-st__name--h4" onClick={() => setOptions((v) => !v)}>
            {options ? <ChevronDown size={11} /> : <ChevronRight size={11} />} Options
          </button>
        </h4>
        {options && (
          <div className="gx-st__rows">
            <div className="gx-st__row">
              <span className="gx-st__name gx-st__name--plain" title="When an element matches both a type rule and a tag rule, whose channels apply. Hidden always wins.">
                Precedence
              </span>
              <span className="gx-st__cell">
                <Select className="gx-select gx-select--sm" value={r.precedence} onChange={(e) => patch({ precedence: e.target.value as 'type' | 'tag' })}>
                  <option value="type">Type rules win</option>
                  <option value="tag">Tag rules win</option>
                </Select>
              </span>
            </div>
            <div className="gx-st__row">
              <span className="gx-st__name gx-st__name--plain">Edge labels (2D)</span>
              <span className="gx-st__cell">
                <Switch on={r.edgeLabels} onChange={(on) => patch({ edgeLabels: on })} />
              </span>
            </div>
            <div className="gx-st__row">
              <span className="gx-st__name gx-st__name--plain">Curve parallel edges</span>
              <span className="gx-st__cell">
                <Switch on={r.curvedEdges} onChange={(on) => patch({ curvedEdges: on })} />
              </span>
            </div>
          </div>
        )}
      </section>
    </div>
  )
}

// ── Row cells ──────────────────────────────────────────────────────────

/**
 * The compact control on a row: a constant edits in place (swatch, number,
 * shape); a mapping is a pill naming its attribute that opens the editor.
 */
function QuickCell({ channel, value, inherit, fallback, onConstant, onOpen, defaultRow }: { channel: ChannelId; value: Channel; inherit?: boolean; fallback: string; onConstant: (ch: Channel) => void; onOpen: () => void; defaultRow?: boolean }) {
  if (value.mode !== 'constant') {
    return (
      <button className={`gx-ap__fn ${inherit ? '' : 'is-own'}`} onClick={onOpen} title={`${summarize(value)} — click to edit`}>
        ƒ {attrLabel(value.attr)}
      </button>
    )
  }
  if (channel === 'color') {
    const v = (value as ColorChannel & { mode: 'constant' }).value
    return (
      <span className={`gx-st__color ${inherit ? 'is-inherit' : ''}`}>
        <ColorSwatch value={inherit ? undefined : v} fallback={v ?? fallback} onChange={(c) => onConstant({ mode: 'constant', ...(c ? { value: c } : {}) })} title={defaultRow ? (v ? `${v} — right-click for automatic (each type its own colour)` : 'automatic — each type its own colour; click to set one') : inherit ? 'Inherits — click to set a colour for these' : `${v ?? 'type colour'} — right-click for the type colour`} />
        {defaultRow && <span className="faint">{v ?? 'auto'}</span>}
      </span>
    )
  }
  if (channel === 'shape') {
    const v = (value as ShapeChannel & { mode: 'constant' }).value
    return <ShapeSelect value={v} inherit={inherit} onChange={(s) => onConstant({ mode: 'constant', value: s })} />
  }
  const [lo, hi, step] = RANGE[channel] ?? [0, 1, 0.05, 1]
  const v = (value as NumberChannel & { mode: 'constant' }).value
  return <input className={`gx-num ${inherit ? 'is-inherit' : ''}`} type="number" min={lo} max={hi} step={step} value={Number(v.toFixed(2))} title={channelLabel(channel)} onChange={(e) => onConstant({ mode: 'constant', value: Math.max(lo, Math.min(hi, Number(e.target.value) || lo)) })} />
}

function Switch({ on, onChange, title }: { on: boolean; onChange: (on: boolean) => void; title?: string }) {
  return (
    <button className={`gx-st__switch ${on ? 'is-on' : ''}`} role="switch" aria-checked={on} title={title} onClick={() => onChange(!on)}>
      <span />
    </button>
  )
}

// ── Channel editor ─────────────────────────────────────────────────────

interface EditorProps {
  element: Element
  channel: ChannelId
  value: Channel
  onChange: (v: Channel) => void
  fields: { key: string; numeric: boolean }[]
  computedMetrics: Set<NodeMetricId>
  members: (AnyEntity | Relationship)[]
  valueOf: (e: AnyEntity | Relationship, attr: Attr) => number | string | undefined
  registry: ReturnType<typeof useTypeRegistry>
  /** What a constant colour with no value falls back to at this scope (type colour); undefined for "all". */
  fallbackColor?: string
}

function ChannelEditor({ element, channel, value, onChange, fields, computedMetrics, members, valueOf, registry, fallbackColor }: EditorProps) {
  const isColor = channel === 'color'
  const isShape = channel === 'shape'
  const isNumber = !isColor && !isShape
  const modes: ('constant' | 'ranking' | 'partition')[] = isShape ? ['constant', 'partition'] : isColor ? ['constant', 'ranking', 'partition'] : ['constant', 'ranking']
  const defaultAttr = (mode: 'ranking' | 'partition'): Attr => {
    if (mode === 'partition') return element === 'nodes' ? { kind: 'type' } : { kind: 'type' }
    if (element === 'nodes') return { kind: 'degree' }
    const f = fields.find((x) => x.numeric)
    return { kind: 'field', key: f?.key ?? 'weight' }
  }
  const switchMode = (mode: 'constant' | 'ranking' | 'partition') => {
    if (mode === value.mode) return
    const [lo, hi, , dmax] = RANGE[channel] ?? [0, 1, 0.05, 1]
    if (mode === 'constant') {
      if (isColor) onChange({ mode: 'constant' })
      else if (isShape) onChange({ mode: 'constant', value: 'circle' })
      else onChange({ mode: 'constant', value: channel === 'opacity' ? 1 : channel === 'width' ? 1 : (lo + hi) / 8 })
    } else if (mode === 'ranking') {
      const attr = value.mode === 'partition' && !isCategoricalAttr(value.attr) ? value.attr : defaultAttr('ranking')
      if (isColor) onChange({ mode: 'ranking', attr, palette: 'viridis' })
      else onChange({ mode: 'ranking', attr, min: channel === 'opacity' ? 0.2 : channel === 'width' ? 0.5 : 3, max: dmax })
    } else {
      const attr = value.mode === 'ranking' && isCategoricalAttr(value.attr) ? value.attr : defaultAttr('partition')
      if (isShape) onChange({ mode: 'partition', attr })
      else onChange({ mode: 'partition', attr, palette: 'tableau10' })
    }
  }

  // Partition preview: the categories this scope actually has.
  const cats = useMemo(() => (value.mode === 'partition' ? categories(members.map((m) => valueOf(m, value.attr)), 'maxCategories' in value && value.maxCategories ? value.maxCategories : 12) : null), [value, members, valueOf])

  return (
    <div className="gx-ap__body">
      <div className="gx-seg">
        {modes.map((m) => (
          <button key={m} className={value.mode === m ? 'is-active' : ''} onClick={() => switchMode(m)} title={m === 'constant' ? 'One value for every element in scope' : m === 'ranking' ? 'A numeric attribute mapped onto a range' : 'A categorical attribute mapped onto distinct values'}>
            {m === 'constant' ? 'Constant' : m === 'ranking' ? 'Ranking' : 'Partition'}
          </button>
        ))}
      </div>

      {value.mode === 'constant' && isColor && (
        <label className="gx-row">
          <span>Colour</span>
          <ColorSwatch value={(value as ColorChannel & { mode: 'constant' }).value} fallback={fallbackColor ?? '#9aa6b2'} onChange={(c) => onChange({ mode: 'constant', ...(c ? { value: c } : {}) })} title={fallbackColor ? 'Right-click to use the type colour' : 'Right-click for automatic (type colour)'} />
          <span className="faint">{(value as { value?: string }).value ?? (fallbackColor ? 'type colour' : 'automatic — each type its own colour')}</span>
        </label>
      )}
      {value.mode === 'constant' && isShape && (
        <label className="gx-row">
          <span>Shape</span>
          <Select className="gx-select" value={(value as ShapeChannel & { mode: 'constant' }).value} onChange={(e) => onChange({ mode: 'constant', value: e.target.value as NodeShape })}>
            {NODE_SHAPES.map((s) => (
              <option key={s.id} value={s.id}>
                {shapeGlyph(s.id)} {s.label}
              </option>
            ))}
          </Select>
        </label>
      )}
      {value.mode === 'constant' && isNumber && (
        <NumberRow label={channelLabel(channel)} channel={channel} value={(value as NumberChannel & { mode: 'constant' }).value} onChange={(v) => onChange({ mode: 'constant', value: v })} />
      )}

      {value.mode !== 'constant' && (
        <AttrPicker element={element} mode={value.mode} attr={value.attr} fields={fields} computedMetrics={computedMetrics} onChange={(attr) => onChange({ ...value, attr } as Channel)} />
      )}

      {value.mode === 'ranking' && (
        <>
          <label className="gx-row">
            <span>Input</span>
            <Select className="gx-select" value={value.domain === 'auto' || !value.domain ? 'auto' : 'manual'} onChange={(e) => onChange({ ...value, domain: e.target.value === 'auto' ? 'auto' : [0, 1] } as Channel)}>
              <option value="auto">Auto (min–max in scope)</option>
              <option value="manual">Manual domain</option>
            </Select>
            <label className="gx-inline">
              <input type="checkbox" checked={!!value.log} onChange={(e) => onChange({ ...value, log: e.target.checked } as Channel)} /> log
            </label>
          </label>
          {Array.isArray(value.domain) && (
            <label className="gx-row">
              <span>Domain</span>
              <input className="input" type="number" style={{ width: 70, height: 26 }} value={value.domain[0]} onChange={(e) => onChange({ ...value, domain: [Number(e.target.value), (value.domain as [number, number])[1]] } as Channel)} />
              <input className="input" type="number" style={{ width: 70, height: 26 }} value={value.domain[1]} onChange={(e) => onChange({ ...value, domain: [(value.domain as [number, number])[0], Number(e.target.value)] } as Channel)} />
            </label>
          )}
          {isColor ? (
            <PaletteRow value={(value as ColorChannel & { mode: 'ranking' }).palette} kinds={['sequential', 'diverging']} onChange={(palette) => onChange({ ...value, palette } as Channel)} />
          ) : (
            <RangeRows channel={channel} min={(value as NumberChannel & { mode: 'ranking' }).min} max={(value as NumberChannel & { mode: 'ranking' }).max} onChange={(min, max) => onChange({ ...value, min, max } as Channel)} />
          )}
        </>
      )}

      {value.mode === 'partition' && (
        <>
          {isColor && (
            <>
              <PaletteRow value={(value as ColorChannel & { mode: 'partition' }).palette} kinds={['categorical']} onChange={(palette) => onChange({ ...value, palette } as Channel)} />
              <label className="gx-row">
                <span>Max groups</span>
                <input className="gx-num" type="number" min={2} max={40} value={('maxCategories' in value && value.maxCategories) || 12} onChange={(e) => onChange({ ...value, maxCategories: Math.max(2, Math.min(40, Number(e.target.value) || 12)) } as Channel)} />
                <span className="faint">rest as “other”</span>
              </label>
            </>
          )}
          {cats && (
            <ul className="gx-ap__cats">
              {cats.keys.map((key, i) => {
                const label = value.attr.kind === 'type' && element === 'nodes' ? registry.get(key).label : value.attr.kind === 'metric' && value.attr.key === 'community' ? `Community ${key}` : key
                return (
                  <li key={key}>
                    {isColor ? (
                      <ColorSwatch
                        value={(value as ColorChannel & { mode: 'partition' }).colors?.[key]}
                        fallback={categoricalColor((value as ColorChannel & { mode: 'partition' }).palette, i)}
                        onChange={(c) => {
                          const colors = { ...((value as ColorChannel & { mode: 'partition' }).colors ?? {}) }
                          if (c) colors[key] = c
                          else delete colors[key]
                          onChange({ ...value, colors } as Channel)
                        }}
                        title="Click to override this group's colour; right-click to reset"
                      />
                    ) : (
                      <Select
                        className="gx-select gx-select--sm"
                        value={(value as ShapeChannel & { mode: 'partition' }).shapes?.[key] ?? NODE_SHAPES[i % NODE_SHAPES.length].id}
                        onChange={(e) => onChange({ ...value, shapes: { ...((value as ShapeChannel & { mode: 'partition' }).shapes ?? {}), [key]: e.target.value as NodeShape } } as Channel)}
                      >
                        {NODE_SHAPES.map((s) => (
                          <option key={s.id} value={s.id}>
                            {shapeGlyph(s.id)}
                          </option>
                        ))}
                      </Select>
                    )}
                    <span className="gx-ap__cat" title={key}>
                      {label}
                    </span>
                    <span className="count">{cats.counts.get(key)}</span>
                  </li>
                )
              })}
              {cats.overflow > 0 && (
                <li>
                  <span className="gx-dot" style={{ background: '#c9c6bf' }} />
                  <span className="gx-ap__cat faint">other</span>
                  <span className="count">{cats.overflow}</span>
                </li>
              )}
              {cats.keys.length === 0 && <li className="faint">No values in scope.</li>}
            </ul>
          )}
        </>
      )}
    </div>
  )
}

function AttrPicker({ element, mode, attr, fields, computedMetrics, onChange }: { element: Element; mode: 'ranking' | 'partition'; attr: Attr; fields: { key: string; numeric: boolean }[]; computedMetrics: Set<NodeMetricId>; onChange: (a: Attr) => void }) {
  const tagStore = useEntityStore()
  const tagPrefixes = useMemo(() => {
    const counts = new Map<string, number>()
    for (const t of tagStore.tags()) {
      const i = t.indexOf(':')
      if (i > 0) counts.set(t.slice(0, i), (counts.get(t.slice(0, i)) ?? 0) + 1)
    }
    return [...counts].filter(([, n]) => n >= 2).map(([p]) => p).sort()
  }, [tagStore])
  const wantCategorical = mode === 'partition'
  const key = attrKey(attr)
  const options: { value: string; label: string; attr: Attr; disabled?: boolean; group: string }[] = []
  if (element === 'nodes') {
    if (!wantCategorical) {
      options.push({ value: 'degree:both', label: 'Degree', attr: { kind: 'degree' }, group: 'Structure' })
      options.push({ value: 'degree:in', label: 'In-degree', attr: { kind: 'degree', dir: 'in' }, group: 'Structure' })
      options.push({ value: 'degree:out', label: 'Out-degree', attr: { kind: 'degree', dir: 'out' }, group: 'Structure' })
    }
    for (const m of METRICS) {
      if (m.id === 'degree' || m.id === 'inDegree' || m.id === 'outDegree') continue
      if (!!m.categorical !== wantCategorical) continue
      options.push({ value: `metric:${m.id}`, label: computedMetrics.has(m.id) ? m.label : `${m.label} (run Stats)`, attr: { kind: 'metric', key: m.id }, disabled: !computedMetrics.has(m.id), group: 'Metrics' })
    }
  }
  if (wantCategorical) {
    options.push({ value: 'type', label: element === 'nodes' ? 'Type' : 'Relationship type', attr: { kind: 'type' }, group: 'Categories' })
    options.push({ value: 'tag:', label: 'First tag', attr: { kind: 'tag' }, group: 'Categories' })
    // Every tag namespace in use (tier:app, tier:platform → "Tag · tier") is a ready grouping, like a type.
    for (const p of tagPrefixes) options.push({ value: `tag:${p}`, label: `Tag · ${p}`, attr: { kind: 'tag', prefix: p }, group: 'Categories' })
    if (element === 'edges') options.push({ value: 'directed', label: 'Directed / undirected', attr: { kind: 'directed' }, group: 'Categories' })
  }
  for (const f of fields) if (wantCategorical || f.numeric) options.push({ value: `field:${f.key}`, label: `data.${f.key}`, attr: { kind: 'field', key: f.key }, group: 'Data fields' })
  // A dataset keyed by entity id or type lends its columns: numbers to rank by, the rest to group by.
  if (element === 'nodes')
    for (const d of datasetsIn(tagStore)) {
      const k = keyColumnOf(d.data)
      if (!k || k.match === 'any') continue
      d.data.columns.forEach((c, i) => {
        if (i === k.index || ((c.kind ?? inferColumnKind(d.data, i)) === 'number') === wantCategorical) return
        const ref = datasetRef(d.id, c.key)
        options.push({ value: `value:${ref}`, label: `${columnLabel(c)} · ${d.label || 'dataset'}${k.match === 'type' ? ' (by type)' : ''}`, attr: { kind: 'value', ref }, group: 'From datasets' })
      })
    }
  if (!options.some((o) => o.value === key)) options.push({ value: key, label: attrLabel(attr), attr, group: 'Current' })
  const groups = [...new Set(options.map((o) => o.group))]
  return (
    <label className="gx-row">
      <span>{mode === 'ranking' ? 'Rank by' : 'Group by'}</span>
      <Select className="gx-select" value={key} onChange={(e) => onChange(options.find((o) => o.value === e.target.value)!.attr)}>
        {groups.map((g) => (
          <optgroup key={g} label={g}>
            {options
              .filter((o) => o.group === g)
              .map((o) => (
                <option key={o.value} value={o.value} disabled={o.disabled}>
                  {o.label}
                </option>
              ))}
          </optgroup>
        ))}
      </Select>
      {attr.kind === 'field' && (
        <input className="input" style={{ width: 90, height: 26 }} value={attr.key} placeholder="field or a.b.c" onChange={(e) => onChange({ kind: 'field', key: e.target.value })} title="Data key, or a dotted path" />
      )}
      {attr.kind === 'tag' && <input className="input" style={{ width: 90, height: 26 }} value={attr.prefix ?? ''} placeholder="prefix (optional)" onChange={(e) => onChange({ kind: 'tag', ...(e.target.value ? { prefix: e.target.value } : {}) })} title="Only tags starting with this; blank = the first tag" />}
    </label>
  )
}

function NumberRow({ label, channel, value, onChange }: { label: string; channel: ChannelId; value: number; onChange: (v: number) => void }) {
  const [lo, hi, step] = RANGE[channel] ?? [0, 1, 0.05, 1]
  return (
    <label className="gx-row">
      <span>{label}</span>
      <input type="range" min={lo} max={hi} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
      <input className="gx-num" type="number" min={lo} max={hi} step={step} value={Number(value.toFixed(2))} onChange={(e) => onChange(Math.max(lo, Math.min(hi, Number(e.target.value) || lo)))} />
    </label>
  )
}

function RangeRows({ channel, min, max, onChange }: { channel: ChannelId; min: number; max: number; onChange: (min: number, max: number) => void }) {
  const [lo, hi, step] = RANGE[channel] ?? [0, 1, 0.05, 1]
  return (
    <>
      <label className="gx-row">
        <span>Range</span>
        <input type="range" min={lo} max={hi} step={step} value={min} onChange={(e) => onChange(Math.min(Number(e.target.value), max), max)} />
        <input type="range" min={lo} max={hi} step={step} value={max} onChange={(e) => onChange(min, Math.max(Number(e.target.value), min))} />
      </label>
      <label className="gx-row">
        <span />
        <input className="gx-num" type="number" min={lo} max={hi} step={step} value={min} onChange={(e) => onChange(Math.min(Number(e.target.value) || lo, max), max)} />
        <span className="faint">→</span>
        <input className="gx-num" type="number" min={lo} max={hi} step={step} value={max} onChange={(e) => onChange(min, Math.max(Number(e.target.value) || lo, min))} />
        <span className="faint">{channel === 'opacity' ? 'alpha' : 'px'}</span>
      </label>
    </>
  )
}

function PaletteRow({ value, kinds, onChange }: { value: PaletteId; kinds: ('sequential' | 'diverging' | 'categorical')[]; onChange: (id: PaletteId) => void }) {
  const options = PALETTES.filter((p) => kinds.includes(p.kind))
  return (
    <label className="gx-row">
      <span>Palette</span>
      <span className="gx-palette__strip" style={{ background: paletteGradient(value) }} />
      <Select className="gx-select" value={value} onChange={(e) => onChange(e.target.value as PaletteId)}>
        {kinds.length > 1
          ? kinds.map((k) => (
              <optgroup key={k} label={k[0].toUpperCase() + k.slice(1)}>
                {options
                  .filter((p) => p.kind === k)
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                    </option>
                  ))}
              </optgroup>
            ))
          : options.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
      </Select>
    </label>
  )
}

// ── Small pieces ───────────────────────────────────────────────────────

function countKeys(keys: string[], rules: Record<string, unknown>): [string, number][] {
  const m = new Map<string, number>()
  for (const k of keys) m.set(k, (m.get(k) ?? 0) + 1)
  for (const k of Object.keys(rules)) if (!m.has(k)) m.set(k, 0)
  return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
}

function sampleFields(items: AnyEntity[]): { key: string; numeric: boolean }[] {
  const seen = new Map<string, { n: number; numeric: number }>()
  for (const e of items.slice(0, 2000)) {
    for (const [k, v] of Object.entries(e.data)) {
      if (typeof v !== 'number' && typeof v !== 'string' && typeof v !== 'boolean') continue
      const s = seen.get(k) ?? { n: 0, numeric: 0 }
      s.n++
      if (typeof v === 'number') s.numeric++
      seen.set(k, s)
    }
  }
  return [...seen.entries()].sort((a, b) => b[1].n - a[1].n).map(([key, s]) => ({ key, numeric: s.numeric > 0 && s.numeric >= s.n * 0.8 }))
}

function parseScope(v: string): Scope {
  if (v === 'all') return { by: 'all' }
  const i = v.indexOf(':')
  return { by: v.slice(0, i) as 'types' | 'tags', key: v.slice(i + 1) }
}

const channelLabel = (c: ChannelId) => (c === 'color' ? 'Colour' : c === 'size' ? 'Size' : c === 'opacity' ? 'Opacity' : c === 'shape' ? 'Shape' : 'Width')
const shapeGlyph = (s: NodeShape) => (s === 'circle' ? '●' : s === 'square' ? '■' : s === 'diamond' ? '◆' : '▲')

function summarize(ch: Channel | undefined): string {
  if (!ch) return ''
  if (ch.mode === 'constant') {
    const v = (ch as { value?: unknown }).value
    return v === undefined ? 'automatic' : typeof v === 'number' ? String(v) : String(v)
  }
  if (ch.mode === 'ranking') return `ranking by ${attrLabel(ch.attr)}${'min' in ch ? ` (${ch.min}–${ch.max})` : ` (${(ch as { palette: string }).palette})`}${ch.log ? ', log' : ''}`
  return `partition by ${attrLabel(ch.attr)}${'palette' in ch ? ` (${ch.palette})` : ''}`
}

function ColorSwatch({ value, fallback, onChange, title }: { value?: string; fallback: string; onChange: (c: string | undefined) => void; title?: string }) {
  const hex = toHex(value ?? fallback)
  return (
    <label className={`gx-swatch ${value ? 'is-set' : ''}`} title={title ?? (value ? `${value} (click to change, right-click to reset)` : 'auto — click to set')} onContextMenu={(e) => (e.preventDefault(), onChange(undefined))}>
      <span style={{ background: value ?? fallback }} />
      <input type="color" value={hex} onChange={(e) => onChange(e.target.value)} />
    </label>
  )
}



function ShapeSelect({ value, inherit, onChange }: { value: NodeShape; inherit?: boolean; onChange: (v: NodeShape) => void }) {
  return (
    <Select className={`gx-select gx-select--sm ${inherit ? 'is-inherit' : ''}`} value={value} onChange={(e) => onChange(e.target.value as NodeShape)} title="Shape">
      {NODE_SHAPES.map((s) => (
        <option key={s.id} value={s.id}>
          {shapeGlyph(s.id)}
        </option>
      ))}
    </Select>
  )
}

function toHex(c: string): string {
  if (/^#[0-9a-f]{6}$/i.test(c)) return c
  if (/^#[0-9a-f]{3}$/i.test(c)) return '#' + c[1] + c[1] + c[2] + c[2] + c[3] + c[3]
  try {
    const ctx = document.createElement('canvas').getContext('2d')
    if (ctx) {
      ctx.fillStyle = c
      const v = ctx.fillStyle
      if (/^#[0-9a-f]{6}$/i.test(v)) return v
    }
  } catch {
    /* ignore */
  }
  return '#888888'
}
