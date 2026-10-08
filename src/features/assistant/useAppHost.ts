import { artifactsHostKey, showArtifact } from '../chats/show'
import { useCallback, useEffect, useMemo, useRef } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useToast } from '../../components/ui/useToast'
import { displayLabel } from '../../core/entity/entity'
import { useEntityStore, useTypeRegistry } from '../../core/entity/hooks'
import type { EntityStore } from '../../core/entity/store'
import { isRelationship, type AnyEntity, type EntityId } from '../../core/entity/types'
import { describeFilter } from '../../core/graph/filter'
import { layoutInfo } from '../../core/graph/layouts'
import { describeRendering } from '../../core/graph/rendering'
import { ancestorsOf, extOf, isDocument } from '../documents/documents'
import { installErrorLog, recentErrors } from '../bridge/errorLog'
import { getExplorerHandle } from '../graph/explorerHandle'
import { HOSTS, HOST_NAMES, mountedHost } from '../workstation/hosts'
import { panes } from '../workstation/model'
import { tablesOnScreen } from './screen'
import { docPageAt } from '../docs/lookup'
import { getProjectHistory } from '../../core/projects/history'
import { isProjectEntity } from '../../core/projects/project'
import { shortId, versioningOf } from '../../core/projects/versioning'
import { isImage } from '../images/images'
import { getAudioPlayback } from '../audio/playback'
import { getPlayback } from '../videos/playback'
import { voice } from '../voice/voice'
import { MEMORY_CONTEXT_CHARS, readMemory, readSharedMemory } from './memory'
import type { AppContext, AppHost } from './tools'

/**
 * Everything a tool host needs from the running app — store, router, and a
 * live view of what's on screen. Shared by the in-app assistant and the
 * Claude Code bridge so both drive the app the same way.
 */
// Module scope: runs once per evaluation, so an HMR update swaps in the fresh capture.
installErrorLog()

const labelOf = (store: EntityStore, id: EntityId) => {
  const e = store.get(id)
  return e ? displayLabel(e) : id
}

/**
 * A tab as its strip shows it: the name it was given, else the name of what its path opens (`/documents/<id>`, a
 * map, an image — the entity the last segment names), else the path. So the assistant reads "Transistor" where the
 * user sees it, not a document's id.
 */
