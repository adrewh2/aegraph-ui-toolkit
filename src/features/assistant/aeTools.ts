import { betaTool } from '@anthropic-ai/sdk/helpers/beta/json-schema'
import { AE_SCHEMA_PATH, AE_SCHEMA_VERSION, validateAe } from '../../core/exchange/ae/validate'
import type { AppHost } from './tools'

const json = (v: unknown) => JSON.stringify(v)

/**
 * The `.ae.json` file format, for agents writing aegraph documents: check a
 * document against the aegraph/v1 rules before loading it (with
 * `import_graph`), and find the specification.
 */
export function createAeTools(_host: AppHost) {
  const validate = betaTool({
    name: 'validate_ae',
    description: `Check an aegraph document (the .ae.json format, ${AE_SCHEMA_VERSION}) before importing it: each problem comes back with a JSON pointer and a message, plus counts, ids referenced but not in the file (fine if they exist in the workspace), and duplicate ids. Pass the document as JSON text. The specification is the JSON Schema at ${AE_SCHEMA_PATH} and the "File format" page of the documentation (/docs/spec).`,
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: 'The document, as JSON text' } },
      required: ['text'],
      additionalProperties: false,
    } as const,
    run: ({ text }) => {
      let doc: unknown
      try {
        doc = JSON.parse(text)
      } catch (err) {
        return json({ ok: false, issues: [{ path: '', message: `not JSON: ${err instanceof Error ? err.message : String(err)}` }] })
      }
      const r = validateAe(doc)
      return json({ ...r, issues: r.issues.slice(0, 50), truncated: r.issues.length > 50 ? r.issues.length - 50 : undefined, schema: AE_SCHEMA_PATH, docs: '/docs/spec' })
    },
  })
  return [validate]
}
