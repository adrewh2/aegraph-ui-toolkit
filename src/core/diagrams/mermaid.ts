import { addEdge, emptyDiagram, findNode, MAX_DIAGRAM_EDGES, upsertNode, type DiagramKind, type ParsedDiagram } from './model'

/**
 * Mermaid: parsers for the diagram types that carry graph structure —
 * flowchart/graph, classDiagram, erDiagram, stateDiagram(-v2), mindmap —
 * plus a flowchart writer. Sequence diagrams are recognised but only their
 * participants are extracted.
 *
 * These are deliberately independent of the mermaid package (which needs a
 * DOM), so imports are deterministic and testable; rendering uses mermaid.
 *
 * Every diagram is parsed when the Diagrams page draws it, and its text can
 * come from anywhere, so no pattern here may take more than time linear in a
 * line, or quadratic in a short one: a line longer than `MAX_LINE` is left
 * out with a warning before any expression sees it, and a class diagram's
 * relationships are read by splitting (`classRelation`) — the one pattern
 * that did it took minutes over a thousand dashes.
 */

/** The longest line read: far past any diagram a person writes, short enough that no pattern below can stall on it. */
export const MAX_LINE = 2_000

/** A source's lines without `%%` comments or blank lines — and without lines longer than `MAX_LINE`, counted in `d`'s warnings. */
function stripComments(src: string, d?: ParsedDiagram): string[] {
  const out: string[] = []
  let long = 0
  for (const raw of src.split('\n')) {
    if (raw.length > MAX_LINE) {
      long++
      continue
    }
    const l = raw.replace(/%%.*$/, '')
    if (l.trim() !== '') out.push(l)
  }
  if (long && d) d.warnings.push(`${long} line${long === 1 ? '' : 's'} longer than ${MAX_LINE.toLocaleString('en-US')} characters left out.`)
  return out
}

/** Which diagram a Mermaid source declares. */
export function mermaidKind(src: string): DiagramKind {
  const first = stripComments(src.replace(/^---[\s\S]*?---\s*/, ''))[0]?.trim().toLowerCase() ?? ''
  if (/^(flowchart|graph)\b/.test(first)) return 'flowchart'
  if (/^classdiagram/.test(first)) return 'classDiagram'
  if (/^erdiagram/.test(first)) return 'erDiagram'
  if (/^statediagram/.test(first)) return 'stateDiagram'
  if (/^mindmap/.test(first)) return 'mindmap'
  if (/^sequencediagram/.test(first)) return 'sequenceDiagram'
  return 'unknown'
}

export function parseMermaid(src: string): ParsedDiagram {
  // Drop YAML front matter.
  const body = src.replace(/^---[\s\S]*?---\s*/, '')
  const kind = mermaidKind(body)
  switch (kind) {
    case 'flowchart':
      return parseFlowchart(body)
    case 'classDiagram':
      return parseClassDiagram(body)
    case 'erDiagram':
      return parseErDiagram(body)
    case 'stateDiagram':
      return parseStateDiagram(body)
    case 'mindmap':
      return parseMindmap(body)
    case 'sequenceDiagram':
      return parseSequence(body)
    default: {
      const d = emptyDiagram('mermaid', 'unknown')
      d.warnings.push('Unrecognised Mermaid diagram type; nothing imported.')
      return d
    }
  }
}

// ── Flowchart ──────────────────────────────────────────────────────────

/** Node shape by bracket pair. Order matters: longer openers first. */
const SHAPES: [string, string, string][] = [
  ['(((', ')))', 'double-circle'],
  ['[[', ']]', 'subroutine'],
  ['[(', ')]', 'cylinder'],
  ['((', '))', 'circle'],
  ['{{', '}}', 'hexagon'],
  ['[/', '/]', 'parallelogram'],
  ['[\\', '\\]', 'parallelogram-alt'],
  ['[/', '\\]', 'trapezoid'],
  ['[\\', '/]', 'trapezoid-alt'],
  ['([', '])', 'stadium'],
  ['>', ']', 'asymmetric'],
  ['[', ']', 'box'],
  ['(', ')', 'rounded'],
  ['{', '}', 'diamond'],
]

