import { addEdge, emptyDiagram, findNode, MAX_DIAGRAM_EDGES, upsertNode, type DEdge, type DNode, type ParsedDiagram } from './model'

/**
 * Graphviz DOT: a tolerant recursive-descent parser and a writer.
 *
 * Parses graph/digraph/strict, subgraphs (clusters become groups), node and
 * edge statements with attribute lists, edge chains (a -> b -> c), node/edge/
 * graph defaults, ports (a:p:n), quoted strings with escapes and `+`
 * concatenation, HTML-ish labels (<…>) kept verbatim, and all three comment
 * styles. Unknown syntax is skipped statement-by-statement with a warning
 * rather than failing the whole import.
 */

// ── Tokenizer ──────────────────────────────────────────────────────────

type Tok = { t: 'id' | 'sym'; v: string; line: number; /** A quoted or HTML string, so a keyword spelt this way is a plain id. */ q?: boolean }

const IDENT_CHAR = /[A-Za-z_0-9.\u0080-\uFFFF]/

function tokenize(src: string): Tok[] {
  const toks: Tok[] = []
  let i = 0
  let line = 1
  const n = src.length
  while (i < n) {
    const c = src[i]
    if (c === '\n') {
      line++
      i++
    }    else if (/\s/.test(c)) i++
    else if (c === '/' && src[i + 1] === '/') while (i < n && src[i] !== '\n') i++
    else if (c === '#' && (i === 0 || src[i - 1] === '\n')) while (i < n && src[i] !== '\n') i++
    else if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2)
      const chunk = src.slice(i, end < 0 ? n : end + 2)
      line += (chunk.match(/\n/g) ?? []).length
      i = end < 0 ? n : end + 2
    } else if (c === '"') {
      let j = i + 1
      let s = ''
      while (j < n && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < n) {
          const nx = src[j + 1]
          s += nx === '"' ? '"' : nx === 'n' ? '\n' : nx === 'l' || nx === 'r' ? '\n' : nx === '\\' ? '\\' : nx === '\n' ? '' : '\\' + nx
          j += 2
        } else {
          if (src[j] === '\n') line++
          s += src[j++]
        }
      }
      i = j + 1
      // `"a" + "b"` concatenation
      const last = toks[toks.length - 1]
      if (last && last.t === 'sym' && last.v === '+' && toks[toks.length - 2]?.t === 'id') {
        toks.pop()
        toks[toks.length - 1].v += s
      } else toks.push({ t: 'id', v: s, line, q: true })
    } else if (c === '<') {
      // HTML label: balanced angle brackets, kept verbatim.
      let depth = 0
      let j = i
      do {
        if (src[j] === '<') depth++
        else if (src[j] === '>') depth--
        else if (src[j] === '\n') line++
        j++
      } while (j < n && depth > 0)
      toks.push({ t: 'id', v: src.slice(i + 1, j - 1), line, q: true })
      i = j
    } else if (c === '-' && (src[i + 1] === '>' || src[i + 1] === '-')) {
      toks.push({ t: 'sym', v: c + src[i + 1], line })
      i += 2
    } else if (IDENT_CHAR.test(c) || (c === '-' && /[0-9.]/.test(src[i + 1] ?? ''))) {
      // Identifiers and numerals (which may start with '-' or '.'). A '-' inside a word is tolerated
      // (unquoted `foo-bar`); '->' and '--' were handled above.
      let j = i + 1
      while (j < n && IDENT_CHAR.test(src[j])) j++
      while (j < n && src[j] === '-' && src[j + 1] !== '-' && src[j + 1] !== '>' && IDENT_CHAR.test(src[j + 1] ?? '')) {
        j++
        while (j < n && IDENT_CHAR.test(src[j])) j++
      }
      toks.push({ t: 'id', v: src.slice(i, j), line })
      i = j
    } else {
      toks.push({ t: 'sym', v: c, line })
      i++
    }
  }
  return toks
}

// ── Parser ─────────────────────────────────────────────────────────────


/** Words the DOT grammar reserves; usable as ids only when quoted. */
const DOT_KEYWORDS = new Set(['graph', 'digraph', 'subgraph', 'node', 'edge', 'strict'])

