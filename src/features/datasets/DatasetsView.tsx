import { useNavigate } from 'react-router-dom'
import { DashboardView } from '../dashboard/DashboardView'
import { ProjectsDialog } from './ProjectsDialog'

/**
 * `/datasets` is no longer a page of its own: everything it offered lives in
 * the Projects dialog, which opens over the Dashboard here so the old link (and
 * the assistant's `open {page:"datasets"}`) still lands where it used to.
 */
export function DatasetsView() {
  const navigate = useNavigate()
  return (
    <>
      <DashboardView />
      <ProjectsDialog tab="projects" onClose={() => navigate('/')} />
    </>
  )
}
