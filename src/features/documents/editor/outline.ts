import type { Editor } from '@tiptap/react'

export interface OutlineEntry {
  level: number
  text: string
  pos: number
}

/** Headings in document order, with their ProseMirror positions for jumping. */
export function outlineOf(editor: Editor): OutlineEntry[] {
  const out: OutlineEntry[] = []
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === 'heading') out.push({ level: node.attrs.level as number, text: node.textContent, pos })
    return node.type.name !== 'heading'
  })
  return out
}
