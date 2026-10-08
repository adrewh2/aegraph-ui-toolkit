import { DOMParser } from '@xmldom/xmldom'

/**
 * The GEXF and GraphML browser builds, for tests: vitest runs in node, where there is no `DOMParser`. The app reads
 * a graph file's document itself (`xml.ts › parseXmlDocument`, with the global `DOMParser`) and hands it to the
 * library, so the global and the library's `Document` must be one xmldom: the libraries' parsers made over the
 * xmldom the tests stub as the global.
 */
type Lib = { default?: unknown } & Record<string, unknown>
const documentClass = () => new DOMParser().parseFromString('<t/>', 'application/xml').constructor

export async function gexfBrowser() {
  const create = ((await import('graphology-gexf/common/parser.js' as string)) as Lib).default as (p: unknown, d: unknown) => unknown
  const node = (await import('graphology-gexf/node')) as unknown as Lib
  return { parse: create(DOMParser, documentClass()), write: node.write }
}

export async function graphmlBrowser() {
  const create = ((await import('graphology-graphml/common/parser.js' as string)) as Lib).default as (p: unknown, d: unknown) => unknown
  return { parse: create(DOMParser, documentClass()) }
}

export { DOMParser as XmlDomParser }
