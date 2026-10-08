import { useLayoutEffect, useRef } from 'react'

/**
 * How anything that floats closes — a menu, a dropdown, a popover, a picker, a flyout, a dialog: a press outside it,
 * or Escape. Every one of them goes through this hook, because the obvious way (a `mousedown` listener on the
 * document) fails without a sound:
 *
 * - **Something between swallows the press.** A dialog stopped `mousedown` from leaving its box, so a dropdown inside
 *   it never heard a press elsewhere in the dialog and stayed open. A canvas (the graph, a map) that calls
 *   `preventDefault` on `pointerdown` means the browser sends no `mousedown` at all. So the press is heard as
 *   `pointerdown`, in the capture phase on the document, before any element can stop or cancel it.
 * - **Popups nest, in portals.** A colour picker opened from a panel, a dropdown in a dialog, a menu opened from a
 *   menu: the inner one is a sibling of the outer in the DOM, so "outside the outer one" would be true of a press on
 *   the inner one. The open layers are a stack; a press inside a layer opened later counts as inside this one.
 * - **Escape closes one thing.** Only the topmost layer answers it, and only if nothing inside took it first
 *   (`preventDefault`: an editor's completion list, a picker's input): Escape in a dropdown closes the dropdown, not the
 *   dialog it sits in.
 */

interface Layer {
  inside: () => readonly (Node | null | undefined)[]
}

/** The open layers, oldest first. */
const layers: Layer[] = []

export interface DismissOptions {
  /** Whether the layer is open (listening). Default true: the component is mounted only while open. */
  active?: boolean
  /** The elements that count as inside: the popup, and the button that opened it when it has one. */
  inside: () => readonly (Node | null | undefined)[]
  /** A press this layer lets pass anyway (a Popover: a press on the rectangle it is anchored to). */
  ignore?: (e: PointerEvent) => boolean
  /** Close on a press outside (default true). A dialog says false: its backdrop does that itself. */
  outside?: boolean
  /** Close on Escape when this is the topmost layer (default true). */
  escape?: boolean
}

export function useDismiss(onDismiss: () => void, options: DismissOptions) {
  // Read through a ref: the callers hand in fresh arrows every render, and re-registering would move the layer to the
  // top of the stack, above the popups opened from it.
  const latest = useRef({ onDismiss, options })
  // Before the layer opens (effects run in order), and after every render: events only come after a commit.
  useLayoutEffect(() => {
    latest.current = { onDismiss, options }
  })
  const active = options.active ?? true
  useLayoutEffect(() => (active ? openLayer(() => latest.current) : undefined), [active])
}

/**
 * Open a layer: listen for a press outside it and for Escape, until the returned function closes it. `current` is read
 * at each event, so the layer follows the latest callbacks while keeping its place in the stack.
 */
export function openLayer(current: () => { onDismiss: () => void; options: DismissOptions }): () => void {
  const layer: Layer = { inside: () => current().options.inside() }
  layers.push(layer)
  const onDown = (e: PointerEvent) => {
    const { options: o, onDismiss } = current()
    if (o.outside === false || o.ignore?.(e)) return
    const target = e.target as Node | null
    if (!target) return
    const from = layers.indexOf(layer)
    const mine = from < 0 ? [layer] : layers.slice(from)
    if (mine.some((l) => l.inside().some((el) => el?.contains(target)))) return
    onDismiss()
  }
  const onKey = (e: KeyboardEvent) => {
    const { options: o, onDismiss } = current()
    // An Escape something inside already took (an editor's completion list, a picker's input) is not this layer's.
    if (e.key !== 'Escape' || e.defaultPrevented || o.escape === false || layers[layers.length - 1] !== layer) return
    onDismiss()
  }
  document.addEventListener('pointerdown', onDown, true)
  document.addEventListener('keydown', onKey)
  return () => {
    document.removeEventListener('pointerdown', onDown, true)
    document.removeEventListener('keydown', onKey)
    const i = layers.indexOf(layer)
    if (i >= 0) layers.splice(i, 1)
  }
}

/** How many layers are open (tests). */
export const openLayers = () => layers.length
