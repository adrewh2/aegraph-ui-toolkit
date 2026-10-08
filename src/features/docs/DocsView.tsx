import { ArrowLeft, ArrowRight, BookOpen, Search, X } from 'lucide-react'
import { useEffect, useMemo, useState, type MouseEvent } from 'react'
import { Navigate, NavLink, useLocation, useNavigate, useParams } from 'react-router-dom'
import { Markdown } from '../../components/Markdown'
import { inlineText, parseMarkdown } from '../../lib/markdown'
import { createAppTools } from '../assistant/tools'
import { useAppHost } from '../assistant/useAppHost'
import { ModelView } from '../model/ModelView'
import { DOC_GROUPS, DOC_PAGES, docPage, type DocPage } from './pages'
import { toolReferenceMarkdown } from './toolReference'
import './DocsView.css'

/**
 * The in-app documentation, framed like the rest of the app: a rail of
 * pages in groups with a search that also looks inside pages, the page in
 * a surface with its own header and an outline of its sections, and
 * previous / next at the end. Pages are Markdown in `src/docs`; the data
 * model is a live page; the assistant page ends with a tool reference
 * generated from the live manifest so it never drifts.
 */
export function DocsView() {
  const { page } = useParams()
  if (!page) return <Navigate to={`/docs/${DOC_PAGES[0].id}`} replace />
  const doc = docPage(page)
  if (!doc) return <Navigate to={`/docs/${DOC_PAGES[0].id}`} replace />
  return <DocsPage doc={doc} />
}

function DocsPage({ doc }: { doc: DocPage }) {
  const navigate = useNavigate()
  const { hash } = useLocation()
  const host = useAppHost()
  const [q, setQ] = useState('')
  const generated = useMemo(() => {
    if (doc.generated !== 'tools') return ''
    const tools = createAppTools({ ...host, confirm: async () => false })
    return '\n\n' + toolReferenceMarkdown(tools)
    // The manifest is static per app build; the host only supplies closures.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc])
  const source = doc.source + generated
  // Sections for the outline; the h1 is the page title.
  const outline = useMemo(() => parseMarkdown(source).flatMap((b) => (b.t === 'heading' && (b.level === 2 || b.level === 3) ? [{ id: b.id, level: b.level, text: inlineText(b.c) }] : [])), [source])

  // Search: page titles and blurbs, and any page whose text contains the words.
  const needle = q.trim().toLowerCase()
  const matches = useMemo(() => {
    if (!needle) return null
    const terms = needle.split(/\s+/)
    return new Set(DOC_PAGES.filter((p) => terms.every((t) => `${p.title} ${p.blurb ?? ''} ${p.source}`.toLowerCase().includes(t))).map((p) => p.id))
  }, [needle])

  const index = DOC_PAGES.findIndex((p) => p.id === doc.id)
  const prev = DOC_PAGES[index - 1]
  const next = DOC_PAGES[index + 1]

  // Internal links stay in the router; hashes scroll within the page.
  const onClick = (e: MouseEvent<HTMLDivElement>) => {
    const a = (e.target as HTMLElement).closest('a')
    if (!a || e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey || a.target === '_blank') return
    const href = a.getAttribute('href') ?? ''
    if (href.startsWith('#')) {
      e.preventDefault()
      document.getElementById(href.slice(1))?.scrollIntoView({ block: 'start' })
      navigate({ hash: href }, { replace: true })
    } else if (href.startsWith('/') && !/\.[a-z0-9]+$/i.test(href)) {
      // App routes stay in the router; links to served files (/spec/….json) open as files.
      e.preventDefault()
      navigate(href)
    }
  }
  useEffect(() => {
    const el = document.querySelector('.docs__body')
    if (!hash) el?.scrollTo({ top: 0 })
    else document.getElementById(hash.slice(1))?.scrollIntoView({ block: 'start' })
  }, [hash, doc.id])

  return (
    <div className="docs">
      <div className="docs__head">
        <div className="docs__title">
          <BookOpen size={16} />
          <span>Documentation</span>
          <span className="muted">how aegraph is put together, and how to drive it</span>
        </div>
        <span className="spacer" />
        <label className="docs__search">
          <Search size={13} className="faint" />
          <input placeholder="Search the docs…" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && setQ('')} />
          {q && (
            <button className="btn btn--sm btn--icon btn--ghost" onClick={() => setQ('')} aria-label="Clear search">
              <X size={12} />
            </button>
          )}
        </label>
      </div>
      <div className="docs__body-wrap">
        <nav className="docs__rail" aria-label="Documentation pages">
          {DOC_GROUPS.map((g) => {
            const pages = matches ? g.pages.filter((p) => matches.has(p.id)) : g.pages
            if (!pages.length) return null
            return (
              <div key={g.title} className="docs__group">
                <div className="docs__group-title">{g.title}</div>
                {pages.map((p) => (
                  <NavLink key={p.id} to={`/docs/${p.id}`} className={({ isActive }) => `docs__link${isActive ? ' is-active' : ''}`} title={p.blurb}>
                    {p.title}
                  </NavLink>
                ))}
              </div>
            )
          })}
          {matches && matches.size === 0 && <div className="docs__nomatch muted">Nothing mentions “{q.trim()}”.</div>}
        </nav>
        <div className="docs__body">
          <article className="docs__page" onClick={onClick}>
            <header className="docs__page-head">
              <div>
                <h1 className="docs__page-title">{doc.title}</h1>
                {doc.blurb && <p className="docs__page-blurb muted">{doc.blurb}</p>}
              </div>
            </header>
            {doc.component === 'model' ? <ModelView embedded /> : <Markdown source={source.replace(/^#\s[^\n]*\n/, '')} className="docs__md" remoteImages />}
            <footer className="docs__pager">
              {prev ? (
                <NavLink to={`/docs/${prev.id}`} className="docs__pager-link">
                  <ArrowLeft size={14} />
                  <span>
                    <small className="muted">Previous</small>
                    {prev.title}
                  </span>
                </NavLink>
              ) : (
                <span />
              )}
              {next && (
                <NavLink to={`/docs/${next.id}`} className="docs__pager-link docs__pager-link--next">
                  <span>
                    <small className="muted">Next</small>
                    {next.title}
                  </span>
                  <ArrowRight size={14} />
                </NavLink>
              )}
            </footer>
          </article>
          {outline.length > 1 && (
            <aside className="docs__outline" aria-label="On this page">
              <div className="docs__group-title">On this page</div>
              {outline.map((h) => (
                <a key={h.id} href={`#${h.id}`} className={`docs__outline-link docs__outline-link--${h.level} ${hash === `#${h.id}` ? 'is-active' : ''}`}>
                  {h.text}
                </a>
              ))}
            </aside>
          )}
        </div>
      </div>
    </div>
  )
}
