import { acceptCompletion, autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from '@codemirror/autocomplete'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { javascript } from '@codemirror/lang-javascript'
import { bracketMatching, defaultHighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { linter, type Diagnostic } from '@codemirror/lint'
import { Compartment, EditorState } from '@codemirror/state'
import { drawSelection, EditorView, hoverTooltip, keymap, placeholder as cmPlaceholder, tooltips } from '@codemirror/view'
import { BookOpen, Check, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useDismiss } from '../../components/ui/useDismiss'
import { ENTITY_FIELDS, RULE_HELPERS, RulePending, compileRule, loadRuleRealm, verdict, type RuleHelper } from '../../core/constraints/rules'
import { displayLabel } from '../../core/entity/entity'
import { useEntityStore, useStoreDataVersion, useTypeRegistry } from '../../core/entity/hooks'
import type { AnyEntity } from '../../core/entity/types'
import { exprCompletion, RULE_VOCABULARY, type Vocabulary } from './completion'
import { buildExprSchema, type ExprSchema } from './schema'
import './expr.css'

/**
 * The expression editor: one or a few lines of JavaScript over an entity,
 * with completion that knows the data (properties of the watched types
 * with kind, coverage and a sample; relationship types and what they
 * join; entity types; tags) and the vocabulary (the helpers, each with a
 * signature and a sentence), hover documentation, a syntax check as you
 * type, a reference drawer, and “try it”: pick an entity of the watched
 * type and see the verdict live. Built for rules; the vocabulary and the
 * evaluator are parameters, so a value expression elsewhere can use the
 * same editor with its own.
 */

export interface ExprEditorProps {
  value: string
  onChange: (v: string) => void
  /** Narrow property completion to these types (the rule's `applies.types`); empty = every type. */
  types?: string[]
  vocabulary?: Vocabulary
  placeholder?: string
  /** Rows the editor starts with. */
  rows?: number
  /** Evaluate the expression against an entity; returns a verdict message, or nothing when it passes. Default: the rule evaluator. */
  evaluate?: (code: string, entity: AnyEntity) => string | undefined
  /** ⌘↵ */
  onSubmit?: () => void
  autoFocus?: boolean
}

let schemaCache: { store: unknown; version: number; schema: ExprSchema } | null = null

/** The schema for the editor's completion, built once per store data version. */
export function useExprSchema(): ExprSchema {
  const store = useEntityStore()
  const registry = useTypeRegistry()
  const version = useStoreDataVersion(store)
  return useMemo(() => {
    if (schemaCache && schemaCache.store === store && schemaCache.version === version) return schemaCache.schema
    const schema = buildExprSchema(store, registry)
    schemaCache = { store, version, schema }
    return schema
  }, [store, registry, version])
}

const defaultEvaluate = (store: ReturnType<typeof useEntityStore>) => (code: string, entity: AnyEntity) => {
  const fn = compileRule(code)
  return verdict(fn(entity, { store, others: new Map() }, store.get(entity.id)))
}

export function ExprEditor({ value, onChange, types, vocabulary = RULE_VOCABULARY, placeholder, rows = 4, evaluate, onSubmit, autoFocus }: ExprEditorProps) {
  const store = useEntityStore()
  const schema = useExprSchema()
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const live = useRef({ onChange, onSubmit, schema, types, vocabulary })
  live.current = { onChange, onSubmit, schema, types, vocabulary }
  const completion = useRef(new Compartment())
  const [reference, setReference] = useState(false)

  // Rules compile in the QuickJS realm (core/constraints/realm.ts); load it with the editor.
  useEffect(() => void loadRuleRealm(), [])

  useEffect(() => {
    if (!host.current) return
    const source = exprCompletion(
      () => live.current.schema,
      () => live.current.types,
      vocabulary,
    )
    const hover = hoverTooltip((v, pos) => {
      const word = v.state.wordAt(pos)
      if (!word) return null
      const name = v.state.sliceDoc(word.from, word.to)
      const h = vocabulary.helpers.find((x) => x.name === name)
      if (!h) return null
      return { pos: word.from, end: word.to, above: true, create: () => ({ dom: helperTooltip(h) }) }
    })
    const syntax = linter(
      (v) => {
        const code = v.state.doc.toString()
        if (!code.trim()) return []
        try {
          compileRule(code)
          return []
        } catch (err) {
          // The realm is still loading (it was asked for on mount): no verdict yet rather than a false error.
          if (err instanceof RulePending) return []
          const d: Diagnostic = { from: 0, to: v.state.doc.length, severity: 'error', message: err instanceof Error ? err.message : String(err) }
          return [d]
        }
      },
      { delay: 400 },
    )
    const state = EditorState.create({
      doc: value,
      extensions: [
        history(),
        drawSelection(),
        bracketMatching(),
        closeBrackets(),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        javascript(),
        completion.current.of(autocompletion({ override: [source], activateOnTyping: true, icons: false, maxRenderedOptions: 40 })),
        hover,
        syntax,
        // Fixed positioning: the popups escape a dialog's or a pane's scroll box instead of being clipped by it.
        tooltips({ position: 'fixed' }),
        keymap.of([{ key: 'Mod-Enter', run: () => (live.current.onSubmit?.(), true) }, { key: 'Tab', run: acceptCompletion }, ...closeBracketsKeymap, ...completionKeymap, ...defaultKeymap, ...historyKeymap]),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) live.current.onChange(u.state.doc.toString())
        }),
        EditorView.lineWrapping,
        EditorState.tabSize.of(2),
        ...(placeholder ? [cmPlaceholder(placeholder)] : []),
      ],
    })
    const v = new EditorView({ state, parent: host.current })
    view.current = v
    if (autoFocus) v.focus()
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

  const watched = types?.length ? types : undefined
  const evaluator = evaluate ?? defaultEvaluate(store)

  return (
    <div className="xp">
      <div ref={host} className="xp__editor" style={{ minHeight: `${rows * 1.55 + 1}em` }} />
      <div className="xp__bar">
        <TryIt code={value} types={watched} evaluate={evaluator} />
        <span className="spacer" />
        <span className="xp__hint faint">⌃Space completes · hover a name for its meaning</span>
        <button type="button" className={`btn btn--sm btn--ghost ${reference ? 'is-active' : ''}`} onClick={() => setReference((r) => !r)}>
          <BookOpen size={12} /> Reference
        </button>
      </div>
      {reference && <Reference schema={schema} types={watched} vocabulary={vocabulary} onInsert={(text) => view.current?.dispatch(view.current.state.replaceSelection(text))} />}
    </div>
  )
}

/** The hover card for a helper: its signature over its sentence. Shared with the script editor. */
export function helperTooltip(h: Pick<RuleHelper, 'signature' | 'doc'>): HTMLElement {
  const dom = document.createElement('div')
  dom.className = 'xp__tip'
  const sig = document.createElement('div')
  sig.className = 'xp__tip-sig'
  sig.textContent = h.signature
  const doc = document.createElement('div')
  doc.textContent = h.doc
  dom.append(sig, doc)
  return dom
}

// ── Try it: the verdict on a real entity, live ───────────────────────────

function TryIt({ code, types, evaluate }: { code: string; types?: string[]; evaluate: (code: string, e: AnyEntity) => string | undefined }) {
  const store = useEntityStore()
  const [q, setQ] = useState('')
  const [picked, setPicked] = useState<AnyEntity | null>(null)
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLSpanElement>(null)
  // The picker sits in the constraint dialogs: a press elsewhere, or Escape, closes the picker and leaves the dialog.
  useDismiss(() => setOpen(false), { active: open, inside: () => [root.current] })
  const candidates = useMemo(() => {
    const pool = types?.length ? types.flatMap((t) => store.ofType(t)) : store.all()
    const needle = q.trim().toLowerCase()
    const list = needle ? pool.filter((e) => displayLabel(e).toLowerCase().includes(needle) || e.id.includes(needle)) : pool
    return list.slice(0, 8)
  }, [store, types, q])
  const sample = picked ?? candidates[0] ?? null
  const result = useMemo(() => {
    if (!sample || !code.trim()) return null
    try {
      const m = evaluate(code, sample)
      return m ? { ok: false, message: m } : { ok: true, message: 'passes' }
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) }
    }
  }, [sample, code, evaluate])
  if (!sample) return <span className="faint xp__try">Nothing to try it on yet.</span>
  return (
    <span className="xp__try" ref={root}>
      <span className="faint">Try on</span>
      <button type="button" className="xp__pick" onClick={() => setOpen((o) => !o)} title={sample.id}>
        {displayLabel(sample)} <span className="faint">({sample.type})</span>
      </button>
      {result && (
        <span className={`xp__verdict ${result.ok ? 'is-ok' : 'is-bad'}`} title={result.message}>
          {result.ok ? <Check size={12} /> : <X size={12} />} {result.message.length > 70 ? result.message.slice(0, 67) + '…' : result.message}
        </span>
      )}
      {open && (
        <span className="xp__picker">
          <input className="input" autoFocus placeholder="Find an entity…" value={q} onChange={(e) => setQ(e.target.value)} />
          {candidates.map((e) => (
            <button key={e.id} type="button" className="xp__cand" onClick={() => (setPicked(e), setOpen(false))}>
              {displayLabel(e)} <span className="faint">{e.type}</span>
            </button>
          ))}
        </span>
      )}
    </span>
  )
}

