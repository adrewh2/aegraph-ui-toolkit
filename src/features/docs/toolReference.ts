/**
 * Renders the assistant's tool manifest as Markdown for the docs page, so the
 * reference is always exactly what the app exposes. Pure: takes the tools'
 * names, descriptions and JSON schemas; no React, no host.
 */
export interface ToolLike {
  name: string
  description?: string
  /** Runnable tools from the SDK carry `input_schema`; the bridge manifest uses `inputSchema`. */
  inputSchema?: unknown
  input_schema?: unknown
}

interface Schema {
  type?: string | string[]
  description?: string
  enum?: unknown[]
  items?: Schema
  properties?: Record<string, Schema>
  required?: string[]
  oneOf?: Schema[]
  anyOf?: Schema[]
  default?: unknown
}

const typeOf = (s: Schema): string => {
  if (s.enum) return s.enum.map((v) => JSON.stringify(v)).join(' | ')
  if (s.oneOf || s.anyOf) return (s.oneOf ?? s.anyOf ?? []).map(typeOf).join(' | ')
  const t = Array.isArray(s.type) ? s.type.join(' | ') : (s.type ?? 'any')
  if (t === 'array') return `${s.items ? typeOf(s.items) : 'any'}[]`
  if (t === 'object' && s.properties) return `{ ${Object.keys(s.properties).join(', ')} }`
  return t
}

const escapeCell = (s: string) => s.replace(/\|/g, '\\|').replace(/\n+/g, ' ')

/** One `###` section per tool with a parameter table; tools sorted by name, grouped by prefix. */
export function toolReferenceMarkdown(tools: ToolLike[]): string {
  const sorted = [...tools].sort((a, b) => a.name.localeCompare(b.name))
  const out: string[] = []
  for (const t of sorted) {
    out.push(`### \`${t.name}\``, '')
    if (t.description) out.push(t.description, '')
    const schema = (t.inputSchema ?? t.input_schema ?? {}) as Schema
    const props = schema.properties ?? {}
    const required = new Set(schema.required ?? [])
    const keys = Object.keys(props)
    if (keys.length) {
      out.push('| Parameter | Type | Description |', '| --- | --- | --- |')
      for (const k of keys) {
        const p = props[k]
        const name = required.has(k) ? `\`${k}\` *` : `\`${k}\``
        out.push(`| ${name} | \`${escapeCell(typeOf(p))}\` | ${escapeCell(p.description ?? '')} |`)
      }
      out.push('')
    } else {
      out.push('_No parameters._', '')
    }
  }
  return out.join('\n')
}
