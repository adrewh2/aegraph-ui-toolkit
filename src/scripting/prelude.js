/* eslint-disable no-unused-vars -- these are the globals scripts call */
// The standard library inside the sandbox. Plain ES2020, no host access:
// everything a script can reach is `ds` (the dataset snapshot the host
// loaded) and what is defined here. Keep it small and obvious; the docs
// page mirrors this file.

// ── Dataset access ──────────────────────────────────────────────────
;(function () {
  // The indexes are built the first time something asks for one, not while the dataset is loading: a script that
  // rolls a type up never looks an id up, and one that walks relationships never asks what types there are. On a
  // project of a hundred thousand entities each of these is a second of the load that used to happen either way.
  let _byId, _outs, _ins, _byType
  const byId = () => {
    if (!_byId) {
      _byId = new Map()
      for (const e of ds.entities) _byId.set(e.id, e)
    }
    return _byId
  }
  const links = () => {
    if (!_outs) {
      _outs = new Map()
      _ins = new Map()
      for (const r of ds.relationships) {
        const o = _outs.get(r.source)
        if (o) o.push(r)
        else _outs.set(r.source, [r])
        const i = _ins.get(r.target)
        if (i) i.push(r)
        else _ins.set(r.target, [r])
      }
    }
  }
  const outs = { get: (id) => (links(), _outs.get(id)) }
  const ins = { get: (id) => (links(), _ins.get(id)) }
  const byType = () => {
    if (!_byType) {
      _byType = new Map()
      for (const e of ds.entities) {
        const g = _byType.get(e.type)
        if (g) g.push(e)
        else _byType.set(e.type, [e])
      }
    }
    return _byType
  }
  ds.get = (id) => byId().get(id)
  ds.byType = (...types) => types.flatMap((t) => byType().get(t) ?? [])
  ds.types = () => [...byType().keys()]
  ds.tagged = (tag) => ds.entities.filter((e) => e.tags.includes(tag))
  ds.where = (fn) => ds.entities.filter(fn)
  const NONE = Object.freeze([])
  /**
   * Outgoing relationships of an entity, optionally of one type. Without a type this is the list itself, not a
   * copy: a filter that only ever returns everything cost an array per call, and `min_degree` over a dataset
   * makes two of those per entity. Treat what comes back as read-only.
   */
  ds.out = (id, type) => (type === undefined ? (outs.get(id) ?? NONE) : (outs.get(id) ?? NONE).filter((r) => r.type === type))
  ds.in = (id, type) => (type === undefined ? (ins.get(id) ?? NONE) : (ins.get(id) ?? NONE).filter((r) => r.type === type))
  /** Neighbouring entities (both directions), optionally via one relationship type. */
  ds.neighbors = (id, type) => {
    const m = byId()
    return [...ds.out(id, type).map((r) => m.get(r.target)), ...ds.in(id, type).map((r) => m.get(r.source))].filter(Boolean)
  }
  /** How many relationships touch an entity. Counted, not collected: no array is made to be measured and thrown away. */
  ds.degree = (id, type) => {
    if (type === undefined) return (outs.get(id)?.length ?? 0) + (ins.get(id)?.length ?? 0)
    let n = 0
    for (const r of outs.get(id) ?? NONE) if (r.type === type) n++
    for (const r of ins.get(id) ?? NONE) if (r.type === type) n++
    return n
  }
  /** A metric column from the latest analysis run (pagerank, betweenness, community, …), or undefined. */
  ds.metric = (name, id) => ds.metrics?.[name]?.[id]
  ds.metricNames = () => Object.keys(ds.metrics ?? {})
  ds.count = () => ds.entities.length

  // ── The project state: the project, the ontology, the tags ──────────
  ds.ontology ??= []
  ds.project ??= null
  const byName = new Map(ds.ontology.map((t) => [t.type, t]))
  /** A type's definition from the ontology: label, category, parent, description, declared properties, count. */
  ds.type = (name) => byName.get(name)
  /** The property keys entities of a type carry — declared on the type, or seen in the data — with kind, coverage and a sample. */
  ds.properties = (type) => {
    const rows = byType().get(type) ?? []
    const seen = new Map()
    for (const e of rows) for (const k in e.data) {
      const v = e.data[k]
      if (v === undefined || v === null) continue
      const cur = seen.get(k) ?? { key: k, kind: Array.isArray(v) ? 'array' : typeof v, count: 0, sample: v }
      cur.count++
      seen.set(k, cur)
    }
    for (const p of byName.get(type)?.properties ?? []) if (!seen.has(p.key)) seen.set(p.key, { key: p.key, kind: p.kind ?? 'unknown', count: 0, declared: true })
    for (const p of byName.get(type)?.properties ?? []) Object.assign(seen.get(p.key), { declared: true, ...(p.label ? { label: p.label } : {}), ...(p.description ? { description: p.description } : {}), ...(p.kind ? { kind: p.kind } : {}) })
    return [...seen.values()].map((p) => ({ ...p, coverage: rows.length ? p.count / rows.length : 0 })).sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
  }
  // Frozen here: once ds.tags is a function the snapshot's freeze no longer reaches the rows, and a script could change them for the next.
  const tagRows = Object.freeze((ds.tags ?? []).map((t) => Object.freeze({ ...t })))
  /** The tags in use: [{ tag, count, color?, description? }], most used first. */
  ds.tags = () => tagRows
  /** A plain summary of everything a script can reach — log(ds.describe()) to see the whole state. */
  ds.describe = () => ({
    scope: ds.scope,
    project: ds.project,
    entities: ds.entities.length,
    relationships: ds.relationships.length,
    types: ds.types().map((t) => ({ type: t, count: byType().get(t).length, properties: ds.properties(t).map((p) => `${p.key}:${p.kind}`) })),
    relationshipTypes: [...new Set(ds.relationships.map((r) => r.type))].map((t) => {
      const rs = ds.relationships.filter((r) => r.type === t)
      const ids = byId()
      const pairs = new Set(rs.map((r) => `${ids.get(r.source)?.type ?? '?'} → ${ids.get(r.target)?.type ?? '?'}`))
      return { type: t, count: rs.length, joins: [...pairs] }
    }),
    tags: tagRows.map((t) => `${t.tag} (${t.count})`),
    metrics: ds.metricNames(),
  })
})()

