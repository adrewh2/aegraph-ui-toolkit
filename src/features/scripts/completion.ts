import type { Completion, CompletionContext, CompletionResult } from '@codemirror/autocomplete'
import type { Language } from '../../scripting/types'
import type { ExprSchema } from '../expr/schema'
import { Bindings, Inference, collectBindings, receiverBefore, type Ty } from './infer'
import { AGGS, BIN_UNITS, VIEW_LIBS, helpersFor, type ScriptHelper } from './vocabulary'

/**
 * Completion for scripts: what the cursor's expression *is*, inferred from
 * the document (infer.ts) and the data schema, decides what is offered —
 *
 *   ds.|                       the dataset's members
 *   people = ds.byType('person'); people[0].data.|   person's properties, with kind, coverage, a sample
 *   ds.get(r.target).data.|    the properties of what r points at
 *   e.data.severity === '|     the values severity takes
 *   ds.byType('|               the types, with counts      (by_type('| in Python)
 *   ds.out(id, '|              the relationship types and what they join
 *   ds.tagged('|  ds.metric('| the tags; the metrics
 *   df = by_type('incident'); df['|   the columns (Python)
 *   bare                       the helpers of the language, and the document's own variables with what they hold
 */

/** The string literal the cursor is inside, if any: where its quote is and the text typed so far. */
export function openString(before: string): { at: number; text: string } | null {
  let open: string | null = null
  let at = -1
  for (let i = 0; i < before.length; i++) {
    const ch = before[i]
    if (open) {
      if (ch === '\\') i++
      else if (ch === open) open = null
    } else if (ch === '"' || ch === "'" || ch === '`') {
      open = ch
      at = i
    } else if (ch === '/' && before[i + 1] === '/') return null
    else if (ch === '#' && before.slice(0, i).trim() === '') return null
  }
  return open ? { at, text: before.slice(at + 1) } : null
}

export interface ScriptCompletionSources {
  schema: () => ExprSchema
  language: () => Language
  /** The metrics the latest analysis run computed. */
  metrics?: () => string[]
}

/** One inference over one document, shared by completion and hover. */
export function analyse(schema: ExprSchema, language: Language, doc: string, pos: number): { infer: Inference; bindings: Bindings } {
  const infer = new Inference(schema, language)
  return { infer, bindings: new Bindings(collectBindings(doc, language), infer, pos) }
}

