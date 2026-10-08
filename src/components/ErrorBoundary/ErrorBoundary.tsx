import { Component, type ErrorInfo, type ReactNode } from 'react'
import { isStaleChunk, reloadForNewVersion } from '../../app/preload'
import './ErrorBoundary.css'

/**
 * A crash stays where it happened. The app is three of these side by side — the sidebar, the page, the assistant
 * panel — and every workstation pane has its own, so one part failing shows a note in its place and the rest keeps
 * working, instead of React unmounting the whole tree and leaving a blank window.
 *
 * `resetKey`: when it changes (the page's path, say) a crashed part tries again on its own, so navigating away from
 * a broken page recovers without a reload.
 */
export interface ErrorBoundaryProps {
  /** What crashed, as the note says it: "This view", "The sidebar". */
  what: string
  resetKey?: unknown
  /** Where it is logged: `[<scope>] crashed`. */
  scope?: string
  /** A one-line note (for narrow places: the sidebar). */
  compact?: boolean
  children: ReactNode
}

/**
 * Code that changed underneath a running page. After a deploy a chunk is no longer on the server; on the dev server a
 * dependency rebuilt (two copies of React: hooks read `use…` of null) or a module hot-swapped a hook into or out of a
 * component that was already mounted (React loses its hook list: `getSnapshot` of null, rendered more or fewer hooks).
 * Only a reload puts the page back on one version.
 */
export function isStaleCode(error: Error): boolean {
  return isStaleChunk(error) || /reading '(use[A-Z]\w*|getSnapshot|memoizedState|queue)'/.test(error.message) || /Rendered (more|fewer) hooks than/.test(error.message)
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, { error: Error | null; key: unknown }> {
  state = { error: null as Error | null, key: this.props.resetKey }
  static getDerivedStateFromError(error: Error) {
    return { error }
  }
  static getDerivedStateFromProps(props: ErrorBoundaryProps, state: { error: Error | null; key: unknown }) {
    // Somewhere else now: the crashed part gets another go.
    if (props.resetKey !== state.key) return { error: null, key: props.resetKey }
    return null
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[${this.props.scope ?? 'app'}] crashed`, error, info.componentStack)
    // A chunk no longer on the server: the page is running a version a deploy has replaced. Reloading is the fix, and
    // it is taken once per page (see reloadForNewVersion) — after that the note below offers it.
    if (isStaleChunk(error)) reloadForNewVersion()
  }
  render() {
    const { error } = this.state
    if (!error) return this.props.children
    const stale = isStaleCode(error)
    const reload = (
      <button className="btn btn--sm btn--primary" onClick={() => location.reload()}>
        Reload page
      </button>
    )
    const retry = (
      <button className="btn btn--sm" onClick={() => this.setState({ error: null })}>
        Try again
      </button>
    )
    if (this.props.compact)
      return (
        <div className="crash crash--compact" role="alert" title={error.message}>
          <strong>{this.props.what} crashed.</strong>
          <div className="crash__actions">
            {reload}
            {retry}
          </div>
        </div>
      )
    return (
      <div className="crash" role="alert">
        <strong>{this.props.what} crashed.</strong>
        <pre>{error.message}</pre>
        {stale && <p className="muted">The app's code changed underneath it (a dependency was rebuilt, a file was hot-swapped, or a new version deployed). Reload the page to pick up one consistent copy.</p>}
        <div className="crash__actions">
          {stale && reload}
          {retry}
          {!stale && reload}
        </div>
      </div>
    )
  }
}
