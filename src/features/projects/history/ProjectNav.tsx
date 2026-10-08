import { GitCommitHorizontal, History, LayoutGrid, Settings } from 'lucide-react'
import { NavLink } from 'react-router-dom'
import type { EntityId } from '../../../core/entity/types'
import { formatNumber } from '../../../lib/format'
import { useChangeCount } from './useHistory'

/** The tabs under a project's title: Overview · Changes (with the unsaved count) · History · Settings. */
export function ProjectNav({ id }: { id: EntityId }) {
  const n = useChangeCount(id)
  const base = `/projects/${encodeURIComponent(id)}`
  const cls = ({ isActive }: { isActive: boolean }) => `vh-tab ${isActive ? 'is-active' : ''}`
  return (
    <nav className="vh-tabs" aria-label="Project pages">
      <NavLink to={base} end className={cls}>
        <LayoutGrid size={13} /> Overview
      </NavLink>
      <NavLink to={`${base}/changes`} className={cls}>
        <GitCommitHorizontal size={13} /> Changes
        {n !== null && n > 0 && <span className="vh-tab__n">{formatNumber(n)}</span>}
      </NavLink>
      <NavLink to={`${base}/history`} className={cls}>
        <History size={13} /> History
      </NavLink>
      <NavLink to={`${base}/settings`} className={cls}>
        <Settings size={13} /> Settings
      </NavLink>
    </nav>
  )
}
