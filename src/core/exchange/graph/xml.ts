export const xmlEscape = (s: unknown) => String(s ?? '').replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]!)

/** Infer the narrowest GraphML/GEXF attribute type for a set of values. */
export function inferAttrType(values: Iterable<unknown>): 'string' | 'int' | 'double' | 'boolean' {
  let type: 'string' | 'int' | 'double' | 'boolean' | undefined
  for (const v of values) {
    if (v === undefined || v === null) continue
    const t = typeof v === 'boolean' ? 'boolean' : typeof v === 'number' ? (Number.isInteger(v) ? 'int' : 'double') : 'string'
    if (!type) type = t
    else if (type !== t) {
      if ((type === 'int' && t === 'double') || (type === 'double' && t === 'int')) type = 'double'
      else return 'string'
    }
  }
  return type ?? 'string'
}

/**
 * A graph file's text as an XML document, read with the platform's `DOMParser` (no external entities are resolved).
 * A document type declaration is refused before it is parsed: GraphML and GEXF never need one, and an internal
 * subset's entities are the one way XML text grows past its own size as it is read.
 */
export function parseXmlDocument(text: string, what: string): Document {
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new Error(`This ${what} file declares a document type (<!DOCTYPE> or <!ENTITY>), which aegraph does not read. Remove the declaration and import it again.`)
  const Parser = (globalThis as { DOMParser?: typeof DOMParser }).DOMParser
  if (!Parser) throw new Error(`Reading ${what} needs a browser's DOMParser.`)
  const doc = new Parser().parseFromString(text, 'application/xml')
  if (doc.getElementsByTagName('parsererror').length) throw new Error(`This ${what} file is not well-formed XML.`)
  return doc
}