export function parseDot(src: string): ParsedDiagram {
  const d = emptyDiagram('dot')
  const toks = tokenize(src)
  let p = 0
  const peek = (o = 0) => toks[p + o]
  const isSym = (v: string, o = 0) => peek(o)?.t === 'sym' && peek(o).v === v
  const isKw = (v: string, o = 0) => peek(o)?.t === 'id' && peek(o).v.toLowerCase() === v
  const next = () => toks[p++]
  const warn = (msg: string, line?: number) => d.warnings.push(line ? `line ${line}: ${msg}` : msg)
  const warnedKeywords = new Set<string>()

  // Header
  if (isKw('strict')) next()
  if (isKw('digraph') || isKw('graph')) d.kind = next().v.toLowerCase() as 'digraph' | 'graph'
  else {
    warn('expected "graph" or "digraph" at the start; assuming digraph')
    d.kind = 'digraph'
  }
  if (peek() && peek().t === 'id' && !isSym('{')) d.attrs.name = next().v
  const directed = d.kind === 'digraph'

  interface Scope {
    group?: string
    nodeDefaults: Record<string, string>
    edgeDefaults: Record<string, string>
  }

  function attrList(): Record<string, string> {
    const out: Record<string, string> = {}
    while (isSym('[')) {
      next()
      while (p < toks.length && !isSym(']')) {
        const k = next()
        if (k.t !== 'id') continue
        if (isSym('=')) {
          next()
          const v = next()
          out[k.v] = v?.v ?? ''
        } else out[k.v] = 'true'
        if (isSym(',') || isSym(';')) next()
      }
      if (isSym(']')) next()
    }
    return out
  }

  function nodeRef(): string | undefined {
    const t = peek()
    if (!t || t.t !== 'id') return undefined
    next()
    // Graphviz rejects a bare keyword as a node id ("syntax error near 'graph'"); a
    // renderer-free parse would otherwise accept it and the drawing would lose its layout.
    if (!t.q && DOT_KEYWORDS.has(t.v.toLowerCase()) && !warnedKeywords.has(t.v)) {
      warnedKeywords.add(t.v)
      warn(`"${t.v}" is a Graphviz keyword and cannot be a bare node id; quote it ("${t.v}") or rename it, or Graphviz will refuse to lay the diagram out`, t.line)
    }
    // ports: a:p or a:p:n
    while (isSym(':') && peek(1)?.t === 'id') {
      next()
      next()
    }
    return t.v
  }

  function body(scope: Scope, expectBrace = true) {
    if (expectBrace) {
      if (!isSym('{')) return warn('expected "{"', peek()?.line)
      next()
    }
    while (p < toks.length && !isSym('}')) {
      const startP = p
      statement(scope)
      if (isSym(';')) next()
      if (p === startP) {
        warn(`skipped unexpected token "${peek()?.v}"`, peek()?.line)
        next()
      }
    }
    if (isSym('}')) next()
  }

  function subgraph(scope: Scope): string[] {
    next() // 'subgraph'
    let id: string | undefined
    if (peek()?.t === 'id' && !isSym('{')) id = next().v
    const gid = id ?? `sub${d.groups.length + 1}`
    const isCluster = /^cluster/i.test(gid)
    const inner: Scope = { group: isCluster ? gid : scope.group, nodeDefaults: { ...scope.nodeDefaults }, edgeDefaults: { ...scope.edgeDefaults } }
    const before = d.nodes.length
    const attrs: Record<string, string> = {}
    // Graph attrs inside the subgraph body end up here through statement(); capture them.
    const capture = (k: string, v: string) => (attrs[k] = v)
    graphAttrSink.push(capture)
    body(inner)
    graphAttrSink.pop()
    if (isCluster) d.groups.push({ id: gid, label: attrs.label ?? gid.replace(/^cluster_?/i, '') ?? gid, parent: scope.group, attrs })
    // Members: nodes first declared here plus any referenced; used as an edge endpoint set.
    return d.nodes.slice(before).map((n) => n.id)
  }

  const graphAttrSink: ((k: string, v: string) => void)[] = []
  const setGraphAttr = (k: string, v: string) => {
    const sink = graphAttrSink[graphAttrSink.length - 1]
    if (sink) sink(k, v)
    else d.attrs[k] = v
  }

  function endpoint(scope: Scope): string[] | undefined {
    if (isKw('subgraph') || isSym('{')) {
      if (isSym('{')) {
        // anonymous subgraph as endpoint
        const inner: Scope = { ...scope, nodeDefaults: { ...scope.nodeDefaults }, edgeDefaults: { ...scope.edgeDefaults } }
        const before = d.nodes.length
        body(inner)
        return d.nodes.slice(before).map((n) => n.id)
      }
      return subgraph(scope)
    }
    const id = nodeRef()
    if (id === undefined) return undefined
    ensureNode(scope, id)
    return [id]
  }

  function ensureNode(scope: Scope, id: string): DNode {
    const existed = findNode(d, id) !== undefined
    const n = upsertNode(d, id, existed ? {} : { group: scope.group, attrs: { ...scope.nodeDefaults } })
    if (!existed) applyNodeAttrs(n, scope.nodeDefaults)
    return n
  }

  function applyNodeAttrs(n: DNode, attrs: Record<string, string>) {
    const { label, shape, class: cls, ...rest } = attrs
    if (label !== undefined && label !== '\\N') n.label = label
    if (shape) n.shape = shape
    if (cls) n.classes = [...new Set([...n.classes, ...cls.split(/\s+/).filter(Boolean)])]
    Object.assign(n.attrs, rest)
  }

  function statement(scope: Scope) {
    // A subgraph or `{ … }` block is a statement on its own, or the first end of an edge (`{ a b } -> c`); endpoint() reads both.
    if (isKw('node') && isSym('[', 1)) {
      next()
      Object.assign(scope.nodeDefaults, attrList())
      return
    }
    if (isKw('edge') && isSym('[', 1)) {
      next()
      Object.assign(scope.edgeDefaults, attrList())
      return
    }
    if (isKw('graph') && isSym('[', 1)) {
      next()
      for (const [k, v] of Object.entries(attrList())) setGraphAttr(k, v)
      return
    }
    // key = value at graph level
    if (peek()?.t === 'id' && isSym('=', 1)) {
      const k = next().v
      next()
      setGraphAttr(k, next()?.v ?? '')
      return
    }
    const first = endpoint(scope)
    if (!first) return
    if (isSym('->') || isSym('--')) {
      // Edge chain
      const chain: string[][] = [first]
      while (isSym('->') || isSym('--')) {
        next()
        const ep = endpoint(scope)
        if (!ep) break
        chain.push(ep)
      }
      const attrs = { ...scope.edgeDefaults, ...attrList() }
      const { label, style, class: cls, ...rest } = attrs
      // `{ a b … } -> { x y … }` is every pair: stop at the diagram's edge bound rather than walk the rest of them.
      chains: for (let i = 0; i < chain.length - 1; i++)
        for (const s of chain[i])
          for (const t of chain[i + 1]) {
            const full = d.edges.length >= MAX_DIAGRAM_EDGES
            addEdge(d, { source: s, target: t, label, directed, style, attrs: { ...rest, ...(cls ? { class: cls } : {}) } })
            if (full) break chains
          }
      return
    }
    // Node statement with attributes
    if (isSym('[')) {
      const attrs = attrList()
      for (const id of first) applyNodeAttrs(ensureNode(scope, id), attrs)
    }
  }

  body({ nodeDefaults: {}, edgeDefaults: {} })
  if (p < toks.length) warn('trailing content after the graph body was ignored', peek()?.line)
  return d
}