// ── Time ────────────────────────────────────────────────────────────
const DAY = 86400000
/** Parse anything date-like to epoch ms (NaN when it is not a date). */
function ms(v) {
  if (v instanceof Date) return v.getTime()
  if (typeof v === 'number') return v > 1e11 ? v : v > 1e8 ? v * 1000 : NaN
  if (typeof v === 'string') return Date.parse(v.length === 7 ? v + '-01' : v)
  return NaN
}
/** Floor a date to a unit (hour, day, week [Monday], month, quarter, year); returns an ISO string, or undefined for non-dates. */
function bin(v, unit = 'month') {
  const t = ms(v)
  if (!Number.isFinite(t)) return undefined
  const d = new Date(t)
  const y = d.getUTCFullYear()
  const m = d.getUTCMonth()
  switch (unit) {
    case 'hour':
      return new Date(Math.floor(t / 3600000) * 3600000).toISOString()
    case 'day':
      return new Date(Date.UTC(y, m, d.getUTCDate())).toISOString()
    case 'week': {
      const day = Date.UTC(y, m, d.getUTCDate())
      return new Date(day - ((d.getUTCDay() + 6) % 7) * DAY).toISOString()
    }
    case 'month':
      return new Date(Date.UTC(y, m, 1)).toISOString()
    case 'quarter':
      return new Date(Date.UTC(y, Math.floor(m / 3) * 3, 1)).toISOString()
    case 'year':
      return new Date(Date.UTC(y, 0, 1)).toISOString()
    default:
      throw new Error(`bin: unknown unit ${unit}`)
  }
}
const daysBetween = (a, b) => (ms(b) - ms(a)) / DAY
const hoursBetween = (a, b) => (ms(b) - ms(a)) / 3600000
const isoDate = (v) => new Date(ms(v)).toISOString().slice(0, 10)

