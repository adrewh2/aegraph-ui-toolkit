/**
 * Argument checks every tool runner skips. The SDK's `betaTool.parse` is the
 * identity and the bridge hands the model's input straight to `run`, so a
 * `spacing: 0` reached a layout whose schema says `minimum: 0.1`. This reads
 * the tool's own JSON schema and refuses what plainly contradicts it — a
 * wrong type, a value outside `minimum`/`maximum`, a word not in an `enum`,
 * for the top-level properties and the items of top-level arrays — with a
 * message the model can act on. A `required` key that is missing, and a key
 * the schema does not know when it says `additionalProperties: false`, are
 * refused too — a `title` passed to a tool that takes `label` used to make
 * an unnamed entity in silence. Nested objects are left to the tool.
 *
 * Under every schema there are limits of shape, because the input is written
 * by a model that may have been talked into anything by what it read, or by
 * a driver nobody vetted: no array longer than `maxItems` (declared) or
 * {@link MAX_ITEMS} (not), no string longer than `maxLength` or
 * {@link MAX_STRING}, nothing nested deeper than {@link MAX_DEPTH}, and no
 * `__proto__` / `constructor` / `prototype` key at any depth — free-form
 * objects (`params`, `rule`, `mapping`, `data`) reach code that walks and
 * assigns them. A tool that takes bulk on purpose is in {@link BULK_TOOLS}.
 */

/** The longest array a tool takes unless its schema says otherwise. */
export const MAX_ITEMS = 50_000
/** …for a tool in {@link BULK_TOOLS}, whose point is to take a whole dataset in one call. */
export const MAX_BULK_ITEMS = 1_000_000
/** The longest string: a document or a CSV fits, a heap-sized one does not. */
export const MAX_STRING = 16 * 1024 * 1024
/** The deepest nesting: real arguments are a few levels deep; a thousand levels is a stack, not data. */
export const MAX_DEPTH = 64
/** Every value in one call, counted — a wide object is as heavy as a long array. */
export const MAX_VALUES = 5_000_000
/** The tools whose arrays are datasets: rows, ids, positions. */
export const BULK_TOOLS = new Set(['import_graph', 'graph_positions', 'load_dataset', 'set_properties', 'delete_entities', 'tag_entities', 'create_relationship', 'dataset', 'globe_load', 'map_import', 'graph_select', 'open_entities'])
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
interface PropSchema {
  type?: string | string[]
  enum?: unknown[]
  minimum?: number
  maximum?: number
  maxItems?: number
  maxLength?: number
  items?: PropSchema
}
interface ObjectSchema {
  type?: string
  properties?: Record<string, PropSchema>
  required?: string[]
  additionalProperties?: boolean | object
}

/** The limits of shape, over the whole input: the first problem found, or undefined. */
export function shapeProblem(input: unknown, maxItems = MAX_ITEMS): string | undefined {
  let values = 0
  const walk = (v: unknown, path: string, depth: number): string | undefined => {
    if (++values > MAX_VALUES) return `has more than ${MAX_VALUES} values in all`
    if (typeof v === 'string') return v.length > MAX_STRING ? `${path || 'input'} is longer than ${MAX_STRING} characters` : undefined
    if (!v || typeof v !== 'object') return undefined
    if (depth > MAX_DEPTH) return `${path} is nested deeper than ${MAX_DEPTH} levels`
    if (Array.isArray(v)) {
      if (v.length > maxItems) return `${path || 'input'} has ${v.length} items; at most ${maxItems} in one call`
      for (let i = 0; i < v.length; i++) {
        const p = walk(v[i], `${path}[${i}]`, depth + 1)
        if (p) return p
      }
      return undefined
    }
    for (const key of Object.keys(v)) {
      const at = path ? `${path}.${key}` : key
      if (FORBIDDEN_KEYS.has(key)) return `${at} is not allowed as a key (it names an object's machinery, not a field)`
      const p = walk((v as Record<string, unknown>)[key], at, depth + 1)
      if (p) return p
    }
    return undefined
  }
  // JSON.parse makes `__proto__` an own key, which Object.keys lists; an object built in code could hide it on the prototype.
  if (input && typeof input === 'object' && !Array.isArray(input) && Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null) return 'input must be a plain object'
  return walk(input, '', 0)
}

