/**
 * Observe an element's size, but only report it once it has stopped changing for a couple of frames.
 * Layout animations (the assistant dock sliding open) resize the element every frame; canvases that
 * re-render on each size change would stutter the animation, so they take the final size instead.
 */
export function observeSettledSize(el: Element, cb: (rect: DOMRectReadOnly) => void, settleMs = 50): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined
  let last: DOMRectReadOnly | undefined
  const ro = new ResizeObserver(([entry]) => {
    last = entry.contentRect
    clearTimeout(timer)
    timer = setTimeout(() => {
      if (last) cb(last)
    }, settleMs)
  })
  ro.observe(el)
  return () => {
    clearTimeout(timer)
    ro.disconnect()
  }
}