// ── Collections and statistics ──────────────────────────────────────
const keyOf = (key) => (typeof key === 'function' ? key : (x) => x?.[key])
/** Group items into a Map by a key (a field name or a function). */
function groupBy(items, key) {
  const f = keyOf(key)
  const m = new Map()
  for (const it of items) {
    const k = f(it)
    if (!m.has(k)) m.set(k, [])
    m.get(k).push(it)
  }
  return m
}
const sum = (xs) => xs.reduce((s, x) => s + (Number.isFinite(x) ? x : 0), 0)
const count = (xs) => xs.length
const mean = (xs) => (xs.length ? sum(xs) / xs.length : NaN)
function quantile(xs, p) {
  const v = xs.filter(Number.isFinite).sort((a, b) => a - b)
  if (!v.length) return NaN
  const i = (v.length - 1) * p
  const lo = Math.floor(i)
  return v[lo] + (v[Math.min(lo + 1, v.length - 1)] - v[lo]) * (i - lo)
}
const median = (xs) => quantile(xs, 0.5)
const min = (xs) => Math.min(...xs.filter(Number.isFinite))
const max = (xs) => Math.max(...xs.filter(Number.isFinite))
const distinct = (xs) => new Set(xs).size
const AGG = { count, sum, mean, median, min, max, distinct }
/**
 * Fold items by key: rollup(items, key, value?, agg = 'count') → [{ key, value, n, items }] sorted by key.
 * `value` picks the number to aggregate (field name or function); with agg 'count' it can be omitted.
 */
function rollup(items, key, value, agg = 'count') {
  const f = typeof agg === 'function' ? agg : AGG[agg]
  if (!f) throw new Error(`rollup: unknown agg ${agg}`)
  const v = value === undefined ? () => 1 : keyOf(value)
  const out = []
  for (const [k, list] of groupBy(items, key)) out.push({ key: k, value: f(list.map(v)), n: list.length, items: list })
  return out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
}
/** Sort a copy by a key (field or function); desc for largest first. */
function sortBy(items, key, desc = false) {
  const f = keyOf(key)
  return [...items].sort((a, b) => {
    const x = f(a)
    const y = f(b)
    return (x < y ? -1 : x > y ? 1 : 0) * (desc ? -1 : 1)
  })
}
const topK = (items, key, k = 10) => sortBy(items, key, true).slice(0, k)
/** Trailing window average over a numeric series. */
function rolling(xs, n = 4) {
  const out = []
  for (let i = 0; i < xs.length; i++) {
    const w = xs.slice(Math.max(0, i - n + 1), i + 1).filter(Number.isFinite)
    out.push(w.length ? sum(w) / w.length : NaN)
  }
  return out
}
function range(a, b, step = 1) {
  const out = []
  for (let x = a; x < b; x += step) out.push(x)
  return out
}
/** Pearson correlation of two equal-length numeric series. */
function correlation(xs, ys) {
  const n = Math.min(xs.length, ys.length)
  const mx = mean(xs.slice(0, n))
  const my = mean(ys.slice(0, n))
  let sxy = 0
  let sxx = 0
  let syy = 0
  for (let i = 0; i < n; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my)
    sxx += (xs[i] - mx) ** 2
    syy += (ys[i] - my) ** 2
  }
  return sxx && syy ? sxy / Math.sqrt(sxx * syy) : NaN
}

