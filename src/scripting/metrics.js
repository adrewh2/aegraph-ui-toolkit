/* eslint-disable no-unused-vars -- these are the globals scripts call */
// Graph metrics inside the sandbox: plain ES2020 over `ds`, no host access,
// so a script can compute what it styles by. Loaded after prelude.js.
// `ds.compute(['pagerank', 'community'])` fills the same `ds.metric(name, id)`
// the latest Insights run does (a computed value wins over a stale one).
// Exact where it is cheap; betweenness and closeness sample sources past a
// few thousand nodes, like the app's analysis does.
;(function () {
  const computed = {}
  const hostMetric = ds.metric
  ds.metric = (name, id) => computed[name]?.[id] ?? hostMetric(name, id)
  ds.metricNames = () => [...new Set([...Object.keys(computed), ...Object.keys(ds.metrics ?? {})])]

  const METRICS = ['degree', 'inDegree', 'outDegree', 'pagerank', 'betweenness', 'closeness', 'clustering', 'component', 'componentSize', 'community']
  let index
  /** The graph as arrays: nodes in ds order, undirected and directed adjacency without self-loops. */
  const build = () => {
    if (index) return index
    const ids = ds.entities.map((e) => e.id)
    const n = ids.length
    const at = new Map(ids.map((id, i) => [id, i]))
    const und = Array.from({ length: n }, () => [])
    const out = Array.from({ length: n }, () => [])
    const inn = Array.from({ length: n }, () => [])
    const seen = new Set()
    for (const r of ds.relationships) {
      const a = at.get(r.source)
      const b = at.get(r.target)
      if (a === undefined || b === undefined || a === b) continue
      out[a].push(b)
      inn[b].push(a)
      const k = a < b ? a * n + b : b * n + a
      if (seen.has(k)) continue
      seen.add(k)
      und[a].push(b)
      und[b].push(a)
    }
    index = { ids, n, at, und, out, inn }
    return index
  }
  const column = (ids, values) => {
    const col = {}
    for (let i = 0; i < ids.length; i++) col[ids[i]] = values[i]
    return col
  }
  const bfs = (adj, s, dist) => {
    dist.fill(-1)
    dist[s] = 0
    const q = [s]
    for (let h = 0; h < q.length; h++) {
      const v = q[h]
      for (const w of adj[v]) if (dist[w] < 0) {
        dist[w] = dist[v] + 1
        q.push(w)
      }
    }
    return q
  }
  const rng = (seed) => {
    let t = seed >>> 0
    return () => {
      t += 0x6d2b79f5
      let r = Math.imul(t ^ (t >>> 15), 1 | t)
      r ^= r + Math.imul(r ^ (r >>> 7), 61 | r)
      return ((r ^ (r >>> 14)) >>> 0) / 4294967296
    }
  }
  const sources = (n, want, seed) => {
    if (n <= want) return Array.from({ length: n }, (_, i) => i)
    const r = rng(seed)
    const picked = new Set()
    while (picked.size < want) picked.add(Math.floor(r() * n))
    return [...picked]
  }

  const compute = {
    degree: ({ und }) => und.map((a) => a.length),
    inDegree: ({ inn }) => inn.map((a) => a.length),
    outDegree: ({ out }) => out.map((a) => a.length),
    component: ({ n, und }) => {
      const comp = new Array(n).fill(-1)
      const dist = new Int32Array(n)
      let c = 0
      const sizes = []
      for (let s = 0; s < n; s++) {
        if (comp[s] >= 0) continue
        const members = bfs(und, s, dist)
        for (const v of members) comp[v] = c
        sizes.push(members.length)
        c++
      }
      // Numbered by size, the largest first.
      const order = sizes.map((s, i) => i).sort((a, b) => sizes[b] - sizes[a])
      const rank = new Array(sizes.length)
      order.forEach((old, i) => (rank[old] = i))
      return { component: comp.map((c) => rank[c]), componentSize: comp.map((c) => sizes[c]) }
    },
    pagerank: ({ n, out, inn }, opts) => {
      const alpha = opts.alpha ?? 0.85
      let pr = new Float64Array(n).fill(1 / n)
      const outDeg = out.map((a) => a.length)
      for (let it = 0; it < (opts.iterations ?? 100); it++) {
        let dangling = 0
        for (let i = 0; i < n; i++) if (!outDeg[i]) dangling += pr[i]
        const next = new Float64Array(n)
        const base = (1 - alpha) / n + (alpha * dangling) / n
        for (let i = 0; i < n; i++) {
          let s = 0
          for (const j of inn[i]) s += pr[j] / outDeg[j]
          next[i] = base + alpha * s
        }
        let delta = 0
        for (let i = 0; i < n; i++) delta += Math.abs(next[i] - pr[i])
        pr = next
        if (delta < (opts.tolerance ?? 1e-6)) break
      }
      return Array.from(pr)
    },
    clustering: ({ n, und }) => {
      const sets = und.map((a) => new Set(a))
      return und.map((a, i) => {
        const k = a.length
        if (k < 2) return 0
        let t = 0
        for (let x = 0; x < k; x++) for (let y = x + 1; y < k; y++) if (sets[a[x]].has(a[y])) t++
        return (2 * t) / (k * (k - 1))
      })
    },
    betweenness: ({ n, und }, opts) => {
      // Brandes, undirected, unweighted; exact below the cap, else sampled and scaled.
      const cap = opts.exactBelow ?? 2000
      const src = sources(n, n <= cap ? n : (opts.sources ?? 200), opts.seed ?? 1)
      const cb = new Float64Array(n)
      const dist = new Int32Array(n)
      const sigma = new Float64Array(n)
      const delta = new Float64Array(n)
      const pred = Array.from({ length: n }, () => [])
      for (const s of src) {
        dist.fill(-1)
        sigma.fill(0)
        delta.fill(0)
        for (const p of pred) p.length = 0
        dist[s] = 0
        sigma[s] = 1
        const order = [s]
        for (let h = 0; h < order.length; h++) {
          const v = order[h]
          for (const w of und[v]) {
            if (dist[w] < 0) {
              dist[w] = dist[v] + 1
              order.push(w)
            }
            if (dist[w] === dist[v] + 1) {
              sigma[w] += sigma[v]
              pred[w].push(v)
            }
          }
        }
        for (let i = order.length - 1; i >= 0; i--) {
          const w = order[i]
          for (const v of pred[w]) delta[v] += (sigma[v] / sigma[w]) * (1 + delta[w])
          if (w !== s) cb[w] += delta[w]
        }
      }
      const scale = (n / src.length) * (n > 2 ? 1 / ((n - 1) * (n - 2)) : 1)
      return Array.from(cb, (v) => v * scale)
    },
    closeness: ({ n, und }, opts) => {
      // Reach-weighted (Wasserman–Faust), so a small component does not look central. Sampled past the cap, on the sources' side.
      const cap = opts.exactBelow ?? 2000
      const dist = new Int32Array(n)
      if (n <= cap) {
        return und.map((_, s) => {
          const reached = bfs(und, s, dist)
          let sum = 0
          for (const v of reached) sum += dist[v]
          const r = reached.length - 1
          return r > 0 ? ((r / (n - 1)) * r) / sum : 0
        })
      }
      const src = sources(n, opts.sources ?? 200, opts.seed ?? 1)
      const sum = new Float64Array(n)
      const cnt = new Int32Array(n)
      for (const s of src) {
        const reached = bfs(und, s, dist)
        for (const v of reached) {
          if (v === s) continue
          sum[v] += dist[v]
          cnt[v]++
        }
      }
      return Array.from(cnt, (c, v) => (c > 0 ? ((c / src.length) * c) / sum[v] : 0))
    },
    community: ({ n, und }, opts) => {
      // Louvain: local moves for modularity, then aggregation, until nothing improves. Unweighted at the start; the
      // aggregated graph is weighted. Communities come out numbered by size, the largest first.
      const r = rng(opts.seed ?? 1)
      let nodeCount = n
      let adj = und.map((a) => new Map(a.map((b) => [b, 1])))
      let membership = Array.from({ length: n }, (_, i) => i) // original node → current community
      let level = 0
      while (level++ < 20) {
        const m2 = adj.reduce((s, a) => { for (const w of a.values()) s += w; return s }, 0) // 2m
        if (!m2) break
        const k = adj.map((a) => { let s = 0; for (const w of a.values()) s += w; return s })
        const comm = Array.from({ length: nodeCount }, (_, i) => i)
        const tot = k.slice()
        let moved = true
        let sweeps = 0
        while (moved && sweeps++ < 50) {
          moved = false
          const order = Array.from({ length: nodeCount }, (_, i) => i)
          for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [order[i], order[j]] = [order[j], order[i]] }
          for (const v of order) {
            const cv = comm[v]
            const links = new Map()
            for (const [w, wt] of adj[v]) links.set(comm[w], (links.get(comm[w]) ?? 0) + wt)
            tot[cv] -= k[v]
            let best = cv
            let bestGain = (links.get(cv) ?? 0) - (tot[cv] * k[v]) / m2
            for (const [c, wt] of links) {
              const gain = wt - (tot[c] * k[v]) / m2
              if (gain > bestGain + 1e-12) { bestGain = gain; best = c }
            }
            tot[best] += k[v]
            if (best !== cv) { comm[v] = best; moved = true }
          }
        }
        // Renumber and aggregate.
        const ids = new Map()
        for (const c of comm) if (!ids.has(c)) ids.set(c, ids.size)
        if (ids.size === nodeCount) break
        membership = membership.map((c) => ids.get(comm[c]))
        const next = Array.from({ length: ids.size }, () => new Map())
        adj.forEach((a, v) => {
          const cv = ids.get(comm[v])
          for (const [w, wt] of a) {
            const cw = ids.get(comm[w])
            next[cv].set(cw, (next[cv].get(cw) ?? 0) + wt)
          }
        })
        adj = next
        nodeCount = ids.size
      }
      const sizes = new Map()
      for (const c of membership) sizes.set(c, (sizes.get(c) ?? 0) + 1)
      const rank = new Map([...sizes.entries()].sort((a, b) => b[1] - a[1]).map(([c], i) => [c, i]))
      return membership.map((c) => rank.get(c))
    },
  }

  /**
   * ds.compute(['pagerank', 'community'], { force?, seed?, alpha?, iterations?, exactBelow?, sources? })
   * → { pagerank: { [id]: value }, … }, also reachable through ds.metric(name, id). Computed once per snapshot
   * unless force. Names: degree, inDegree, outDegree, pagerank, betweenness, closeness, clustering, component,
   * componentSize, community (Louvain).
   */
  // Columns are kept between runs (computed once per snapshot) and frozen, so no run can change what the next one reads.
  ds.compute = (names, opts = {}) => {
    const want = (Array.isArray(names) ? names : [names]).map(String)
    const bad = want.filter((m) => !METRICS.includes(m))
    if (bad.length) throw new Error(`Unknown metric${bad.length > 1 ? 's' : ''} ${bad.join(', ')}. Metrics: ${METRICS.join(', ')}.`)
    const g = build()
    const out = {}
    for (const name of want) {
      if (!opts.force && computed[name]) { out[name] = computed[name]; continue }
      if (name === 'component' || name === 'componentSize') {
        const { component, componentSize } = compute.component(g)
        computed.component = Object.freeze(column(g.ids, component))
        computed.componentSize = Object.freeze(column(g.ids, componentSize))
      } else computed[name] = Object.freeze(column(g.ids, compute[name](g, opts)))
      out[name] = computed[name]
    }
    return out
  }
  ds.computable = () => METRICS.slice()
})()

