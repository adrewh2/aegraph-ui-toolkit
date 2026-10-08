import { acceptCompletion, autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap, type CompletionSource } from '@codemirror/autocomplete'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { javascript } from '@codemirror/lang-javascript'
import { python } from '@codemirror/lang-python'
import { bracketMatching, HighlightStyle, indentOnInput, syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language'
import { tags as t } from '@lezer/highlight'
import { Compartment, EditorState } from '@codemirror/state'
import { drawSelection, EditorView, highlightActiveLine, highlightActiveLineGutter, hoverTooltip, keymap, lineNumbers, placeholder as cmPlaceholder, tooltips } from '@codemirror/view'
import { useEffect, useImperativeHandle, useRef, type Ref } from 'react'
import type { Language } from '../../scripting/types'
import { helperTooltip } from '../expr/ExprEditor'
import './codeEditor.css'

interface Props {
  value: string
  language: Language
  onChange: (v: string) => void
  /** ⌘↵ / Ctrl+↵ */
  onRun?: () => void
  /** ⌘S / Ctrl+S */
  onSave?: () => void
  placeholder?: string
  className?: string
  /** Completion over the data and the vocabulary (scriptCompletion); hover shows a name's signature and sentence. */
  completion?: CompletionSource
  hover?: (name: string, doc: string, pos: number) => { signature: string; doc: string } | undefined
  /** To insert text at the cursor from outside (the Reference drawer). */
  handle?: Ref<CodeEditorHandle>
}

export interface CodeEditorHandle {
  insert: (text: string) => void
  focus: () => void
}

/**
 * The page's own palette for code, in place of CodeMirror's stock blues and purples, which belonged to another
 * app: the same warm ink the rest of the page is set in, with strings in green, numbers and constants in amber,
 * keywords in the link's rust and comments faint and italic so the code reads before its commentary does. The
 * colours are CSS variables (`codeEditor.css`), so the theme owns them rather than this file.
 */
const paletteHighlight = HighlightStyle.define([
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: 'var(--code-comment)', fontStyle: 'italic' },
  { tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.operatorKeyword], color: 'var(--code-keyword)' },
  { tag: [t.string, t.special(t.string), t.regexp], color: 'var(--code-string)' },
  { tag: [t.number, t.bool, t.null, t.atom], color: 'var(--code-number)' },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.definition(t.function(t.variableName))], color: 'var(--code-function)' },
  { tag: [t.typeName, t.className, t.namespace, t.standard(t.variableName)], color: 'var(--code-type)' },
  { tag: [t.propertyName, t.attributeName], color: 'var(--code-property)' },
  { tag: [t.operator, t.punctuation, t.separator, t.bracket, t.paren, t.brace, t.squareBracket], color: 'var(--code-punctuation)' },
  { tag: [t.variableName, t.definition(t.variableName)], color: 'var(--code-text)' },
  { tag: [t.meta, t.processingInstruction], color: 'var(--code-comment)' },
  { tag: t.invalid, color: 'var(--danger)' },
])

/**
 * The script editor: CodeMirror with JavaScript or Python highlighting,
 * switched live, completion that knows the data and the vocabulary, and
 * hover documentation. Uncontrolled inside (CodeMirror owns the
 * document); the value prop is pushed in only when it differs from what
 * the editor holds.
 */
export function CodeEditor({ value, language, onChange, onRun, onSave, placeholder, className, completion, hover, handle }: Props) {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const lang = useRef(new Compartment())
  const handlers = useRef({ onChange, onRun, onSave, completion, hover })
  handlers.current = { onChange, onRun, onSave, completion, hover }
  useImperativeHandle(handle, () => ({
    insert: (text) => {
      const v = view.current
      if (!v) return
      v.dispatch(v.state.replaceSelection(text))
      v.focus()
    },
    focus: () => view.current?.focus(),
  }))

  useEffect(() => {
    if (!host.current) return
    const state = EditorState.create({
      doc: value,
      extensions: [
        lineNumbers(),
        highlightActiveLineGutter(),
        highlightActiveLine(),
        history(),
        drawSelection(),
        indentOnInput(),
        bracketMatching(),
        syntaxHighlighting(paletteHighlight),
        // Whatever the palette above does not name keeps CodeMirror's own colour rather than none.
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        lang.current.of(language === 'python' ? python() : javascript({ typescript: false })),
        closeBrackets(),
        autocompletion({ override: [(ctx) => handlers.current.completion?.(ctx) ?? null], activateOnTyping: true, icons: false, maxRenderedOptions: 40 }),
        hoverTooltip((v, pos) => {
          const word = v.state.wordAt(pos)
          if (!word) return null
          const h = handlers.current.hover?.(v.state.sliceDoc(word.from, word.to), v.state.doc.toString(), pos)
          if (!h) return null
          return { pos: word.from, end: word.to, above: true, create: () => ({ dom: helperTooltip(h) }) }
        }),
        // Fixed positioning: the popups escape the pane's scroll box instead of being clipped by it.
        tooltips({ position: 'fixed' }),
        keymap.of([
          { key: 'Mod-Enter', run: () => (handlers.current.onRun?.(), true) },
          { key: 'Mod-s', run: () => (handlers.current.onSave?.(), true) },
          ...closeBracketsKeymap,
          ...completionKeymap,
          // Tab takes the suggestion while the list is open; otherwise it indents.
          { key: 'Tab', run: acceptCompletion },
          indentWithTab,
          ...defaultKeymap,
          ...historyKeymap,
        ]),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) handlers.current.onChange(u.state.doc.toString())
        }),
        EditorState.tabSize.of(2),
        ...(placeholder ? [cmPlaceholder(placeholder)] : []),
      ],
    })
    const v = new EditorView({ state, parent: host.current })
    view.current = v
    return () => {
      v.destroy()
      view.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const v = view.current
    if (!v) return
    const cur = v.state.doc.toString()
    if (cur !== value) v.dispatch({ changes: { from: 0, to: cur.length, insert: value } })
  }, [value])

  useEffect(() => {
    view.current?.dispatch({ effects: lang.current.reconfigure(language === 'python' ? python() : javascript({ typescript: false })) })
  }, [language])

  return <div ref={host} className={`ce ${className ?? ''}`} />
}
