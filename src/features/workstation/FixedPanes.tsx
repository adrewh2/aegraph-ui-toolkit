import { ChevronDown, ChevronRight, Expand, Maximize2, Minimize2, Minus } from 'lucide-react'
import { useRef, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'

/**
 * A page made of a fixed set of panes in the workstation's split tree:
 * the same gutters and chrome, but the panes are prescribed by the page —
 * no tabs, nothing can be closed, each one only collapses to its title
 * bar and opens again. Ratios and collapsed state are the page's to keep
 * (see `fixedLayoutStorage`).
 */
export type FixedNode = { kind: 'pane'; id: string } | { kind: 'split'; id: string; dir: 'row' | 'col'; ratio: number; children: [FixedNode, FixedNode] }
export interface FixedLayout {
  root: FixedNode
  collapsed: Record<string, boolean>
  /** One pane holding the page, and what was collapsed before, so Restore puts it back. */
  maximized?: { id: string; before: Record<string, boolean> }
}
export interface FixedPaneDef {
  title: string
  /** Shown in the title bar, before the collapse toggle. */
  actions?: ReactNode
  render: () => ReactNode
}

export const fixedPane = (id: string): FixedNode => ({ kind: 'pane', id })
export const fixedSplit = (id: string, dir: 'row' | 'col', ratio: number, a: FixedNode, b: FixedNode): FixedNode => ({ kind: 'split', id, dir, ratio, children: [a, b] })

export function setFixedRatio(n: FixedNode, splitId: string, ratio: number): FixedNode {
  if (n.kind === 'pane') return n
  // A drag that divided by zero is not a ratio: the divider stays where it was.
  if (n.id === splitId) return { ...n, ratio: Number.isFinite(ratio) ? Math.max(0.1, Math.min(0.9, ratio)) : n.ratio }
  return { ...n, children: [setFixedRatio(n.children[0], splitId, ratio), setFixedRatio(n.children[1], splitId, ratio)] }
}
/** Every pane id in the tree, in order. */
export function fixedPaneIds(n: FixedNode): string[] {
  return n.kind === 'pane' ? [n.id] : [...fixedPaneIds(n.children[0]), ...fixedPaneIds(n.children[1])]
}
const allCollapsed = (n: FixedNode, c: Record<string, boolean>): boolean => fixedPaneIds(n).every((id) => c[id])

/** Remember a layout per page; a stored tree is only used when it still names exactly the page's panes. */
export function fixedLayoutStorage(key: string, expectedPanes: string[]) {
  return {
    read(fallback: FixedLayout): FixedLayout {
      try {
        const raw = localStorage.getItem(key)
        if (!raw) return fallback
        const v = JSON.parse(raw) as FixedLayout
        const ids = fixedPaneIds(v.root).sort().join(',')
        return ids === [...expectedPanes].sort().join(',') ? { root: v.root, collapsed: v.collapsed ?? {} } : fallback
      } catch {
        return fallback
      }
    },
    write(layout: FixedLayout) {
      try {
        localStorage.setItem(key, JSON.stringify(layout))
      } catch {
        /* ignore */
      }
    },
  }
}

/** The layout with a pane collapsed or opened — never with every pane collapsed: the last open one stays. Ends a maximize. */
export function toggleFixedPane(layout: FixedLayout, id: string): FixedLayout {
  const ids = fixedPaneIds(layout.root)
  if (!ids.includes(id)) return layout
  const open = ids.filter((p) => !layout.collapsed[p])
  if (!layout.collapsed[id] && open.length <= 1) return layout
  return { root: layout.root, collapsed: { ...layout.collapsed, [id]: !layout.collapsed[id] } }
}
/** One pane takes the page (the others collapse); maximizing it again restores what was open before. */
export function maximizeFixedPane(layout: FixedLayout, id: string): FixedLayout {
  if (layout.maximized?.id === id) return { root: layout.root, collapsed: layout.maximized.before }
  const ids = fixedPaneIds(layout.root)
  // A pane the page does not have would leave every pane collapsed.
  if (!ids.includes(id)) return layout
  const collapsed = Object.fromEntries(ids.map((p) => [p, p !== id]))
  return { root: layout.root, collapsed, maximized: { id, before: layout.maximized?.before ?? layout.collapsed } }
}

export function FixedPanes({ layout, panes, onChange }: { layout: FixedLayout; panes: Record<string, FixedPaneDef>; onChange: (next: FixedLayout) => void }) {
  const toggle = (id: string) => onChange(toggleFixedPane(layout, id))
  const maximize = (id: string) => onChange(maximizeFixedPane(layout, id))
  const setRatio = (splitId: string, ratio: number) => onChange({ ...layout, root: setFixedRatio(layout.root, splitId, ratio) })
  const open = fixedPaneIds(layout.root).filter((p) => !layout.collapsed[p])
  return (
    <div className="fp">
      <FixedTree node={layout.root} collapsed={layout.collapsed} panes={panes} onToggle={toggle} onMaximize={maximize} onRatio={setRatio} dir="col" lastOpen={open.length === 1 ? open[0] : undefined} maximized={layout.maximized?.id} />
    </div>
  )
}

interface TreeProps {
  collapsed: Record<string, boolean>
  panes: Record<string, FixedPaneDef>
  onToggle: (id: string) => void
  onMaximize: (id: string) => void
  onRatio: (splitId: string, ratio: number) => void
  /** The one pane still open, when there is only one: it cannot be minimized. */
  lastOpen?: string
  /** The pane holding the page, if one is maximized. */
  maximized?: string
}

function FixedTree({ node, dir, ...rest }: TreeProps & { node: FixedNode; dir: 'row' | 'col' }) {
  if (node.kind === 'pane') return <FixedPane id={node.id} def={rest.panes[node.id]} collapsed={!!rest.collapsed[node.id]} onToggle={rest.onToggle} onMaximize={rest.onMaximize} parentDir={dir} pinned={rest.lastOpen === node.id} maximized={rest.maximized === node.id} />
  return <FixedSplitView node={node} {...rest} />
}

function FixedSplitView({ node, ...rest }: TreeProps & { node: Extract<FixedNode, { kind: 'split' }> }) {
  const { collapsed } = rest
  const ref = useRef<HTMLDivElement>(null)
  const [a, b] = node.children
  const aShut = allCollapsed(a, collapsed), bShut = allCollapsed(b, collapsed)
  const onDown = (e: ReactPointerEvent) => {
    e.preventDefault()
    const el = ref.current!
    const cls = node.dir === 'row' ? 'ws-resizing-x' : 'ws-resizing-y'
    const move = (ev: PointerEvent) => {
      const r = el.getBoundingClientRect()
      rest.onRatio(node.id, node.dir === 'row' ? (ev.clientX - r.left) / r.width : (ev.clientY - r.top) / r.height)
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      document.body.classList.remove(cls)
    }
    document.body.classList.add(cls)
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }
  // A collapsed side takes only its title bar; the other side gets the rest. With both open the ratio splits the space.
  // Both collapsed in a row: a strip stays a strip, but a collapsed group of bars still spans the width.
  const style = (side: FixedNode, shut: boolean, otherShut: boolean, ratio: number) => {
    if (shut && otherShut) return node.dir === 'row' && side.kind === 'split' ? { flex: '1 1 auto' } : { flex: '0 0 auto' }
    return shut ? { flex: '0 0 auto' } : otherShut ? { flex: '1 1 auto' } : { flexBasis: `${ratio * 100}%` }
  }
  return (
    <div ref={ref} className={`ws-split ws-split--${node.dir}`}>
      <div className="ws-split__child" style={style(a, aShut, bShut, node.ratio)}>
        <FixedTree node={a} {...rest} dir={node.dir} />
      </div>
      {!aShut && !bShut && <div className={`ws-gutter ws-gutter--${node.dir}`} onPointerDown={onDown} onDoubleClick={() => rest.onRatio(node.id, 0.5)} title="Drag to resize · double-click to even out" />}
      <div className="ws-split__child" style={style(b, bShut, aShut, 1 - node.ratio)}>
        <FixedTree node={b} {...rest} dir={node.dir} />
      </div>
    </div>
  )
}

function FixedPane({ id, def, collapsed, onToggle, onMaximize, parentDir, pinned, maximized }: { id: string; def: FixedPaneDef | undefined; collapsed: boolean; onToggle: (id: string) => void; onMaximize: (id: string) => void; parentDir: 'row' | 'col'; pinned: boolean; maximized: boolean }) {
  if (!def) return null
  // Collapsed beside something (a row): a narrow strip with the title turned; collapsed above/below: a bar.
  const strip = collapsed && parentDir === 'row'
  const minTitle = collapsed ? `Open ${def.title}` : pinned ? 'One pane stays open — open another first' : `Minimize ${def.title}`
  return (
    <section className={`fp__pane ${collapsed ? 'is-collapsed' : ''} ${strip ? 'fp__pane--strip' : ''} ${maximized ? 'is-maximized' : ''}`} aria-label={def.title}>
      <header className="fp__head" onDoubleClick={() => (collapsed ? onToggle(id) : onMaximize(id))}>
        <button className="fp__toggle" title={minTitle} disabled={pinned} onClick={() => onToggle(id)}>
          {collapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
        </button>
        <span className="fp__title">{def.title}</span>
        {!collapsed && def.actions && <span className="fp__actions">{def.actions}</span>}
        <span className="fp__buttons">
          {collapsed ? (
            <button className="fp__min" title={`Open ${def.title}`} onClick={() => onToggle(id)}>
              <Expand size={12} />
            </button>
          ) : (
            <>
              <button className="fp__min" title={minTitle} disabled={pinned} onClick={() => onToggle(id)}>
                <Minus size={13} />
              </button>
              <button className="fp__min" title={maximized ? 'Restore the other panes' : `Maximize ${def.title}`} onClick={() => onMaximize(id)}>
                {maximized ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
              </button>
            </>
          )}
        </span>
      </header>
      {!collapsed && <div className="fp__body">{def.render()}</div>}
    </section>
  )
}
