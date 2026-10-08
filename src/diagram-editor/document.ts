/**
 * The diagram editor's document, as far as the rest of the app needs to
 * know: an Excalidraw scene file kept as text. No dependencies, so the
 * app can create and inspect documents without loading the editor.
 */

/** What a new canvas starts from. */
export const EMPTY_SCENE = '{"type":"excalidraw","version":2,"source":"aegraph","elements":[],"appState":{"viewBackgroundColor":"#ffffff","gridSize":null},"files":{}}'

/** Whether the text is a scene file at all. */
export function isScene(text: string | undefined): boolean {
  if (!text) return false
  try {
    const v = JSON.parse(text) as { type?: unknown; elements?: unknown }
    return v?.type === 'excalidraw' && Array.isArray(v.elements)
  } catch {
    return false
  }
}

/** Counts for a status line, without loading the editor. */
export function sceneSummary(text: string | undefined): { elements: number; shapes: number; arrows: number; text: number } {
  let elements: { isDeleted?: boolean; type?: string }[] = []
  try {
    elements = text ? ((JSON.parse(text) as { elements?: typeof elements }).elements ?? []) : []
  } catch {
    /* not a scene */
  }
  let shapes = 0
  let arrows = 0
  let texts = 0
  for (const e of elements) {
    if (e.isDeleted) continue
    if (e.type === 'arrow' || e.type === 'line') arrows++
    else if (e.type === 'text') texts++
    else shapes++
  }
  return { elements: shapes + arrows + texts, shapes, arrows, text: texts }
}