// ── The chart tool's conventions ───────────────────────────────────
// A chart exported from Charts uses these, so it draws the same picture: the same reading of a value
// (a date by name or shape → epoch ms, a numeric string → a number), the same bins, the same series order and
// colours, the same marker sizes. Mirrors src/core/graph/plot.ts; change both together.
/** The series colours, in order. */
const PLOT_COLORS = ['#0f766e', '#2563eb', '#ea580c', '#9333ea', '#e11d48', '#ca8a04', '#0891b2', '#65a30d', '#7c3aed', '#db2777', '#475569', '#b45309']
const plotColor = (i) => PLOT_COLORS[i % PLOT_COLORS.length]
/** A raw value as an axis reads it: { v, temporal } — temporal when the ref looks like a date (createdAt, *_ts, …) or the value does. */
function axisValue(raw, ref = '') {
  if (raw === undefined || raw === null || raw === '') return { v: undefined, temporal: false }
  const dated = /^meta\./.test(ref) || /(created|updated|ended|_ts|timestamp|date|time|At$|_at$)/i.test(ref) || (typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}/.test(raw))
  if (dated) {
    const t = typeof raw === 'number' && Number.isFinite(raw) ? (raw > 1e11 ? raw : raw > 1e8 ? raw * 1000 : undefined) : typeof raw === 'string' && /^\d{4}-\d{2}/.test(raw) ? ms(raw) : undefined
    if (t !== undefined && Number.isFinite(t)) return { v: t, temporal: true }
  }
  if (typeof raw === 'number') return { v: raw, temporal: false }
  const n = Number(raw)
  if (typeof raw === 'string' && raw.trim() !== '' && Number.isFinite(n)) return { v: n, temporal: false }
  return { v: String(raw), temporal: false }
}
/** Snap an axis value into its bin: a time unit for dates (epoch ms of the unit's start), a width for numbers; a unit on anything else leaves it as is, a width on a non-number is undefined (nothing to bin — the row is skipped, as the plot tool does). */
function binAxis(a, unit) {
  if (unit === undefined) return a.v
  if (typeof unit === 'string') return a.temporal && typeof a.v === 'number' ? ms(bin(a.v, unit)) : a.v
  if (typeof a.v !== 'number') return undefined
  return unit > 0 ? Math.floor(a.v / unit) * unit : a.v
}
/** Axis values back to what Plotly draws: dates as ISO strings. */
const axisOut = (v, temporal) => (temporal && typeof v === 'number' ? new Date(v).toISOString() : v)
/** Numbers by size, everything else by text. */
const sortScalars = (a, b) => (typeof a === 'number' && typeof b === 'number' ? a - b : String(a).localeCompare(String(b)))
/** Rows split into series by a key, largest first, folded into “other” past 24; undefined keys read “(none)”. */
function seriesOf(rows, key, limit = 24) {
  if (!key) return new Map([[undefined, rows]])
  const groups = new Map()
  for (const e of rows) {
    const v = keyOf(key)(e)
    const k = v === undefined ? '(none)' : String(v)
    if (!groups.has(k)) groups.set(k, [])
    groups.get(k).push(e)
  }
  const sorted = [...groups.entries()].sort((a, b) => b[1].length - a[1].length)
  if (sorted.length <= limit) return new Map(sorted)
  const keep = new Map(sorted.slice(0, limit - 1))
  keep.set('other', sorted.slice(limit - 1).flatMap((e) => e[1]))
  return keep
}
/** Marker diameters 6–24 px over the values' range (8 when there is no range or the value is missing). */
function markerSizes(values) {
  const finite = values.filter((v) => Number.isFinite(v))
  const lo = Math.min(...finite)
  const hi = Math.max(...finite)
  return values.map((v) => (Number.isFinite(v) && hi > lo ? 6 + 18 * ((v - lo) / (hi - lo)) : 8))
}
/** The aggregates the plot tool offers, over numbers. */
const aggregate = (values, agg) => (agg === 'count' ? values.length : !values.length ? NaN : agg === 'sum' ? sum(values) : agg === 'mean' ? mean(values) : agg === 'median' ? median(values) : agg === 'min' ? min(values) : agg === 'max' ? max(values) : agg === 'distinct' ? distinct(values) : NaN)

