/**
 * The tools nothing else runs. An audit of `createAppTools` found six of
 * its ninety-eight never executed by any test — they appeared only in the
 * manifest assertion, which checks that a name is on the list and runs
 * nothing. Four of them can be run against the real app over the bridge,
 * and this is where they are: `app_diagnostics`, `view_diagram`, `globe`
 * and `globe_load`. The other two need something a headless run has not
 * got — `chat` spawns the Claude Code CLI, `capture_video_frame` needs a
 * player with a frame in it — and stay out, as playback does in step 13.
 * Starts from the Library (b35) for meaning rather than for passing:
 * app_diagnostics is checked against the store's own counts, so both
 * sides move together and the run is green in any scope — verified, by
 * running it under a profile dirtied on purpose with the declaration
 * removed, where it still reported 10 of 10. What the declaration buys
 * is that the figures are the Library's and not a few dozen entities
 * somebody left in view.
 *   GL=1 node mcp/drive.mjs mcp/smoke/26-unrun-tools.mjs
 * or `npm run smoke:unrun-tools`.
 */
import { unframe } from '../frame.mjs'
import { check, startFrom } from './lib.mjs'

const LABEL = 'Smoke: the unrun tools'
const DOT = 'digraph G { rankdir=LR; a -> b; b -> c; a -> c }'

/** What the store says, for checking a tool's answer against the thing it describes rather than against itself. */
const COUNT_OF = (type) => `window.__aegraph.store.countOfType(${JSON.stringify(type)})`

export default async ({ call, evaluate, sleep, client }) => {
  await startFrom({ call, evaluate, sleep }, 'library')
  const made = []

  // ── app_diagnostics: a picture of what is in the store, checked against the store ──
  const diag = await call('app_diagnostics', { top: 5, sample: 50 })
  const rows = diag.types ?? diag.byType ?? []
  check('app_diagnostics answers with types, counts and an estimate', Array.isArray(rows) && rows.length > 0 && rows.every((r) => typeof r.count === 'number' && r.count > 0 && typeof r.type === 'string'), JSON.stringify({ keys: Object.keys(diag), rows: rows.length }))
  const first = rows[0]
  const reallyHas = first ? await evaluate(COUNT_OF(first.type)) : -1
  check('and the counts are the store’s own, not a guess', !!first && reallyHas === first.count, `${first?.type}: reported ${first?.count}, store has ${reallyHas}`)

  // ── view_diagram: a diagram made, then looked at — the summary and a drawn picture ──
  const d = await call('create_diagram', { label: LABEL, source: DOT, format: 'dot', open: false })
  made.push(d.id)
  const seen = await client.callTool({ name: 'view_diagram', arguments: { id: d.id, source: true } })
  const head = JSON.parse(unframe(seen.content.find((c) => c.type === 'text').text))
  const image = seen.content.find((c) => c.type === 'image')
  check('view_diagram reads the diagram back and says what is in it', head.id === d.id && head.format === 'dot' && head.source.includes('rankdir') && (head.nodes ?? head.nodeCount) === 3, JSON.stringify({ format: head.format, nodes: head.nodes ?? head.nodeCount, edges: head.edges ?? head.edgeCount }))
  // MCP carries an image as { data, mimeType }; the Anthropic runner's own shape nests it under `source`. Read either.
  const png = image ? { type: image.mimeType ?? image.source?.media_type, bytes: (image.data ?? image.source?.data ?? '').length } : null
  check('and draws it: a PNG comes back with the summary', png?.type === 'image/png' && png.bytes > 1000, png ? `${png.type}, ${png.bytes} characters of base64` : 'no image block')
  await expectRefused(client, 'view_diagram on something that is not a diagram is refused', { id: 'no-such-entity-at-all' })

  // ── globe_load: places and journeys put on a map in one call ──
  const loaded = await call('globe_load', {
    label: LABEL,
    map: LABEL,
    tags: 'smoke',
    locations: [
      { label: 'Smoke Reykjavik', lat: 64.1466, lng: -21.9426 },
      { label: 'Smoke Lisbon', lat: 38.7223, lng: -9.1393 },
    ],
    paths: [{ label: 'Smoke crossing', points: [[-21.9426, 64.1466], [-9.1393, 38.7223]], at: '2026-05-01T09:00:00Z', until: '2026-05-01T14:00:00Z' }],
  })
  const mapId = loaded.map?.id
  const ids = [...(loaded.ids ?? []), mapId].filter((x) => typeof x === 'string')
  made.push(...ids)
  check('globe_load puts the places and the journey into the entity system', loaded.created === 3 && (loaded.ids ?? []).length === 3 && loaded.map?.label === LABEL, JSON.stringify({ created: loaded.created, ids: (loaded.ids ?? []).length, map: loaded.map?.label }))
  const onMap = await call('map_state', { map_id: mapId })
  check('and they are on the map it made, with the journey as a line', onMap.features.length === 3 && onMap.features.some((f) => f.geometry?.type === 'LineString'), `${onMap.features.length} features: ${onMap.features.map((f) => f.geometry?.type).join(', ')}`)

  // ── globe: the stage in front, and the time window ──
  const g = await call('globe', { action: 'open', mode: 'globe', map_id: mapId })
  // Wait for the stage rather than a guessed delay: the globe is a WebGL canvas that arrives after the route does.
  let stage = null
  for (let i = 0; i < 20; i++) {
    await sleep(500)
    stage = await evaluate(`({ route: location.pathname, globe: !!document.querySelector('.geo-globe, canvas.geo-globe__canvas, .geo__stage canvas'), tabs: [...document.querySelectorAll('.gx-tab.is-active')].map((t) => t.textContent.trim()) })`)
    if (stage.globe) break
  }
  check('globe opens the Maps page with the globe in front', stage.route.startsWith('/maps') && stage.globe && stage.tabs.some((t) => /globe/i.test(t)), JSON.stringify({ answer: g.shown ?? g.mode ?? Object.keys(g), ...stage }))

  // Tidy from a page that can answer: a delete asks the tab to confirm, and the globe was in front of everything.
  await call('open', { page: '/entities' })
  await sleep(1500)
  const gone = await call('delete_entities', { ids: made })
  check('the run takes what it made away with it', gone.deleted === made.length, `${gone.deleted} deleted of ${made.length}`)
  const left = await evaluate(`window.__aegraph.store.library.all().filter((e) => ${JSON.stringify(made)}.includes(e.id)).length`)
  check('and nothing of it is left in the store', left === 0, `${left} left behind`)
}

/** A tool that should refuse: the error is the answer, so a success is the failure. */
const expectRefused = async (client, name, args, tool = 'view_diagram') => {
  const r = await client.callTool({ name: tool, arguments: args }).catch((e) => ({ isError: true, content: [{ type: 'text', text: String(e) }] }))
  check(name, !!r.isError, r.isError ? '' : `it answered instead: ${JSON.stringify(r.content).slice(0, 120)}`)
}
