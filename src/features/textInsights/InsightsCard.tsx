import { MessageSquareText, Sparkles, Table2, Tag as TagIcon, X } from 'lucide-react'
import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useDismiss } from '../../components/ui/useDismiss'
import { entityHref, pickHref } from '../../app/openIn'
import { displayLabel } from '../../core/entity/entity'
import { useEntityStore, useTypeRegistry } from '../../core/entity/hooks'
import { textInsights } from '../../core/entity/textInsights'
import type { AnyEntity } from '../../core/entity/types'
import { askAssistant } from '../assistant/ask'
import './textInsights.css'

/** Rows shown per section before "Show all". */
const SHOWN = 8
const WIDTH = 360

/**
 * The Insights card: what in the open project a selected passage names (entities by name or alias), tags (tags by
 * name) and is found in (entities whose text holds a short selection) — `core/entity/textInsights.ts`. It sits under
 * the selection; a row opens the entity, a tag the entities that carry it, and the footer hands the lot to the
 * Entities table or the question to the assistant. The entity being read is left out of its own insights. Back from
 * where a row led brings the card again (`TextSelectionMenu`).
 */
export function InsightsCard({ text, rect, onClose, onLeave }: { text: string; rect: DOMRect; onClose: () => void; /** Called before a row or the footer takes the app elsewhere, so Back can bring the card again. */ onLeave?: () => void }) {
  const store = useEntityStore()
  const registry = useTypeRegistry()
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const ref = useRef<HTMLDivElement>(null)
  useDismiss(onClose, { inside: () => [ref.current] })

  const found = useMemo(() => {
    // The page's own entity — the document the text is in — named in the address.
    const exclude = pathname
      .split('/')
      .map((p) => {
        try {
          return decodeURIComponent(p)
        } catch {
          return p
        }
      })
      .filter((p) => p && store.get(p))
    return textInsights(store, text, { exclude, skip: (e) => registry.categoryOf(e.type) === 'schema' })
    // Once per card: the answer is about the moment the words were picked.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Under the selection, inside the window; above it when there is no room below.
  const [pos, setPos] = useState({ left: rect.left, top: rect.bottom + 8 })
  useLayoutEffect(() => {
    const h = ref.current?.getBoundingClientRect().height ?? 0
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - WIDTH - 8))
    const below = rect.bottom + 8
    const top = below + h > window.innerHeight - 8 ? Math.max(8, rect.top - h - 8) : below
    setPos({ left, top })
  }, [rect])

  const open = (to: string) => {
    onLeave?.()
    onClose()
    navigate(to)
  }
  const quote = text.trim().replace(/\s+/g, ' ')
  const all = [...found.named.map((m) => m.entity), ...found.mentions]
  const nothing = !found.named.length && !found.tags.length && !found.mentions.length

  const row = (e: AnyEntity, note?: string) => (
    <button key={e.id} className="tins__row" onClick={() => open(entityHref(e, registry))} title={e.id}>
      <span className="tins__label">{displayLabel(e)}</span>
      <span className="tins__type">{note ?? e.type}</span>
    </button>
  )

  return (
    <div ref={ref} className="tins" role="dialog" aria-label="Insights" style={{ left: pos.left, top: pos.top, width: WIDTH }}>
      <header className="tins__head">
        <Sparkles size={14} />
        <span className="tins__title">Insights</span>
        <span className="tins__quote" title={quote}>
          “{quote.length > 60 ? `${quote.slice(0, 57)}…` : quote}”
        </span>
        <button className="btn btn--sm btn--icon btn--ghost" onClick={onClose} aria-label="Close">
          <X size={13} />
        </button>
      </header>
      <div className="tins__body thin-scroll">
        {nothing && <p className="muted tins__none">Nothing in this project is named, tagged or written like this.</p>}
        {found.named.length > 0 && (
          <section>
            <h4>
              Named here <span className="faint">{found.namedTotal}</span>
            </h4>
            {found.named.slice(0, SHOWN).map((m) => row(m.entity, m.how === 'partial' ? `${m.entity.type} · contains it` : m.entity.type))}
          </section>
        )}
        {found.tags.length > 0 && (
          <section>
            <h4>Tags</h4>
            <div className="tins__tags">
              {found.tags.slice(0, SHOWN * 2).map((t) => (
                <button key={t.tag} className="tins__tag" onClick={() => open(pickHref(store.withTag(t.tag).map((e) => e.id), `Tagged ${t.tag}`))} title={`Every entity tagged ${t.tag}`}>
                  <TagIcon size={11} /> {t.tag} <span className="faint">{t.count.toLocaleString()}</span>
                </button>
              ))}
            </div>
          </section>
        )}
        {found.mentions.length > 0 && (
          <section>
            <h4>
              Mentioned in <span className="faint">{found.mentionsTotal}</span>
            </h4>
            {found.mentions.slice(0, SHOWN).map((e) => row(e))}
          </section>
        )}
      </div>
      <footer className="tins__foot">
        {all.length > 0 && (
          <button className="btn btn--sm" onClick={() => open(pickHref(all.map((e) => e.id), `Related to “${quote.slice(0, 40)}”`))}>
            <Table2 size={13} /> Show all in Entities
          </button>
        )}
        <span className="spacer" />
        <button
          className="btn btn--sm btn--ghost"
          onClick={() => {
            onClose()
            askAssistant(`What in the project relates to this passage, and how?\n\n> ${quote.slice(0, 2000)}`)
          }}
        >
          <MessageSquareText size={13} /> Ask the assistant
        </button>
      </footer>
    </div>
  )
}
