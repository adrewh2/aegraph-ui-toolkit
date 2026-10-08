import { useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { storePick } from '../../app/openIn'
import { displayLabel } from '../../core/entity/entity'
import { useEntityStore } from '../../core/entity/hooks'
import type { EntityId } from '../../core/entity/types'
import { WorkstationView } from '../workstation/WorkstationView'
import { mountedHost } from '../workstation/hosts'
import { findPane, makePane, makeTab, panes, type Workstation } from '../workstation/model'
import { artifactPath, artifactsHostKey } from './artifactPath'
import { artifactKind, type ChatArtifact } from './artifacts'

/** Ask the panel to show an artifact (or, `graph`, Unigraph on all of them); `n` makes a repeat a new request. */
export interface ArtifactRequest {
  id: EntityId
  n: number
  graph?: boolean
}

/**
 * Artifacts are heavy views — a Unigraph engine, a map with its point layer, a diagram renderer — each with its own
 * GPU context and memory, and a browser keeps only so many GPU contexts alive at once. So the panel keeps the front
 * tab and the one before it mounted (not a pane's usual four), and holds at most MAX_TABS: opening another closes the
 * tab furthest from the front. A closed artifact reopens from the chat's Artifacts menu as it was saved.
 */
export const PANEL_WARM_TABS = 2
export const MAX_TABS = 8

const WIDTH_KEY = 'aegraph:chats:panel-width'
const MIN_W = 340
const readWidth = () => {
  try {
    const w = Number(localStorage.getItem(WIDTH_KEY))
    return Number.isFinite(w) && w >= MIN_W ? w : 0
  } catch {
    return 0
  }
}
const forget = (key: string) => {
  try {
    localStorage.removeItem(key)
  } catch {
    /* ignore */
  }
}

/**
 * The chat's artifacts, beside it: a pane host of tabs — the same one the Workstation, Entities and Unigraph use, in
 * its tabs-only dress and without splitting — so a document opens in its editor, a diagram in its workbench, a map
 * on its map, a scene in Unigraph, anything else in its detail view. It is not there until something is shown: it
 * slides in from the right when an artifact opens, and away again when its last tab is closed (or `open` goes
 * false). Its width is dragged at its left edge and remembered.
 */
export function ArtifactsPanel({ chatId, chatTitle, artifacts, requests, open, onEmpty }: { chatId: string; chatTitle: string; artifacts: ChatArtifact[]; requests: readonly ArtifactRequest[]; open: boolean; onEmpty: () => void }) {
  const key = artifactsHostKey(chatId)
  const store = useEntityStore()
  // The first tab of a host that has none stored yet; later tabs go through the mounted host.
  const [seed, setSeed] = useState<{ path: string; title: string } | null>(null)
  useEffect(() => setSeed(null), [key])
  const initial = useMemo(
    () => (): Workstation => {
      const pane = makePane([makeTab(seed?.path ?? '/artifact/', seed?.title)])
      return { root: pane, focused: pane.id }
    },
    [seed],
  )

  // Requests that arrive before the host has mounted wait for it — all of them, in order: the host may restore this
  // chat's tabs from last time, which a seed would not reach, and a turn that writes three documents asks for three
  // tabs before the panel is there (one waiting slot kept the last, and the one between was lost).
  const pending = useRef<{ path: string; title: string }[]>([])
  useEffect(() => {
    if (pending.current.length && mountedHost(key)) {
      const waiting = pending.current
      pending.current = []
      for (const p of waiting) show(p.path, p.title)
    }
  })

  const show = (path: string, title: string) => {
    const h = mountedHost(key)
    if (!h) {
      pending.current.push({ path, title })
      return setSeed((s) => s ?? { path, title })
    }
    const ws = h.get()
    for (const p of panes(ws.root)) {
      const i = p.tabs.findIndex((t) => t.path === path)
      if (i >= 0) {
        h.run({ type: 'focus', paneId: p.id })
        h.run({ type: 'activate', paneId: p.id, index: i })
        return
      }
    }
    const pane = findPane(ws.root, ws.focused) ?? panes(ws.root)[0]
    // Full: the tab opened longest ago (and not in front) makes room.
    const all = panes(ws.root).flatMap((p) => p.tabs.map((t, i) => ({ pane: p.id, tab: t, front: i === p.active })))
    for (const old of all.filter((x) => !x.front).slice(0, Math.max(0, all.length - MAX_TABS + 1))) h.run({ type: 'closeTab', paneId: old.pane, tabId: old.tab.id })
    h.run({ type: 'addTab', paneId: pane.id, tab: makeTab(path, title) })
  }

  // Asked from outside: the header's Artifacts menu, a tool card's Show, `?artifact=`, the chat tool — and the
  // assistant, once for each thing it makes. Every request since the last one handled is shown, in order, a tab each;
  // one whose entity is not in the store yet waits for the next change of the artifacts and is tried again.
  const handled = useRef(0)
  const unresolved = useRef<ArtifactRequest[]>([])
  useEffect(() => {
    const todo = [...unresolved.current, ...requests.filter((r) => r.n > handled.current)]
    unresolved.current = []
    for (const r of requests) handled.current = Math.max(handled.current, r.n)
    for (const r of todo) {
      if (r.graph) {
        show(`/unigraph/2d?only=${storePick(artifacts.map((a) => a.id), `${chatTitle} — artifacts`)}&fresh=1`, 'Graph of this chat')
        continue
      }
      const a = artifacts.find((x) => x.id === r.id)
      const e = a?.entity ?? store.get(r.id)
      if (e) show(artifactPath({ id: e.id, kind: a?.kind ?? artifactKind(e), entity: e }), displayLabel(e))
      else unresolved.current.push(r)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requests, artifacts])

  // Slides in and out: mounted at zero width, then widened, so the width change runs as a transition; on close it
  // narrows and unmounts when the transition ends.
  const [mounted, setMounted] = useState(open)
  const [shown, setShown] = useState(open)
  const ref = useRef<HTMLElement>(null)
  useEffect(() => {
    if (open) setMounted(true)
    else setShown(false)
  }, [open])
  useLayoutEffect(() => {
    if (!mounted || !open || shown) return
    ref.current?.getBoundingClientRect()
    setShown(true)
  }, [mounted, open, shown])

  const [width, setWidth] = useState(readWidth)
  const onDrag = (e: ReactPointerEvent) => {
    e.preventDefault()
    const right = ref.current!.getBoundingClientRect().right
    const parent = ref.current!.parentElement!.getBoundingClientRect()
    const move = (ev: PointerEvent) => setWidth(Math.round(Math.min(parent.width - 320, Math.max(MIN_W, right - ev.clientX))))
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      document.body.classList.remove('is-resizing')
      setWidth((w) => {
        try {
          localStorage.setItem(WIDTH_KEY, String(w))
        } catch {
          /* ignore */
        }
        return w
      })
    }
    document.body.classList.add('is-resizing')
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  if (!mounted) return null
  return (
    <aside
      ref={ref}
      className={`chats__panel ${shown ? 'is-open' : ''}`}
      style={shown && width ? { width } : undefined}
      aria-label="Artifacts"
      onTransitionEnd={(e) => {
        if (e.target === e.currentTarget && e.propertyName === 'width' && !open) setMounted(false)
      }}
    >
      <div className="chats__panel-grip" title="Drag to resize" onPointerDown={onDrag} />
      <div className="chats__host">
        <WorkstationView
          key={key}
          storageKey={key}
          initialWorkstation={initial}
          chrome="tabs"
          warmTabs={PANEL_WARM_TABS}
          splits={false}
          onLastTabClosed={() => {
            // Nothing left to show: the panel goes, and the next artifact starts it afresh.
            forget(key)
            onEmpty()
          }}
        />
      </div>
    </aside>
  )
}