const unquote = (s: string) =>
  s
    .trim()
    .replace(/^"(.*)"$/s, '$1')
    .replace(/^'(.*)'$/s, '$1')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/#quot;/g, '"')

/** Parse `id[Label]:::cls` → { id, label?, shape?, classes }, consuming from `s`. Returns rest. */
function readNode(s: string): { id: string; label?: string; shape?: string; classes: string[]; rest: string } | undefined {
  const m = /^\s*([A-Za-z0-9_.-]+)/.exec(s)
  // An id needs a word character: `-->` at the start of a line is not a node called `--`.
  if (!m || !/[A-Za-z0-9_]/.test(m[1])) return undefined
  const id = m[1]
  let rest = s.slice(m[0].length)
  let label: string | undefined
  let shape: string | undefined
  // `id@{ shape: x, label: "y" }` (new syntax)
  const at = /^@\{([^}]*)\}/.exec(rest)
  if (at) {
    const kv = Object.fromEntries([...at[1].matchAll(/(\w+)\s*:\s*("[^"]*"|[^,]+)/g)].map((x) => [x[1], unquote(x[2])]))
    label = kv.label
    shape = kv.shape
    rest = rest.slice(at[0].length)
  } else {
    for (const [open, close, name] of SHAPES) {
      if (rest.startsWith(open)) {
        // A quoted label may hold the closing bracket: the closer is the one after the closing quote.
        const quoted = rest[open.length] === '"' ? rest.indexOf('"', open.length + 1) : -1
        const end = rest.indexOf(close, quoted >= 0 ? quoted + 1 : open.length)
        if (end < 0) continue // not this pair: `[/x\]` opens like a parallelogram but closes like a trapezoid
        label = unquote(rest.slice(open.length, end))
        shape = name
        rest = rest.slice(end + close.length)
        break
      }
    }
  }
  const classes: string[] = []
  const cls = /^:::([A-Za-z0-9_-]+)/.exec(rest)
  if (cls) {
    classes.push(cls[1])
    rest = rest.slice(cls[0].length)
  }
  return { id, label, shape, classes, rest }
}

/** Parse an arrow: `-->`, `---`, `-.->`, `==>`, `--text-->`, `-->|text|`, `<-->`, `--o`, `--x`. */
function readArrow(s: string): { label?: string; style: string; directed: boolean; rest: string } | undefined {
  // shaft, optional inline text closed by another shaft (`-- text -->`), optional head, optional |label|
  const m = /^\s*(<?)([-=.]+)(?:\s*([^-=.<>|\s][^<>|]*?)\s*([-=.]+))?(>|o|x)?\s*(?:\|([^|]*)\|)?/.exec(s)
  if (!m) return undefined
  const body = m[2] + (m[4] ?? '')
  const label = m[6] !== undefined ? unquote(m[6]) : m[3] !== undefined ? unquote(m[3]) : undefined
  const style = body.includes('.') ? 'dotted' : body.includes('=') ? 'thick' : 'solid'
  const head = m[5]
  const directed = !!head || !!m[1]
  return { label, style: head === 'o' ? `${style} circle` : head === 'x' ? `${style} cross` : style, directed, rest: s.slice(m[0].length) }
}

export function parseFlowchart(src: string): ParsedDiagram {
  const d = emptyDiagram('mermaid', 'flowchart')
  const lines = stripComments(src, d)
  const header = /^\s*(flowchart|graph)\s*([A-Za-z]{2})?/.exec(lines[0] ?? '')
  if (header?.[2]) d.attrs.direction = header[2].toUpperCase()
  const groupStack: string[] = []
  const classDefs = new Map<string, string>()
  const pendingLinkStyles: [string, Record<string, string>][] = []

  for (const raw of lines.slice(1)) {
    let line = raw.trim().replace(/;$/, '')
    if (!line) continue
    const sub = /^subgraph\s+(.+)$/.exec(line)
    if (sub) {
      const m = /^([A-Za-z0-9_.-]+)\s*(?:\[(.*)\])?$/.exec(sub[1].trim())
      const id = m ? m[1] : sub[1].trim()
      const label = m?.[2] !== undefined ? unquote(m[2]) : unquote(sub[1])
      d.groups.push({ id, label, parent: groupStack[groupStack.length - 1], attrs: {} })
      groupStack.push(id)
      continue
    }
    if (/^end$/.test(line)) {
      groupStack.pop()
      continue
    }
    if (/^direction\s+/.test(line)) continue
    const cd = /^classDef\s+([A-Za-z0-9_,-]+)\s+(.*)$/.exec(line)
    if (cd) {
      for (const c of cd[1].split(',')) classDefs.set(c, cd[2])
      continue
    }
    const cl = /^class\s+([A-Za-z0-9_,.\-\s]+)\s+([A-Za-z0-9_-]+)$/.exec(line)
    if (cl) {
      for (const id of cl[1].split(',').map((x) => x.trim()).filter(Boolean)) upsertNode(d, id, { classes: [cl[2]] })
      continue
    }
    if (/^(style|linkStyle|click)\s/.test(line)) {
      const st = /^style\s+([A-Za-z0-9_-]+)\s+(.*)$/.exec(line)
      if (st) upsertNode(d, st[1], { attrs: colourAttrs(st[2]) })
      const ls = /^linkStyle\s+([0-9,\s]+|default)\s+(.*)$/.exec(line)
      if (ls) pendingLinkStyles.push([ls[1], colourAttrs(ls[2])])
      continue
    }
    // Node/edge chain: A --> B & C --> D
    let rest = line
    let prev: string[] | null = null
    let pendingArrow: ReturnType<typeof readArrow> | undefined
    let guard = 0
    while (rest.trim() && guard++ < 100) {
      const group: string[] = []
      for (;;) {
        const n = readNode(rest)
        if (!n) break
        upsertNode(d, n.id, { ...(n.label !== undefined ? { label: n.label } : {}), ...(n.shape ? { shape: n.shape } : {}), classes: n.classes, group: groupStack[groupStack.length - 1] })
        group.push(n.id)
        rest = n.rest
        const amp = /^\s*&\s*/.exec(rest)
        if (!amp) break
        rest = rest.slice(amp[0].length)
      }
      if (group.length === 0) {
        d.warnings.push(`could not parse: ${line}`)
        break
      }
      if (prev) {
        const arrow = pendingArrow
        pairs: for (const s of prev)
          for (const t of group) {
            const full = d.edges.length >= MAX_DIAGRAM_EDGES
            addEdge(d, { source: s, target: t, label: arrow?.label, directed: arrow?.directed ?? true, style: arrow?.style, attrs: {} })
            if (full) break pairs
          }
      }
      prev = group
      const a = readArrow(rest)
      if (!a) break
      pendingArrow = a
      rest = a.rest
    }
  }
  for (const n of d.nodes) for (const c of n.classes) if (classDefs.has(c)) n.attrs[`classDef:${c}`] = classDefs.get(c)!
  // linkStyle indexes edges in declaration order, which is the order they were added.
  for (const [which, attrs] of pendingLinkStyles) {
    const targets = which === 'default' ? d.edges : which.split(',').map((i) => d.edges[Number(i.trim())]).filter(Boolean)
    for (const e of targets) Object.assign(e.attrs, attrs)
  }
  return d
}

/** Mermaid `fill:#x,stroke:#y,color:#z,stroke-width:2px` → the DOT-style colour attributes the model uses everywhere. */
function colourAttrs(css: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const part of css.split(',')) {
    const [k, ...rest] = part.split(':')
    const v = rest.join(':').trim()
    if (!v) continue
    switch (k.trim()) {
      case 'fill':
        out.fillcolor = v
        break
      case 'stroke':
        out.color = v
        break
      case 'color':
        out.fontcolor = v
        break
      case 'stroke-width':
        out.penwidth = v.replace(/px$/, '')
        break
      case 'stroke-dasharray':
        out.style = 'dashed'
        break
    }
  }
  return out
}

// ── Class diagram ──────────────────────────────────────────────────────

/** Arrow → relationship style and which side is the source (the child / owner / dependant). */
const CLASS_ARROWS: [RegExp, string, 'ltr' | 'rtl'][] = [
  [/<\|--/, 'inheritance', 'rtl'],
  [/--\|>/, 'inheritance', 'ltr'],
  [/<\|\.\./, 'realization', 'rtl'],
  [/\.\.\|>/, 'realization', 'ltr'],
  [/\*--/, 'composition', 'ltr'],
  [/--\*/, 'composition', 'rtl'],
  [/o--/, 'aggregation', 'ltr'],
  [/--o/, 'aggregation', 'rtl'],
  [/<--/, 'association', 'rtl'],
  [/-->/, 'association', 'ltr'],
  [/<\.\./, 'dependency', 'rtl'],
  [/\.\.>/, 'dependency', 'ltr'],
  [/--/, 'link', 'ltr'],
  [/\.\./, 'dashed link', 'ltr'],
]

const CLASS_ID = /^[A-Za-z0-9_.\-~<>]+$/
const ARROW = /^[<|*o.\->]+$/
const isArrow = (s: string) => ARROW.test(s) && (s.includes('--') || s.includes('..'))

/**
 * A relationship line, `A "1" <|-- "many" B : label`, as its parts — or undefined when it is not one. Read by
 * splitting on whitespace and quotes, then on the arrow's shaft (`--` or `..`) when the arrow is written against a
 * name (`A<|--B`): time linear in the line, where one regular expression over the same grammar backtracked through
 * every way of sharing a run of dashes between the names and the arrow.
 */
export function classRelation(line: string): { a: string; cardA?: string; arrow: string; cardB?: string; b: string; label?: string } | undefined {
  const colon = line.indexOf(':')
  const head = colon >= 0 ? line.slice(0, colon) : line
  const label = colon >= 0 ? line.slice(colon + 1).trim() : undefined
  const toks: { q: boolean; v: string }[] = []
  for (let i = 0; i < head.length; ) {
    const c = head[i]
    if (c === ' ' || c === '\t') {
      i++
      continue
    }
    if (c === '"') {
      const e = head.indexOf('"', i + 1)
      if (e < 0) return undefined
      toks.push({ q: true, v: head.slice(i + 1, e) })
      i = e + 1
    } else {
      let j = i
      while (j < head.length && head[j] !== ' ' && head[j] !== '\t' && head[j] !== '"') j++
      for (const v of splitAttached(head.slice(i, j))) toks.push({ q: false, v })
      i = j
    }
    if (toks.length > 5) return undefined
  }
  const words = toks.filter((t) => !t.q)
  if (words.length !== 3 || toks[0].q || toks[toks.length - 1].q) return undefined
  const [a, arrow, b] = words.map((t) => t.v)
  if (!CLASS_ID.test(a) || !CLASS_ID.test(b) || !isArrow(arrow)) return undefined
  const at = toks.indexOf(words[1])
  const cardA = toks[at - 1]?.q ? toks[at - 1].v : undefined
  const cardB = toks[at + 1]?.q ? toks[at + 1].v : undefined
  // Nothing but the names, the arrow and a cardinality either side of it.
  if (toks.length !== 3 + (cardA !== undefined ? 1 : 0) + (cardB !== undefined ? 1 : 0)) return undefined
  return { a, cardA, arrow, cardB, b, label: label || undefined }
}

/** A word holding an arrow written against a name or two (`A<|--B`, `A--`, `-->B`) as its parts; other words whole. */
function splitAttached(word: string): string[] {
  if (isArrow(word)) return [word]
  const dash = word.indexOf('--')
  const dot = word.indexOf('..')
  const core = dash < 0 ? dot : dot < 0 ? dash : Math.min(dash, dot)
  if (core < 0) return [word]
  let start = core
  while (start > 0 && start > core - 2 && '<|*'.includes(word[start - 1])) start--
  let end = core + 2
  while (end < word.length && (word[end] === word[core] || ('>|*'.includes(word[end]) && end < core + 4))) end++
  return [word.slice(0, start), word.slice(start, end), word.slice(end)].filter((p) => p !== '')
}

export function parseClassDiagram(src: string): ParsedDiagram {
  const d = emptyDiagram('mermaid', 'classDiagram')
  const lines = stripComments(src, d).slice(1)
  let current: string | null = null
  for (const raw of lines) {
    const line = raw.trim()
    if (current) {
      if (line === '}') {
        current = null
        continue
      }
      addMember(d, current, line)
      continue
    }
    const decl = /^class\s+([A-Za-z0-9_.\-~<>]+)(?:\s*\[\s*"?([^"\]]*)"?\s*\])?\s*(\{)?$/.exec(line)
    if (decl) {
      upsertNode(d, decl[1], { label: decl[2] ?? decl[1], shape: 'class' })
      if (decl[3]) current = decl[1]
      continue
    }
    const member = /^([A-Za-z0-9_.-]+)\s*:\s*(.+)$/.exec(line)
    if (member && !/[-.<>|*o]{2,}/.test(line)) {
      upsertNode(d, member[1], { shape: 'class' })
      addMember(d, member[1], member[2])
      continue
    }
    const ann = /^<<(\w+)>>\s+([A-Za-z0-9_.-]+)$/.exec(line)
    if (ann) {
      upsertNode(d, ann[2], { shape: 'class', classes: [ann[1]] })
      continue
    }
    const ns = /^namespace\s+([A-Za-z0-9_.-]+)\s*\{?$/.exec(line)
    if (ns) {
      d.groups.push({ id: ns[1], label: ns[1], attrs: {} })
      continue
    }
    if (line === '}') continue // the namespace's closing brace
    // Relationship: A "1" <|-- "many" B : label
    const rel = classRelation(line)
    if (rel) {
      const found = CLASS_ARROWS.find(([re]) => re.test(rel.arrow))
      const style = found?.[1] ?? 'link'
      const dir = found?.[2] ?? 'ltr'
      const [a, b] = dir === 'ltr' ? [rel.a, rel.b] : [rel.b, rel.a]
      upsertNode(d, rel.a, { shape: 'class' })
      upsertNode(d, rel.b, { shape: 'class' })
      const attrs: Record<string, string> = {}
      if (rel.cardA) attrs[dir === 'ltr' ? 'sourceCardinality' : 'targetCardinality'] = rel.cardA
      if (rel.cardB) attrs[dir === 'ltr' ? 'targetCardinality' : 'sourceCardinality'] = rel.cardB
      addEdge(d, { source: a, target: b, label: rel.label, directed: true, style, attrs })
      continue
    }
    if (line && !/^(direction|classDef|class|style|click|note|link|callback)\b/.test(line)) d.warnings.push(`could not parse: ${line}`)
  }
  return d
}

function addMember(d: ParsedDiagram, cls: string, line: string) {
  const n = upsertNode(d, cls, { shape: 'class' })
  const m = line.trim()
  if (!m || m === '}') return
  const isMethod = /\(.*\)/.test(m)
  const key = isMethod ? 'methods' : 'attributes'
  n.attrs[key] = n.attrs[key] ? `${n.attrs[key]}\n${m}` : m
}

// ── ER diagram ─────────────────────────────────────────────────────────

const erCard = (s: string) => (Object.hasOwn(ER_CARD, s) ? ER_CARD[s] : s)
const ER_CARD: Record<string, string> = { '||': 'exactly one', '|o': 'zero or one', 'o|': 'zero or one', '}|': 'one or more', '|{': 'one or more', '}o': 'zero or more', 'o{': 'zero or more' }

export function parseErDiagram(src: string): ParsedDiagram {
  const d = emptyDiagram('mermaid', 'erDiagram')
  const lines = stripComments(src, d).slice(1)
  let current: string | null = null
  for (const raw of lines) {
    const line = raw.trim()
    if (current) {
      if (line === '}') {
        current = null
        continue
      }
      const n = upsertNode(d, current, { shape: 'entity' })
      n.attrs.attributes = n.attrs.attributes ? `${n.attrs.attributes}\n${line}` : line
      continue
    }
    const rel = /^("[^"]*"|[A-Za-z0-9_-]+)\s+([|}o]{1,2})([.-]{2})([|{o]{1,2})\s+("[^"]*"|[A-Za-z0-9_-]+)\s*:\s*(.+)$/.exec(line)
    if (rel) {
      const a = unquote(rel[1])
      const b = unquote(rel[5])
      upsertNode(d, a, { shape: 'entity' })
      upsertNode(d, b, { shape: 'entity' })
      addEdge(d, { source: a, target: b, label: unquote(rel[6]), directed: true, style: rel[3] === '..' ? 'non-identifying' : 'identifying', attrs: { sourceCardinality: erCard(rel[2]), targetCardinality: erCard(rel[4]) } })
      continue
    }
    const ent = /^("[^"]*"|[A-Za-z0-9_-]+)(?:\s*\[\s*"?([^"\]]*)"?\s*\])?\s*(\{)?$/.exec(line)
    if (ent) {
      const id = unquote(ent[1])
      upsertNode(d, id, { label: ent[2] ?? id, shape: 'entity' })
      if (ent[3]) current = id
      continue
    }
    if (line) d.warnings.push(`could not parse: ${line}`)
  }
  return d
}

// ── State diagram ──────────────────────────────────────────────────────

export function parseStateDiagram(src: string): ParsedDiagram {
  const d = emptyDiagram('mermaid', 'stateDiagram')
  const lines = stripComments(src, d).slice(1)
  const stack: string[] = []
  const special = (s: string) => (s === '[*]' ? (stack.length ? `${stack[stack.length - 1]}.[*]` : '[*]') : s)
  for (const raw of lines) {
    const line = raw.trim()
    const comp = /^state\s+(?:"([^"]*)"\s+as\s+)?([A-Za-z0-9_-]+)\s*\{$/.exec(line)
    if (comp) {
      d.groups.push({ id: comp[2], label: comp[1] ?? comp[2], parent: stack[stack.length - 1], attrs: {} })
      stack.push(comp[2])
      continue
    }
    if (line === '}') {
      stack.pop()
      continue
    }
    const alias = /^state\s+"([^"]*)"\s+as\s+([A-Za-z0-9_-]+)$/.exec(line) ?? /^([A-Za-z0-9_-]+)\s*:\s*(.+)$/.exec(line)
    if (alias && !line.includes('-->')) {
      const [id, label] = line.startsWith('state') ? [alias[2], alias[1]] : [alias[1], alias[2]]
      upsertNode(d, id, { label, shape: 'state', group: stack[stack.length - 1] })
      continue
    }
    const ann = /^state\s+([A-Za-z0-9_-]+)\s+<<(\w+)>>$/.exec(line)
    if (ann) {
      upsertNode(d, ann[1], { shape: ann[2], group: stack[stack.length - 1] })
      continue
    }
    const tr = /^(\[\*\]|[A-Za-z0-9_-]+)\s*-->\s*(\[\*\]|[A-Za-z0-9_-]+)\s*(?::\s*(.+))?$/.exec(line)
    if (tr) {
      const a = special(tr[1])
      const b = special(tr[2])
      upsertNode(d, a, { shape: a.endsWith('[*]') ? 'terminal' : 'state', group: stack[stack.length - 1] })
      upsertNode(d, b, { shape: b.endsWith('[*]') ? 'terminal' : 'state', group: stack[stack.length - 1] })
      addEdge(d, { source: a, target: b, label: tr[3]?.trim(), directed: true, attrs: {} })
      continue
    }
    if (line && !/^(direction|note|end note|classDef|class|hide|--)/.test(line)) d.warnings.push(`could not parse: ${line}`)
  }
  return d
}

