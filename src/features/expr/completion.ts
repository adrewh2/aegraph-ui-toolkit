import type { Completion, CompletionContext, CompletionResult } from '@codemirror/autocomplete'
import { ENTITY_FIELDS, META_FIELDS, RULE_HELPERS, STORE_METHODS, type RuleHelper } from '../../core/constraints/rules'
import type { ExprSchema } from './schema'

/**
 * Completion for rule expressions, driven by the schema and the
 * vocabulary: what is offered depends on where the cursor is —
 *
 *   e.|            the entity's fields
 *   e.data.|       the properties of the watched types, with kind, coverage and a sample
 *   e.meta.|       the meta fields
 *   store.|        the store's methods
 *   out('|         relationship types (and what they join)
 *   get('|         paths: label, tags, data.<key>…
 *   ofType('|      entity types
 *   e.type === '|  entity types
 *   tags.includes('|  tags
 *   bare           the helpers, each with its signature and a sentence
 *
 * The vocabulary (the bare names) is a parameter, so the same editor can
 * serve another place with its own helpers.
 */

export interface Vocabulary {
  helpers: RuleHelper[]
  /** The name of the entity variable (`e`). */
  entity: string
}

export const RULE_VOCABULARY: Vocabulary = { helpers: RULE_HELPERS, entity: 'e' }

const pct = (n: number) => `${Math.round(n * 100)}%`

export function exprCompletion(schema: () => ExprSchema, watched: () => string[] | undefined, vocab: Vocabulary = RULE_VOCABULARY) {
  const typesWatched = () => {
    const w = watched()
    const s = schema()
    return w?.length ? w : s.types.filter((t) => t.kind === 'entity').map((t) => t.type)
  }
  /** Properties of the watched types, merged: a key once, with the best coverage seen. */
  const propertyOptions = (): Completion[] => {
    const s = schema()
    const merged = new Map<string, { info: string; detail: string; boost: number }>()
    for (const t of typesWatched()) {
      for (const p of s.properties.get(t) ?? []) {
        const cur = merged.get(p.key)
        const detail = `${p.kind} · ${pct(p.coverage)}`
        const info = [p.description, p.sample !== undefined ? `e.g. ${p.sample}` : undefined, `${pct(p.coverage)} of ${t} entities carry it${p.declared ? ' · declared' : ''}`].filter(Boolean).join('\n')
        if (!cur || cur.boost < p.coverage) merged.set(p.key, { info, detail, boost: p.coverage })
      }
    }
    return [...merged].map(([label, m]) => ({ label, type: 'property', detail: m.detail, info: m.info, boost: Math.round(m.boost * 10) }))
  }
  const typeOptions = (kind?: 'entity' | 'relationship'): Completion[] =>
    schema()
      .types.filter((t) => !kind || t.kind === kind)
      .map((t, i, all) => ({ label: t.type, type: 'type', detail: `${t.count.toLocaleString()} ${t.kind === 'relationship' ? 'relationships' : 'entities'}`, info: t.label, boost: Math.round(((all.length - i) / all.length) * 9) }))
  // The most numerous first: what the data mostly has is what a rule mostly means.
  const relOptions = (): Completion[] => schema().relationshipTypes.map((r, i, all) => ({ label: r.type, type: 'type', detail: r.count.toLocaleString(), info: r.pairs.length ? r.pairs.join('\n') : undefined, boost: Math.round(((all.length - i) / all.length) * 9) }))
  const pathOptions = (): Completion[] => [
    { label: 'label', type: 'property' },
    { label: 'description', type: 'property' },
    { label: 'tags', type: 'property' },
    { label: 'type', type: 'property' },
    { label: 'id', type: 'property' },
    ...propertyOptions().map((p) => ({ ...p, label: `data.${p.label}` })),
    ...META_FIELDS.map((m) => ({ label: `meta.${m}`, type: 'property' as const })),
  ]
  const tagOptions = (): Completion[] => schema().tags.map((t) => ({ label: t, type: 'constant' }))
  const helperOptions = (): Completion[] =>
    vocab.helpers.map((h) => ({
      label: h.name,
      type: h.signature.includes('(') ? 'function' : 'variable',
      detail: h.signature.replace(/^[^(]*/, '').replace(/ → .*/, '') || undefined,
      info: `${h.signature}\n${h.doc}`,
      boost: h.name === vocab.entity ? 5 : 0,
      // Typing a function drops the cursor between its parentheses.
      apply: h.signature.includes('(') ? h.name + '(' : h.name,
    }))

  return (context: CompletionContext): CompletionResult | null => {
    const line = context.state.doc.lineAt(context.pos)
    const before = context.state.sliceDoc(line.from, context.pos)
    // Inside a string literal? Find an unmatched quote before the cursor.
    const str = /(["'`])([^"'`]*)$/.exec(before)
    if (str) {
      const from = context.pos - str[2].length
      const prefix = before.slice(0, before.length - str[2].length - 1)
      const call = /([A-Za-z_$][\w$]*)\s*\(\s*$/.exec(prefix)
      const helper = call ? vocab.helpers.find((h) => h.name === call[1]) : undefined
      let options: Completion[] = []
      if (helper?.arg === 'rel') options = relOptions()
      else if (helper?.arg === 'path') options = pathOptions()
      else if (helper?.arg === 'type') options = typeOptions('entity')
      else if (/\.type\s*(===|!==|==|!=)\s*$/.test(prefix) || /typeOf\([^)]*\)\s*(===|!==|==|!=)\s*$/.test(prefix)) options = typeOptions()
      else if (/tags\.includes\(\s*$/.test(prefix) || /tags\.some\([^)]*$/.test(prefix)) options = tagOptions()
      else if (/\.includes\(\s*$/.test(prefix)) options = tagOptions()
      else if (call) options = [...relOptions(), ...typeOptions()]
      if (!options.length) return null
      return { from, options, validFor: /^[^"'`]*$/ }
    }
    // A member chain or a bare word.
    const word = context.matchBefore(/[\w$]*(\.[\w$]*)*/)
    if (!word) return null
    const text = word.text
    const lastDot = text.lastIndexOf('.')
    if (lastDot >= 0) {
      const chain = text.slice(0, lastDot)
      const from = word.from + lastDot + 1
      const validFor = /^[\w$]*$/
      if (chain.endsWith('data')) return { from, options: propertyOptions(), validFor }
      if (chain.endsWith('meta')) return { from, options: META_FIELDS.map((m) => ({ label: m, type: 'property' })), validFor }
      if (chain === 'store' || chain.endsWith('.store')) return { from, options: STORE_METHODS.map((m) => ({ label: m.name, type: 'method', detail: m.signature.replace(/^[^(]*/, ''), info: m.doc, apply: m.name + '(' })), validFor }
      if (chain === vocab.entity || /\)$/.test(before.slice(0, before.length - (text.length - lastDot))) || /\]$/.test(chain) || chain === 'previous' || chain.endsWith('()')) {
        return { from, options: ENTITY_FIELDS.map((f) => ({ label: f.name, type: 'property', info: f.doc, detail: f.kind ? 'relationship' : undefined })), validFor }
      }
      return null
    }
    if (!context.explicit && !text) return null
    return { from: word.from, options: helperOptions(), validFor: /^[\w$]*$/ }
  }
}