// ── Output builders ─────────────────────────────────────────────────
/** Plotly traces. `opts` is merged into the trace (name, marker, line, text, …). */
const line = (x, y, opts = {}) => ({ type: 'scatter', mode: 'lines', x, y, ...opts })
const scatter = (x, y, opts = {}) => ({ type: 'scatter', mode: 'markers', x, y, ...opts })
const bar = (x, y, opts = {}) => ({ type: 'bar', x, y, ...opts })
const area = (x, y, opts = {}) => ({ type: 'scatter', mode: 'lines', fill: 'tozeroy', x, y, ...opts })
const box = (y, opts = {}) => ({ type: 'box', y, ...opts })
const histogram = (x, opts = {}) => ({ type: 'histogram', x, ...opts })
const heatmap = (x, y, z, opts = {}) => ({ type: 'heatmap', x, y, z, ...opts })
const pie = (labels, values, opts = {}) => ({ type: 'pie', labels, values, ...opts })
/** A figure: `figure(traces, layout)` → what the host draws. `layout` takes any Plotly layout key (title, barmode, xaxis, yaxis, …). */
const figure = (traces, layout = {}) => ({ plot: { data: Array.isArray(traces) ? traces : [traces], layout: typeof layout === 'string' ? { title: layout } : layout } })
/** A table from row objects (columns from the keys) or from arrays with explicit columns. */
const table = (rows, columns) => ({ table: { columns: columns ?? (rows[0] && !Array.isArray(rows[0]) ? Object.keys(rows[0]) : []), rows: rows.map((r) => (Array.isArray(r) ? r : (columns ?? Object.keys(rows[0])).map((c) => r[c]))) } })
/** A scene for the Scenes page: positions per entity id ({ x, y }, optional width/height), optional groups { name: { title, members } }. */
const scene = (positions, opts = {}) => ({ scene: { positions, ...opts } })
// Replaced by the host at the start of every run, so nothing one run does to it is seen by the next.
let __logs = []
const log = (...args) => {
  __logs.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a, __replacer))).join(' '))
}
function __replacer(_k, v) {
  if (v instanceof Map) return Object.fromEntries(v)
  if (v instanceof Set) return [...v]
  if (typeof v === 'number' && !Number.isFinite(v)) return null
  if (v === undefined) return null
  return v
}

// ── Collections: the chained query API ──────────────────────────────
// `entities` and `relationships` are arrays with a vocabulary, the same in
// JavaScript and Python (prelude.py): entities.types.person.filter({ min_degree: 2 })
// .neighbors('wrote').sort('label').take(10). Every step returns a new
// collection; the array itself (map, length, [i], for-of) still works.
// A filter takes a predicate or a spec; a spec's keys accept snake_case
// (as in Python) and camelCase.
const __snake = (k) => k.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase())
/** A value on a record by path: 'label', 'data.year', 'meta.source'; a function is applied. */
const pathOf = (key) => (typeof key === 'function' ? key : (x) => key.split('.').reduce((v, k) => (v === undefined || v === null ? undefined : v[k]), x))
const __asSet = (v) => (v === undefined || v === null ? null : new Set(Array.isArray(v) || v instanceof Set ? [...v] : [v]))
const __idsOf = (v) => (v === undefined || v === null ? null : typeof v === 'string' ? new Set([v]) : new Set([...v].map((x) => (typeof x === 'string' ? x : x.id))))
const __text = (e) => `${e.label ?? ''} ${e.description ?? ''}`.toLowerCase()
const __matchData = (data, spec) => Object.entries(spec).every(([k, want]) => (typeof want === 'function' ? want(data?.[k]) : Array.isArray(want) || want instanceof Set ? [...want].includes(data?.[k]) : data?.[k] === want))

