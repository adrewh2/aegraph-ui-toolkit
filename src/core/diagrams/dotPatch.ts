import { dotInches, dotPos } from './dot'
import type { DEdge, DNode, ParsedDiagram } from './model'

/**
 * Bring DOT text up to date with a diagram *without rewriting it*: the
 * user's formatting, comments, defaults and attribute order stay; only
 * the statements that changed are touched. Works on the common one-
 * statement-per-line style. Returns undefined when the text is shaped in
 * a way this can't edit safely (chained edges, several statements on a
 * line for something that must change) — the caller then rewrites.
 */

const ID = String.raw`(?:"(?:[^"\\]|\\.)*"|[A-Za-z_][A-Za-z_0-9]*|-?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?))`
const unquote = (s: string) => (s.startsWith('"') ? s.slice(1, -1).replace(/\\(.)/g, '$1') : s)
const quoteId = (s: string) => (/^[A-Za-z_][A-Za-z_0-9]*$/.test(s) || /^-?(\.[0-9]+|[0-9]+(\.[0-9]*)?)$/.test(s) ? s : `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`)

const ATTRS = String.raw`((?:"(?:[^"\\]|\\.)*"|[^\]"])*)`
const NODE_LINE = new RegExp(String.raw`^(\s*)(${ID})(\s*\[${ATTRS}\])?\s*;?\s*(//.*|#.*)?$`)
const EDGE_LINE = new RegExp(String.raw`^(\s*)(${ID})\s*(->|--)\s*(${ID})(\s*\[${ATTRS}\])?\s*;?\s*(//.*|#.*)?$`)
const CHAINED = new RegExp(String.raw`^\s*${ID}\s*(?:->|--)\s*${ID}\s*(?:->|--)`)
const KEYWORDS = new Set(['node', 'edge', 'graph', 'subgraph', 'digraph', 'strict'])

interface Attr {
  key: string
  raw: string
}

/** `a=1, b="x y"` → ordered entries with their original text, so untouched ones come back verbatim. */
function parseAttrs(s: string): Attr[] {
  const out: Attr[] = []
  const re = new RegExp(String.raw`(${ID})\s*=\s*(${ID}|<[^>]*>)`, 'g')
  let m: RegExpExecArray | null
  while ((m = re.exec(s))) out.push({ key: unquote(m[1]), raw: m[0] })
  return out
}
const joinAttrs = (attrs: Attr[]) => attrs.map((a) => a.raw).join(', ')
function setAttr(attrs: Attr[], key: string, value: string) {
  const raw = `${key}=${quoteId(value)}`
  const i = attrs.findIndex((a) => a.key === key)
  if (i >= 0) attrs[i] = { key, raw }
  else attrs.push({ key, raw })
}
function delAttr(attrs: Attr[], key: string) {
  const i = attrs.findIndex((a) => a.key === key)
  if (i >= 0) attrs.splice(i, 1)
}

const GEOM = ['pos', 'width', 'height', 'fixedsize']
/** Excalidraw's default stroke; a node drawn without choosing a colour has it. */
const CANVAS_INK = '#1e1e1e'