function tabTitle(store: Pick<EntityStore, 'get'>, t: { title?: string; path: string }): string {
  if (t.title) return t.title
  const last = t.path.split(/[?#]/)[0].split('/').filter(Boolean).pop()
  let e: AnyEntity | undefined
  try {
    e = last ? store.get(decodeURIComponent(last)) : undefined
  } catch {
    e = undefined
  }
  return e ? displayLabel(e) : t.path
}

export function useAppHost(): Omit<AppHost, 'confirm'> {
  const store = useEntityStore()
  const registry = useTypeRegistry()
  const navigate = useNavigate()
  const location = useLocation()
  const toast = useToast()

  const locationRef = useRef(location)
  useEffect(() => {
    locationRef.current = location
  }, [location])

  const getContext = useCallback((): AppContext => {
    const { pathname, search } = locationRef.current
    const m = /^\/documents\/([^/]+)$/.exec(pathname)
    const doc = m ? store.get(decodeURIComponent(m[1])) : undefined
    const im = /^\/images\/([^/]+)$/.exec(pathname)
    const image = im ? store.get(decodeURIComponent(im[1])) : undefined
    const sel = typeof window !== 'undefined' ? window.getSelection()?.toString().trim() : ''
    const explorer = getExplorerHandle()
    const errors = recentErrors()
    const project = store.scope ? store.get(store.scope) : undefined
    const versioning = (() => {
      if (!isProjectEntity(project)) return undefined
      try {
        const h = getProjectHistory(store)
        const head = h.head(project.id)
        return { ...(head ? { head: { id: head.id, short: shortId(head.id), message: head.data.message, at: head.data.at, auto: !!head.data.auto } } : {}), commits: h.commits(project.id).length, unsaved: h.countSync(project.id), autosave: versioningOf(project).autosave }
      } catch {
        return undefined // no history store here (a test, a headless tab): the tools still answer
      }
    })()
    const docs: NonNullable<AppContext['docs']> = []
    const onPage = docPageAt(pathname + search + locationRef.current.hash)
    if (onPage) docs.push({ id: onPage.page.id, title: onPage.page.title, blurb: onPage.page.blurb, section: onPage.section, where: 'page' })
    const tabs = HOST_NAMES.flatMap((name) => {
      const live = mountedHost(HOSTS[name].key)
      if (!live) return []
      const ws = live.get()
      // A docs page showing in a pane counts as on screen too — the focused pane's first, so "this page" resolves.
      for (const p of [...panes(ws.root)].sort((a, b) => Number(b.id === ws.focused) - Number(a.id === ws.focused))) {
        const t = p.tabs[p.active]
        const d = t && docPageAt(t.path)
        if (d && !docs.some((x) => x.id === d.page.id)) docs.push({ id: d.page.id, title: d.page.title, blurb: d.page.blurb, section: d.section, where: p.id === ws.focused ? 'focused pane' : 'pane' })
      }
      return [{ host: name, tabs: panes(ws.root).flatMap((p) => p.tabs.map((t, i) => ({ id: t.id, title: tabTitle(store, t), path: t.path, active: i === p.active }))) }]
    })
    const tables = tablesOnScreen()
    const onChat = /^\/chats\/([^/?#]+)/.exec(pathname)
    const chatsPage = onChat
      ? (() => {
          const chat = decodeURIComponent(onChat[1])
          const ws = mountedHost(artifactsHostKey(chat))?.get()
          const panel = ws ? panes(ws.root).flatMap((p) => p.tabs.map((t, i) => ({ title: tabTitle(store, t), path: t.path, active: i === p.active }))) : []
          return { chat, panel }
        })()
      : undefined
    return {
      route: pathname + search,
      ...(errors.length ? { recentErrors: errors.slice(-5) } : {}),
      ...(project ? { project: { id: project.id, label: displayLabel(project), entities: store.size() } } : {}),
      ...(versioning ? { versioning } : {}),
      ...(tables.length ? { tables } : {}),
      ...(tabs.length ? { tabs } : {}),
      ...(chatsPage ? { chatsPage } : {}),
      ...(docs.length ? { docs } : {}),
      ...(voice.getState().enabled ? { voice: true } : {}),
      ...(() => {
        const memory = readMemory(store)
        const shared = readSharedMemory(store)
        return {
          ...(memory ? { memory: memory.length > MEMORY_CONTEXT_CHARS ? memory.slice(0, MEMORY_CONTEXT_CHARS) + '\n… (more: memory {action:"read"})' : memory } : {}),
          ...(shared ? { sharedMemory: shared.slice(0, MEMORY_CONTEXT_CHARS) } : {}),
        }
      })(),
      document: isDocument(doc)
        ? {
            id: doc.id,
            label: displayLabel(doc),
            extension: extOf(doc),
            folderPath: ancestorsOf(store, doc.id)
              .reverse()
              .map((a) => displayLabel(store.get(a) ?? ({ id: a } as AnyEntity))),
          }
        : undefined,
      image: isImage(image) ? { id: image.id, label: displayLabel(image), width: image.data.width, height: image.data.height } : undefined,
      selection: sel && sel.length <= 4000 ? sel : undefined,
      video: (() => {
        const p = getPlayback()
        const v = p ? store.get(p.videoId) : undefined
        return p && v ? { id: v.id, label: displayLabel(v), currentTime: Math.round(p.currentTime * 10) / 10, playing: p.playing, duration: p.duration } : undefined
      })(),
      audio: (() => {
        const p = getAudioPlayback()
        const v = p ? store.get(p.audioId) : undefined
        return p && v ? { id: v.id, label: displayLabel(v), currentTime: Math.round(p.currentTime * 10) / 10, playing: p.playing, duration: p.duration } : undefined
      })(),
      graph: explorer
        ? (() => {
            const st = explorer.getState()
            const slice = explorer.getSlice()
            const selected = st.selectedIds.slice(-12).map((id) => {
              const e = store.get(id)
              return { id, label: e ? displayLabel(e) : id, type: e?.type ?? '?' }
            })
            const edge = st.selectedEdgeId ? store.get(st.selectedEdgeId) : undefined
            const selectedEdge = edge && isRelationship(edge) ? { id: edge.id, label: `${labelOf(store, edge.source.id)} —${edge.type}→ ${labelOf(store, edge.target.id)}` } : undefined
            return {
              mode: explorer.renderer ?? (explorer.dims === 3 ? ('3d' as const) : ('2d' as const)),
              filter: describeFilter(st.filter),
              layout: layoutInfo(st.algorithm).label,
              style: describeRendering(st.rendering),
              nodes: slice.nodes.length,
              edges: slice.edges.length,
              selectedId: st.selectedId,
              ...(selected.length ? { selected, selectedMore: Math.max(0, st.selectedIds.length - selected.length) } : {}),
              ...(selectedEdge ? { selectedEdge } : {}),
              ...(explorer.describeDetail ? { detail: explorer.describeDetail() } : {}),
            }
          })()
        : undefined,
    }
  }, [store])

  // In development the context is reachable from the console (`__aegraph.context()`) for scripted checks.
  useEffect(() => {
    if (import.meta.env.DEV) ((window as unknown as { __aegraph?: Record<string, unknown> }).__aegraph ??= {}).context = getContext
  }, [getContext])

  // The assistant taking you somewhere (its tools, a link in an answer) from the Chats page: the chat comes along, in the
  // side panel — the page it was on is gone, and the panel shows the chat in front, which is the one you were in.
  const go = useCallback(
    (to: string) => {
      const onChats = /^\/chats(\/|$)/.test(locationRef.current.pathname)
      const toChats = /^\/chats(\/|$|\?)/.test(to)
      if (onChats && !toChats) window.dispatchEvent(new CustomEvent('aegraph:assistant', { detail: { open: true } }))
      navigate(to)
    },
    [navigate],
  )
  // What a tool made, shown where the user is: on the Chats page, as a tab in that chat's artifacts panel (`openMade`).
  const reveal = useCallback((id: EntityId) => {
    const m = /^\/chats\/([^/]+)/.exec(locationRef.current.pathname)
    return !!m && showArtifact(decodeURIComponent(m[1]), id)
  }, [])
  return useMemo(() => ({ store, registry, navigate: go, getContext, notify: toast, reveal }), [store, registry, go, getContext, toast, reveal])
}