class Collection extends Array {
  static get [Symbol.species]() {
    return Array
  }
  /** The member with this id (the whole dataset's collections look it up by index). */
  get(id) {
    if (this === ds.entities) return ds.get(id)
    return this.find((x) => x.id === id)
  }
  ids() {
    return this.map((x) => x.id)
  }
  labels() {
    return this.map((x) => x.label)
  }
  count() {
    return this.length
  }
  first() {
    return this[0]
  }
  last() {
    return this[this.length - 1]
  }
  take(n) {
    return this.constructor.from(Array.prototype.slice.call(this, 0, n))
  }
  skip(n) {
    return this.constructor.from(Array.prototype.slice.call(this, n))
  }
  slice(a, b) {
    return this.constructor.from(Array.prototype.slice.call(this, a, b))
  }
  sample(n = 10) {
    const out = [...this]
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[out[i], out[j]] = [out[j], out[i]]
    }
    return this.constructor.from(out.slice(0, n))
  }
  /** A predicate, or a spec: see Entities / Relationships for the keys. */
  filter(spec) {
    if (typeof spec === 'function') return this.constructor.from(Array.prototype.filter.call(this, spec))
    // A bare name is a type: entities.filter('person').
    if (typeof spec === 'string') spec = { types: spec }
    const norm = Object.fromEntries(Object.entries(spec ?? {}).map(([k, v]) => [__snake(k), v]))
    return this.constructor.from(Array.prototype.filter.call(this, this._match(norm)))
  }
  where(fn) {
    return this.filter(fn)
  }
  exclude(spec) {
    const keep = new Set(this.filter(spec).ids())
    return this.filter((x) => !keep.has(x.id))
  }
  /** A field name, a 'data.x' path, or a key function; desc for largest first. A comparator (two parameters) works as Array's. Returns a new collection. */
  sort(key = 'label', desc = false) {
    if (typeof key === 'function' && key.length >= 2) return this.constructor.from([...this].sort(key))
    const f = pathOf(key)
    const out = [...this].sort((a, b) => {
      const x = f(a)
      const y = f(b)
      if (x === y) return 0
      if (x === undefined || x === null) return 1
      if (y === undefined || y === null) return -1
      return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y))) * (desc ? -1 : 1)
    })
    return this.constructor.from(out)
  }
  top(key, n = 10) {
    return this.sort(key, true).take(n)
  }
  unique(key) {
    return [...new Set(this.map(pathOf(key)))]
  }
  pluck(key) {
    return this.map(pathOf(key))
  }
  /** { key: Collection } */
  group(key) {
    const f = pathOf(key)
    const out = {}
    for (const x of this) (out[f(x)] ??= this.constructor.from([])).push(x)
    return out
  }
  /** [{ key, value, n, items }], one per group, sorted by key; key and value are field names, 'data.x' paths or functions. */
  rollup(key, value, agg = 'count') {
    return rollup([...this], pathOf(key), value === undefined ? undefined : pathOf(value), agg).map((r) => ({ ...r, items: this.constructor.from(r.items) }))
  }
  /** The tags carried by members, most used first: [{ tag, count }]. */
  tags() {
    const m = new Map()
    for (const x of this) for (const t of x.tags ?? []) m.set(t, (m.get(t) ?? 0) + 1)
    return [...m].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count)
  }
  /** The properties members carry: [{ key, kind, count, coverage }]. */
  properties() {
    const m = new Map()
    for (const x of this)
      for (const k in x.data ?? {}) {
        const v = x.data[k]
        if (v === undefined || v === null) continue
        const cur = m.get(k) ?? { key: k, kind: Array.isArray(v) ? 'array' : typeof v, count: 0, sample: v }
        cur.count++
        m.set(k, cur)
      }
    return [...m.values()].map((p) => ({ ...p, coverage: this.length ? p.count / this.length : 0 })).sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
  }
  /** A table output: columns are field names or 'data.x' paths (default: id, type, label and every data key). */
  table(columns) {
    const cols = columns ?? ['id', 'type', 'label', ...this.properties().map((p) => `data.${p.key}`)]
    return table(
      this.map((x) => Object.fromEntries(cols.map((c) => [c, pathOf(c)(x)]))),
      cols,
    )
  }
  json() {
    return [...this]
  }
  describe() {
    return { count: this.length, types: rollup([...this], 'type').map((r) => `${r.key} (${r.value})`), tags: this.tags().map((t) => `${t.tag} (${t.count})`), properties: this.properties().map((p) => `${p.key}:${p.kind}`) }
  }
  _match() {
    return () => true
  }
}

