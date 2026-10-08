import type { Language } from '../../scripting/types'
import type { ExprSchema, PropertyInfo } from '../expr/schema'

/**
 * Scaffolds: scripts written from the data as it stands, so what a user
 * starts from names real things — the project, the types with their
 * counts, the properties a type's entities carry (with kind, coverage and
 * a sample as comments), the relationship types and what they join. A
 * scaffold is a function over the project state whose arguments are what
 * `ds` holds; the body is the part to edit.
 */

const q = (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
const pq = (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
const ident = (k: string) => (/^[A-Za-z_$][\w$]*$/.test(k) ? k : JSON.stringify(k))
const access = (k: string) => (/^[A-Za-z_$][\w$]*$/.test(k) ? `.${k}` : `[${JSON.stringify(k)}]`)
const pct = (n: number) => `${Math.round(n * 100)}%`
const n = (x: number) => x.toLocaleString('en-US')

/** `entities.types.person`, or `entities.types['schema:type']` for a name that is not an identifier. */
export const access_ = (type: string) => (/^[A-Za-z_$][\w$]*$/.test(type) ? `entities.types.${type}` : `entities.types[${q(type)}]`)

const propComment = (p: PropertyInfo) => [p.kind, pct(p.coverage), p.description ?? (p.sample !== undefined ? `e.g. ${p.sample}` : undefined)].filter(Boolean).join(' · ')

/** The state the scaffolds describe, from the editor's schema plus what only the host knows. */
export interface ScaffoldContext {
  schema: ExprSchema
  project?: { label: string; id: string }
  metrics?: string[]
}

/** The lines that describe the state, as comments in the language's syntax. */
function stateLines(ctx: ScaffoldContext, c: string): string[] {
  const { schema } = ctx
  const ents = schema.types.filter((t) => t.kind === 'entity')
  const rels = schema.relationshipTypes
  const total = ents.reduce((s, t) => s + t.count, 0)
  const list = (xs: string[], max = 6) => (xs.length > max ? [...xs.slice(0, max), '…'] : xs).join(', ')
  return [
    `${c}   project        ${ctx.project ? `${ctx.project.label} (${ctx.project.id})` : 'null — the Library is open'}`,
    `${c}   ontology       ${ents.length} type${ents.length === 1 ? '' : 's'}: [{ type, label, category, parent, count, properties: [{ key, kind, description }] }]`,
    `${c}   entities       ${n(total)}: ${list(ents.map((t) => `${t.type} (${n(t.count)})`))}`,
    `${c}   relationships  ${n(rels.reduce((s, r) => s + r.count, 0))}: ${list(rels.map((r) => `${r.type} (${n(r.count)})`)) || 'none'}`,
    `${c}   tags           ${schema.tags.length ? list(schema.tags, 8) : 'none'}`,
    `${c}   metrics        ${ctx.metrics?.length ? ctx.metrics.join(', ') : 'none yet — run Insights (or analyze) first'}`,
  ]
}

/** A function over the whole project state: every argument is what `ds` holds, described with the real counts. */
export function scaffoldState(ctx: ScaffoldContext, language: Language = 'js'): string {
  if (language === 'python') {
    return [
      '# A function over the project state — edit the body',
      '# Every argument is real; describe() prints the whole state:',
      ...stateLines(ctx, '#'),
      'def main(project, ontology, entities, relationships, tags, metrics):',
      "    # entities and relationships are collections: entities.types.<type>.filter(...).neighbors('rel').sort('label').table()",
      "    return table([{'type': r['key'], 'count': r['value'], 'properties': ', '.join(p['key'] for p in r['items'].properties())} for r in entities.rollup('type')])",
      '',
      'main(project, ontology, entities, relationships, tags, metrics)',
    ].join('\n')
  }
  const head = language === 'view' ? ['// A visual over the project state — draw into #app; every argument is real:'] : ['// A function over the project state — edit the body', '// Every argument is real; log(ds.describe()) prints the whole state:']
  const body =
    language === 'view'
      ? [
          'function main({ project, ontology, entities, relationships, tags, metrics }) {',
          "  const app = document.getElementById('app')",
          "  app.style.font = '13px system-ui'",
          '  app.innerHTML = `<h3>${project?.label ?? \'Library\'}</h3><p>${entities.length} entities · ${relationships.length} relationships · ${ontology.length} types</p>`',
          '  for (const t of ontology) app.insertAdjacentHTML(\'beforeend\', `<div><b>${t.type}</b> ${t.count} · ${t.properties.map((p) => p.key).join(\', \')}</div>`)',
          '}',
          'main({ ...ds, tags: ds.tags() })',
        ]
      : [
          'function main({ project, ontology, entities, relationships, tags, metrics }) {',
          "  // entities and relationships are collections: entities.types.<type>.filter({ … }).neighbors('rel').sort('label').table()",
          "  return table(entities.rollup('type').map((r) => ({ type: r.key, count: r.value, properties: r.items.properties().map((p) => p.key).join(', ') })))",
          '}',
          'return main({ ...ds, tags: ds.tags() })',
        ]
  return [...head, ...stateLines(ctx, '//'), ...body].join('\n')
}

/** Every entity of a type as a table, one column per property it carries, each annotated with kind, coverage and a sample. */
export function scaffoldType(ctx: ScaffoldContext, type: string, language: Language = 'js'): string {
  const t = ctx.schema.types.find((x) => x.type === type)
  const props = (ctx.schema.properties.get(type) ?? []).filter((p) => p.coverage > 0 || p.declared)
  const title = `${n(t?.count ?? 0)} ${type}${t?.count === 1 ? '' : 's'}`
  if (language === 'python') {
    const cols = ['id', 'label', ...props.map((p) => p.key)]
    return [
      `# Every ${type}, with its properties — ${title}`,
      `# ${access_(type)}.properties() lists what ${type} entities carry; edit the columns. ${access_(type)}.table() is the quick form.`,
      `df = ${access_(type)}.df`,
      ...props.map((p) => `# ${p.key}: ${propComment(p)}`),
      `df[[${cols.map(pq).join(', ')}]]`,
    ].join('\n')
  }
  const rows = [
    `// Every ${type}, with its properties — ${title}`,
    `// ${access_(type)}.properties() lists what ${type} entities carry; edit the columns. ${access_(type)}.table() is the quick form.`,
    `const rows = ${access_(type)}.map((e) => ({`,
    '  id: e.id,',
    '  label: e.label,',
    ...props.map((p) => `  ${ident(p.key)}: e.data${access(p.key)}, // ${propComment(p)}`),
    "  tags: e.tags.join(', '),",
    '  degree: ds.degree(e.id),',
    '}))',
  ]
  if (language === 'view') return [...rows, "const app = document.getElementById('app')", "app.style.cssText = 'font: 12px system-ui; overflow: auto; height: 100%'", "app.innerHTML = `<table>${rows.map((r) => `<tr>${Object.values(r).map((v) => `<td>${v ?? ''}</td>`).join('')}</tr>`).join('')}</table>`", 'aegraph.result(table(rows))'].join('\n')
  return [...rows, "return table(sortBy(rows, 'label'))"].join('\n')
}

/** Every relationship of a type with both ends, and what it joins. */
export function scaffoldRelationship(ctx: ScaffoldContext, rel: string, language: Language = 'js'): string {
  const r = ctx.schema.relationshipTypes.find((x) => x.type === rel)
  const joins = r?.pairs.length ? r.pairs.join(', ') : 'anything'
  if (language === 'python') {
    return [
      `# ${rel}: ${n(r?.count ?? 0)} relationships joining ${joins}`,
      `# relationships.types.${rel}.sources() / .targets() are the entities at the ends; .table() the quick form.`,
      `rel = relationships.types[${pq(rel)}].df`,
      "ends = entities.df[['id', 'type', 'label']]",
      "df = rel.merge(ends.add_prefix('source_'), left_on='source', right_on='source_id').merge(ends.add_prefix('target_'), left_on='target', right_on='target_id')",
      "df[['source_label', 'source_type', 'target_label', 'target_type']]",
    ].join('\n')
  }
  const relAccess = /^[A-Za-z_$][\w$]*$/.test(rel) ? `relationships.types.${rel}` : `relationships.types[${q(rel)}]`
  return [
    `// ${rel}: ${n(r?.count ?? 0)} relationships joining ${joins}`,
    `// ${relAccess}.sources() / .targets() are the entities at the ends; .table() the quick form.`,
    `const rows = ${relAccess}.map((r) => {`,
    '  const s = ds.get(r.source)',
    '  const t = ds.get(r.target)',
    '  return { source: s?.label, sourceType: s?.type, target: t?.label, targetType: t?.type, ...r.data }',
    '})',
    language === 'view' ? 'aegraph.result(table(rows))' : 'return table(rows)',
  ].join('\n')
}
