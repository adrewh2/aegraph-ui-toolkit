import { describe, expect, it } from 'vitest'
import { initialFocus, isTabbable, shouldRestore, wrapTab, type FocusCandidate } from '../useFocusTrap'

/** An element as the checks see it: attributes, a tab index, and whether it is rendered. */
const el = (o: { tabIndex?: number; attrs?: string[]; rendered?: boolean; inert?: boolean } = {}): FocusCandidate => ({
  tabIndex: o.tabIndex ?? 0,
  hasAttribute: (n) => (o.attrs ?? []).includes(n),
  getClientRects: () => ({ length: o.rendered === false ? 0 : 1 }),
  closest: () => (o.inert ? {} : null),
})

describe('what Tab stops on', () => {
  it('a rendered, enabled element in the order', () => {
    expect(isTabbable(el())).toBe(true)
  })
  it('not one taken out of the order, disabled, hidden, inert or not rendered', () => {
    expect(isTabbable(el({ tabIndex: -1 }))).toBe(false)
    expect(isTabbable(el({ attrs: ['disabled'] }))).toBe(false)
    expect(isTabbable(el({ attrs: ['hidden'] }))).toBe(false)
    expect(isTabbable(el({ inert: true }))).toBe(false)
    expect(isTabbable(el({ rendered: false }))).toBe(false)
  })
})

describe('Tab wraps at the ends of a dialog', () => {
  const [a, b, c] = ['a', 'b', 'c']
  const list = [a, b, c]
  it('from the last element forwards goes to the first', () => {
    expect(wrapTab(list, c, false)).toBe(a)
  })
  it('from the first backwards goes to the last', () => {
    expect(wrapTab(list, a, true)).toBe(c)
  })
  it('in the middle the browser takes the ordinary step', () => {
    expect(wrapTab(list, b, false)).toBeNull()
    expect(wrapTab(list, b, true)).toBeNull()
    expect(wrapTab(list, a, false)).toBeNull()
    expect(wrapTab(list, c, true)).toBeNull()
  })
  it('from outside the list (the dialog box itself) forwards to the first, backwards to the last', () => {
    expect(wrapTab(list, 'box', false)).toBe(a)
    expect(wrapTab(list, 'box', true)).toBe(c)
    expect(wrapTab(list, null, false)).toBe(a)
  })
  it('with nothing to reach, the focus stays where it is', () => {
    expect(wrapTab([], 'box', false)).toBe('stay')
  })
})

describe('where the focus goes as a dialog opens', () => {
  const box = (...inside: string[]) => ({ name: 'box', contains: (n: unknown) => n === 'box' || inside.includes(n as string) })
  it('stays on what the markup focused (autoFocus) when that is inside', () => {
    const b = box('confirm')
    expect(initialFocus(b as never, 'confirm', null, ['cancel', 'confirm'] as never)).toBeNull()
  })
  it('else the element marked data-autofocus', () => {
    const b = box('input')
    expect(initialFocus(b as never, 'opener', 'input' as never, ['first', 'input'] as never)).toBe('input')
  })
  it('else the first element Tab reaches', () => {
    expect(initialFocus(box() as never, 'opener', null, ['first', 'second'] as never)).toBe('first')
  })
  it('else the dialog box itself', () => {
    const b = box()
    expect(initialFocus(b as never, 'opener', null, [])).toBe(b)
  })
  it('focus on the box itself still moves in, to what is marked or first', () => {
    const b = box('first')
    expect(initialFocus(b as never, b, null, ['first'] as never)).toBe('first')
  })
})

describe('where the focus goes as it closes', () => {
  const body = { name: 'body', isConnected: true }
  const opener = { name: 'opener', isConnected: true }
  const inside = { name: 'inside', isConnected: true }
  const elsewhere = { name: 'elsewhere', isConnected: true }
  const box = { contains: (n: unknown) => n === inside }
  it('back to the opener from inside the dialog, or from the body its removal left the focus on', () => {
    expect(shouldRestore(opener, inside, body, box)).toBe(true)
    expect(shouldRestore(opener, body, body, box)).toBe(true)
    expect(shouldRestore(opener, null, body, box)).toBe(true)
  })
  it('not when the action moved the focus on elsewhere', () => {
    expect(shouldRestore(opener, elsewhere, body, box)).toBe(false)
  })
  it('not to an opener that has left the document, or to the body', () => {
    expect(shouldRestore({ name: 'gone', isConnected: false }, inside, body, box)).toBe(false)
    expect(shouldRestore(body, inside, body, box)).toBe(false)
    expect(shouldRestore(null, inside, body, box)).toBe(false)
  })
})