// ── Colour helpers for styling by value ─────────────────────────────
/** A few of the app's palettes, as stops; `colorRamp(t, PALETTES.viridis)` interpolates for t in 0–1. */
const PALETTES = {
  viridis: ['#440154', '#482878', '#3e4989', '#31688e', '#26828e', '#1f9e89', '#35b779', '#6ece58', '#b5de2b', '#fde725'],
  magma: ['#000004', '#180f3d', '#440f76', '#721f81', '#9e2f7f', '#cd4071', '#f1605d', '#fd9668', '#feca8d', '#fcfdbf'],
  blues: ['#f7fbff', '#deebf7', '#c6dbef', '#9ecae1', '#6baed6', '#4292c6', '#2171b5', '#08519c', '#08306b'],
  reds: ['#fff5f0', '#fee0d2', '#fcbba1', '#fc9272', '#fb6a4a', '#ef3b2c', '#cb181d', '#a50f15', '#67000d'],
  redBlue: ['#b2182b', '#d6604d', '#f4a582', '#fddbc7', '#f7f7f7', '#d1e5f0', '#92c5de', '#4393c3', '#2166ac'],
  tableau10: ['#4e79a7', '#f28e2b', '#e15759', '#76b7b2', '#59a14f', '#edc948', '#b07aa1', '#ff9da7', '#9c755f', '#bab0ac'],
}
const __hex = (c) => {
  const s = c.replace('#', '')
  const v = s.length === 3 ? s.split('').map((x) => x + x).join('') : s
  return [parseInt(v.slice(0, 2), 16), parseInt(v.slice(2, 4), 16), parseInt(v.slice(4, 6), 16)]
}
const __toHex = (rgb) => '#' + rgb.map((x) => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, '0')).join('')
/** The colour at t (0–1) along a list of hex stops. */
const colorRamp = (t, stops = PALETTES.viridis) => {
  const x = Math.max(0, Math.min(1, Number.isFinite(t) ? t : 0)) * (stops.length - 1)
  const i = Math.min(stops.length - 2, Math.floor(x))
  const f = x - i
  const a = __hex(stops[i])
  const b = __hex(stops[i + 1])
  return __toHex(a.map((v, k) => v + (b[k] - v) * f))
}
/** A categorical colour for an index or a key (the same key always gets the same colour). */
const colorOf = (key, stops = PALETTES.tableau10) => {
  if (typeof key === 'number') return stops[((key % stops.length) + stops.length) % stops.length]
  let h = 0
  for (const ch of String(key)) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return stops[h % stops.length]
}
/** Map a value from a domain onto a range, clamped; `scaleSqrt` and `scaleLog` for skewed values (sizes by degree, say). */
const scaleLinear = (v, [d0, d1], [r0, r1]) => (d1 === d0 ? r0 : r0 + (r1 - r0) * Math.max(0, Math.min(1, (v - d0) / (d1 - d0))))
const scaleSqrt = (v, [d0, d1], [r0, r1]) => scaleLinear(Math.sqrt(Math.max(0, v)), [Math.sqrt(Math.max(0, d0)), Math.sqrt(Math.max(0, d1))], [r0, r1])
const scaleLog = (v, [d0, d1], [r0, r1]) => scaleLinear(Math.log1p(Math.max(0, v)), [Math.log1p(Math.max(0, d0)), Math.log1p(Math.max(0, d1))], [r0, r1])
/** The min and max of a list of numbers (NaNs skipped). */
const extent = (values) => {
  let lo = Infinity
  let hi = -Infinity
  for (const v of values) if (Number.isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v }
  return lo <= hi ? [lo, hi] : [0, 0]
}

// ── Output builder: a style for the Graph Explorer ───────────────────
/**
 * style(nodes, { edges?, legend?, label?, spec? }) — a style per entity id: nodes { [id]: { color?, size?, opacity?,
 * shape?, visible?, label? } }, edges { [id]: { color?, width?, opacity?, visible?, arrow? } }; legend { title, items:
 * [{ label, color }] } or { title, palette, domain: [lo, hi] }; `spec` an optional rendering spec for what the ids do
 * not set (defaults and type/tag rules, the same shape graph_style takes). Applied on the Graph Explorer, and saved as
 * a style that remembers the script.
 */
const style = (nodes, opts = {}) => ({ style: { nodes, ...opts } })
/**
 * layout(positions, { label?, dimensions? }) — a position per entity id ({ x, y, z? }) for the Graph Explorer: applied as
 * the view's layout and saved as a layout that remembers the script. (scene(positions) is for the Scenes page instead.)
 */
const layout = (positions, opts = {}) => ({ layout: { positions, ...opts } })
