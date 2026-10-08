import { MultiGraph } from 'graphology'
import { fromGraphology, toGraphology } from './graphology'
import { checkGraphShape } from './limits'
import { isObjectMachinery, type ExportFile, type GraphExportInput, type ParsedGraph } from './model'
import { inferAttrType, parseXmlDocument, xmlEscape } from './xml'

/**
 * GraphML: parsed with graphology-graphml (browser build, lazy), written by hand — the library has no writer.
 *
 * The library keeps a file's keys in plain objects indexed by what the file says (`models[for][id]`,
 * `defaults[for][attr.name]`), so `<key for="__proto__">` would write onto every object in the tab and
 * `for="constructor"` over `Object`'s own functions. The document is therefore read here first (`checkGraphml`) and
 * handed over only once every name in it is one of its own.
 */
export async function parseGraphml(text: string): Promise<ParsedGraph> {
  const doc = checkGraphml(parseXmlDocument(text, 'GraphML'))
  checkGraphShape('The GraphML file', { nodes: doc.getElementsByTagName('node'), edges: doc.getElementsByTagName('edge') })
  const { parse } = await import('graphology-graphml/browser')
  const g = parse(MultiGraph, doc, { addMissingNodes: true })
  const p = fromGraphology(g)
  // The parser applies edgedefault to every edge; a `directed` attribute (ours, or yEd/NetworkX style) is authoritative.
  for (const e of p.edges) {
    const d = e.attrs.directed
    if (d !== undefined) {
      e.directed = d === true || d === 'true' || d === 1 || d === '1'
      delete e.attrs.directed
    }
  }
  return p
}

const KEY_SCOPES = new Set(['graph', 'node', 'edge', 'all'])
const KEY_TYPES = new Set(['boolean', 'int', 'long', 'float', 'double', 'string'])

/**
 * A GraphML document made safe to hand to graphology-graphml, or refused with a sentence: a `<key>` is for the graph,
 * nodes, edges or all of them (`all` is spelt out as one key per scope, which the library does not read); its id,
 * `attr.name` and every `<data key>` are names of the file's own, never one a plain object already answers to
 * (`__proto__`, `constructor`, `toString`…); an `attr.type` the library has no caster for is read as a string.
 */
export function checkGraphml(doc: Document): Document {
  const refuse = (what: string, name: string) => new Error(`This GraphML file uses ${JSON.stringify(name)} as ${what}, a name aegraph does not read from a file. Rename it and import again.`)
  if (!doc.getElementsByTagName('graph')[0]) throw new Error('This GraphML file has no <graph> element.')
  for (const key of Array.from(doc.getElementsByTagName('key'))) {
    const scope = key.getAttribute('for') || 'node'
    if (!KEY_SCOPES.has(scope)) throw refuse('a key\'s scope (for=)', scope)
    const id = key.getAttribute('id') ?? ''
    const name = key.getAttribute('attr.name') ?? ''
    if (isObjectMachinery(id)) throw refuse('a key id', id)
    if (isObjectMachinery(name)) throw refuse('an attribute name', name)
    const type = key.getAttribute('attr.type')
    if (type !== null && !KEY_TYPES.has(type)) key.setAttribute('attr.type', 'string')
    if (scope === 'all') {
      for (const s of ['graph', 'node', 'edge']) {
        const copy = key.cloneNode(true) as Element
        copy.setAttribute('for', s)
        key.parentNode?.insertBefore(copy, key)
      }
      key.parentNode?.removeChild(key)
    }
  }
  for (const data of Array.from(doc.getElementsByTagName('data'))) {
    const k = data.getAttribute('key') ?? ''
    if (isObjectMachinery(k)) throw refuse('a data key', k)
  }
  return doc
}

export async function writeGraphml(input: GraphExportInput): Promise<ExportFile[]> {
  return [{ name: `${input.name ?? 'graph'}.graphml`, text: graphmlString(input), mime: 'application/graphml+xml' }]
}

export function graphmlString(input: GraphExportInput): string {
  const g = toGraphology(input)
  const nodeAttrs = new Map<string, unknown[]>()
  const edgeAttrs = new Map<string, unknown[]>()
  const collect = (map: Map<string, unknown[]>, attrs: Record<string, unknown>) => {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null) continue
      const val = Array.isArray(v) ? v.join(';') : v
      const list = map.get(k)
      if (list) list.push(val)
      else map.set(k, [val])
    }
  }
  g.forEachNode((_, a) => collect(nodeAttrs, a))
  g.forEachEdge((_, a, _s, _t, _sa, _ta, undirected) => collect(edgeAttrs, { ...a, directed: !undirected }))
  const keys: string[] = []
  const keyId = (scope: 'node' | 'edge', name: string) => `${scope[0]}_${name.replace(/[^A-Za-z0-9_.-]/g, '_')}`
  for (const [name, vals] of nodeAttrs) keys.push(`<key id="${keyId('node', name)}" for="node" attr.name="${xmlEscape(name)}" attr.type="${inferAttrType(vals)}"/>`)
  for (const [name, vals] of edgeAttrs) keys.push(`<key id="${keyId('edge', name)}" for="edge" attr.name="${xmlEscape(name)}" attr.type="${inferAttrType(vals)}"/>`)
  const data = (scope: 'node' | 'edge', attrs: Record<string, unknown>) =>
    Object.entries(attrs)
      .filter(([, v]) => v !== undefined && v !== null)
      .map(([k, v]) => `<data key="${keyId(scope, k)}">${xmlEscape(Array.isArray(v) ? v.join(';') : v)}</data>`)
      .join('')
  const nodes: string[] = []
  g.forEachNode((id, a) => nodes.push(`<node id="${xmlEscape(id)}">${data('node', a)}</node>`))
  const edges: string[] = []
  g.forEachEdge((id, a, s, t, _sa, _ta, undirected) => edges.push(`<edge id="${xmlEscape(id)}" source="${xmlEscape(s)}" target="${xmlEscape(t)}"${undirected ? ' directed="false"' : ''}>${data('edge', { ...a, directed: !undirected })}</edge>`))
  return `<?xml version="1.0" encoding="UTF-8"?>\n<graphml xmlns="http://graphml.graphdrawing.org/xmlns" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://graphml.graphdrawing.org/xmlns http://graphml.graphdrawing.org/xmlns/1.0/graphml.xsd">\n${keys.join('\n')}\n<graph id="G" edgedefault="directed">\n${nodes.join('\n')}\n${edges.join('\n')}\n</graph>\n</graphml>\n`
}