// ── Mindmap ────────────────────────────────────────────────────────────

export function parseMindmap(src: string): ParsedDiagram {
  const d = emptyDiagram('mermaid', 'mindmap')
  const lines = stripComments(src, d).slice(1)
  const stack: { indent: number; id: string }[] = []
  let counter = 0
  for (const raw of lines) {
    const indent = raw.match(/^\s*/)![0].length
    let text = raw.trim()
    let shape: string | undefined
    const icon = /::icon\((.*?)\)/.exec(text)
    if (icon) text = text.replace(icon[0], '').trim()
    const cls = /:::([A-Za-z0-9_-]+)/.exec(text)
    if (cls) text = text.replace(cls[0], '').trim()
    if (!text && (icon || cls)) {
      // `::icon(…)` or `:::class` on a line of its own decorates the node above it.
      const above = d.nodes[d.nodes.length - 1]
      if (above) {
        if (icon) above.attrs.icon = icon[1]
        if (cls) above.classes = [...new Set([...above.classes, cls[1]])]
      }
      continue
    }
    const shaped = /^([A-Za-z0-9_-]*)(\(\(|\)\)|\[|\(|\{\{|\)|\]|\}\})(.*?)(\)\)|\(\(|\]|\)|\}\}|\()$/.exec(text)
    let id: string
    let label: string
    if (shaped) {
      id = shaped[1] || `n${++counter}`
      label = unquote(shaped[3])
      shape = shaped[2] === '((' ? 'circle' : shaped[2] === '[' ? 'box' : shaped[2] === '(' ? 'rounded' : shaped[2] === '{{' ? 'hexagon' : 'cloud'
    } else {
      id = text.replace(/[^A-Za-z0-9_-]+/g, '_') || `n${++counter}`
      label = text
    }
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop()
    const parent = stack[stack.length - 1]?.id
    if (findNode(d, id)) id = `${id}_${++counter}`
    upsertNode(d, id, { label, shape, classes: cls ? [cls[1]] : [], attrs: icon ? { icon: icon[1] } : {} })
    if (parent) addEdge(d, { source: parent, target: id, directed: true, attrs: {} })
    stack.push({ indent, id })
  }
  return d
}

