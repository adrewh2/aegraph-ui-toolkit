import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import type { Node as PMNode } from '@tiptap/pm/model'
import type { Highlight } from '../../../components/Markdown'

/**
 * Paints annotation quotes as inline decorations, so highlights live over
 * the text without touching the document (nothing to serialize, nothing
 * the user can accidentally delete). Quotes are matched per text block,
 * across mark boundaries.
 */

export const highlightsKey = new PluginKey<DecorationSet>('annotationHighlights')

export interface HighlightsOptions {
  getHighlights: () => Highlight[]
  onClick?: (id: string) => void
}

export const AnnotationHighlights = Extension.create<HighlightsOptions>({
  name: 'annotationHighlights',

  addOptions() {
    return { getHighlights: () => [], onClick: undefined }
  },

  addProseMirrorPlugins() {
    const opts = this.options
    return [
      new Plugin<DecorationSet>({
        key: highlightsKey,
        state: {
          init: (_, state) => build(state.doc, opts.getHighlights()),
          apply: (tr, old, _oldState, newState) => (tr.docChanged || tr.getMeta(highlightsKey) ? build(newState.doc, opts.getHighlights()) : old),
        },
        props: {
          decorations(state) {
            return highlightsKey.getState(state)
          },
          handleClick(_view, _pos, event) {
            const id = (event.target as HTMLElement | null)?.closest?.('[data-highlight]')?.getAttribute('data-highlight')
            if (id && opts.onClick) {
              opts.onClick(id)
              return true
            }
            return false
          },
        },
      }),
    ]
  },
})

function build(doc: PMNode, highlights: Highlight[]): DecorationSet {
  const active = highlights.filter((h) => h.exact)
  if (active.length === 0) return DecorationSet.empty
  const decos: Decoration[] = []
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true
    // Flatten the block to a string with a char → doc position map, so quotes can span marks.
    let text = ''
    const at: number[] = []
    node.forEach((child, offset) => {
      const start = pos + 1 + offset
      if (child.isText) {
        for (let i = 0; i < child.text!.length; i++) at.push(start + i)
        text += child.text
      } else {
        at.push(start)
        text += '￼'
      }
    })
    for (const h of active) {
      let from = text.indexOf(h.exact)
      while (from !== -1) {
        const to = from + h.exact.length
        decos.push(
          Decoration.inline(at[from], at[to - 1] + 1, {
            class: 'md-hl',
            'data-highlight': h.id,
            title: h.title ?? '',
            ...(h.color ? { style: `background:${h.color}` } : {}),
          }),
        )
        from = text.indexOf(h.exact, to)
      }
    }
    return false
  })
  return DecorationSet.create(doc, decos)
}
