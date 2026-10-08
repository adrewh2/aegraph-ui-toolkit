import { X } from 'lucide-react'
import { useMemo } from 'react'
import { useEntityStore, useStoreVersion } from '../../core/entity/hooks'
import { MISSING_COLOR, paletteGradient } from '../../core/graph/palettes'
import { attrKey, attrLabel, type Attr, type ColorChannel, type NodeAppearance } from '../../core/graph/rendering'
import { useExplorer } from './explorerState'
import { Select } from '../../components/ui/Select'

const fmt = (v: number) => (Math.abs(v) >= 1000 ? v.toLocaleString(undefined, { maximumFractionDigits: 0 }) : Number.isInteger(v) ? String(v) : v.toPrecision(3))

/** What the node colours mean: a gradient bar for numeric mappings, swatches for categories/types. */
export function Legend() {
  const { state, dispatch, styles, metricsStale, slice } = useExplorer()
  const store = useEntityStore()
  useStoreVersion(store)
  const legend = styles.legend
  const cb = state.rendering.nodes.default.color
  // What the legend can switch the colouring to, right here: type, each tag namespace on the nodes in view, the first
  // tag — or keep whatever else it is. The view's nodes, not the project's tags: counting a million-entity project's
  // tags to offer a menu over a few thousand nodes was half a second of the first picture.
  const choices = useMemo(() => {
    const seen = new Set<string>()
    for (const n of slice.nodes) for (const t of n.tags) seen.add(t)
    const prefixes = new Map<string, number>()
    for (const t of seen) {
      const i = t.indexOf(':')
      if (i > 0) prefixes.set(t.slice(0, i), (prefixes.get(t.slice(0, i)) ?? 0) + 1)
    }
    const out: { key: string; label: string; attr: Attr }[] = [{ key: 'type', label: 'Type', attr: { kind: 'type' } }]
    for (const [p] of [...prefixes].filter(([, n]) => n >= 2).sort()) out.push({ key: `tag:${p}`, label: `Tag · ${p}`, attr: { kind: 'tag', prefix: p } })
    out.push({ key: 'tag:', label: 'First tag', attr: { kind: 'tag' } })
    return out
  }, [slice])
  if (!state.showLegend || !legend) return null
  const stale = metricsStale && cb.mode !== 'constant' && cb.attr.kind === 'metric'
  const currentKey = cb.mode === 'partition' ? attrKey(cb.attr) : cb.mode === 'constant' ? 'type' : `other:${attrKey(cb.attr)}`
  const known = choices.some((c) => c.key === currentKey)
  /**
   * Colour everything by the choice. Per-type and per-tag appearances keep their size, shape and the rest but lose
   * their own colour, which would otherwise win over the default channel and leave the switch without effect; a
   * type's fixed colour survives as that type's swatch when colouring by type.
   */
  // A type or tag legend doubles as a visibility switch: clicking an item hides or shows its nodes through the same
  // per-type / per-tag rule the Style tab edits (its eye button), so the two always agree.
  const ruleBy: 'types' | 'tags' | undefined = cb.mode === 'partition' && cb.attr.kind === 'type' ? 'types' : cb.mode === 'partition' && cb.attr.kind === 'tag' ? 'tags' : cb.mode === 'constant' ? 'types' : undefined
  const hiddenKey = (key: string) => (ruleBy ? state.rendering.nodes[ruleBy][key]?.visible === false : false)
  const toggleKey = (key: string) => {
    if (!ruleBy) return
    dispatch({ type: 'setRule', scope: 'nodes', by: ruleBy, key, patch: { visible: hiddenKey(key) ? undefined : false } })
  }
  // Double-click: only this row — every other row in the legend hidden; again on the sole visible row: all shown.
  // The first click of the pair has already toggled the row, so "was visible before" reads as hidden now.
  const soloKey = (key: string) => {
    if (!ruleBy || !legend || legend.kind !== 'categories') return
    const others = legend.items.map((it) => it.key).filter((k) => k !== key)
    const wasSolo = hiddenKey(key) && others.every(hiddenKey)
    for (const k of others) dispatch({ type: 'setRule', scope: 'nodes', by: ruleBy, key: k, patch: { visible: wasSolo ? undefined : false } })
    dispatch({ type: 'setRule', scope: 'nodes', by: ruleBy, key, patch: { visible: undefined } })
  }
  const colorBy = (key: string) => {
    const c = choices.find((x) => x.key === key)
    if (!c) return
    const { nodes } = state.rendering
    const strip = (m: Record<string, NodeAppearance>) => Object.fromEntries(Object.entries(m).map(([k, { color: _c, ...rest }]) => [k, rest]))
    const typeColors: Record<string, string> = { ...(cb.mode === 'partition' && cb.attr.kind === 'type' ? cb.colors : {}) }
    for (const [t, a] of Object.entries(nodes.types)) if (a.color?.mode === 'constant' && a.color.value) typeColors[t] = a.color.value
    const next: ColorChannel = { mode: 'partition', attr: c.attr, palette: cb.mode === 'partition' ? cb.palette : 'tableau10', ...(c.attr.kind === 'type' && Object.keys(typeColors).length ? { colors: typeColors } : {}) }
    dispatch({ type: 'patchRendering', patch: { nodes: { ...nodes, default: { ...nodes.default, color: next }, types: strip(nodes.types), tags: strip(nodes.tags) } } })
  }
  return (
    <div className="gx-legend" role="note">
      <div className="gx-legend__head">
        {legend.scripted ? (
          <span className="gx-legend__by gx-legend__title" title="What the script's colours mean">
            {legend.title}
          </span>
        ) : (
          <Select className="gx-select gx-legend__by" value={currentKey} title="Colour and legend by type, or by a tag namespace" onChange={(e) => colorBy(e.target.value)}>
            {!known && <option value={currentKey}>{cb.mode === 'constant' ? 'Type' : attrLabel(cb.attr)}</option>}
            {choices.map((c) => (
              <option key={c.key} value={c.key}>
                {c.label}
              </option>
            ))}
          </Select>
        )}
        {stale && (
          <span className="badge badge--warn" title="Metrics were computed for a different view; re-run Stats">
            stale
          </span>
        )}
        <button className="gx-chip-x" onClick={() => dispatch({ type: 'setLegend', on: false })} aria-label="Hide legend">
          <X size={11} />
        </button>
      </div>
      {legend.kind === 'gradient' ? (
        <>
          <div className="gx-legend__bar" style={{ background: paletteGradient(legend.palette) }} />
          <div className="gx-legend__ends">
            <span>{fmt(legend.domain[0])}</span>
            {legend.log && <span className="faint">log</span>}
            <span>{fmt(legend.domain[1])}</span>
          </div>
        </>
      ) : (
        <ul className="gx-legend__items thin-scroll">
          {legend.items.length === 0 && <li className="gx-legend__none">Nothing in view has a {legend.title.toLowerCase()}</li>}
          {legend.items.map((it) => {
            const off = hiddenKey(it.key)
            return (
              <li key={it.key} className={`${ruleBy ? 'gx-legend__item--switch' : ''} ${off ? 'is-off' : ''}`} title={ruleBy ? `${it.count} nodes · click to ${off ? 'show' : 'hide'} them · double-click for only these (the Style tab's eye)` : `${it.count} nodes`} onClick={ruleBy ? (e) => (e.detail >= 2 ? soloKey(it.key) : toggleKey(it.key)) : undefined} role={ruleBy ? 'switch' : undefined} aria-checked={ruleBy ? !off : undefined}>
                <span className="gx-dot" style={{ background: it.color }} />
                <span className="gx-legend__label">{it.label}</span>
                {!legend.scripted && <span className="count">{it.count}</span>}
              </li>
            )
          })}
          {legend.overflow > 0 && (
            <li title="More values than the legend lists; they are still drawn, in their colours">
              <span className="gx-dot" style={{ background: legend.palette ? paletteGradient(legend.palette) : MISSING_COLOR }} />
              <span className="gx-legend__label faint">{legend.more} more</span>
              <span className="count">{legend.overflow}</span>
            </li>
          )}
          {legend.missing > 0 && legend.items.length > 0 && (
            <li title="Nodes with no value to colour by">
              <span className="gx-dot" style={{ background: MISSING_COLOR }} />
              <span className="gx-legend__label faint">none</span>
              <span className="count">{legend.missing}</span>
            </li>
          )}
        </ul>
      )}
      {legend.kind === 'categories' && legend.repeatsFrom !== undefined && (
        <div className="gx-legend__note faint" title="The palette has this many colours; values past them share one">Colours repeat after the first {legend.repeatsFrom}</div>
      )}
    </div>
  )
}
