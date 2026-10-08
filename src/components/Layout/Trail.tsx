import { ArrowLeft, ArrowRight } from 'lucide-react'
import { useEffect } from 'react'
import { useLocation, useNavigate, useNavigationType } from 'react-router-dom'
import { canGoBack, canGoForward, record, step, useTrail } from '../../app/trail'
import './Trail.css'

/**
 * Back and forward through every place the app has shown — pane tabs
 * included, which the browser's own history never records. Lives in the
 * sidebar header; ⌥← / ⌥→ and a mouse's back/forward buttons do the same.
 */
export function TrailButtons() {
  const location = useLocation()
  const navigate = useNavigate()
  const navType = useNavigationType()
  useTrail()
  const path = `${location.pathname}${location.search}`

  // A replace is not a move: the same entry, rewritten.
  useEffect(() => record(path, navType === 'REPLACE' ? 'replace' : 'push'), [path, navType])

  const go = (delta: number) => {
    const to = step(delta)
    if (to) navigate(to)
  }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey || (e.target as HTMLElement).closest('input, textarea, select, [contenteditable]')) return
      if (e.key === 'ArrowLeft') (e.preventDefault(), go(-1))
      else if (e.key === 'ArrowRight') (e.preventDefault(), go(1))
    }
    const onMouse = (e: MouseEvent) => {
      if (e.button === 3) (e.preventDefault(), go(-1))
      else if (e.button === 4) (e.preventDefault(), go(1))
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('mouseup', onMouse)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('mouseup', onMouse)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <span className="trail">
      <button className="trail__btn" disabled={!canGoBack()} onClick={() => go(-1)} title="Back (⌥←)" aria-label="Back">
        <ArrowLeft size={15} />
      </button>
      <button className="trail__btn" disabled={!canGoForward()} onClick={() => go(1)} title="Forward (⌥→)" aria-label="Forward">
        <ArrowRight size={15} />
      </button>
    </span>
  )
}
