import { execFileSync } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { getEntityType } from '../../../entity/schema'
import { isRelationship, type AegraphDocument, type AnyEntity } from '../../../entity/types'
import '../../../resources/types'
import '../../../graph/types'
import { validateAe } from '../validate'

/**
 * The documents the app ships — the template a pipeline bundle names, the
 * example the file-format page hands out (the demo projects live in the
 * aegraph-ui-demos repository, which validates its own) —
 * read the way a browser would read them and put through the app's own
 * validator. A file that fails here is one a visitor would open and find
 * broken, so: valid, no id claimed twice, every reference resolving
 * inside the file, no type declared and then never used, entities and
 * relationships each shaped like what they say they are, a size the
 * repository can carry, and the same document on a second read.
 */
const root = resolve(fileURLToPath(new URL('../../../../../', import.meta.url)))
// What the repository actually ships: tracked files only. The demos (public/demos) are fetched at build time and
// gitignored — they are not what a fresh checkout hands a visitor.
const shipped = execFileSync('git', ['ls-files', 'public/templates', 'public/spec'], { cwd: root, encoding: 'utf8' })
  .split('\n')
  .filter((f) => f.endsWith('.json') && !f.endsWith('.schema.json'))
const read = (rel: string) => JSON.parse(readFileSync(resolve(root, rel), 'utf8')) as AegraphDocument
const entitiesOf = (doc: AegraphDocument) => (Array.isArray(doc.entities) ? (doc.entities as AnyEntity[]) : [])

describe('the documents the app ships', () => {
  it('finds them all, so a new one is checked without anybody remembering to', () => {
    expect(shipped.length).toBeGreaterThanOrEqual(2)
    expect(shipped).toContain('public/spec/example.ae.json')
    expect(shipped).toContain('public/templates/conversation-atlas.template.ae.json')
  })

  it.each(shipped)('%s is a valid aegraph document', (rel) => {
    const doc = read(rel)
    expect(doc.$schema).toBe('aegraph/v1')
    const report = validateAe(doc)
    expect(report.issues.slice(0, 5)).toEqual([]) // the first few say enough to find the rest
    expect(report.ok).toBe(true)
    expect(report.duplicates).toEqual([])
    expect(report.unresolved).toEqual([]) // a shipped file stands on its own: nothing points outside it
    expect(report.entities + report.relationships).toBe(entitiesOf(doc).length)
  })

  it.each(shipped)('%s declares no type it does not use', (rel) => {
    // A type a file brings with it but never puts on anything is drift: it lands in the workspace's ontology
    // and shows up in every type list for nothing. (Types used without a declaration are fine — the registry
    // knows the app's own, and makes a plain definition for the rest.)
    const entities = entitiesOf(read(rel))
    const used = new Set(entities.filter((e) => e.type !== 'schema:type').map((e) => e.type))
    const idle = entities
      .filter((e) => e.type === 'schema:type')
      .map((e) => String((e.data as { name?: string }).name ?? e.id))
      .filter((name) => !used.has(name) && !getEntityType(name))
    expect(idle).toEqual([])
  })

  it.each(shipped)('%s gives every entity a kind the reader can tell apart', (rel) => {
    const entities = entitiesOf(read(rel))
    for (const e of entities) {
      const rel2 = isRelationship(e)
      const ends = e as { source?: { id?: string }; target?: { id?: string } }
      expect(rel2 ? !!ends.source?.id && !!ends.target?.id : ends.source === undefined && ends.target === undefined, `${e.id} is a ${e.kind}`).toBe(true)
    }
  })

  it.each(shipped)('%s is small enough to carry and reads the same twice', (rel) => {
    const bytes = statSync(resolve(root, rel)).size
    expect(bytes).toBeLessThan(2_000_000) // the repository refuses more than 5 MB; a demo should be far under
    const once = read(rel)
    expect(read(rel)).toEqual(once)
    // Nothing in it that JSON cannot carry back: a NaN or an Infinity would have been written as null already,
    // but an undefined in an array (a hole) or a -0 would survive a parse and differ on the next write.
    expect(JSON.parse(JSON.stringify(once))).toEqual(once)
  })
})
