import { BookOpen, Building2, FileText, Globe2, Network, Share2, Sparkles, type LucideIcon } from 'lucide-react'

/**
 * What a new chat is offered: things that show what the app is for, each a short title and a line of what it does on
 * the card, and the whole request — precise enough to work, naming the data where it comes from the web — in the
 * composer when chosen. They cover the parts a first chat should meet: data fetched from the web and explored in
 * Unigraph, linked data from Wikidata, a field's literature from OpenAlex, documents written and linked by what they
 * share (one tab each), the globe, and a map with notes and a chart. Every data source named here answers a plain GET
 * without a key (checked when this was written): vega-datasets on GitHub, Wikidata's SPARQL endpoint, the OpenAlex API.
 */
export interface Suggestion {
  icon: LucideIcon
  title: string
  hint: string
  prompt: string
}

export const SHOWCASES: Suggestion[] = [
  {
    icon: Network,
    title: 'Les Misérables, as a network',
    hint: 'A classic dataset fetched from the web, explored in Unigraph',
    prompt:
      'Fetch the Les Misérables character co-appearance network from vega-datasets (https://raw.githubusercontent.com/vega/vega-datasets/main/data/miserables.json) and import it as characters. Open it in Unigraph, colour the characters by their group and size them by how connected they are, then tell me who holds the story together and which characters bridge its communities.',
  },
  {
    icon: Share2,
    title: 'Who influenced whom',
    hint: 'Philosophers from Wikidata, drawn as an influence graph',
    prompt:
      'Query Wikidata (https://query.wikidata.org/sparql) with a SPARQL CONSTRUCT for philosophers of the 19th and 20th centuries and who influenced whom (P737), with their labels, and import the result as a graph. Show it in Unigraph with the most influential thinkers at the centre, and tell me which schools of thought the clusters are.',
  },
  {
    icon: BookOpen,
    title: 'A field’s citation map',
    hint: 'The most-cited papers on a topic from OpenAlex, and how they cite each other',
    prompt:
      'Use the OpenAlex API (https://api.openalex.org/works) to find the 30 most-cited papers on graph neural networks, with their year, citation count and the works they reference. Make each paper an entity, link a paper to each of the others it cites, and show the citation network in Unigraph, papers sized by citations and coloured by year. Which papers is everything built on?',
  },
  {
    icon: FileText,
    title: 'Three essays, linked by what they share',
    hint: 'Documents written side by side, their shared ideas made entities',
    prompt:
      'Write three short documents — on the transistor, the integrated circuit and Moore’s law — each a page with a few headings. Then find the concepts they share, make each concept an entity linked to the documents that discuss it, and show the documents and concepts together as a graph.',
  },
  {
    icon: Globe2,
    title: 'The world’s busiest routes, on the globe',
    hint: 'Airports and the flights between them, as places and paths',
    prompt:
      'Put the world’s 20 busiest airports on the globe, each with its city and yearly passengers, and draw the 25 busiest air routes between them as flight paths. Then chart the airports by passengers, and tell me which region the busiest routes cluster in.',
  },
  {
    icon: Building2,
    title: 'The tallest buildings, mapped',
    hint: 'Pins with a note on each, and a chart to compare them',
    prompt:
      'Map the world’s ten tallest buildings, one pin each, with a short note on every building (its height, year and what makes it notable) linked to its pin. Then add a chart comparing their heights.',
  },
]

/** The showcases, with the open project's own two first when there is one: its shape in Unigraph, and a brief on it. */
export function suggestionsFor(project?: string): Suggestion[] {
  if (!project) return SHOWCASES
  return [
    {
      icon: Network,
      title: `${project} in Unigraph`,
      hint: 'Its most connected entities, laid out and coloured by type',
      prompt: `Build a Unigraph scene of the most connected entities in ${project}, coloured by type and sized by how connected they are, and tell me what the picture shows.`,
    },
    {
      icon: Sparkles,
      title: `A brief on ${project}`,
      hint: 'One page on what it holds, linked to the entities it names',
      prompt: `Write a one-page brief on what ${project} holds — its main kinds of things, the most important ones and how they connect — and link the brief to the entities it names.`,
    },
    ...SHOWCASES.slice(0, 4),
  ]
}

/** For the assistant panel on a document's page: what to do with the document in front. */
export const DOCUMENT_SUGGESTIONS: string[] = [
  'Summarize this document in three bullets',
  'Tidy up the headings and fix typos in this document',
  'Find the people, places and ideas this document names, and link them to it as entities',
  'Write a companion document that goes deeper on this one’s main idea, and link the two',
]