// ── Sequence (participants only) ───────────────────────────────────────

export function parseSequence(src: string): ParsedDiagram {
  const d = emptyDiagram('mermaid', 'sequenceDiagram')
  for (const raw of stripComments(src, d).slice(1)) {
    const line = raw.trim()
    const p = /^(participant|actor)\s+([A-Za-z0-9_-]+)(?:\s+as\s+(.+))?$/.exec(line)
    if (p) upsertNode(d, p[2], { label: p[3] ?? p[2], shape: p[1] })
    const msg = /^([A-Za-z0-9_]+)\s*(-{1,2}[>x)]+|-{1,2}>>|-x|--x)\s*([A-Za-z0-9_]+)\s*:\s*(.+)$/.exec(line)
    if (msg) {
      // A message names its ends; one declared as an actor stays one.
      for (const id of [msg[1], msg[3]]) upsertNode(d, id, findNode(d, id) ? {} : { shape: 'participant' })
      addEdge(d, { source: msg[1], target: msg[3], label: msg[4].trim(), directed: true, style: msg[2].includes('--') ? 'dotted' : 'solid', attrs: {} })
    }
  }
  d.warnings.push('Sequence diagrams import participants and messages only.')
  return d
}

// ── Writer (flowchart) ─────────────────────────────────────────────────

