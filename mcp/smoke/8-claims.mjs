/**
 * Use case 1, "Read a literature set and keep the claims", end to end over
 * the bridge: a document → a passage annotated by text quote → a claim →
 * `supports` from the annotation → the evidence graph. The annotation is
 * anchored by its words, so an edit elsewhere in the document leaves it in
 * place and the reader still highlights it. Needs GL=1 (sigma). Run alone
 * Read, not yet measured (b35): every check is about the document it
 * wrote, the passage it annotated, the claim it made and the three-node
 * evidence graph rooted at them, so nothing it looks at predates it —
 * the shape steps 13, 20 and 25 were exempted for. Expected to need no
 * declared state; not yet run against a profile dirtied on purpose, so
 * nothing has been declared or exempted here yet.
 *   GL=1 node mcp/drive.mjs mcp/smoke/8-claims.mjs
 * or as `npm run smoke:claims`.
 */
import { check, counted, tidied } from './lib.mjs'

const QUOTE = 'Sleep deprivation impairs working memory in a dose-dependent way.'
const BODY = `# Notes on sleep and memory

Walker (2017) reviews the evidence. ${QUOTE} The effect is largest after two nights.

Other studies find the effect fades with age.
`

export default async ({ call, evaluate, sleep }) => {
  const wasHolding = await counted(evaluate)
  // The source, and a passage in it.
  const doc = await call('create_document', { title: 'Smoke: sleep and memory', content: BODY, tags: ['reading'], open: false })
  check('a document is created', doc.type === 'document' && !!doc.id, JSON.stringify(doc).slice(0, 120))
  const read = await call('read_document', { id: doc.id })
  check('read_document returns the text and no annotations yet', read.content?.includes(QUOTE) && read.annotations?.length === 0, `${(read.content ?? '').length} chars, ${read.annotations?.length} annotations`)
  const ann = await call('annotate_document', { document_id: doc.id, quote: QUOTE, comment: 'Key finding: dose-dependent', tags: ['evidence'] })
  check('a passage is annotated', ann.type === 'annotation' && !!ann.id, JSON.stringify(ann).slice(0, 120))
  const missing = await call('annotate_document', { document_id: doc.id, quote: 'not in the document', comment: 'x' }).then(() => null, (e) => e.message)
  check('a quote that is not in the document is refused', /not found verbatim/.test(String(missing)), String(missing).slice(0, 100))

  // The anchor: a text-quote selector with context, on the annotates relationship.
  const full = await call('get_entity', { id: ann.id })
  const link = full.relationships.find((r) => r.type === 'annotates')
  check('the annotation is linked to the document by a text-quote selector with context', link?.other?.id === doc.id && link.selector?.kind === 'text' && link.selector.exact === QUOTE && !!link.selector.prefix && !!link.selector.suffix, JSON.stringify(link?.selector).slice(0, 160))

  // The claim and its evidence.
  const claim = await call('create_entity', { type: 'claim', label: 'Sleep loss degrades working memory', description: 'Dose-dependent; strongest after two nights.', tags: ['thesis'] })
  check('a claim entity is created', claim.type === 'claim' && !!claim.id, JSON.stringify(claim).slice(0, 100))
  const sup = await call('create_relationship', { source_id: ann.id, target_id: claim.id, type: 'supports' })
  check('the annotation supports the claim', sup.type === 'supports' && !!sup.id, JSON.stringify(sup).slice(0, 100))

  // An edit elsewhere in the document does not move the anchor.
  await call('edit_document', { id: doc.id, old_text: 'Walker (2017) reviews the evidence.', new_text: 'Walker (2017) and later reviews summarise the evidence.' })
  const after = await call('read_document', { id: doc.id })
  check('the annotation survives an edit elsewhere in the document', after.content.includes('later reviews') && after.annotations.length === 1 && after.annotations[0].quote === QUOTE, JSON.stringify(after.annotations).slice(0, 120))

  // The reader highlights it.
  await call('open', { id: doc.id })
  await sleep(1500)
  const marks = await evaluate(`[...document.querySelectorAll('.md-hl')].map((m) => m.textContent)`)
  check('the reader highlights the annotated passage', Array.isArray(marks) && marks.some((t) => t === QUOTE), JSON.stringify(marks).slice(0, 120))

  // The evidence graph: claim, annotation, document and the links between them.
  await call('open', { page: '/unigraph/2d' })
  await sleep(1500)
  const g = await call('graph_filter', { replace: true, types: ['claim', 'annotation', 'document'], roots: [claim.id], depth: 2 })
  check('the evidence graph holds the claim, its annotation and the source', g.nodes === 3 && g.edges === 2, `${g.nodes} nodes, ${g.edges} edges`)
  const q = await call('graph_query', { selector: { types: ['claim'] }, values: ['degree.in:supports'] })
  check('the claim shows one supporting piece of evidence', q.rows.length === 1 && Number(q.rows[0].values['degree.in:supports']) === 1, JSON.stringify(q.rows[0]).slice(0, 140))

  // The claim opens in the inspector on its relationships.
  const opened = await call('inspect', { id: claim.id, tab: 'relationships' })
  await sleep(800)
  const url = await evaluate('location.pathname + location.search')
  check('inspect opens the claim in the Entities browser', opened.type === 'claim' && url.startsWith('/entities') && url.includes(claim.id), url)

  // Tidy.
  const mine = [claim.id, ann.id, doc.id]
  await call('delete_entities', { ids: mine })
  await tidied(evaluate, mine, wasHolding)
}
