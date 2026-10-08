import { Globe } from 'lucide-react'
import { useState } from 'react'
import { useToast } from '../../components/ui/useToast'
import { requireExternalServices } from '../account/settings'
import { graphFormat, type GraphFormat } from '../../core/exchange/graph/graphFormats'

interface Props {
  busy: boolean
  say: (line: string) => void
  /** Hands the fetched file to the graph import wizard (mapping preview, then merge). */
  onImport: (format: GraphFormat, files: File[]) => void
  /** Opens the sample: the DBpedia demo project. */
  onSample: () => void
}

/**
 * The sample: a demo project in the aegraph-ui-demos repository — a slice of DBpedia built with SPARQL CONSTRUCT and
 * imported through this same RDF importer (its generator keeps the N-Triples and the script that fetched them).
 */
export const DBPEDIA_DEMO_ID = 'dbpedia-programming-languages'

/** `Berlin`, `dbr:Berlin`, `https://dbpedia.org/resource/Berlin`, `https://dbpedia.org/page/Berlin` → the resource's N-Triples URL; any other URL is fetched as it is. */
export function dbpediaDataUrl(input: string): string {
  const s = input.trim()
  const m = /^(?:https?:\/\/(?:[a-z]+\.)?dbpedia\.org\/(?:resource|page|data)\/|dbr:)(.+?)(?:\.(?:ntriples|nt|ttl|json|rdf|n3))?$/i.exec(s)
  if (m) return `https://dbpedia.org/data/${encodeURIComponent(decodeURIComponent(m[1])).replace(/%2C/g, ',').replace(/%28/g, '(').replace(/%29/g, ')')}.ntriples`
  if (/^https?:\/\//i.test(s)) return s
  return `https://dbpedia.org/data/${encodeURIComponent(s.replace(/ /g, '_'))}.ntriples`
}

/**
 * Linked data: RDF files (N-Triples, Turtle, N-Quads, TriG) from DBpedia,
 * Wikidata or anywhere. Drop one on the page, fetch a DBpedia resource by
 * name, or open the sample (a demo project). Everything else goes through
 * the graph import wizard, which shows the types, tags and predicates it found before
 * anything is written; entities keep their IRIs as ids, so a second file
 * about the same things extends them rather than duplicating.
 */
export function LinkedDataCard({ busy, say, onImport, onSample }: Props) {
  const toast = useToast()
  const [query, setQuery] = useState('')
  const [fetching, setFetching] = useState(false)

  const fetchInto = async (label: string, urls: string[]) => {
    setFetching(true)
    try {
      const parts: string[] = []
      requireExternalServices('Linked-data import')
      for (const url of urls) {
        const res = await fetch(url, { headers: { Accept: 'application/n-triples, text/turtle;q=0.9, */*;q=0.1' } })
        if (!res.ok) throw new Error(`${res.status} ${res.statusText} fetching ${url}`)
        const text = await res.text()
        if (/^\s*</.test(text) && /<html/i.test(text.slice(0, 300))) throw new Error(`${url} answered with a web page, not RDF (DBpedia may be down for maintenance)`)
        parts.push(text)
        say(`Fetched ${url} · ${Math.round(text.length / 1024)} KB`)
      }
      const name = urls.length === 1 ? decodeURIComponent(urls[0].split('/').pop() ?? 'linked-data') : `${label.replace(/[^\w.-]+/g, '_')}.nt`
      const fname = /\.(nt|ntriples|ttl|nq|trig|n3)$/i.test(name) ? name : `${name}.nt`
      onImport(graphFormat('rdf'), [new File([parts.join('\n')], fname, { type: 'application/n-triples' })])
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      say(`${label}: ${msg}`)
      toast(/Failed to fetch|NetworkError/.test(msg) ? 'Could not reach that server (offline, or no CORS) — download the file and drop it here instead' : msg)
    } finally {
      setFetching(false)
    }
  }

  const fetchResources = () => {
    const names = query
      .split(/[,\n]/)
      .map((s) => s.trim())
      .filter(Boolean)
    if (!names.length) return
    void fetchInto(names.length === 1 ? names[0] : `${names.length} DBpedia resources`, names.map(dbpediaDataUrl))
  }

  return (
    <section className="ds__card">
      <header>
        <span className="ds__icon" style={{ background: '#fef3c7', color: '#92400e' }}>
          <Globe size={18} />
        </span>
        <div>
          <h2>Linked data · DBpedia</h2>
          <p>
            RDF as entities: N-Triples, Turtle, N-Quads or TriG from DBpedia, Wikidata or any linked-data source. Subjects become entities under their IRI (<code>dbr:Berlin</code>), <code>rdf:type</code> picks the type, <code>rdfs:label</code> and <code>rdfs:comment</code> the label and description, other literals become data, categories become tags, and every other link becomes a relationship — the wizard shows what it found before writing. Drop a file on this page, fetch a resource from DBpedia by name, or open the sample, a demo project made this way.
          </p>
        </div>
      </header>
      <div className="ds__actions">
        <button className="btn btn--primary" disabled={busy || fetching} onClick={onSample} title="The demo project: a slice of DBpedia — ~100 programming languages, who designed them, what influenced what, paradigms, licences — built with SPARQL CONSTRUCT and imported through this importer">
          Programming languages (DBpedia)
        </button>
        <input
          className="input"
          style={{ flex: '1 1 260px', minWidth: 200 }}
          placeholder="DBpedia resource(s) or an RDF URL — Berlin, Ada_Lovelace, https://…/x.ttl"
          value={query}
          disabled={busy || fetching}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && fetchResources()}
          spellCheck={false}
        />
        <button className="btn" disabled={busy || fetching || !query.trim()} onClick={fetchResources}>
          {fetching ? 'Fetching…' : 'Fetch'}
        </button>
      </div>
    </section>
  )
}
