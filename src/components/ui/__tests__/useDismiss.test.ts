import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/** A node that contains itself and its children, as a DOM node does. */
interface FakeNode {
  name: string
  children: FakeNode[]
  contains: (n: unknown) => boolean
}
const node = (name: string, ...children: FakeNode[]): FakeNode & Node => {
  const n: FakeNode = { name, children, contains: (x) => x === n || children.some((c) => c.contains(x)) }
  return n as FakeNode & Node
}

describe('closing what floats: a press outside, or Escape', () => {
  const listeners: { type: string; fn: (e: unknown) => void; capture: boolean }[] = []
  const press = (target: FakeNode, at = { clientX: 0, clientY: 0 }) =>
    listeners.filter((l) => l.type === 'pointerdown').forEach((l) => l.fn({ target, ...at }))
  const key = (k: string) => listeners.filter((l) => l.type === 'keydown').forEach((l) => l.fn({ key: k }))

  beforeEach(() => {
    listeners.length = 0
    vi.resetModules()
    vi.stubGlobal('document', {
      addEventListener: (type: string, fn: (e: unknown) => void, capture?: boolean) => listeners.push({ type, fn, capture: !!capture }),
      removeEventListener: (type: string, fn: (e: unknown) => void) => {
        const i = listeners.findIndex((l) => l.type === type && l.fn === fn)
        if (i >= 0) listeners.splice(i, 1)
      },
    })
  })
  afterEach(() => vi.unstubAllGlobals())

  it('hears the press in the capture phase, as a pointerdown — before anything can stop it or cancel the mousedown', async () => {
    const { openLayer } = await import('../useDismiss')
    const close = openLayer(() => ({ onDismiss: () => {}, options: { inside: () => [] } }))
    expect(listeners.find((l) => l.type === 'pointerdown')?.capture).toBe(true)
    expect(listeners.some((l) => l.type === 'mousedown')).toBe(false)
    close()
    expect(listeners).toEqual([])
  })

  it('a dropdown in a dialog: a press elsewhere in the dialog closes the dropdown, not the dialog', async () => {
    const { openLayer, openLayers } = await import('../useDismiss')
    const field = node('field')
    const dialogBox = node('dialog', field, node('button'))
    const list = node('list')
    const dialog = vi.fn()
    const dropdown = vi.fn()
    const closeDialog = openLayer(() => ({ onDismiss: dialog, options: { inside: () => [dialogBox], outside: false } }))
    const closeDropdown = openLayer(() => ({ onDismiss: dropdown, options: { inside: () => [list, field] } }))
    expect(openLayers()).toBe(2)
    press(list.children[0] ?? list)
    expect(dropdown).not.toHaveBeenCalled()
    press(field)
    expect(dropdown).not.toHaveBeenCalled()
    press(dialogBox.children[1])
    expect(dropdown).toHaveBeenCalledOnce()
    expect(dialog).not.toHaveBeenCalled()
    closeDropdown()
    closeDialog()
    expect(openLayers()).toBe(0)
  })

  it('a press inside a popup opened from another counts as inside both; one outside closes both', async () => {
    const { openLayer } = await import('../useDismiss')
    const panel = node('panel')
    const picker = node('picker') // portalled: a sibling of the panel, not inside it
    const outer = vi.fn()
    const inner = vi.fn()
    openLayer(() => ({ onDismiss: outer, options: { inside: () => [panel] } }))
    openLayer(() => ({ onDismiss: inner, options: { inside: () => [picker] } }))
    press(picker)
    expect(outer).not.toHaveBeenCalled()
    expect(inner).not.toHaveBeenCalled()
    press(node('elsewhere'))
    expect(outer).toHaveBeenCalledOnce()
    expect(inner).toHaveBeenCalledOnce()
  })

  it('Escape closes only the topmost layer; a layer that keeps Escape for itself holds it', async () => {
    const { openLayer } = await import('../useDismiss')
    const dialog = vi.fn()
    const menu = vi.fn()
    const closeDialog = openLayer(() => ({ onDismiss: dialog, options: { inside: () => [], outside: false } }))
    const closeMenu = openLayer(() => ({ onDismiss: menu, options: { inside: () => [] } }))
    key('Escape')
    expect(menu).toHaveBeenCalledOnce()
    expect(dialog).not.toHaveBeenCalled()
    closeMenu()
    const picker = vi.fn()
    const closePicker = openLayer(() => ({ onDismiss: picker, options: { inside: () => [], escape: false } }))
    key('Escape')
    expect(picker).not.toHaveBeenCalled()
    expect(dialog).not.toHaveBeenCalled()
    closePicker()
    key('Enter')
    key('Escape')
    expect(dialog).toHaveBeenCalledOnce()
    closeDialog()
  })

  it('leaves an Escape that something inside already took (an editor’s completion list) alone', async () => {
    const { openLayer } = await import('../useDismiss')
    const dialog = vi.fn()
    openLayer(() => ({ onDismiss: dialog, options: { inside: () => [], outside: false } }))
    listeners.filter((l) => l.type === 'keydown').forEach((l) => l.fn({ key: 'Escape', defaultPrevented: true }))
    expect(dialog).not.toHaveBeenCalled()
    key('Escape')
    expect(dialog).toHaveBeenCalledOnce()
  })

  it('lets through what the layer ignores — a Popover’s own anchor, whose click closes it', async () => {
    const { openLayer } = await import('../useDismiss')
    const close = vi.fn()
    openLayer(() => ({ onDismiss: close, options: { inside: () => [], ignore: (e) => e.clientX < 10 } }))
    press(node('anchor'), { clientX: 5, clientY: 0 })
    expect(close).not.toHaveBeenCalled()
    press(node('elsewhere'), { clientX: 50, clientY: 0 })
    expect(close).toHaveBeenCalledOnce()
  })
})