class Entities extends Collection {
  /** entities.types.person, entities.types['schema:type'] — a plural (documents) finds the singular. */
  get types() {
    return __typesNamespace(this, 'type')
  }
  type(...names) {
    const want = new Set(names.flat())
    return this.filter((e) => want.has(e.type))
  }
  tagged(tag) {
    return this.filter((e) => e.tags.includes(tag))
  }
  /** Relationships leaving members, optionally of one type. */
  out(rel) {
    return __relsOf(this, 'out', rel)
  }
  /** Relationships arriving at members. */
  into(rel) {
    return __relsOf(this, 'in', rel)
  }
  /** Relationships touching members, either direction. */
  links(rel) {
    return __relsOf(this, 'both', rel)
  }
  /** The entities at the other end of members' relationships, deduplicated; dir: 'out' | 'in' | 'both'. */
  neighbors(rel, dir = 'both') {
    const own = new Set(this.ids())
    const seen = new Set()
    const out = []
    for (const r of __relsOf(this, dir, rel)) {
      const id = own.has(r.source) && !(dir === 'in' && own.has(r.target)) ? r.target : r.source
      if (seen.has(id)) continue
      seen.add(id)
      const e = ds.get(id)
      if (e) out.push(e)
    }
    return Entities.from(out)
  }
  /** id → degree, over the whole dataset (optionally through one relationship type). */
  degrees(rel) {
    return Object.fromEntries(this.map((e) => [e.id, ds.degree(e.id, rel)]))
  }
  /**
   * Spec keys: types / type (one, a list, a set) · tags (any of) · all_tags · text (in label or description) ·
   * has (a data key present) · data ({ key: value | [values] | fn }) · min_degree / max_degree (rel: through one
   * relationship type) · ids · created_after / created_before / updated_after / updated_before · where (fn).
   */
  _match(s) {
    const types = __asSet(s.types ?? s.type)
    const tags = __asSet(s.tags ?? s.tag)
    const all = __asSet(s.all_tags)
    const ids = __idsOf(s.ids ?? s.id)
    const text = s.text ? String(s.text).toLowerCase() : null
    const has = s.has ? [].concat(s.has) : null
    const ca = s.created_after ? ms(s.created_after) : null
    const cb = s.created_before ? ms(s.created_before) : null
    const ua = s.updated_after ? ms(s.updated_after) : null
    const ub = s.updated_before ? ms(s.updated_before) : null
    const rel = s.rel
    const minD = s.min_degree
    const maxD = s.max_degree
    return (e) => {
      if (types && !types.has(e.type)) return false
      if (ids && !ids.has(e.id)) return false
      if (tags && !e.tags.some((t) => tags.has(t))) return false
      if (all && ![...all].every((t) => e.tags.includes(t))) return false
      if (text && !__text(e).includes(text)) return false
      if (has && !has.every((k) => e.data?.[k] !== undefined && e.data[k] !== null && e.data[k] !== '')) return false
      if (s.data && !__matchData(e.data, s.data)) return false
      if (ca !== null && !(ms(e.createdAt) > ca)) return false
      if (cb !== null && !(ms(e.createdAt) < cb)) return false
      if (ua !== null && !(ms(e.updatedAt) > ua)) return false
      if (ub !== null && !(ms(e.updatedAt) < ub)) return false
      if (minD !== undefined || maxD !== undefined) {
        const d = ds.degree(e.id, rel)
        if (minD !== undefined && d < minD) return false
        if (maxD !== undefined && d > maxD) return false
      }
      if (s.where && !s.where(e)) return false
      return true
    }
  }
}