export interface MermaidWriteOptions {
  direction?: 'TB' | 'LR' | 'BT' | 'RL' | 'TD'
  /** Wrap nodes with the same group into subgraphs. */
  subgraphs?: boolean
  /** classDef fills keyed by class name. */
  classFills?: Record<string, string>
}

/** Words Mermaid's flowchart grammar reserves; a node with one of these ids fails to parse. */
const MM_RESERVED = new Set(['end', 'style', 'linkstyle', 'classdef', 'class', 'click', 'subgraph', 'direction', 'graph', 'flowchart', 'default', 'interpolate', 'call', 'href'])
/** Mermaid's spelling of an id: word characters only, never a keyword. Deterministic, so other formats can meet Mermaid halfway. */
export const mmId = (s: string) => {
  const id = /^[A-Za-z0-9_]+$/.test(s) ? s : 'n_' + s.replace(/[^A-Za-z0-9_]+/g, '_')
  return MM_RESERVED.has(id.toLowerCase()) ? `${id}_` : id
}
// An empty label is a parse error in Mermaid; a space draws an empty shape.
const mmLabel = (s: string) => `"${(s || ' ').replace(/"/g, '#quot;').replace(/\r?\n/g, '<br/>')}"`

const OPENERS: Record<string, [string, string]> = {
  box: ['[', ']'],
  rounded: ['(', ')'],
  stadium: ['([', '])'],
  subroutine: ['[[', ']]'],
  cylinder: ['[(', ')]'],
  circle: ['((', '))'],
  diamond: ['{', '}'],
  hexagon: ['{{', '}}'],
  parallelogram: ['[/', '/]'],
  // DOT / drawing shape names: an ellipse is a circle in Mermaid — the one round shape it has.
  ellipse: ['((', '))'],
  oval: ['((', '))'],
  note: ['[', ']'],
  record: ['[', ']'],
  plaintext: ['[', ']'],
  plain: ['[', ']'],
  point: ['((', '))'],
  doublecircle: ['(((', ')))'],
}