// ── Reference: what can be written ───────────────────────────────────────

function Reference({ schema, types, vocabulary, onInsert }: { schema: ExprSchema; types?: string[]; vocabulary: Vocabulary; onInsert: (text: string) => void }) {
  const [tab, setTab] = useState<'helpers' | 'properties' | 'relationships' | 'types'>('helpers')
  const shown = types?.length ? types : schema.types.filter((t) => t.kind === 'entity').slice(0, 6).map((t) => t.type)
  return (
    <div className="xp__ref">
      <div className="xp__ref-tabs">
        {(['helpers', 'properties', 'relationships', 'types'] as const).map((t) => (
          <button key={t} type="button" className={tab === t ? 'is-active' : ''} onClick={() => setTab(t)}>
            {t}
          </button>
        ))}
        <span className="spacer" />
        <span className="faint">click to insert</span>
      </div>
      <div className="xp__ref-body">
        {tab === 'helpers' && (
          <>
            {vocabulary.helpers.map((h) => (
              <button key={h.name} type="button" className="xp__ref-row" onClick={() => onInsert(h.signature.includes('(') ? `${h.name}(` : h.name)} title={h.doc}>
                <span className="mono xp__ref-name">{h.signature}</span>
                <span className="muted">{h.doc}</span>
              </button>
            ))}
            <div className="xp__ref-note muted">
              <span className="mono">e</span> has {ENTITY_FIELDS.map((f) => f.name).join(', ')}. An expression's value decides: true passes; false or a string (the message) fails. With a <span className="mono">return</span> it is a function body.
            </div>
          </>
        )}
        {tab === 'properties' &&
          shown.map((t) => (
            <div key={t} className="xp__ref-group">
              <div className="xp__ref-head">{t}</div>
              {(schema.properties.get(t) ?? []).map((p) => (
                <button key={p.key} type="button" className="xp__ref-row" onClick={() => onInsert(`e.data.${p.key}`)} title={p.description ?? (p.sample !== undefined ? `e.g. ${p.sample}` : '')}>
                  <span className="mono xp__ref-name">data.{p.key}</span>
                  <span className="xp__ref-kind">{p.kind}</span>
                  <span className="xp__ref-cov">{Math.round(p.coverage * 100)}%</span>
                  <span className="muted xp__ref-sample">{p.description ?? (p.sample !== undefined ? `e.g. ${p.sample}` : '')}</span>
                </button>
              ))}
              {!(schema.properties.get(t) ?? []).length && <div className="faint">no properties seen</div>}
            </div>
          ))}
        {tab === 'relationships' &&
          schema.relationshipTypes.map((r) => (
            <button key={r.type} type="button" className="xp__ref-row" onClick={() => onInsert(`out('${r.type}')`)}>
              <span className="mono xp__ref-name">{r.type}</span>
              <span className="xp__ref-cov">{r.count.toLocaleString()}</span>
              <span className="muted xp__ref-sample">{r.pairs.join(' · ')}</span>
            </button>
          ))}
        {tab === 'types' &&
          schema.types.map((t) => (
            <button key={t.type} type="button" className="xp__ref-row" onClick={() => onInsert(`'${t.type}'`)}>
              <span className="mono xp__ref-name">{t.type}</span>
              <span className="xp__ref-kind">{t.kind}</span>
              <span className="xp__ref-cov">{t.count.toLocaleString()}</span>
              <span className="muted xp__ref-sample">{t.label}</span>
            </button>
          ))}
      </div>
    </div>
  )
}

export { RULE_HELPERS }