export function toolInputProblems(schema: ObjectSchema | undefined, input: unknown, maxItems = MAX_ITEMS): string[] {
  const out: string[] = []
  if (!input || typeof input !== 'object') return out
  const shape = shapeProblem(input, maxItems)
  if (shape) return [shape]
  if (!schema?.properties) return out
  const given = input as Record<string, unknown>
  for (const key of schema.required ?? []) if (given[key] === undefined || given[key] === null) out.push(`${key} is required`)
  if (schema.additionalProperties === false) {
    const known = Object.keys(schema.properties)
    for (const key of Object.keys(given)) {
      if (known.includes(key)) continue
      const near = known.find((k) => k.toLowerCase() === key.toLowerCase() || k.replace(/_/g, '') === key.replace(/[_-]/g, '').toLowerCase())
      out.push(`${key} is not a parameter of this tool${near ? ` (did you mean ${near}?)` : ` (it takes ${known.join(', ')})`}`)
    }
  }
  for (const [key, spec] of Object.entries(schema.properties)) {
    const v = (input as Record<string, unknown>)[key]
    if (v === undefined || v === null) continue
    const problem = check(spec, v)
    if (problem) out.push(`${key} ${problem}`)
    else if (spec.items && Array.isArray(v)) {
      const i = v.findIndex((x) => x !== undefined && x !== null && check(spec.items!, x))
      if (i >= 0) out.push(`${key}[${i}] ${check(spec.items, v[i])}`)
    }
  }
  return out
}

function check(spec: PropSchema, v: unknown): string | undefined {
  const type = typeof spec.type === 'string' ? spec.type : undefined
  if (type === 'string' && typeof v !== 'string') return `must be a string, got ${kind(v)}`
  if ((type === 'number' || type === 'integer') && (typeof v !== 'number' || !Number.isFinite(v))) return `must be a number, got ${kind(v)}`
  if (type === 'integer' && !Number.isInteger(v)) return `must be an integer, got ${String(v)}`
  if (type === 'boolean' && typeof v !== 'boolean') return `must be true or false, got ${kind(v)}`
  if (type === 'array' && !Array.isArray(v)) return `must be an array, got ${kind(v)}`
  if (type === 'object' && (typeof v !== 'object' || Array.isArray(v))) return `must be an object, got ${kind(v)}`
  if (spec.enum && !spec.enum.includes(v)) return `must be one of ${spec.enum.map((e) => JSON.stringify(e)).join(', ')}, got ${JSON.stringify(v)}`
  if (typeof v === 'string' && spec.maxLength !== undefined && v.length > spec.maxLength) return `must be at most ${spec.maxLength} characters, got ${v.length}`
  if (Array.isArray(v) && spec.maxItems !== undefined && v.length > spec.maxItems) return `must have at most ${spec.maxItems} items, got ${v.length}`
  if (typeof v === 'number') {
    if (spec.minimum !== undefined && v < spec.minimum) return `must be at least ${spec.minimum}, got ${v}`
    if (spec.maximum !== undefined && v > spec.maximum) return `must be at most ${spec.maximum}, got ${v}`
  }
  return undefined
}

const kind = (v: unknown) => (Array.isArray(v) ? 'an array' : v === null ? 'null' : typeof v === 'object' ? 'an object' : `${typeof v} ${JSON.stringify(v)}`)

/** The tool with its `parse` checking the input against its schema first. */
export function withInputChecks<T extends { name: string; input_schema?: unknown; parse: (input: unknown) => unknown }>(tool: T): T {
  return {
    ...tool,
    parse: (input: unknown) => {
      const problems = toolInputProblems(tool.input_schema as ObjectSchema | undefined, input, BULK_TOOLS.has(tool.name) ? MAX_BULK_ITEMS : MAX_ITEMS)
      if (problems.length) throw new Error(`${tool.name}: ${problems.join('; ')}`)
      return tool.parse(input)
    },
  }
}
