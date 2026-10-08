/**
 * Use case 4, "Draw a system and make it data", end to end over the
 * bridge: DOT → a diagram resource → entities and relationships with
 * deterministic dg- ids and a scene that keeps the drawn geometry → an
 * edit to one entity → the view written back to DOT with the same ids, so
 * exporting that diagram again updates in place. Needs GL=1 (sigma). Run
 *   GL=1 node mcp/drive.mjs mcp/smoke/9-diagram.mjs
 * or as `npm run smoke:diagram`.
 */
import { check, counted, tidied } from './lib.mjs'

const DOT = `digraph system {
  rankdir=LR;
  subgraph cluster_services { label="Services"; api; worker; }
  subgraph cluster_stores { label="Stores"; db; }
  api -> db [label="reads"];
  worker -> db [label="writes"];
  api -> worker [label="enqueues"];
}
`

export default async ({ call, evaluate, sleep }) => {
  const wasHolding = await counted(evaluate)
  const d = await call('create_diagram', { label: 'Smoke system', source: DOT, open: false })
  check('a DOT diagram is created and parsed', d.format === 'dot' && d.nodes === 3 && d.edges === 3 && d.groups === 2, JSON.stringify(d).slice(0, 140))

  // The plan before the write: the inferred mapping types nodes by their cluster and edges by their label.
  const dry = await call('diagram_to_dataset', { id: d.id, dry_run: true })
  // Three edges plus, by default, a derived-from link from each entity back to the diagram.
  check('the dry run plans 3 entities and their relationships from the inferred mapping', dry.dryRun === true && dry.entities === 3 && dry.relationships === 6 && dry.mapping.nodeTypeBy === 'group' && dry.mapping.edgeTypeBy === 'label', JSON.stringify(dry).slice(0, 200))

  const done = await call('diagram_to_dataset', { id: d.id })
  check('the diagram becomes entities, with a scene of its geometry', done.created === 3 && !!done.projectionId, JSON.stringify(done).slice(0, 160))
  const prefix = `dg-${d.id.slice(0, 8)}-`
  const api = await call('get_entity', { id: `${prefix}n-api` })
  const db = await call('get_entity', { id: `${prefix}n-db` })
  check('entity ids are deterministic from the diagram and the node names', api.id === `${prefix}n-api` && db.id === `${prefix}n-db`, `${api.id}, ${db.id}`)
  // Types are the cluster labels put back into the singular ("Services" → service); edges take their labels; each entity derives from the diagram.
  check('node types come from the clusters, relationship types from the edge labels', api.type === 'service' && db.type === 'store' && api.relationships.some((r) => r.type === 'reads' && r.other.id === db.id) && api.relationships.some((r) => r.type === 'enqueues') && api.relationships.some((r) => r.type === 'derived-from' && r.other.id === d.id), `${api.type}, ${db.type}, ${api.relationships.map((r) => r.type).join('/')}`)
  const scene = await call('get_entity', { id: done.projectionId })
  const placed = scene.data?.nodes ? Object.keys(scene.data.nodes) : Object.keys(scene.data?.positions ?? {})
  check('the scene keeps a position for every node', placed.includes(`${prefix}n-api`) && placed.includes(`${prefix}n-db`) && placed.includes(`${prefix}n-worker`), `${placed.length} placed: ${placed.slice(0, 3).join(', ')}`)

  // Exporting the same diagram again touches nothing.
  const again = await call('diagram_to_dataset', { id: d.id, dry_run: true })
  check('exporting again would update in place, not duplicate', again.created === 0 && again.entities === 3, JSON.stringify(again).slice(0, 120))

  // Edit the data, then write the view back to DOT: the ids survive, the edit shows.
  await call('update_entity', { id: api.id, label: 'API gateway' })
  await call('open', { page: '/unigraph/2d' })
  await sleep(1500)
  // The demo seeded on a fresh profile has services and stores of its own, so the view is narrowed to the three
  // the diagram made. `only` is the pick of exactly those ids: this asked for roots at depth 0 until the tools
  // began checking their inputs against their own schemas, where depth has a minimum of 1 — and then said so.
  const g = await call('graph_filter', { replace: true, only: [api.id, db.id, `${prefix}n-worker`], relationship_types: ['reads', 'writes', 'enqueues'] })
  check('the system is a 3-node view', g.nodes === 3 && g.edges === 3, `${g.nodes} nodes, ${g.edges} edges`)
  const out = await call('graph_export', { format: 'dot', save_as: 'Smoke system (from view)' })
  const src = String(out).includes('--- ') ? String(out).split('--- ')[1].split('\n').slice(1).join('\n') : ''
  check('the view is written back as DOT with the same node ids and the edited label', src.includes(`${prefix}n-api`) && src.includes('API gateway') && /enqueues/.test(src), src.slice(0, 200).replace(/\n/g, ' '))
  const savedId = /"saved":\{"id":"([^"]+)"/.exec(String(out))?.[1]
  check('and kept as a diagram entity', !!savedId, String(savedId))
  const round = await call('diagram_to_dataset', { id: savedId, dry_run: true })
  check('exporting that diagram to the dataset would reuse every entity', round.entities === 3 && round.created === 0 && round.reused === 3, JSON.stringify(round).slice(0, 160))

  // Tidy.
  const mine = [d.id, savedId, done.projectionId, api.id, db.id, `${prefix}n-worker`].filter(Boolean)
  await call('delete_entities', { ids: mine })
  await tidied(evaluate, mine, wasHolding)
}
