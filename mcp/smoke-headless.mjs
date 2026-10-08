/**
 * End-to-end over the headless engine — no browser anywhere:
 *
 *   npm run smoke:headless
 *
 * Builds `dist-headless`, speaks MCP over stdio to a fresh workspace file,
 * and drives the thing the engine exists for: a project created, entities
 * and relationships added, documents written, the graph filtered, analysed
 * and laid out, the workspace saved — then a second process opened on the
 * same file, which must find everything where the first left it.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { unframe } from './frame.mjs'

const root = new URL('..', import.meta.url).pathname
const entry = join(root, 'dist-headless/aegraph-headless.mjs')
const dir = mkdtempSync(join(tmpdir(), 'aegraph-headless-'))
const file = join(dir, 'smoke.ae.json')
const failures = []

const check = (ok, what) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`)
  if (!ok) failures.push(what)
}

async function connect() {
  const client = new Client({ name: 'smoke-headless', version: '0.1.0' })
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [entry, file], stderr: 'inherit' }))
  const call = async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args })
    // Every text block comes framed as data (frame.mjs), as the bridge's do.
    const text = (r.content ?? []).map((b) => unframe(b.text ?? '')).join('\n')
    if (r.isError) throw new Error(`${name}: ${text}`)
    try {
      return JSON.parse(text)
    } catch {
      return text
    }
  }
  return { client, call }
}

try {
  const build = spawnSync('npx', ['vite', 'build', '--config', 'vite.headless.config.ts', '--logLevel', 'warn'], { cwd: root, encoding: 'utf8' })
  if (build.status !== 0) {
    process.stderr.write(build.stdout + build.stderr)
    throw new Error('the headless build failed')
  }

  const { client, call } = await connect()
  // One writer per workspace: this process holds it, so a second is turned away rather than fighting over autosave.
  const second_writer = spawnSync(process.execPath, [entry, file, '--list-tools'], { encoding: 'utf8' })
  const held = spawnSync(process.execPath, [entry, file], { encoding: 'utf8', timeout: 10_000 })
  check(second_writer.status === 0 && /is held by process/.test(held.stderr), 'a second writer on the same workspace is refused')
  const { tools } = await client.listTools()
  check(tools.length > 40, `${tools.length} tools listed`)
  check(!tools.some((t) => t.name.startsWith('gpu_') || t.name === 'graph_filter' || t.name === 'workstation'), 'no tools that need a screen')

  const empty = await call('workspace_status')
  check(empty.entities === 0 && empty.project === null, 'a fresh workspace is empty')

  const created = await call('project_create', { label: 'Headless smoke', description: 'Made over MCP with no browser.' })
  const project = created.created ?? created
  check(!!project.id, `project created (${project.id})`)
  await call('open_project', { id: project.id })
  check((await call('workspace_status')).project === project.id, 'the project is open')

  // A small graph: three services, two dependencies, plus a note about them.
  const ids = []
  for (const label of ['gateway', 'indexer', 'store']) {
    const e = await call('create_entity', { type: 'concept', label, tags: ['service'] })
    ids.push(e.id ?? e.entity?.id)
  }
  check(ids.every(Boolean), 'three entities created')
  await call('create_relationship', { source_id: ids[0], target_id: ids[1], type: 'depends-on', directed: true })
  await call('create_relationship', { source_id: ids[1], target_id: ids[2], type: 'depends-on', directed: true })
  const doc = await call('create_document', { title: 'notes', content: '# Services\n\nThe gateway depends on the indexer.' })
  const docId = doc.id ?? doc.created?.id ?? doc.document?.id
  check(!!docId, 'a document was written')

  const found = await call('search_entities', { query: 'indexer' })
  check(JSON.stringify(found).includes('indexer'), 'search finds it in the project scope')

  const services = { tags: ['service'] }
  const slice = await call('graph_slice', services)
  check(slice.nodes === 3 && slice.edges === 2, `graph_slice sees the graph (${slice.nodes} nodes, ${slice.edges} edges)`)
  const whole = await call('graph_slice', {})
  check(whole.nodes === 4, `the document is in the graph too (${whole.nodes} nodes)`)
  const metrics = await call('graph_metrics', { ...services, metrics: ['degree', 'pagerank', 'component'], write: true })
  check(metrics.metrics.degree.max === 2, 'degree is computed')
  check(metrics.written === 3, `metrics were written onto the entities (${metrics.written})`)
  const layout = await call('graph_layout', { ...services, algorithm: 'tree', tree_follow: 'out', write: true })
  check(layout.positioned === 3 && layout.hierarchy.roots === 1 && layout.hierarchy.maxDepth === 2, `the tree layout reads as a hierarchy (${layout.hierarchy?.roots} root, depth ${layout.hierarchy?.maxDepth})`)

  // The ontology, versioning and constraints: project management, not drawing.
  const type = await call('define_entity_type', { name: 'service', label: 'Service', category: 'knowledge', properties: [{ key: 'tier', kind: 'number' }] })
  check(JSON.stringify(type).includes('service'), 'an entity type was defined')
  const commit = await call('project_commit', { message: 'the services and a note' })
  check(!!(commit.commit ?? commit).id, 'the project was committed')
  const history = await call('project_history', {})
  check((history.commits ?? history).length >= 1, 'the commit is in the history')
  const changes = await call('project_changes', {})
  check(!!changes, 'changes since HEAD can be read')
  const constraint = await call('constraint', { action: 'list' })
  check(!!constraint, 'constraints answer headless')

  const exported = join(dir, 'exported.ae.json')
  const wrote = await call('export_file', { path: exported })
  check(wrote.entities >= 4 && statSync(exported).size > 0, `the project exported to a file (${wrote.entities} entities)`)

  const saved = await call('workspace_save')
  check(statSync(file).size === saved.bytes, `the workspace is on disk (${saved.bytes} bytes)`)
  await client.close()

  // A second process, same file: everything must still be there, in the project that was open.
  const second = await connect()
  const status = await second.call('workspace_status')
  check(status.entities >= 4 && status.project === project.id, `reopened: ${status.entities} entities, project ${status.project === project.id ? 'restored' : 'lost'}`)
  const again = await second.call('graph_slice', { tags: ['service'] })
  check(again.nodes === 3 && again.edges === 2, 'the graph survived the round trip')
  const read = await second.call('read_document', { id: docId })
  check(JSON.stringify(read).includes('gateway depends'), 'the document survived the round trip')
  const analysis = await second.call('analyze', { action: 'run', analyses: ['centrality', 'schema'] }).catch((err) => ({ error: err.message }))
  check(!analysis.error && Array.isArray(analysis.findings ?? analysis.top ?? []), `analyze runs headless${analysis.error ? ` — ${analysis.error}` : ` (${(analysis.findings ?? []).length} findings)`}`)
  // A bundle read from disk becomes its own project, ids merged the way the app opens one.
  const walked = await second.call('project_history', {})
  const head = (walked.commits ?? walked)[0]
  check(!!head, 'the commit from the first process is in the history')
  const restored = head ? await second.call('project_restore', { commit: head.id ?? head.short }).catch((err) => ({ error: err.message })) : { error: 'no commit' }
  check(!restored.error, `its content was restored from disk${restored.error ? ` — ${restored.error}` : ''}`)
  const reimported = await second.call('import_file', { path: exported })
  check(!!reimported.opened || reimported.count >= 4, `the exported file reads back in (${reimported.opened ? 'as a project' : `${reimported.count} entities`})`)
  await second.client.close()
} finally {
  rmSync(dir, { recursive: true, force: true })
}

if (failures.length) {
  console.error(`\nsmoke:headless — ${failures.length} failure(s)\n  ${failures.join('\n  ')}`)
  process.exit(1)
}
console.log('\nsmoke:headless: ok')