export function scriptCompletion({ schema, language, metrics }: ScriptCompletionSources) {
  const typeOptions = (kind?: 'entity' | 'relationship'): Completion[] =>
    schema()
      .types.filter((t) => !kind || t.kind === kind)
      .map((t, i, all) => ({ label: t.type, type: 'type', detail: `${t.count.toLocaleString()} ${t.kind === 'relationship' ? 'relationships' : 'entities'}`, info: t.label, boost: Math.round(((all.length - i) / all.length) * 9) }))
  const relOptions = (): Completion[] => schema().relationshipTypes.map((r, i, all) => ({ label: r.type, type: 'type', detail: r.count.toLocaleString(), info: r.pairs.length ? r.pairs.join('\n') : undefined, boost: Math.round(((all.length - i) / all.length) * 9) }))
  const tagOptions = (): Completion[] => schema().tags.map((t) => ({ label: t, type: 'constant' }))
  const plain = (xs: string[], type = 'constant'): Completion[] => xs.map((x) => ({ label: x, type }))
  const metricOptions = () => plain(metrics?.() ?? ['pagerank', 'betweenness', 'community', 'degree'])
  const helperOption = (h: ScriptHelper, boost = 0): Completion => ({
    label: h.name,
    type: h.signature.includes('(') ? 'function' : 'variable',
    detail: h.signature.replace(/^[^(]*/, '').replace(/ → .*/, '') || (h.signature.includes(' → ') ? h.signature.replace(/^.* → /, '') : undefined),
    info: `${h.signature}\n${h.doc}`,
    boost,
    // Typing a function drops the cursor between its parentheses.
    apply: h.signature.includes('(') ? h.name + '(' : h.name,
  })
  const forArg = (h: ScriptHelper | undefined, index: number): Completion[] | null => {
    if (!h?.arg || ((h.argIndex ?? 0) !== -1 && (h.argIndex ?? 0) !== index)) return null
    switch (h.arg) {
      case 'type':
        return typeOptions('entity')
      case 'rel':
        return relOptions()
      case 'tag':
        return tagOptions()
      case 'metric':
        return metricOptions()
      case 'unit':
        return plain(BIN_UNITS)
      case 'agg':
        return plain(AGGS)
      case 'lib':
        return plain(VIEW_LIBS)
      default:
        return null
    }
  }
  /** What a value of a type may be, as a string: the names it is one of. */
  const namesFor = (infer: Inference, ty: Ty): Completion[] | null => {
    if (ty.k === 'value') {
      const vs = infer.values(ty.types, ty.key, ty.rel)
      return vs.length ? vs.map((v, i, all) => ({ label: v, type: 'constant', boost: Math.round(((all.length - i) / all.length) * 9) })) : null
    }
    if (ty.k === 'name') return ty.of === 'type' ? typeOptions('entity') : ty.of === 'rel' ? relOptions() : ty.of === 'tag' ? tagOptions() : metricOptions()
    if (ty.k === 'list') return namesFor(infer, ty.of)
    return null
  }
  /** The members of a value as completions. */
  const memberOptions = (infer: Inference, ty: Ty, members = infer.members(ty)): Completion[] =>
    members.map((m, i) => {
      const fn = m.ty.k === 'method'
      const kind = m.ty.k === 'data' || m.ty.k === 'value' ? 'property' : fn ? 'method' : m.ty.k === 'list' || m.ty.k === 'df' ? 'variable' : 'property'
      // A property row already says what it is (kind, coverage, values); other members get the inferred description.
      const what = fn || m.ty.k === 'value' ? undefined : infer.describe(m.ty)
      const coverage = ty.k === 'data' ? Number(m.detail?.match(/(\d+)%/)?.[1] ?? 0) : 0
      return { label: m.name, type: kind, detail: m.detail ?? (fn ? '(…)' : undefined), info: [m.doc, what && what !== m.detail ? what : undefined].filter(Boolean).join('\n') || undefined, boost: ty.k === 'data' ? Math.round(coverage / 10) : ty.k === 'list' && i === 0 ? 1 : 0, apply: fn ? `${m.name}(` : m.name }
    })

  return (context: CompletionContext): CompletionResult | null => {
    const lang = language()
    const { bare, members } = helpersFor(lang)
    const doc = context.state.doc.toString()
    const { infer, bindings } = analyse(schema(), lang, doc, context.pos)
    const typeOf = (expr: string | null): Ty => (expr ? infer.typeOf(expr, bindings) : { k: 'unknown' })
    const line = context.state.doc.lineAt(context.pos)
    const before = context.state.sliceDoc(line.from, context.pos)
    const py = lang === 'python'

    // ── Inside a string literal ──
    const str = openString(before)
    if (str) {
      const from = context.pos - str.text.length
      const prefix = before.slice(0, str.at)
      let options: Completion[] | null = null
      // A comparison: what is on the left decides — e.data.severity === '…', e.type === '…', r['type'] == '…'
      const cmp = /^(.*?)\s*(?:===|!==|==|!=)\s*$/.exec(prefix)
      if (cmp) {
        options = namesFor(infer, typeOf(receiverBefore(cmp[1], cmp[1].length)))
        // Nothing known about the left side: its last member still says what it is.
        if (!options && /\.type$|\[\s*['"]type['"]\s*\]$/.test(cmp[1])) options = typeOptions()
      }
      // An index: df['…'], e['data']['…'], e.data['…'], ds.metrics['…']
      const idx = !options && /\[\s*$/.exec(prefix)
      if (idx) {
        const ty = typeOf(receiverBefore(prefix, idx.index))
        if (ty.k === 'metrics') options = metricOptions()
        else if (ty.k === 'df') options = memberOptions(infer, ty, infer.columns(ty))
        else if (ty.k === 'coll' && py) options = memberOptions(infer, ty, infer.columns({ k: 'df', types: ty.types, rel: ty.rel }))
        else if (ty.k !== 'unknown' && ty.k !== 'any') {
          const ms = infer.members(ty).filter((m) => m.ty.k !== 'method')
          options = ms.length ? memberOptions(infer, ty, ms) : null
        }
      }
      // .includes('…') on tags or a categorical value
      const inc = !options && /\.(includes|indexOf|startsWith)\(\s*$/.exec(prefix)
      if (inc) {
        const recv = receiverBefore(prefix, inc.index)
        options = namesFor(infer, typeOf(recv)) ?? (recv && /\.tags$/.test(recv) ? tagOptions() : null)
      }
      // Python: '…' in e['tags']
      const pin = !options && py && /\bin\s+(.+)$/.exec(prefix)
      if (pin) options = namesFor(infer, typeOf(receiverBefore(pin[1], pin[1].length)))
      // A method on a collection: entities.filter({ types: '…' }) / filter(types='…'), .out('…'), .sort('data.…'), .table(['…'])
      const mcall = !options && /\.(\w+)\s*\(([^()]*)$/.exec(prefix)
      if (mcall) {
        const recv = typeOf(receiverBefore(prefix, mcall.index))
        if (recv.k === 'coll') {
          const [, name, args] = mcall
          const types = () => (recv.rel ? relOptions() : typeOptions('entity'))
          const paths = (): Completion[] => [...plain(recv.rel ? ['id', 'type', 'source', 'target'] : ['id', 'type', 'label', 'tags', 'createdAt', 'updatedAt'], 'property'), ...infer.properties(recv.types, recv.rel).map((p) => ({ label: `data.${p.key}`, type: 'property', detail: `${p.kind} · ${Math.round(p.coverage * 100)}%` }))]
          if (name === 'filter' || name === 'exclude') {
            // data: { key: '…' } — the values a property takes; otherwise the spec key before the quote.
            const inData = /\bdata\s*[:=]\s*\{[^}]*?['"]?(\w+)['"]?\s*:\s*$/.exec(args)
            const key = inData ? null : /(\w+)\s*[:=]\s*$/.exec(args)?.[1]
            if (inData) {
              const vs = infer.values(recv.types, inData[1], recv.rel)
              options = vs.length ? plain(vs) : null
            } else if (key) {
              const k = key.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase())
              if (k === 'types' || k === 'type') options = types()
              else if (k === 'tags' || k === 'tag' || k === 'all_tags') options = tagOptions()
              else if (k === 'rel') options = relOptions()
              else if (k === 'source_type' || k === 'target_type' || k === 'source_types' || k === 'target_types') options = typeOptions('entity')
              else if (k === 'has') options = infer.properties(recv.types, recv.rel).map((p) => ({ label: p.key, type: 'property', detail: p.kind }))
            }
          } else if (name === 'type') options = types()
          else if (name === 'tagged') options = tagOptions()
          else if (['out', 'into', 'links', 'neighbors'].includes(name)) options = args.split(',').length - 1 === 0 ? relOptions() : name === 'neighbors' ? plain(['out', 'in', 'both']) : null
          else if (['sort', 'top', 'pluck', 'unique', 'group', 'rollup', 'table'].includes(name)) options = name === 'rollup' && args.split(',').length - 1 === 2 ? plain(AGGS) : paths()
          if (options) return options.length ? { from, options, validFor: /^[^"'`]*$/ } : null
        }
      }
      // The argument of a call: which argument, of which helper
      const call = !options && /([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?)\s*\(([^()]*)$/.exec(prefix)
      if (call) {
        const [, callee, args] = call
        const index = args.split(',').length - 1
        const dot = callee.indexOf('.')
        const h = dot >= 0 ? members.find((m) => m.of === callee.slice(0, dot) && m.name === callee.slice(dot + 1)) : bare.find((m) => m.name === callee)
        options = forArg(h, index)
        // An unknown call gets the names there are; a known helper whose argument here is an id or a value gets nothing.
        if (!options && !h) options = [...typeOptions(), ...tagOptions()]
      }
      if (!options?.length) return null
      return { from, options, validFor: /^[^"'`]*$/ }
    }

    // ── After a dot: the members of what precedes it ──
    const word = context.matchBefore(/[\w$]*/)
    const partial = word?.text ?? ''
    const dotAt = context.pos - partial.length
    if (before[dotAt - line.from - 1] === '.') {
      const recv = receiverBefore(before, dotAt - line.from - 1)
      const ty = typeOf(recv)
      const from = dotAt
      const validFor = /^[\w$]*$/
      if (ty.k === 'ds' && py) return null
      if (ty.k === 'ds') {
        // The vocabulary's entries carry the signatures; the inference adds what each returns.
        const inferred = infer.members(ty)
        const returns = (name: string) => {
          const t = inferred.find((x) => x.name === name)?.ty
          const d = t && t.k !== 'method' ? infer.describe(t) : undefined
          return d ? `\n→ ${d}` : ''
        }
        return { from, options: members.filter((m) => m.of === 'ds').map((m, i) => ({ ...helperOption(m, m.group === 'dataset' ? 3 : m.group === 'project' ? 2 : i < 6 ? 1 : 0), info: `${m.signature}\n${m.doc}${returns(m.name)}` })), validFor }
      }
      if (ty.k === 'aegraph') return { from, options: members.filter((m) => m.of === 'aegraph').map((m) => helperOption(m)), validFor }
      if (ty.k === 'any') return null
      if (ty.k !== 'unknown') {
        const ms = infer.members(ty)
        if (ms.length) return { from, options: memberOptions(infer, ty, ms), validFor }
      }
      // Unknown: something that is probably an entity — a loop variable, a []-index — gets the entity's shape.
      if (!py && recv && (/^[a-z]$|^(e|x|n|row|entity|node|item)$/.test(recv) || /[)\]]$/.test(recv))) return { from, options: memberOptions(infer, { k: 'entity', types: null }), validFor }
      if (recv && /(^|\.)data$/.test(recv)) return { from, options: memberOptions(infer, { k: 'data', types: null }), validFor }
      return null
    }

    // ── A bare word: the helpers, and the document's own names with what they hold ──
    if (!context.explicit && partial.length < 2) return null
    const own: Completion[] = []
    const seen = new Set<string>()
    for (const b of bindings.all()) {
      if (seen.has(b.name) || b.at >= context.pos) continue
      seen.add(b.name)
      const ty = bindings.lookup(b.name, (e) => infer.typeOf(e, bindings))
      const what = ty ? infer.describe(ty) : undefined
      own.push({ label: b.name, type: 'variable', detail: what ? what.split(/[:—(]/)[0].trim() : undefined, info: what, boost: 2 })
    }
    return { from: context.pos - partial.length, options: [...own, ...bare.map((h, i) => helperOption(h, h.name === 'ds' ? 5 : i < 3 ? 1 : 0))], validFor: /^[\w$]*$/ }
  }
}

/** What to say on hover: a helper's card, or a variable and what it holds. */
export function hoverFor(schema: ExprSchema, language: Language, doc: string, pos: number, name: string): { signature: string; doc: string } | undefined {
  const { bare, members } = helpersFor(language)
  const h = bare.find((x) => x.name === name) ?? members.find((x) => x.name === name)
  if (h) return h
  const { infer, bindings } = analyse(schema, language, doc, pos)
  const ty = bindings.lookup(name, (e) => infer.typeOf(e, bindings))
  const what = ty ? infer.describe(ty) : undefined
  return what ? { signature: name, doc: what } : undefined
}
