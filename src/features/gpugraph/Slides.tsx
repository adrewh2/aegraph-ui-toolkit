import { memo, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { BookOpenText, ChevronLeft, ChevronRight, Eye, EyeOff, Frame, Layers, Plus, Presentation, X } from 'lucide-react'
import { useEntityStore, useStoreDataVersion } from '../../core/entity/hooks'
import type { EntityId } from '../../core/entity/types'
import type { SlidesView } from '../../core/graph/scene'
import { blockMembers, placementKey, readStories, wireId, createDeck, createSlide, leafBlocks, readBlocks, readDecks, shownDecks, type DeckInfo, type PlacedSlide } from '../../core/slides/slides'
import { displayLabel } from '../../core/entity/entity'
import { Dialog } from '../../components/ui/Dialog'
import { Select } from '../../components/ui/Select'
import { useToast } from '../../components/ui/useToast'
import { prefersReducedMotion } from '../../lib/motion'
import { keyIsElsewhere } from '../../lib/keys'
import type { GraphEngine } from './engine/engine'
import { SlideLayer } from './SlideLayer'

interface Props {
  engine: GraphEngine | null
  view: SlidesView
  selectedIds: EntityId[]
  setSlides: (patch: Partial<SlidesView>) => void
  select: (ids: EntityId[], mode: 'replace' | 'add') => void
  /** Receives the function that turns the camera to a slide (for the view's handle and the tools). */
  faceRef: React.MutableRefObject<((id: EntityId, ms?: number) => boolean) | null>
}

/**
 * The 3D view's slides: the layer (`SlideLayer`) and the bar under the
 * picture that drives it — which decks hang, the slide in front and the
 * ones either side of it, and a slide made from the selection. A click on
 * a card puts it in front and selects what it shows; a double-click, the
 * arrows on the bar or Page Up / Page Down also turn the camera to face it.
 * The store is read here, not in the view around it, so a change to the
 * data re-renders the bar and the cards only.
 */
export const Slides = memo(function Slides({ engine, view, selectedIds, setSlides, select, faceRef }: Props) {
  const store = useEntityStore()
  const version = useStoreDataVersion(store)
  // A stable list while nothing about the slides changed: the layer re-places them only when they do.
  const all = useStable(useMemo(() => readDecks(store), [store, version]))
  const blocks = useStable(useMemo(() => readBlocks(store), [store, version]))
  const stories = useStable(useMemo(() => readStories(store), [store, version]))
  const decks = useMemo(() => shownDecks(all, view.decks), [all, view.decks])
  const shownStories = useMemo(() => {
    const ids = new Set(decks.map((d) => d.id))
    return stories.filter((st) => st.deck && ids.has(st.deck))
  }, [stories, decks])
  // Over the decks shown, as the arrangement reads them: a story told in a deck that is not up does not lift the ring.
  const composed = useMemo(() => decks.some((d) => d.slides.some((s) => s.compose)), [decks])
  const told = useMemo(() => shownStories.some((st) => st.beats.length) && decks.some((d) => d.slides.some((s) => s.beat)), [shownStories, decks])
  const parts = view.parts !== false
  // A project with stories shows the whole stack unless its view says otherwise; without, the story and blueprint
  // layers stay off until asked for.
  const story = told && (view.story ?? true)
  const spatial = composed && (view.spatial ?? told)
  const final = view.final !== false
  const switches = useMemo(() => ({ parts, story, spatial }), [parts, story, spatial])

  const labelOf = useCallback((id: EntityId) => {
    const e = store.get(id)
    return e ? displayLabel(e) : undefined
  }, [store])
  const placed = useRef(new Map<EntityId, PlacedSlide>())
  /** The arrangement `placed` is of, and the one the view asks for now: a face asked between them waits for the new one. */
  const placedKey = useRef('')
  const wantKey = useRef('')
  const pendingFace = useRef<{ id: EntityId; ms?: number } | null>(null)
  const engineRef = useRef(engine)
  engineRef.current = engine
  const faceTimer = useRef(0)
  const [making, setMaking] = useState(false)

  wantKey.current = placementKey(decks, switches)
  const order = useMemo(() => decks.flatMap((d) => d.slides.map((s) => ({ s, d }))), [decks])
  const focusAt = view.focus ? order.findIndex((o) => o.s.id === view.focus) : -1
  const focused = focusAt >= 0 ? order[focusAt] : undefined

  const face = useCallback(
    (id: EntityId, ms = 650) => {
      // The decks or the plates just changed: the slides are about to move, so the camera waits for where they land.
      if (view.show && placedKey.current !== wantKey.current) {
        pendingFace.current = { id, ms }
        return true
      }
      const p = placed.current.get(id)
      if (!engine || engine.dims !== 3 || !p) return false
      const cam = engine.camera3
      // Bringing a slide forward selects what it shows, and the details pane opening for it narrows the view a moment
      // later — the engine holds the picture still through a resize, which would leave the slide off to one side. If
      // the view changes size while the camera flies, the flight is taken again to the new size.
      const w0 = cam.width, h0 = cam.height
      // One pending retake at a time: a slide faced since takes over.
      window.clearTimeout(faceTimer.current)
      faceTimer.current = window.setTimeout(() => {
        if (engineRef.current === engine && (cam.width !== w0 || cam.height !== h0)) faceRef.current?.(id, 250)
      }, 350)
      // Square on to the card and a little above it, far enough that it fills most of the view with the web under it.
      const t = Math.tan(cam.fov / 2)
      const aspect = cam.width / Math.max(1, cam.height)
      const yaw = Math.atan2(p.normal[0], p.normal[2])
      const pitch = Math.asin(Math.max(-1, Math.min(1, p.normal[1]))) + 0.22
      // A composed slide with its plates hung: the view takes in the slide and the plates it is made of, the lines between.
      const slide = all.flatMap((d) => d.slides).find((s) => s.id === id)
      const compose = slide?.compose
      // What hangs under the slide in its column: its blueprint and its beats, or its plates.
      const column = [wireId(id), ...(slide?.beat ? stories.flatMap((st) => st.beats).filter((b) => b.id === slide.beat || b.parent === slide.beat).map((b) => b.id) : [])]
      const stacked = column.map((c) => placed.current.get(c)).filter((x): x is PlacedSlide => !!x)
      const under = stacked.length ? stacked : compose && parts ? leafBlocks(compose, blocks).map((b) => placed.current.get(b.id)).filter((x): x is PlacedSlide => !!x) : []
      if (under.length) {
        const bottom = Math.min(...under.map((u) => u.center[1] - u.height / 2))
        const top = p.center[1] + p.height / 2
        const distance = Math.max((top - bottom) / (2 * t * 0.72), p.width / (2 * t * aspect * 0.6))
        cam.animateTo({ tx: p.center[0], ty: (top + bottom) / 2 - (top - bottom) * 0.04, tz: p.center[2], distance, yaw, pitch: pitch - 0.08, canonical: true }, prefersReducedMotion() ? 0 : ms)
        engine.cameraChanged()
        return true
      }
      const distance = Math.max(p.height / (2 * t * 0.5), p.width / (2 * t * aspect * 0.62))
      // The card a touch above the middle of the view: the beams fall into the lower part.
      cam.animateTo({ tx: p.center[0], ty: p.center[1] - p.height * 0.35, tz: p.center[2], distance, yaw, pitch, canonical: true }, prefersReducedMotion() ? 0 : ms)
      engine.cameraChanged()
      return true
    },
    [engine, all, blocks, parts, stories, view.show],
  )
  faceRef.current = face

  const bring = useCallback(
    (id: EntityId, opts: { face?: boolean; add?: boolean } = {}) => {
      const slide = all.flatMap((d) => d.slides).find((s) => s.id === id)
      if (!slide) return
      setSlides({ focus: id })
      select(slide.members.filter((m) => store.has(m)), opts.add ? 'add' : 'replace')
      if (opts.face) face(id)
    },
    [all, face, select, setSlides, store],
  )

  const step = useCallback(
    (by: number) => {
      if (!order.length) return
      const next = focusAt < 0 ? (by > 0 ? 0 : order.length - 1) : (focusAt + by + order.length) % order.length
      bring(order[next].s.id, { face: true })
    },
    [bring, focusAt, order],
  )

  // Page Down / Page Up (what a presenter's clicker sends) and ] / [ step through the slides shown.
  useEffect(() => {
    if (!view.show || !order.length) return
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || keyIsElsewhere(e)) return
      // Only the view in front takes them: a pane behind, or another page, is not presenting.
      const host = engine?.container
      if (!host?.isConnected || host.offsetParent === null) return
      // And only when the page has nothing else focused that pages through itself — a side panel, a table.
      const t = e.target as Node | null
      if (t && t !== document.body && !host.closest('.gg')?.contains(t)) return
      if (e.key === 'PageDown' || e.key === ']') step(1)
      else if (e.key === 'PageUp' || e.key === '[') step(-1)
      else return
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [engine, order.length, step, view.show])

  const live = useRef({ bring, select, stories, blocks, store, face })
  live.current = { bring, select, stories, blocks, store, face }
  const onCardClick = useCallback((id: EntityId, keys: { shift: boolean; meta: boolean }) => live.current.bring(id, { add: keys.shift || keys.meta }), [])
  const onCardOpen = useCallback((id: EntityId) => live.current.bring(id, { face: true }), [])
  const onPlaced = useCallback((m: Map<EntityId, PlacedSlide>, key: string) => {
    placed.current = m
    placedKey.current = key
    const pending = pendingFace.current
    if (pending && key === wantKey.current) {
      pendingFace.current = null
      live.current.face(pending.id, pending.ms)
    }
  }, [])
  const onBeatClick = useCallback((id: EntityId, keys: { shift: boolean; meta: boolean }) => {
    const { stories: st, store: s, select: sel } = live.current
    sel((st.flatMap((x) => x.beats).find((b) => b.id === id)?.cites ?? []).filter((m) => s.has(m)), keys.shift || keys.meta ? 'add' : 'replace')
  }, [])
  const onBlockClick = useCallback((id: EntityId, keys: { shift: boolean; meta: boolean }) => {
    const { blocks: b, store: s, select: sel } = live.current
    sel(blockMembers(id, b).filter((m) => s.has(m)), keys.shift || keys.meta ? 'add' : 'replace')
  }, [])

  // With no deck yet the bar is only the way to make the first slide, and only once something is selected to show.
  const empty = !all.length
  if (empty && !selectedIds.length) return null
  const only = view.decks && view.decks.length === 1 ? view.decks[0] : undefined
  return (
    <>
      {view.show && !empty && (
        <SlideLayer
          engine={engine}
          decks={decks}
          focus={view.focus}
          onClick={onCardClick}
          onOpen={onCardOpen}
          onPlaced={onPlaced}
          blocks={blocks}
          parts={parts}
          stories={shownStories}
          story={story}
          spatial={spatial}
          final={final}
          onBeatClick={onBeatClick}
          labelOf={labelOf}
          onBlockClick={onBlockClick}
        />
      )}
      <div className="gg-slidebar" role="toolbar" aria-label="Slides">
        {!empty && (<>
        <button className="btn btn--sm btn--icon btn--ghost" title={view.show ? 'Hide the slides' : 'Show the slides'} aria-pressed={view.show} onClick={() => setSlides({ show: !view.show })}>
          {view.show ? <Eye size={13} /> : <EyeOff size={13} />}
        </button>
        {view.show && told && (
          <button className={`btn btn--sm btn--icon ${story ? '' : 'btn--ghost'}`} title={story ? 'Hide the story layer' : 'Show the story: each deck\'s outline, beat by beat, citing what it draws on'} aria-pressed={story} onClick={() => setSlides({ story: !story })}>
            <BookOpenText size={13} style={{ opacity: story ? 1 : 0.45 }} />
          </button>
        )}
        {view.show && composed && (
          <button className={`btn btn--sm btn--icon ${spatial ? '' : 'btn--ghost'}`} title={spatial ? 'Hide the blueprints' : 'Show each slide\'s blueprint: its frame and the rectangles of its regions'} aria-pressed={spatial} onClick={() => setSlides({ spatial: !spatial })}>
            <Frame size={13} style={{ opacity: spatial ? 1 : 0.45 }} />
          </button>
        )}
        {view.show && (told || composed) && (
          <button className={`btn btn--sm btn--icon ${final ? '' : 'btn--ghost'}`} title={final ? 'Hide the finished slides' : 'Show the finished slides'} aria-pressed={final} onClick={() => setSlides({ final: !final })}>
            <Presentation size={13} style={{ opacity: final ? 1 : 0.45 }} />
          </button>
        )}
        {view.show && composed && !story && !spatial && (
          <button className={`btn btn--sm btn--icon ${parts ? '' : 'btn--ghost'}`} title={parts ? 'Fold the blocks into their slides' : 'Hang each slide’s blocks beneath it'} aria-pressed={parts} onClick={() => setSlides({ parts: !parts })}>
            <Layers size={13} style={{ opacity: parts ? 1 : 0.45 }} />
          </button>
        )}
        {view.show && (
          <>
            <div className="gg-slidebar__decks thin-scroll">
              <button className={`gg-chip${view.decks ? '' : ' is-on'}`} aria-pressed={!view.decks} onClick={() => setSlides({ decks: undefined })} title="Every deck">
                All
              </button>
              {all.map((d) => {
                const on = !view.decks || view.decks.includes(d.id)
                return (
                  <button
                    key={d.id}
                    className={`gg-chip${view.decks && on ? ' is-on' : ''}`}
                    style={{ ['--deck' as string]: d.color }}
                    aria-pressed={!!view.decks && on}
                    title={`${d.label} — ${d.slides.length} slide${d.slides.length === 1 ? '' : 's'}${d.description ? `. ${d.description}` : ''} (⇧-click to add or remove)`}
                    onClick={(e) => {
                      if (e.shiftKey && view.decks) {
                        const next = on ? view.decks.filter((x) => x !== d.id) : [...view.decks, d.id]
                        setSlides({ decks: next.length ? next : undefined })
                      } else setSlides({ decks: only === d.id ? undefined : [d.id], focus: view.focus && d.slides.some((s) => s.id === view.focus) ? view.focus : undefined })
                    }}
                  >
                    <span className="gg-chip__dot" />
                    {d.label}
                  </button>
                )
              })}
            </div>
            <span className="gg-slidebar__sep" />
            <button className="btn btn--sm btn--icon btn--ghost" title="Previous slide (Page Up)" onClick={() => step(-1)} disabled={!order.length}>
              <ChevronLeft size={14} />
            </button>
            <span className="gg-slidebar__now" title={focused ? focused.s.label : 'No slide in front'}>
              {focused ? (
                <>
                  <span className="gg-chip__dot" style={{ ['--deck' as string]: focused.d.color }} />
                  {focused.d.slides.indexOf(focused.s) + 1}/{focused.d.slides.length} · {focused.s.label}
                </>
              ) : (
                `${order.length} slide${order.length === 1 ? '' : 's'}`
              )}
            </span>
            <button className="btn btn--sm btn--icon btn--ghost" title="Next slide (Page Down)" onClick={() => step(1)} disabled={!order.length}>
              <ChevronRight size={14} />
            </button>
            {focused && (
              <button
                className="btn btn--sm btn--icon btn--ghost"
                title="Back to the whole picture"
                onClick={() => {
                  setSlides({ focus: undefined })
                  engine?.fit({ padding: 0.04, ms: prefersReducedMotion() ? 0 : 500 })
                }}
              >
                <X size={13} />
              </button>
            )}
          </>
        )}
        <span className="gg-slidebar__sep" />
        </>)}
        <button className="btn btn--sm" disabled={!selectedIds.length} title={selectedIds.length ? `A new slide showing the ${selectedIds.length.toLocaleString()} selected` : 'Select what the slide should show first'} onClick={() => setMaking(true)}>
          <Plus size={13} /> Slide
        </button>
      </div>
      <NewSlideDialog
        open={making}
        decks={all}
        defaultDeck={only ?? focused?.d.id}
        members={selectedIds}
        onClose={() => setMaking(false)}
        onMade={(id, deck) => {
          setMaking(false)
          if (view.decks && !view.decks.includes(deck)) setSlides({ decks: [...view.decks, deck] })
          setSlides({ show: true, focus: id })
        }}
      />
    </>
  )
})

/** A new slide from the selection: its title, its deck (or a new one), a few lines. */
function NewSlideDialog({ open, decks, defaultDeck, members, onClose, onMade }: { open: boolean; decks: DeckInfo[]; defaultDeck?: EntityId; members: EntityId[]; onClose: () => void; onMade: (id: EntityId, deck: EntityId) => void }) {
  const store = useEntityStore()
  const toast = useToast()
  const uid = useId()
  const real = decks.filter((d) => store.has(d.id))
  const [title, setTitle] = useState('')
  const [deck, setDeck] = useState<string>('')
  const [newDeck, setNewDeck] = useState('')
  const [body, setBody] = useState('')
  useEffect(() => {
    if (!open) return
    setTitle('')
    setBody('')
    setNewDeck('')
    setDeck(defaultDeck && store.has(defaultDeck) ? defaultDeck : (real[0]?.id ?? '+new'))
    // Only when it opens: the defaults are the deck in front at that moment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])
  const make = () => {
    const label = title.trim()
    if (!label) return
    try {
      const deckId = deck === '+new' ? createDeck(store, { label: newDeck.trim() || 'New deck' }).id : deck
      const { slide, members: shown } = createSlide(store, { deck: deckId, label, body, members })
      toast(`Slide “${label}” shows ${shown.length.toLocaleString()} entit${shown.length === 1 ? 'y' : 'ies'}`)
      onMade(slide.id, deckId)
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err))
    }
  }
  return (
    <Dialog
      open={open}
      title="New slide"
      description={`A slide showing the ${members.length.toLocaleString()} selected — it hangs over the graph with a beam to each of them.`}
      onClose={onClose}
      footer={
        <>
          <button className="btn btn--sm" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn--sm btn--primary" disabled={!title.trim()} onClick={make}>
            Make slide
          </button>
        </>
      }
    >
      <div className="field">
        <label htmlFor={`${uid}-title`}>Title</label>
        <input id={`${uid}-title`} className="input" autoFocus value={title} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && make()} />
      </div>
      <div className="field">
        <label>Deck</label>
        <Select value={deck} onChange={(e) => setDeck(e.target.value)} aria-label="Deck">
          {real.map((d) => (
            <option key={d.id} value={d.id}>
              {d.label}
            </option>
          ))}
          <option value="+new">New deck…</option>
        </Select>
      </div>
      {deck === '+new' && (
        <div className="field">
          <label htmlFor={`${uid}-deck`}>New deck’s name</label>
          <input id={`${uid}-deck`} className="input" value={newDeck} onChange={(e) => setNewDeck(e.target.value)} />
        </div>
      )}
      <div className="field">
        <label htmlFor={`${uid}-body`}>Text</label>
        <textarea id={`${uid}-body`} className="input" rows={4} placeholder={'- one line per point\n- **bold** for what matters'} value={body} onChange={(e) => setBody(e.target.value)} />
      </div>
    </Dialog>
  )
}

/**
 * The same value while it reads the same, so a store change elsewhere does not re-place the slides. Compared only
 * when the input is a new object (a store change), never on a render that merely passed the same one in.
 */
function useStable<T>(value: T): T {
  const ref = useRef<{ input: T | undefined; key: string; value: T }>({ input: undefined, key: '', value })
  if (value !== ref.current.input) {
    const key = JSON.stringify(value instanceof Map ? [...value] : value)
    ref.current = key === ref.current.key ? { ...ref.current, input: value } : { input: value, key, value }
  }
  return ref.current.value
}
