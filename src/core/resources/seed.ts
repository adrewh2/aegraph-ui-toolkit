import { createEntity, createRelationship } from '../entity/entity'
import type { EntityStore } from '../entity/store'
import type { AnyEntity } from '../entity/types'
import {
  RELATIONSHIP_TYPES,
  RESOURCE_TYPES,
  type AnnotationData,
  type DocumentData,
  type ImageData,
  type VideoData,
  type WebpageData,
} from './types'

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString()
const meta = (created: number, updated = created, source = 'seed') => ({
  createdAt: daysAgo(created),
  updatedAt: daysAgo(updated),
  source,
})

export const WELCOME_DOC_ID = 'welcome'
const WELCOME_KEY = 'aegraph:welcome:v1'

/**
 * The document a new workspace opens on: what aegraph is and where to
 * start. Written once per browser (the key), so deleting it sticks.
 */
export function seedWelcome(store: EntityStore) {
  let done = false
  try {
    done = localStorage.getItem(WELCOME_KEY) === '1'
  } catch {
    /* no storage: seed it every time */
  }
  if (done || store.get(WELCOME_DOC_ID)) return
  store.upsert(
    createEntity<DocumentData>({
      id: WELCOME_DOC_ID,
      type: RESOURCE_TYPES.document,
      label: 'Welcome to aegraph',
      tags: ['guide'],
      data: {
        extension: 'md',
        content: `# Welcome to aegraph

A local-first knowledge workspace. Everything here is an *entity* — documents, notes, webpages, images, videos, maps, diagrams, the relationships between them — and every view is a way of looking at the same graph. It all lives in this browser; nothing leaves it unless you export.

## Start with something

- **Open project…** (the project control at the top of the sidebar, or the \`/new\` address) has ready-made projects: *Aurora*, eighteen months of a platform team's operations, 6,000 entities, is the one to explore the Graph Explorer, Insights and Analytics with; *Knowledge Infrastructure* and *China tour* are smaller. The same dialog imports your own: an aegraph bundle, GEXF / GraphML / CSV, RDF, or a ChatGPT export.
- **Documents** — write in Markdown; select a passage and annotate it.
- **Unigraph** — the graph explorer: filter, lay out, style and analyse whatever is loaded, in 2D or 3D.

## The assistant

⌘J opens the assistant. With an Anthropic API key it answers here; running locally next to Claude Code, it can answer through Claude Code instead, no key needed. Either way it acts through the same tools you use — *"show me the biggest communities"*, *"tag everything about deployments"*, *"chart incidents per month"*.

## Tabs and panes

This is the **Workstation**: tabs (⌘T for a new one), panes (⌘D splits), and any page can be a tab. Entities, Unigraph and Analytics are tabbed pages of their own.

**Documentation** (bottom left) goes deeper — the model, the file format, every tool.
`,
      },
      meta: { ...meta(0, 0, 'seed'), accessedAt: daysAgo(0) },
    }),
  )
  try {
    localStorage.setItem(WELCOME_KEY, '1')
  } catch {
    /* ignore */
  }
}