export function patchDot(text: string, current: ParsedDiagram, previous: ParsedDiagram): string | undefined {
  const lines = text.split('\n')
  const positions = Object.values(current.geometry?.nodes ?? {}).some((g) => g.pinned)
  const prevNodes = new Map(previous.nodes.map((n) => [n.id, n]))
  const prevEdges = previous.edges
  const curNodes = new Map(current.nodes.map((n) => [n.id, n]))
  const edgeKey = (e: DEdge) => `${e.source}\u0000${e.target}\u0000${e.label ?? ''}`
  const curEdgeKeys = new Set(current.edges.map(edgeKey))
  const prevEdgeKeys = new Set(prevEdges.map(edgeKey))

  // Index the lines: which node / edge statement each one is (only the simple, one-per-line shapes).
  const nodeLine = new Map<string, number>()
  const edgeLines: { i: number; source: string; target: string; label?: string }[] = []
  // Ids named in chained edges (`a -> b -> c`): a line this can't edit, so a node in one can't be removed here.
  const chained = new Set<string>()
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    if (CHAINED.test(l)) {
      for (const m of l.matchAll(new RegExp(ID, 'g'))) chained.add(unquote(m[0]))
      continue
    }
    const e = EDGE_LINE.exec(l)
    if (e) {
      const attrs = parseAttrs(e[6] ?? '')
      const label = attrs.find((a) => a.key === 'label')
      edgeLines.push({ i, source: unquote(e[2]), target: unquote(e[4]), label: label ? unquote(label.raw.replace(/^label\s*=\s*/, '')) : undefined })
      continue
    }
    const n = NODE_LINE.exec(l)
    if (n && !KEYWORDS.has(unquote(n[2]).toLowerCase()) && !/[{}=]/.test(l.replace(/\[[^\]]*\]/, ''))) nodeLine.set(unquote(n[2]), i)
  }

  const removeLines = new Set<number>()
  const replaced = new Map<number, string>()

  // Removed nodes and their edges; removed edges.
  for (const id of prevNodes.keys()) {
    if (curNodes.has(id)) continue
    const li = nodeLine.get(id)
    if (li === undefined || chained.has(id)) return undefined
    removeLines.add(li)
    for (const el of edgeLines) if (el.source === id || el.target === id) removeLines.add(el.i)
  }
  for (const e of prevEdges) {
    if (curEdgeKeys.has(edgeKey(e)) || !curNodes.has(e.source) || !curNodes.has(e.target)) continue
    const el = edgeLines.find((x) => x.source === e.source && x.target === e.target && x.label === e.label)
    if (!el) return undefined
    removeLines.add(el.i)
  }

  // Nodes that changed label, shape or position: edit their line's attributes.
  const patchNode = (n: DNode, li: number) => {
    const m = NODE_LINE.exec(lines[li])!
    const attrs = parseAttrs(m[4] ?? '')
    const prev = prevNodes.get(n.id)
    if (n.label !== (prev?.label ?? n.id)) {
      if (n.label === n.id) delAttr(attrs, 'label')
      else setAttr(attrs, 'label', n.label)
    }
    // Colours the diagram states that differ from what the text (its defaults included) gave this node.
    for (const k of ['fillcolor', 'color', 'fontcolor']) {
      const v = n.attrs[k]
      if (!v || v.toLowerCase() === (prev?.attrs[k] ?? '').toLowerCase()) continue
      // The canvas's own default ink isn't a choice the text needs to hear about.
      if (!prev?.attrs[k] && v.toLowerCase() === CANVAS_INK) continue
      setAttr(attrs, k, v)
    }
    if (n.attrs.fillcolor && !/\bfilled\b/.test(prev?.attrs.style ?? attrs.find((a) => a.key === 'style')?.raw ?? '')) setAttr(attrs, 'style', [...(prev?.attrs.style ?? '').split(',').filter(Boolean), 'filled'].join(','))
    const geom = current.geometry?.nodes[n.id]
    if (positions && geom?.pinned) {
      setAttr(attrs, 'pos', dotPos(geom.x, geom.y))
      setAttr(attrs, 'width', String(dotInches(geom.width)))
      setAttr(attrs, 'height', String(dotInches(geom.height)))
      setAttr(attrs, 'fixedsize', 'true')
    }
    replaced.set(li, `${m[1]}${m[2]}${attrs.length ? ` [${joinAttrs(attrs)}]` : ''};${m[5] ? ` ${m[5]}` : ''}`)
  }
  const additions: { afterGroup?: string; line: string }[] = []
  for (const n of current.nodes) {
    const li = nodeLine.get(n.id)
    if (li !== undefined) {
      patchNode(n, li)
      continue
    }
    // A node the text never declared on its own (it only appears in edges) gets a statement now; a new node gets one too.
    // Either way it is placed in its group's block when there is one.
    const attrs: Attr[] = []
    if (n.label !== n.id) setAttr(attrs, 'label', n.label)
    if (n.shape && n.shape !== 'box') setAttr(attrs, 'shape', n.shape)
    for (const [k, v] of Object.entries(n.attrs)) if (!GEOM.includes(k) && !(k === 'color' && v.toLowerCase() === CANVAS_INK)) setAttr(attrs, k, v)
    const geom = current.geometry?.nodes[n.id]
    if (positions && geom?.pinned) {
      setAttr(attrs, 'pos', dotPos(geom.x, geom.y))
      setAttr(attrs, 'width', String(dotInches(geom.width)))
      setAttr(attrs, 'height', String(dotInches(geom.height)))
      setAttr(attrs, 'fixedsize', 'true')
    }
    additions.push({ afterGroup: n.group, line: `${quoteId(n.id)}${attrs.length ? ` [${joinAttrs(attrs)}]` : ''};` })
  }
  // New edges go at the end of the graph.
  const directed = /^\s*(strict\s+)?digraph\b/i.test(text)
  for (const e of current.edges) {
    if (prevEdgeKeys.has(edgeKey(e))) continue
    const attrs: Attr[] = []
    if (e.label) setAttr(attrs, 'label', e.label)
    if (e.style) setAttr(attrs, 'style', e.style)
    for (const [k, v] of Object.entries(e.attrs)) setAttr(attrs, k, v)
    additions.push({ line: `${quoteId(e.source)} ${directed ? '->' : '--'} ${quoteId(e.target)}${attrs.length ? ` [${joinAttrs(attrs)}]` : ''};` })
  }

  // Apply, bottom-up so indices hold.
  const out = lines.map((l, i) => (replaced.has(i) ? replaced.get(i)! : l))
  const closing = (from: number, to: number, subgraph?: string): number => {
    // The line of the `}` that closes the block opened at/after `from` (the graph, or a subgraph by id).
    let depth = 0
    let opened = false
    for (let i = from; i < to; i++) {
      const l = out[i]
      if (!opened) {
        if (subgraph ? new RegExp(String.raw`\bsubgraph\s+${quoteId(subgraph).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\b`).test(l) || (subgraph.startsWith('cluster') ? false : new RegExp(String.raw`\bsubgraph\s+"?cluster_?${subgraph}"?\b`).test(l)) : /\{/.test(l)) opened = true
        else continue
      }
      for (const ch of l) {
        if (ch === '{') depth++
        else if (ch === '}') {
          depth--
          // A block that opens and closes on one line has no line of its own to insert before.
          if (depth === 0) return /\{/.test(l) ? -1 : i
        }
      }
    }
    return -1
  }
  const inserts = new Map<number, string[]>()
  const indentOf = (i: number) => /^(\s*)/.exec(out[i - 1] ?? '')?.[1] ?? '  '
  for (const a of additions) {
    let at = a.afterGroup ? closing(0, out.length, a.afterGroup) : -1
    if (at < 0) at = closing(0, out.length)
    if (at < 0) return undefined
    const indent = indentOf(at) || '  '
    inserts.set(at, [...(inserts.get(at) ?? []), `${indent}${a.line}`])
  }
  // Layout hints, once, right after the graph opens.
  if (positions && !/\blayout\s*=/.test(text)) {
    const open = out.findIndex((l) => /\{/.test(l))
    if (open >= 0) inserts.set(open + 1, ['  layout=neato; inputscale=72; overlap=true; splines=true;', ...(inserts.get(open + 1) ?? [])])
  }
  const result: string[] = []
  for (let i = 0; i < out.length; i++) {
    if (inserts.has(i)) result.push(...inserts.get(i)!)
    if (!removeLines.has(i)) result.push(out[i])
  }
  return result.join('\n')
}
