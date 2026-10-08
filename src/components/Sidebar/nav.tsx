import type { ReactNode } from 'react'
import { BookOpen, ChartLine, House, LayoutTemplate, Library, MessagesSquare, Network, Sparkles } from 'lucide-react'
import { EntityIcon } from '../icons/EntityIcon'
import { UnigraphIcon } from '../icons/UnigraphIcon'
import { pathOff } from '../../app/features'

/**
 * The pages the sidebar lists, in its order — and so the names the app gives its pages elsewhere: the browser tab's
 * title (`pageTitle.ts`) reads them from here.
 */
export type NavLeaf = { label: string; to?: string; badge?: string; trailing?: string }
export type NavItem = NavLeaf & { icon?: ReactNode; children?: NavLeaf[] }

/** A page of a feature this deployment turned off (`app/features.ts`) is not listed, nor named in a tab's title. */
const listed = (leaf: NavLeaf) => !leaf.to || !pathOff(leaf.to)

const everyPage: NavItem[] = [
  { label: 'Dashboard', to: '/', icon: <House size={16} /> },
  { label: 'Workstation', to: '/workstation', icon: <LayoutTemplate size={16} /> },
  { label: 'Chats', to: '/chats', icon: <MessagesSquare size={16} /> },
  { label: 'Entities', to: '/entities', icon: <EntityIcon size={16} /> },
  { label: 'Ontology', to: '/ontology', icon: <Network size={16} /> },
  {
    label: 'Resources',
    icon: <Library size={16} />,
    children: [
      { label: 'Documents', to: '/documents' },
      { label: 'Diagrams', to: '/diagrams' },
      { label: 'Images', to: '/images' },
      { label: 'Videos', to: '/videos' },
      { label: 'Audio', to: '/audio' },
      { label: 'Maps', to: '/maps' },
    ],
  },
  // The same explorer on the GPU engine: graphs up to a million nodes, in 2D or 3D.
  { label: 'Unigraph', to: '/unigraph', icon: <UnigraphIcon size={16} /> },
  { label: 'Insights', to: '/insights', icon: <Sparkles size={16} /> },
  {
    // Making and keeping, in the order the work flows: a scene (a graph composed) goes into a script, the table the
    // script returns is a dataset, and a chart reads the dataset.
    label: 'Analytics',
    icon: <ChartLine size={16} />,
    children: [
      { label: 'Scenes', to: '/scenes' },
      { label: 'Scripts', to: '/analytics/scripts' },
      { label: 'Datasets', to: '/analytics/datasets' },
      { label: 'Charts', to: '/analytics/charts' },
    ],
  },
]

export const primaryNav: NavItem[] = everyPage.filter(listed).map((item) => (item.children ? { ...item, children: item.children.filter(listed) } : item))

export const secondaryNav: NavItem[] = [{ label: 'Documentation', to: '/docs', icon: <BookOpen size={16} /> }]

/** Pages reached from elsewhere than the sidebar's list — the project switcher, the settings menu, a chat's artifact. */
export const otherPages: NavLeaf[] = [
  { label: 'Projects', to: '/projects' },
  { label: 'This browser', to: '/browser' },
  { label: 'Artifact', to: '/artifact' },
  { label: 'Datasets', to: '/datasets' },
]