export function writeMermaid(d: ParsedDiagram, opts: MermaidWriteOptions = {}): string {
  const dir = opts.direction ?? (d.attrs.direction as MermaidWriteOptions['direction']) ?? (d.attrs.rankdir as MermaidWriteOptions['direction']) ?? 'TD'
  const lines = [`flowchart ${dir}`]
  const nodeLine = (n: typeof d.nodes[number], indent: string) => {
    const shape = (n.shape ?? '').toLowerCase()
    // A DOT `style=rounded` box is Mermaid's round-edged node.
    const rounded = (!shape || shape === 'box') && /\brounded\b/.test(n.attrs.style ?? '')
    const [o, c] = rounded ? ['(', ')'] : Object.hasOwn(OPENERS, shape) ? OPENERS[shape] : ['[', ']']
    const cls = n.classes.length ? `:::${n.classes[0]}` : ''
    return `${indent}${mmId(n.id)}${o}${mmLabel(n.label)}${c}${cls}`
  }
  /** Colours as Mermaid CSS, from the model's DOT-style attributes or captured geometry. */
  const css = (a: { fill?: string; stroke?: string; color?: string; width?: string }) => {
    const parts: string[] = []
    if (a.fill) parts.push(`fill:${a.fill}`)
    if (a.stroke) parts.push(`stroke:${a.stroke}`)
    if (a.color) parts.push(`color:${a.color}`)
    if (a.width && Number(a.width) !== 1) parts.push(`stroke-width:${a.width}px`)
    return parts.join(',')
  }
  const useGroups = opts.subgraphs ?? d.groups.length > 0
  const byGroup = new Map<string | undefined, typeof d.nodes>()
  for (const n of d.nodes) {
    const g = useGroups ? n.group : undefined
    const list = byGroup.get(g)
    if (list) list.push(n)
    else byGroup.set(g, [n])
  }
  for (const [g, nodes] of byGroup) {
    if (g) {
      const group = d.groups.find((x) => x.id === g)
      lines.push(`  subgraph ${mmId(g)} [${mmLabel(group?.label ?? g)}]`)
      for (const n of nodes) lines.push(nodeLine(n, '    '))
      lines.push('  end')
    } else for (const n of nodes) lines.push(nodeLine(n, '  '))
  }
  for (const e of d.edges) {
    const dotted = e.style?.includes('dotted') || e.style?.includes('dashed')
    const thick = e.style?.includes('thick') || e.style?.includes('bold')
    const shaft = dotted ? '-.-' : thick ? '==' : '--'
    const head = e.directed ? '>' : dotted ? '' : '-'
    const arrow = dotted && !e.directed ? '-.-' : `${shaft}${head}`
    lines.push(`  ${mmId(e.source)} ${arrow}${e.label ? `|${mmLabel(e.label)}|` : ''} ${mmId(e.target)}`)
  }
  for (const [cls, fill] of Object.entries(opts.classFills ?? {})) lines.push(`  classDef ${mmId(cls)} fill:${fill},stroke:#333,color:#111`)
  for (const n of d.nodes) {
    const geom = d.geometry?.nodes[n.id]
    const c = css({ fill: geom?.fill ?? n.attrs.fillcolor, stroke: geom?.stroke ?? n.attrs.color, color: geom?.color ?? n.attrs.fontcolor, width: geom?.strokeWidth !== undefined ? String(geom.strokeWidth) : n.attrs.penwidth })
    if (c) lines.push(`  style ${mmId(n.id)} ${c}`)
  }
  d.edges.forEach((e, i) => {
    const geom = d.geometry?.edges[e.id]
    const c = css({ stroke: geom?.stroke ?? e.attrs.color, width: geom?.strokeWidth !== undefined ? String(geom.strokeWidth) : e.attrs.penwidth })
    if (c) lines.push(`  linkStyle ${i} ${c}`)
  })
  return lines.join('\n') + '\n'
}
