import type { GraphEngine } from './engine'

/** The explorer's pointer tools: the hand (drag moves the camera), the box (drag selects), the path. */
export type ExplorerTool = 'pan' | 'box' | 'path'

/**
 * Pointer and wheel handling for the engine: hover (picked once per frame,
 * not per event), click to select (shift/⌘ toggles), drag a node or the
 * selection it belongs to, pan on empty space (orbit in 3D; the right
 * button, ⌥-drag or the middle button pans — so 3D translates with a drag
 * the way 2D does), shift+drag a marquee — and with the box tool a plain drag on empty space is a marquee, Space
 * held (or the right or middle button) moving the camera instead — wheel and pinch to zoom about
 * the pointer (dolly in 3D), right-click for the menu (a right button
 * that moved was a pan, not a click: the menu waits for the release and
 * opens only when the pointer stayed put). Nothing here
 * allocates per move: the drag list is a typed array reused across drags,
 * positions are read from the engine's arrays.
 */
export class Interaction {
  /** `pan` (the hand): a drag on empty space moves the camera. `box` (select): it draws a marquee. `path`: clicks pick a path's ends. */
  tool: ExplorerTool = 'pan'
  /** Space held: with the box tool, a drag moves the camera instead (the hand, while it is held). */
  private space = false
  /** The marquee adds to the selection (⇧) rather than replacing it. */
  private marqueeAdd = true
  private mode: 'none' | 'pan' | 'orbit' | 'drag' | 'marquee' | 'pinch' | 'pending' = 'none'
  /** A press waiting for the positions to be read back before it picks (see `onDown`), and a release that came first. */
  private pendingKeys = { shift: false, alt: false }
  private pendingUp: { x: number; y: number; e: PointerEvent } | null = null
  private dragDepth = 1
  private delta = { x: 0, y: 0, z: 0 }
  private downX = 0
  private downY = 0
  private lastX = 0
  private lastY = 0
  private moved = false
  private button = 0
  private dragNodes = new Uint32Array(1024)
  private dragCount = 0
  private pendingMove = false
  private moveX = 0
  private moveY = 0
  private raf = 0
  private marquee: HTMLDivElement
  private pointers = new Map<number, { x: number; y: number }>()
  private pinchDist = 0
  private unbind: (() => void)[] = []
  /** Nodes larger than this many neighbours drag alone even when selected with others (a select-all drag is a pan, not a drag). */
  static readonly DRAG_MAX = 50_000

  private engine: GraphEngine
  private el: HTMLElement

  constructor(engine: GraphEngine, el: HTMLElement) {
    this.engine = engine
    this.el = el
    this.marquee = document.createElement('div')
    this.marquee.className = 'gg-marquee'
    this.marquee.style.display = 'none'
    el.appendChild(this.marquee)
    const on = <K extends keyof HTMLElementEventMap>(name: K, fn: (e: HTMLElementEventMap[K]) => void, opts?: AddEventListenerOptions) => {
      el.addEventListener(name, fn, opts)
      this.unbind.push(() => el.removeEventListener(name, fn, opts))
    }
    on('pointerdown', this.onDown)
    on('pointermove', this.onMove)
    on('pointerup', this.onUp)
    on('pointercancel', this.onUp)
    on('pointerleave', this.onLeave)
    on('wheel', this.onWheel, { passive: false })
    on('contextmenu', this.onContext)
    on('dblclick', this.onDouble)
    el.style.touchAction = 'none'
    // Space as the hand while the box tool is on, as in drawing tools. Not while typing in a field.
    const key = (down: boolean) => (e: KeyboardEvent) => {
      if (e.code !== 'Space' || isField(e.target)) return
      if (down && this.tool === 'box' && this.mode === 'none' && el.matches(':hover')) e.preventDefault()
      this.space = down
      this.updateCursor()
    }
    const kd = key(true)
    const ku = key(false)
    const blur = () => ((this.space = false), this.updateCursor())
    window.addEventListener('keydown', kd)
    window.addEventListener('keyup', ku)
    window.addEventListener('blur', blur)
    this.unbind.push(() => window.removeEventListener('keydown', kd), () => window.removeEventListener('keyup', ku), () => window.removeEventListener('blur', blur))
  }

  /** The resting cursor: crosshair for the path tool, the hand while Space is held over the box tool, else the default. */
  updateCursor() {
    if (this.mode !== 'none') return
    this.el.style.cursor = this.tool === 'path' ? 'crosshair' : this.tool === 'box' && this.space ? 'grab' : ''
  }

  destroy() {
    for (const u of this.unbind) u()
    this.unbind = []
    if (this.raf) cancelAnimationFrame(this.raf)
    this.marquee.remove()
  }