/** A small, connected sample so the resources view has something to show. */
export function seedStore(store: EntityStore) {
  const web1 = createEntity<WebpageData>({
    id: 'seed-web-1',
    type: RESOURCE_TYPES.webpage,
    label: 'The Semantic Web — W3C',
    tags: ['semantic-web', 'reference'],
    data: { url: 'https://www.w3.org/standards/semanticweb/', hasHtml: true, hasScreenshot: true },
    meta: meta(12, 3, 'extension'),
  })
  const web2 = createEntity<WebpageData>({
    id: 'seed-web-2',
    type: RESOURCE_TYPES.webpage,
    label: 'Web Annotation Data Model',
    tags: ['annotation', 'w3c', 'reference'],
    data: { url: 'https://www.w3.org/TR/annotation-model/', hasHtml: true, hasScreenshot: false },
    meta: meta(9, 9, 'extension'),
  })
  const web3 = createEntity<WebpageData>({
    id: 'seed-web-3',
    type: RESOURCE_TYPES.webpage,
    label: 'Entity component system — Wikipedia',
    tags: ['architecture'],
    data: { url: 'https://en.wikipedia.org/wiki/Entity_component_system', hasHtml: false, hasScreenshot: false },
    meta: meta(30, 30, 'extension'),
  })

  const ann1 = createEntity<AnnotationData>({
    id: 'seed-ann-1',
    type: RESOURCE_TYPES.annotation,
    label: 'Annotations as independent objects',
    tags: ['annotation', 'protocol'],
    data: {
      annotationType: 'text',
      selectedText: 'An annotation is considered to be a set of connected resources, typically including a body and target',
      comment: 'This matches our model — annotations are entities with a target ref, not editor features.',
      pageUrl: 'https://www.w3.org/TR/annotation-model/',
    },
    meta: meta(8, 8, 'extension'),
  })
  const ann2 = createEntity<AnnotationData>({
    id: 'seed-ann-2',
    type: RESOURCE_TYPES.annotation,
    label: 'Linked data diagram',
    tags: ['semantic-web'],
    data: {
      annotationType: 'image',
      imageUrl: 'https://www.w3.org/2008/site/images/logo-w3c-mobile-lg',
      comment: 'Reuse as a figure in the protocol doc.',
      pageUrl: 'https://www.w3.org/standards/semanticweb/',
    },
    meta: meta(11, 11, 'extension'),
  })

  const doc1 = createEntity<DocumentData>({
    id: 'seed-doc-1',
    type: RESOURCE_TYPES.document,
    label: 'Aegraph information model',
    tags: ['protocol', 'draft'],
    data: {
      extension: 'md',
      content: '# Aegraph information model\n\nEntities, relationships, documents, annotations, tags, types, arbitrary data.\n',
    },
    meta: { ...meta(6, 1, 'user'), accessedAt: daysAgo(0) },
  })
  const doc2 = createEntity<DocumentData>({
    id: 'seed-doc-2',
    type: RESOURCE_TYPES.document,
    label: 'Meeting notes 2026-09-10',
    tags: ['notes'],
    data: { extension: 'txt', content: 'Discussed gutting aegraph and rebuilding the UI from scratch.' },
    meta: { ...meta(2, 2, 'user'), accessedAt: daysAgo(1) },
  })
  const doc3 = createEntity<DocumentData>({
    id: 'seed-doc-3',
    type: RESOURCE_TYPES.document,
    label: 'Web Annotation Data Model (spec PDF)',
    tags: ['annotation', 'reference'],
    data: { extension: 'pdf' },
    meta: meta(9, 9, 'import:url'),
  })

  const vid1 = createEntity<VideoData>({
    id: 'seed-vid-1',
    type: RESOURCE_TYPES.video,
    label: 'What is Linked Data?',
    tags: ['semantic-web', 'talk'],
    data: {
      url: 'https://www.youtube.com/watch?v=4x_xzT5eF5Q',
      videoId: '4x_xzT5eF5Q',
      channel: 'Manu Sporny',
      publishedAt: '2012-06-19T00:00:00.000Z',
      duration: 12 * 60 + 15,
      viewCount: 132_540,
      likeCount: 1_820,
      commentCount: 96,
      thumbnailUrl: 'https://i.ytimg.com/vi/4x_xzT5eF5Q/mqdefault.jpg',
    },
    meta: meta(14, 14, 'import:youtube'),
  })

  const img1 = createEntity<ImageData>({
    id: 'seed-img-1',
    type: RESOURCE_TYPES.image,
    label: 'W3C logo',
    tags: ['w3c', 'reference'],
    data: { src: 'https://www.w3.org/2008/site/images/logo-w3c-mobile-lg', url: 'https://www.w3.org/2008/site/images/logo-w3c-mobile-lg', width: 90, height: 53, mimeType: 'image/png' },
    meta: meta(5, 5, 'import:url'),
  })
  const ann3 = createEntity<AnnotationData>({
    id: 'seed-ann-3',
    type: RESOURCE_TYPES.annotation,
    label: 'The W3C mark',
    tags: ['reference'],
    data: { annotationType: 'image', comment: 'The knot mark in the middle; the ring text around it spells out the name.', imageUrl: img1.data.src },
    meta: meta(5, 5, 'user'),
  })

  const ann4 = createEntity<AnnotationData>({
    id: 'seed-ann-4',
    type: RESOURCE_TYPES.annotation,
    label: 'Definition of linked data',
    tags: ['semantic-web'],
    data: { annotationType: 'note', comment: 'The four principles are laid out here — worth quoting in the model doc.', pageUrl: 'https://www.youtube.com/watch?v=4x_xzT5eF5Q&t=95s' },
    meta: meta(13, 13, 'user'),
  })
  const ann5 = createEntity<AnnotationData>({
    id: 'seed-ann-5',
    type: RESOURCE_TYPES.annotation,
    label: 'Slide with the graph diagram',
    tags: ['semantic-web'],
    data: { annotationType: 'image', comment: 'This diagram is the one to redraw for the docs.', pageUrl: 'https://www.youtube.com/watch?v=4x_xzT5eF5Q&t=210s' },
    meta: meta(13, 13, 'user'),
  })

  const note1 = createEntity({
    id: 'seed-note-1',
    type: RESOURCE_TYPES.note,
    label: 'Primitives should be boring',
    tags: ['protocol'],
    data: { text: 'Keep the primitive layer small. Specialised functionality belongs above it.' },
    meta: meta(1, 1, 'user'),
  })

  // Named, like the entities above: seeding a store that already holds the sample must not give it a second copy.
  const rels: AnyEntity[] = [
    createRelationship({
      id: 'seed-rel-1',
      type: RELATIONSHIP_TYPES.annotates,
      source: ann1.id,
      target: { id: web2.id, selector: { kind: 'text', exact: ann1.data.selectedText! } },
      meta: meta(8, 8, 'extension'),
    }),
    createRelationship({
      id: 'seed-rel-2',
      type: RELATIONSHIP_TYPES.annotates,
      source: ann2.id,
      target: { id: web1.id, selector: { kind: 'region', x: 120, y: 340, width: 480, height: 260 } },
      meta: meta(11, 11, 'extension'),
    }),
    createRelationship({ id: 'seed-rel-3', type: RELATIONSHIP_TYPES.references, source: doc1.id, target: web2.id, tags: ['citation'], meta: meta(6) }),
    createRelationship({ id: 'seed-rel-4', type: RELATIONSHIP_TYPES.references, source: doc1.id, target: ann1.id, tags: ['evidence'], meta: meta(6) }),
    createRelationship({ id: 'seed-rel-5', type: RELATIONSHIP_TYPES.derivedFrom, source: doc3.id, target: web2.id, meta: meta(9) }),
    createRelationship({ id: 'seed-rel-6', type: RELATIONSHIP_TYPES.related, source: note1.id, target: doc1.id, directed: false, meta: meta(1) }),
    createRelationship({ id: 'seed-rel-7', type: RELATIONSHIP_TYPES.references, source: doc2.id, target: web3.id, meta: meta(2) }),
    createRelationship({ id: 'seed-rel-8', type: RELATIONSHIP_TYPES.annotates, source: ann4.id, target: { id: vid1.id, selector: { kind: 'time', start: 95, end: 128 } }, meta: meta(13, 13, 'user') }),
    createRelationship({
      id: 'seed-rel-9',
      type: RELATIONSHIP_TYPES.annotates,
      source: ann5.id,
      target: { id: vid1.id, selector: { kind: 'time', start: 210, region: { x: 0.12, y: 0.18, width: 0.5, height: 0.55 } } },
      meta: meta(13, 13, 'user'),
    }),
    createRelationship({
      id: 'seed-rel-10',
      type: RELATIONSHIP_TYPES.annotates,
      source: ann3.id,
      target: { id: img1.id, selector: { kind: 'region', x: 22, y: 12, width: 46, height: 30 } },
      meta: meta(5, 5, 'user'),
    }),
  ]

  store.upsertMany([web1, web2, web3, ann1, ann2, ann3, ann4, ann5, doc1, doc2, doc3, img1, vid1, note1, ...rels])
  store.setTagInfo('protocol', { color: '#c7d2fe', description: 'Relates to the exchange-protocol direction.' })
  store.setTagInfo('reference', { color: '#bbf7d0', description: 'External source material.' })
  store.setTagInfo('draft', { color: '#fde68a' })
}
