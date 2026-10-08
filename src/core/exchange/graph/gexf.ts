import { MultiGraph } from 'graphology'
import { fromGraphology, toGraphology } from './graphology'
import { checkGraphShape } from './limits'
import { isObjectMachinery, type ExportFile, type GraphExportInput, type ParsedGraph } from './model'
import { parseXmlDocument } from './xml'

/**
 * GEXF 1.2 (what Gephi reads and writes), via graphology-gexf's browser build. Loaded lazily: it needs DOMParser.
 *
 * The document is read here first (`checkGexf`): an attribute's id, title or `for` that a plain object already
 * answers to is refused, since the library keys its model and every node's attributes by them; and list-typed
 * attributes (`liststring`, `listinteger`…) are read as text and split here, in one pass, because the library splits
 * them with a regular expression that takes time quadratic in a run of spaces.
 */
export async function parseGexf(text: string): Promise<ParsedGraph> {
  const doc = parseXmlDocument(text, 'GEXF')
  const lists = checkGexf(doc)
  checkGraphShape('The GEXF file', { nodes: doc.getElementsByTagName('node'), edges: doc.getElementsByTagName('edge') })
  const { parse } = await import('graphology-gexf/browser')
  const g = parse(MultiGraph, doc, { addMissingNodes: true, allowUndeclaredAttributes: true })
  const p = fromGraphology(g)
  const split = (attrs: Record<string, unknown>, declared: Map<string, string>) => {
    for (const [title, sub] of declared) {
      const v = attrs[title]
      if (typeof v === 'string') attrs[title] = splitGexfList(v).map((piece) => gexfScalar(sub, piece))
    }
  }
  if (lists.node.size) for (const n of p.nodes) split(n.attrs, lists.node)
  if (lists.edge.size) for (const e of p.edges) split(e.attrs, lists.edge)
  return p
}

/**
 * Refuses a GEXF document whose attribute names would reach an object's machinery, and turns its list-typed
 * attributes into strings, returning them (title → item type, per class) to be split after the parse.
 */
export function checkGexf(doc: Document): { node: Map<string, string>; edge: Map<string, string> } {
  const refuse = (what: string, name: string) => new Error(`This GEXF file uses ${JSON.stringify(name)} as ${what}, a name aegraph does not read from a file. Rename it and import again.`)
  if (!doc.getElementsByTagName('graph')[0]) throw new Error('This GEXF file has no <graph> element.')
  const lists = { node: new Map<string, string>(), edge: new Map<string, string>() }
  for (const group of Array.from(doc.getElementsByTagName('attributes'))) {
    const cls = group.getAttribute('class')
    for (const a of Array.from(group.getElementsByTagName('attribute'))) {
      const id = a.getAttribute('id') || a.getAttribute('for') || ''
      for (const name of [a.getAttribute('id'), a.getAttribute('for'), a.getAttribute('title')]) if (name !== null && isObjectMachinery(name)) throw refuse('an attribute name', name)
      const type = a.getAttribute('type') ?? 'string'
      if (!type.startsWith('list')) continue
      // The library's own rule for what an attribute is called: its title when its id is a number, else its id.
      const title = !Number.isNaN(+id) ? a.getAttribute('title') || id : id
      if (cls === 'node' || cls === 'edge') lists[cls].set(title, type.slice(4))
      a.setAttribute('type', 'string')
    }
  }
  for (const v of Array.from(doc.getElementsByTagName('attvalue'))) {
    for (const name of [v.getAttribute('id'), v.getAttribute('for')]) if (name !== null && isObjectMachinery(name)) throw refuse('an attribute name', name)
  }
  return lists
}

/** A GEXF list value as its items: `[a, "b c"]`, `a|b` or `a, b` — read in one pass, whatever its length. */
export function splitGexfList(s: string): string[] {
  if (s.length >= 2 && s[0] === '[' && s[s.length - 1] === ']') return listPieces(s.slice(1, -1))
  const sep = s.includes('|') ? '|' : s.includes(',') ? ',' : undefined
  if (!sep) return [s]
  const parts = s.split(sep)
  // What `/\s*,\s*/` would split on: the separator with the whitespace either side of it.
  return parts.map((p, i) => {
    let q = p
    if (i > 0) q = q.trimStart()
    if (i < parts.length - 1) q = q.trimEnd()
    return q
  })
}

const isSpace = (c: string) => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === '\v'
const ESCAPES: Record<string, string> = { n: '\n', t: '\t', r: '\r', '\\': '\\' }

/** The items of a bracketed list: comma-separated, each optionally quoted, with backslash escapes. */
function listPieces(s: string): string[] {
  const out: string[] = []
  let i = 0
  while (i < s.length) {
    while (i < s.length && isSpace(s[i])) i++
    if (i >= s.length) break
    if (s[i] === ',') {
      i++
      continue
    }
    const quote = s[i] === '"' || s[i] === "'" ? s[i++] : ''
    let piece = ''
    while (i < s.length) {
      const c = s[i]
      if (!quote && c === ',') break
      if (quote && c === quote) {
        i++
        break
      }
      if (c === '\\' && i + 1 < s.length) {
        const nx = s[i + 1]
        piece += Object.hasOwn(ESCAPES, nx) ? ESCAPES[nx] : nx
        i += 2
        continue
      }
      piece += c
      i++
    }
    out.push(piece)
    while (i < s.length && s[i] !== ',') i++
    i++
  }
  return out
}

/** One item of a GEXF list as its declared type, as the library reads a scalar. */
function gexfScalar(type: string, s: string): unknown {
  if (!type || type === 'string') return s
  if (type === 'boolean') return s === 'true'
  if (type === 'byte' || type === 'short' || type === 'integer' || type === 'long' || type === 'float' || type === 'double') return +s
  return s
}

export async function writeGexf(input: GraphExportInput): Promise<ExportFile[]> {
  const { write } = await import('graphology-gexf/browser')
  const text = write(toGraphology(input), { version: '1.2', pretty: false })
  return [{ name: `${input.name ?? 'graph'}.gexf`, text, mime: 'application/gexf+xml' }]
}