class Relationships extends Collection {
  get types() {
    return __typesNamespace(this, 'type')
  }
  type(...names) {
    const want = new Set(names.flat())
    return this.filter((r) => want.has(r.type))
  }
  /** The entities at members' sources / targets / both ends, deduplicated. */
  sources() {
    return __endsOf(this, 'source')
  }
  targets() {
    return __endsOf(this, 'target')
  }
  ends() {
    return __endsOf(this, 'both')
  }
  /** Members leaving an entity (an id, or a collection of entities). */
  from(x) {
    const ids = __idsOf(x)
    return this.filter((r) => ids.has(r.source))
  }
  /** Members arriving at an entity (an id, or a collection). */
  to(x) {
    const ids = __idsOf(x)
    return this.filter((r) => ids.has(r.target))
  }
  /**
   * Spec keys: types / type · source / target (an id, a list, a collection) · source_type / target_type (one or a
   * list) · directed · has · data · text (on either end's label) · where (fn).
   */
  _match(s) {
    const types = __asSet(s.types ?? s.type)
    const src = __idsOf(s.source)
    const tgt = __idsOf(s.target)
    const st = __asSet(s.source_type ?? s.source_types)
    const tt = __asSet(s.target_type ?? s.target_types)
    const has = s.has ? [].concat(s.has) : null
    const text = s.text ? String(s.text).toLowerCase() : null
    return (r) => {
      if (types && !types.has(r.type)) return false
      if (src && !src.has(r.source)) return false
      if (tgt && !tgt.has(r.target)) return false
      if (st && !st.has(ds.get(r.source)?.type)) return false
      if (tt && !tt.has(ds.get(r.target)?.type)) return false
      if (s.directed !== undefined && !!r.directed !== !!s.directed) return false
      if (has && !has.every((k) => r.data?.[k] !== undefined && r.data[k] !== null)) return false
      if (s.data && !__matchData(r.data, s.data)) return false
      if (text && !(__text(ds.get(r.source) ?? {}).includes(text) || __text(ds.get(r.target) ?? {}).includes(text))) return false
      if (s.where && !s.where(r)) return false
      return true
    }
  }
}

function __relsOf(coll, dir, rel) {
  const own = new Set(coll.ids())
  const out = []
  const seen = new Set()
  for (const id of own) {
    for (const r of dir === 'out' ? ds.out(id, rel) : dir === 'in' ? ds.in(id, rel) : [...ds.out(id, rel), ...ds.in(id, rel)]) {
      if (seen.has(r.id)) continue
      seen.add(r.id)
      out.push(r)
    }
  }
  return Relationships.from(out)
}
function __endsOf(rels, end) {
  const seen = new Set()
  const out = []
  for (const r of rels)
    for (const id of end === 'source' ? [r.source] : end === 'target' ? [r.target] : [r.source, r.target]) {
      if (seen.has(id)) continue
      seen.add(id)
      const e = ds.get(id)
      if (e) out.push(e)
    }
  return Entities.from(out)
}
/** `.types`: a namespace whose properties are the type names in the collection (plurals allowed), plus list(). */
function __typesNamespace(coll) {
  const names = [...new Set(coll.map((x) => x.type))]
  const byName = new Map(names.map((n) => [n, n]))
  const resolve = (k) => byName.get(k) ?? (k.endsWith('s') ? byName.get(k.slice(0, -1)) ?? byName.get(k.slice(0, -1).replace(/ie$/, 'y')) : undefined) ?? byName.get(k.replace(/_/g, '-')) ?? byName.get(k.replace(/_/g, ':'))
  return new Proxy(
    {},
    {
      get(_, k) {
        if (k === 'list') return () => names
        if (k === 'has') return (name) => resolve(name) !== undefined
        if (typeof k !== 'string') return undefined
        const name = resolve(k)
        return name === undefined ? coll.constructor.from([]) : coll.type(name)
      },
      has(_, k) {
        return typeof k === 'string' && resolve(k) !== undefined
      },
      ownKeys() {
        return names
      },
      getOwnPropertyDescriptor(_, k) {
        return typeof k === 'string' && resolve(k) !== undefined ? { enumerable: true, configurable: true, value: coll.type(resolve(k)) } : undefined
      },
    },
  )
}

const entities = Entities.from(ds.entities)
const relationships = Relationships.from(ds.relationships)
ds.entities = entities
ds.relationships = relationships
// The ds helpers hand back collections too, so a chain can start anywhere.
ds.byType = (...types) => entities.type(...types)
ds.tagged = (tag) => entities.tagged(tag)
ds.where = (fn) => entities.filter(fn)
;(function () {
  const out = ds.out
  const inn = ds.in
  const neighbors = ds.neighbors
  ds.out = (id, type) => Relationships.from(out(id, type))
  ds.in = (id, type) => Relationships.from(inn(id, type))
  ds.neighbors = (id, type) => Entities.from(neighbors(id, type))
})()