// ── Writer ─────────────────────────────────────────────────────────────

export interface DotWriteOptions {
  name?: string
  directed?: boolean
  rankdir?: 'TB' | 'LR' | 'BT' | 'RL'
  /** Wrap nodes with the same group into clusters. */
  clusters?: boolean
  /**
   * The diagram as it was last written in DOT: nodes and edges that still
   * exist keep the attributes they had there (colours, styles, anything
   * the other format could not carry), under whatever the current diagram
   * sets.
   */
  previous?: ParsedDiagram
  /**
   * Write pinned positions and sizes (`pos="x,y!"`, `width`, `height`) from
   * the geometry, so a drawing's arrangement survives in DOT and neato
   * renders it as drawn. Default: whenever any node's geometry is pinned.
   */
  positions?: boolean
}

/** Attributes the writer derives from geometry or structure; never copied from a previous rendition. */
const DERIVED_ATTRS = new Set(['pos', 'width', 'height', 'pin', 'label', 'shape', 'class'])

/** DOT points ↔ canvas pixels: one to one, with DOT's y axis pointing up. Sizes are in inches at 72 dpi. */
export const dotPos = (x: number, y: number) => `${round(x)},${round(-y)}!`
export const dotInches = (px: number) => round(px / 72, 3)
const round = (v: number, d = 1) => Math.round(v * 10 ** d) / 10 ** d

const dotId = (s: string) => (/^[A-Za-z_][A-Za-z_0-9]*$/.test(s) || /^-?(\.[0-9]+|[0-9]+(\.[0-9]*)?)$/.test(s) ? s : `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`)

/** Mermaid / Excalidraw shape words that Graphviz spells differently. */
const DOT_SHAPES: Record<string, string | { shape: string; style: string[] }> = {
  rounded: { shape: 'box', style: ['rounded'] },
  stadium: { shape: 'box', style: ['rounded'] },
  subroutine: 'box',
  'double-circle': 'doublecircle',
  hexagon: 'hexagon',
  'parallelogram-alt': 'parallelogram',
  trapezoid: 'trapezium',
  'trapezoid-alt': 'invtrapezium',
  asymmetric: 'cds',
  rectangle: 'box',
  text: 'plaintext',
}

