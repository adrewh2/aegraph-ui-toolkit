import about from '../../docs/about.md?raw'
import roadmap from '../../docs/roadmap.md?raw'
import overview from '../../docs/overview.md?raw'
import workflow from '../../docs/workflow.md?raw'
import useCases from '../../docs/use-cases.md?raw'
import explorer from '../../docs/explorer.md?raw'
import pipeline from '../../docs/pipeline.md?raw'
import values from '../../docs/values.md?raw'
import resources from '../../docs/resources.md?raw'
import navigation from '../../docs/navigation.md?raw'
import positions from '../../docs/positions.md?raw'
import analysis from '../../docs/analysis.md?raw'
import insights from '../../docs/insights.md?raw'
import scripts from '../../docs/scripts.md?raw'
import datasets from '../../docs/datasets.md?raw'
import plots from '../../docs/plots.md?raw'
import exchange from '../../docs/exchange.md?raw'
import projects from '../../docs/projects.md?raw'
import diagrams from '../../docs/diagrams.md?raw'
import maps from '../../docs/maps.md?raw'
import assistant from '../../docs/assistant.md?raw'
import spec from '../../docs/spec.md?raw'
import constraints from '../../docs/constraints.md?raw'
import smoke from '../../docs/smoke.md?raw'
import privacy from '../../docs/privacy.md?raw'
import { featureOn, type FeatureName } from '../../app/features'

export interface DocPage {
  id: string
  title: string
  /** One line under the title in the rail and header. */
  blurb?: string
  /** Markdown source; empty for pages that render a component. */
  source: string
  /** The page ends with a generated section (the tool reference). */
  generated?: 'tools'
  /** A live page (the data model) rendered instead of Markdown. */
  component?: 'model'
  /** The page of a feature a deployment can turn off (`app/features.ts`): not served there. */
  feature?: FeatureName
}

export interface DocGroup {
  title: string
  pages: DocPage[]
}

/** Every page, grouped and in reading order. Markdown lives in `src/docs`. */
const EVERY_GROUP: DocGroup[] = [
  {
    title: 'Start here',
    pages: [
      { id: 'about', title: 'About aegraph', blurb: 'What it is for, the model behind it, what is built, and where it is going', source: about },
      { id: 'roadmap', title: 'Ontology roadmap', blurb: 'Where aegraph stands as an ontology harness, and the nine gaps in the order to close them', source: roadmap },
      { id: 'overview', title: 'Overview', blurb: 'What aegraph is and how it is laid out', source: overview },
      { id: 'workflow', title: 'A working session', blurb: '⌘K, asking the assistant, Insights, claims, and publishing a page — one walk-through', source: workflow },
      { id: 'navigation', title: 'Getting around', blurb: 'The pages, ⌘K, what every table and inspector does, the Workstation, the keys', source: navigation },
      { id: 'use-cases', title: 'Use cases', blurb: 'Ten jobs the app is for, the path through each, the tools and the utilities underneath', source: useCases },
      { id: 'model', title: 'Data model', blurb: 'The primitives, categories and registered types — live from this workspace', source: '', component: 'model' },
    ],
  },
  {
    title: 'Working with data',
    pages: [
      { id: 'exchange', title: 'Import & export', blurb: 'Files in and out, datasets, ChatGPT exports', source: exchange },
      { id: 'projects', title: 'Projects', blurb: 'Named scopes over one Library — bundles, versions, templates, publishing', source: projects },
      { id: 'resources', title: 'Documents & media', blurb: 'Documents, web pages, images, videos, audio, conversations — and annotations on exact places in them', source: resources },
      { id: 'diagrams', title: 'Diagrams', blurb: 'Graphviz, Mermaid, Excalidraw, and the Scenes page', source: diagrams },
      { id: 'maps', title: 'Maps', blurb: 'Places, Google Maps links, KML and GeoJSON, notes at a point and a time', source: maps, feature: 'maps' },
    ],
  },
  {
    title: 'Graph',
    pages: [
      { id: 'explorer', title: 'Unigraph', blurb: 'The graph explorer: filters, layouts, styles and scenes in 2D and 3D on one engine — several sessions as tabs', source: explorer },
      { id: 'pipeline', title: 'The pipeline', blurb: 'How a view is computed', source: pipeline },
      { id: 'values', title: 'Values & selectors', blurb: 'Referring to data on nodes and edges', source: values },
      { id: 'positions', title: 'Position layouts', blurb: 'Placing nodes by rule or by hand', source: positions },
      { id: 'analysis', title: 'Analysis', blurb: 'Metrics over the current view', source: analysis },
      { id: 'insights', title: 'Insights', blurb: 'The analytics harness: five analyses, ranked findings, visuals', source: insights },
      { id: 'plots', title: 'Charts', blurb: 'Charts over entity data, built without code', source: plots },
      { id: 'scripts', title: 'Scripts', blurb: 'JavaScript over the dataset in a sandbox: figures, tables, scenes', source: scripts },
      { id: 'datasets', title: 'Datasets', blurb: 'Tables kept as entities — what a script returns, edited in a grid, read by charts', source: datasets },
    ],
  },
  {
    title: 'Reference',
    pages: [
      { id: 'spec', title: 'File format (.ae.json)', blurb: 'The aegraph document: schema, example, and what other systems write', source: spec },
      { id: 'constraints', title: 'Constraints', blurb: 'Rules every write must satisfy: required, unique, what a relationship may join, JavaScript checks; the audit', source: constraints },
      { id: 'assistant', title: 'Assistant & MCP', blurb: 'Driving the app by tools, with the full tool reference', source: assistant, generated: 'tools' },
      { id: 'privacy', title: 'Privacy & security', blurb: 'Where your work lives, what reaches the network and when, your API key, and running aegraph where an organisation\'s rules apply', source: privacy },
      { id: 'smoke', title: 'The smoke suite', blurb: 'Twelve scripted runs over the bridge and a headless tab: the driver, what each step proves, a run on record', source: smoke },
    ],
  },
]

/**
 * The in-app documentation this deployment serves: a page of a feature it turned off is gone from the index, the
 * rail, search, the `docs` tool and its own address (which goes to the first page).
 */
export const DOC_GROUPS: DocGroup[] = EVERY_GROUP.map((g) => ({ ...g, pages: g.pages.filter((p) => !p.feature || featureOn(p.feature)) }))

export const DOC_PAGES: DocPage[] = DOC_GROUPS.flatMap((g) => g.pages)

export const docPage = (id: string | undefined): DocPage | undefined => DOC_PAGES.find((p) => p.id === id)