  private local(e: PointerEvent | MouseEvent | WheelEvent): { x: number; y: number } {
    const r = this.el.getBoundingClientRect()
    this.moveX = e.clientX - r.left
    this.moveY = e.clientY - r.top
    return { x: this.moveX, y: this.moveY }
  }

  private onDown = (e: PointerEvent) => {
    const { x, y } = this.local(e)
    this.pointers.set(e.pointerId, { x, y })
    if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()]
      this.pinchDist = Math.hypot(a.x - b.x, a.y - b.y)
      this.mode = 'pinch'
      return
    }
    this.el.setPointerCapture(e.pointerId)
    this.downX = this.lastX = x
    this.downY = this.lastY = y
    this.moved = false
    this.button = e.button
    if (e.button === 0 && e.ctrlKey) {
      this.mode = 'none'
      return
    }
    const engine = this.engine
    engine.camera.stop()
    engine.camera3.stop()
    if (e.button === 1 || e.button === 2) {
      // The right button pans (in 3D too, where the left button orbits); released without moving, it is the menu.
      this.mode = 'pan'
      return
    }
    if (e.button !== 0) return
    // A live run on the GPU moves the picture every frame, but the positions a pick searches are the CPU's copy, read
    // back every dozen frames: a press on a dot as drawn found nothing where the copy had it, and panned instead —
    // grabbing a node while the simulation ran all but never worked. So the press waits one read-back, then picks.
    if (engine.dims === 2 && engine.positionsLag()) {
      this.mode = 'pending'
      this.pendingKeys = { shift: e.shiftKey, alt: e.altKey }
      this.pendingUp = null
      void engine.freshPositions().then(() => this.settlePending())
      return
    }
    // A press on a card over the picture grabs no node behind it: held still it is the card's click (⇧ with it — never a
    // marquee, whose release clicks nothing), dragged it orbits.
    const onCard = !!engine.overlayAt(x, y)
    this.begin(onCard ? -1 : engine.pick(x, y), onCard ? false : e.shiftKey, e.altKey)
  }

  /** The press decided: a drag of the node (or of the selection it is part of), a marquee, or the camera. */
  private begin(node: number, shiftKey: boolean, altKey: boolean) {
    const engine = this.engine
    if (node >= 0 && !shiftKey && this.tool !== 'path') {
      // The grabbed node, or the whole selection when it is part of it.
      const sel = engine.selected
      let n = 0
      if (sel.has(node) && engine.selectedCount() <= Interaction.DRAG_MAX) {
        const need = engine.selectedCount()
        if (this.dragNodes.length < need) this.dragNodes = new Uint32Array(need * 2)
        sel.forEach((i) => (this.dragNodes[n++] = i))
      } else this.dragNodes[n++] = node
      this.dragCount = n
      this.dragDepth = engine.depthOf(node)
      this.mode = 'drag'
      this.el.style.cursor = 'grabbing'
      return
    }
    // A marquee: ⇧-drag with any tool adds to the selection; a plain drag on empty space with the box tool replaces
    // it (⌥, or Space held, moves the camera instead).
    if (node < 0 && (shiftKey || (this.tool === 'box' && !this.space && !altKey))) {
      this.mode = 'marquee'
      this.marqueeAdd = shiftKey
      return
    }
    this.mode = engine.dims === 3 && !altKey ? 'orbit' : 'pan'
  }

  /** The read-back landed: pick where the press was, then catch up with the pointer (and a release) meanwhile. */
  private settlePending() {
    if (this.mode !== 'pending') return
    const onCard = !!this.engine.overlayAt(this.downX, this.downY)
    this.begin(onCard ? -1 : this.engine.pick(this.downX, this.downY), onCard ? false : this.pendingKeys.shift, this.pendingKeys.alt)
    // lastX/Y stayed at the press while it waited: the move so far is applied as one step.
    if (this.moved) this.moveTo(this.moveX, this.moveY)
    const up = this.pendingUp
    this.pendingUp = null
    if (up) this.finish(up.x, up.y, up.e)
  }

  private onMove = (e: PointerEvent) => {
    const { x, y } = this.local(e)
    const p = this.pointers.get(e.pointerId)
    if (p) {
      p.x = x
      p.y = y
    }
    if (this.mode === 'pinch' && this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()]
      const d = Math.hypot(a.x - b.x, a.y - b.y)
      if (this.pinchDist > 0 && d > 0) {
        if (this.engine.dims === 3 && this.engine.controls === 'fly') this.engine.camera3.fly((d - this.pinchDist) * this.engine.camera3.fitDistance * 0.004, 0, 0)
        else if (this.engine.dims === 3) this.engine.camera3.dolly(this.pinchDist / d)
        else this.engine.camera.zoomAt(d / this.pinchDist, (a.x + b.x) / 2, (a.y + b.y) / 2)
      }
      this.pinchDist = d
      this.engine.cameraChanged()
      return
    }
    if (!this.moved && Math.hypot(x - this.downX, y - this.downY) > 3) this.moved = true
    // Waiting to know what was pressed: the move is kept (lastX/Y stay put) and applied when it is known.
    if (this.mode === 'pending') return
    if (this.moveTo(x, y)) return
    // Hover: coalesced to one pick per frame.
    if (!this.pendingMove) {
      this.pendingMove = true
      this.raf = requestAnimationFrame(this.hoverTick)
    }
  }

  /** The pointer at x, y during a pan, an orbit, a drag or a marquee; false when none is under way. */
  private moveTo(x: number, y: number): boolean {
    const dx = x - this.lastX, dy = y - this.lastY
    if (this.mode === 'pan' || this.mode === 'orbit') {
      if (this.moved) {
        const engine = this.engine
        // Flying, a drag looks around from where the camera is (right turns right, up looks up); orbiting, it turns the camera around the point it looks at.
        if (this.mode === 'orbit' && engine.controls === 'fly') engine.camera3.look(dx * 0.004, -dy * 0.004)
        else if (this.mode === 'orbit') engine.camera3.orbit(-dx * 0.006, dy * 0.006)
        else if (engine.dims === 3) engine.camera3.pan(dx, dy)
        else engine.camera.panBy(dx, dy)
        engine.cameraChanged()
      }
      this.lastX = x
      this.lastY = y
      return true
    }
    if (this.mode === 'drag') {
      if (this.moved) {
        const engine = this.engine
        if (!engine.dragging) {
          engine.dragging = engine.selected.clone()
          for (let k = 0; k < this.dragCount; k++) engine.dragging.set(this.dragNodes[k])
        }
        if (engine.dims === 3) {
          engine.camera3.dragDelta(dx, dy, this.dragDepth, this.delta)
          engine.moveBy(this.dragNodes, this.dragCount, this.delta.x, this.delta.y, this.delta.z)
        } else {
          const s = engine.camera.scale
          engine.moveBy(this.dragNodes, this.dragCount, dx / s, -dy / s)
        }
      }
      this.lastX = x
      this.lastY = y
      return true
    }
    if (this.mode === 'marquee') {
      if (this.moved) {
        const m = this.marquee
        m.style.display = 'block'
        m.style.transform = `translate(${Math.min(this.downX, x)}px, ${Math.min(this.downY, y)}px)`
        m.style.width = `${Math.abs(x - this.downX)}px`
        m.style.height = `${Math.abs(y - this.downY)}px`
      }
      this.lastX = x
      this.lastY = y
      return true
    }
    return false
  }

  private hoverTick = () => {
    this.raf = 0
    this.pendingMove = false
    if (this.mode !== 'none') return
    const engine = this.engine
    const x = this.moveX, y = this.moveY
    // Over a card the node behind it is not under the pointer: nothing hovered, and the card keeps its cursor.
    if (engine.overlayAt(x, y)) {
      if (engine.hovered >= 0) engine.setHover(-1)
      if (engine.hoveredEdge >= 0) engine.setHoveredEdge(-1)
      return
    }
    void engine.pickAsync(x, y).then((node) => {
      if (this.mode !== 'none' || x !== this.moveX || y !== this.moveY) return
      this.hoverResult(node)
    })
  }

  private hoverResult(node: number) {
    const engine = this.engine
    engine.setHover(node)
    if (node >= 0) {
      this.el.style.cursor = this.tool === 'path' ? 'crosshair' : 'grab'
      if (engine.hoveredEdge >= 0) engine.setHoveredEdge(-1)
      return
    }
    this.el.style.cursor = this.tool === 'path' ? 'crosshair' : ''
    // Edge hover only in the close regimes, where edges are wide enough to mean something under the pointer.
    if (engine.lod.regime >= 2 && engine.showEdges) {
      const x = this.moveX, y = this.moveY
      void engine.pickEdge(x, y).then((edge) => {
        if (this.mode !== 'none' || x !== this.moveX || y !== this.moveY) return
        engine.setHoveredEdge(edge)
        if (edge >= 0) this.el.style.cursor = 'pointer'
      })
    } else if (engine.hoveredEdge >= 0) engine.setHoveredEdge(-1)
  }

  private onUp = (e: PointerEvent) => {
    this.pointers.delete(e.pointerId)
    if (this.mode === 'pinch') {
      if (this.pointers.size < 2) this.mode = 'none'
      return
    }
    const { x, y } = this.local(e)
    if (this.el.hasPointerCapture(e.pointerId)) this.el.releasePointerCapture(e.pointerId)
    // Released before the press knew what it was on: it finishes when it does.
    if (this.mode === 'pending') {
      this.pendingUp = { x, y, e }
      return
    }
    this.finish(x, y, e)
  }

  /** The press ends at x, y: a drag dropped, a marquee's selection, a click. */
  private finish(x: number, y: number, e: PointerEvent) {
    const engine = this.engine
    const mode = this.mode
    this.mode = 'none'
    this.el.style.cursor = ''
    this.updateCursor()
    if (mode === 'drag') {
      if (this.moved) {
        engine.dragging = null
        engine.commit()
        engine.emit('dragEnd', this.dragNodes.slice(0, this.dragCount))
      } else this.click(this.dragNodes[0], x, y, e)
      return
    }
    if (mode === 'marquee') {
      this.marquee.style.display = 'none'
      if (this.moved) {
        let n = 0
        let hits = new Uint32Array(4096)
        engine.nodesInScreenRect(this.downX, this.downY, x, y, (i) => {
          if (n === hits.length) {
            const bigger = new Uint32Array(n * 2)
            bigger.set(hits)
            hits = bigger
          }
          hits[n++] = i
        })
        if (n || !this.marqueeAdd) engine.setSelection(hits.subarray(0, n), this.marqueeAdd ? 'add' : 'replace', 'marquee')
      } else if (!this.marqueeAdd) this.click(-1, x, y, e)
      return
    }
    if ((mode === 'pan' || mode === 'orbit') && !this.moved && this.button === 0) this.click(-1, x, y, e)
    if (mode === 'pan' && !this.moved && this.button === 2) this.menuAt(e)
  }

  /** The context menu for what is under the pointer: a node, else an edge, else the stage. */
  private menuAt(e: MouseEvent) {
    const { x, y } = this.local(e)
    const engine = this.engine
    // A card's right-click is not the menu of a node behind it, nor of the stage.
    if (engine.overlayAt(x, y)) return
    const node = engine.pick(x, y)
    if (node >= 0) {
      engine.emit('contextmenu', { x: e.clientX, y: e.clientY, node, edge: -1 })
      return
    }
    void engine.pickEdge(x, y).then((edge) => engine.emit('contextmenu', { x: e.clientX, y: e.clientY, node: -1, edge }))
  }

  private click(node: number, x: number, y: number, e: PointerEvent) {
    const engine = this.engine
    const additive = e.shiftKey || e.metaKey || e.ctrlKey
    if (node >= 0) {
      if (this.tool === 'path') {
        engine.emit('nodeClick', { node, shift: e.shiftKey, meta: e.metaKey || e.ctrlKey })
        return
      }
      engine.setSelection([node], additive ? 'toggle' : 'replace', 'click')
      if (engine.selectedEdge >= 0) engine.setSelectedEdge(-1)
      return
    }
    const overlay = engine.overlayAt(x, y)
    if (overlay) {
      overlay.click(x, y, { shift: e.shiftKey, meta: e.metaKey || e.ctrlKey })
      return
    }
    // Empty space: an edge under the pointer, else clear.
    void engine.pickEdge(x, y).then((edge) => {
      if (edge >= 0) {
        engine.setSelectedEdge(edge)
        engine.emit('edgeSelect', edge)
      } else engine.clearSelection('click')
    })
  }

  private onLeave = () => {
    if (this.mode === 'none') {
      this.engine.setHover(-1)
      this.engine.setHoveredEdge(-1)
    }
  }

  private onWheel = (e: WheelEvent) => {
    e.preventDefault()
    const { x, y } = this.local(e)
    // Trackpads report small deltas continuously; wheels report large steps. Both zoom about the pointer, in 3D as in 2D:
    // flying, the eye moves along the ray through the pointer by a share of the graph's size per notch; orbiting, the
    // camera closes on the point under the pointer, which stays under it.
    const factor = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0022))
    if (this.engine.dims === 3 && this.engine.controls === 'fly') this.engine.camera3.flyToward(Math.log(factor) * this.engine.camera3.fitDistance * 0.5, x, y)
    else if (this.engine.dims === 3) this.engine.camera3.dollyAt(1 / factor, x, y)
    else this.engine.camera.zoomAt(factor, x, y)
    this.engine.cameraChanged()
  }

  private onContext = (e: MouseEvent) => {
    e.preventDefault()
    // The right button's own event comes at the press on macOS and at the release elsewhere; either way the pointer
    // handlers decide (a drag pans, a still release opens the menu). Everything else — ⌃-click, the keyboard's menu
    // key — opens it here.
    if (e.button === 2) return
    this.menuAt(e)
  }

  private onDouble = (e: MouseEvent) => {
    const { x, y } = this.local(e)
    const overlay = this.engine.overlayAt(x, y)
    if (overlay) {
      overlay.double?.(x, y)
      return
    }
    const node = this.engine.pick(x, y)
    if (node >= 0) this.engine.fitTo([node], { ms: 300 })
  }
}

/** A keystroke meant for a field, not for the picture. */
const isField = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))