export function writeDot(d: ParsedDiagram, opts: DotWriteOptions = {}): string {
  const directed = opts.directed ?? d.kind !== 'graph'
  const arrow = directed ? '->' : '--'
  const lines: string[] = [`${directed ? 'digraph' : 'graph'} ${dotId(opts.name ?? d.attrs.name ?? 'G')} {`]
  const rankdir = opts.rankdir ?? d.attrs.rankdir
  if (rankdir) lines.push(`  rankdir=${rankdir};`)
  lines.push('  node [fontname="Helvetica", fontsize=10];', '  edge [fontname="Helvetica", fontsize=9];')
  const attrsOf = (a: Record<string, string>) =>
    Object.entries(a)
      .map(([k, v]) => `${k}=${dotId(v)}`)
      .join(', ')
  const positions = opts.positions ?? Object.values(d.geometry?.nodes ?? {}).some((g) => g.pinned)
  // Pinned positions are in points (the drawing's pixels); neato reads `pos` in inches unless told otherwise.
  if (positions && !d.attrs.layout) lines.push('  layout=neato; inputscale=72; overlap=true; splines=true;')
  const previousNodes = new Map<string, DNode>()
  for (const x of opts.previous?.nodes ?? []) if (!previousNodes.has(x.id)) previousNodes.set(x.id, x)
  const prevNode = (id: string) => previousNodes.get(id)
  const prevEdge = (e: DEdge) => opts.previous?.edges.find((x) => x.id === e.id || (x.source === e.source && x.target === e.target && x.label === e.label))
  const inherited = (a: Record<string, string> | undefined) => Object.fromEntries(Object.entries(a ?? {}).filter(([k]) => !DERIVED_ATTRS.has(k)))
  const nodeLine = (n: typeof d.nodes[number], indent: string) => {
    const a: Record<string, string> = { ...inherited(prevNode(n.id)?.attrs), ...n.attrs }
    for (const k of ['pos', 'width', 'height', 'pin']) delete a[k]
    if (n.label !== n.id) a.label = n.label
    const geom = d.geometry?.nodes[n.id]
    if (positions && geom) {
      a.pos = dotPos(geom.x, geom.y)
      a.width = String(dotInches(geom.width))
      a.height = String(dotInches(geom.height))
      a.fixedsize = 'true'
    }
    if (n.shape) {
      // Mermaid shape words → Graphviz shapes; round-edged ones become a rounded box.
      const word = n.shape.toLowerCase()
      const shape = Object.hasOwn(DOT_SHAPES, word) ? DOT_SHAPES[word] : n.shape
      a.shape = typeof shape === 'string' ? shape : shape.shape
      if (typeof shape !== 'string') a.style = [...new Set([...(a.style ?? '').split(',').filter(Boolean), ...shape.style])].join(',')
    }
    // A fill colour only shows on a filled node.
    if (a.fillcolor && !/\bfilled\b/.test(a.style ?? '')) a.style = [...(a.style ?? '').split(',').filter(Boolean), 'filled'].join(',')
    if (n.classes.length) a.class = n.classes.join(' ')
    const s = attrsOf(a)
    return `${indent}${dotId(n.id)}${s ? ` [${s}]` : ''};`
  }
  const useClusters = opts.clusters ?? d.groups.length > 0
  const byGroup = new Map<string | undefined, typeof d.nodes>()
  for (const n of d.nodes) {
    const g = useClusters ? n.group : undefined
    const list = byGroup.get(g)
    if (list) list.push(n)
    else byGroup.set(g, [n])
  }
  for (const [g, nodes] of byGroup) {
    if (g) {
      const group = d.groups.find((x) => x.id === g)
      lines.push(`  subgraph ${dotId(/^cluster/i.test(g) ? g : `cluster_${g}`)} {`, `    label=${dotId(group?.label ?? g)};`, '    style="rounded"; color="#c9c5bb";')
      for (const n of nodes) lines.push(nodeLine(n, '    '))
      lines.push('  }')
    } else for (const n of nodes) lines.push(nodeLine(n, '  '))
  }
  for (const e of d.edges) {
    const a: Record<string, string> = { ...inherited(prevEdge(e)?.attrs), ...e.attrs }
    if (e.label) a.label = e.label
    if (e.style) a.style = e.style
    const s = attrsOf(a)
    lines.push(`  ${dotId(e.source)} ${arrow} ${dotId(e.target)}${s ? ` [${s}]` : ''};`)
  }
  lines.push('}')
  return lines.join('\n') + '\n'
}
