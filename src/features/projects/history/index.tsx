import { useParams } from 'react-router-dom'
import { ProjectChangesView } from './ProjectChangesView'
import { ProjectHistoryView } from './ProjectHistoryView'
import { ProjectSettingsView } from './ProjectSettingsView'

/** The project's version-control pages, by route: `/projects/:id/changes`, `/history[/:commit]`, `/settings`. */
export function ProjectChangesRoute() {
  const { id = '' } = useParams()
  return <ProjectChangesView id={id} />
}
export function ProjectHistoryRoute() {
  const { id = '', commit } = useParams()
  return <ProjectHistoryView id={id} commit={commit} />
}
export function ProjectSettingsRoute() {
  const { id = '' } = useParams()
  return <ProjectSettingsView id={id} />
}
