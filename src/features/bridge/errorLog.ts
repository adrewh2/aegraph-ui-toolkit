import * as React from 'react'

/**
 * The last few uncaught errors in this tab, so an assistant driving the app
 * over the bridge can see why something didn't mount instead of guessing.
 */
export interface LoggedError {
  at: string
  message: string
  source?: string
}

interface Installed {
  onError: (e: ErrorEvent) => void
  onRejection: (e: PromiseRejectionEvent) => void
  consoleError: typeof console.error
}
// React 19's dev-only owner stack (undefined in production builds).
const captureOwnerStack: (() => string | null) | undefined = (React as unknown as { captureOwnerStack?: () => string | null }).captureOwnerStack

const g = globalThis as unknown as { __aegraphErrors?: LoggedError[]; __aegraphErrorsInstalled?: Installed }
const log = (g.__aegraphErrors ??= [])

const brief = (err: unknown): string => {
  if (err instanceof Error) return `${err.name}: ${err.message} — ${(err.stack ?? '').split('\n').slice(1, 5).join(' | ')}`
  if (err && typeof err === 'object') {
    try {
      return JSON.stringify(err).slice(0, 300)
    } catch {
      return Object.prototype.toString.call(err)
    }
  }
  return String(err)
}

/** Installs the capture (or, after an HMR re-evaluation, swaps the previous listeners for these). */
export function installErrorLog() {
  if (typeof window === 'undefined') return
  const prev = g.__aegraphErrorsInstalled
  if (prev) {
    window.removeEventListener('error', prev.onError)
    window.removeEventListener('unhandledrejection', prev.onRejection)
    console.error = prev.consoleError
  }
  const push = (message: string, source?: string) => {
    log.push({ at: new Date().toISOString(), message: message.slice(0, 800), source })
    if (log.length > 10) log.shift()
  }
  const onError = (e: ErrorEvent) => push(`${e.message?.trim() || 'Uncaught'} ${e.error !== undefined ? brief(e.error) : ''}`.trim(), e.filename ? `${e.filename}:${e.lineno}` : undefined)
  const onRejection = (e: PromiseRejectionEvent) => push(brief(e.reason), 'promise')
  window.addEventListener('error', onError)
  window.addEventListener('unhandledrejection', onRejection)
  // React reports render errors through console.error too; keep the ones that carry an Error or read like one.
  const consoleError = console.error
  console.error = (...args: unknown[]) => {
    const first = args[0]
    if (args.some((a) => a instanceof Error) || (typeof first === 'string' && /(error|failed|uncaught)/i.test(first))) push(args.map(brief).join(' ').slice(0, 800), 'console')
    // A render loop ("Maximum update depth exceeded") names no component by itself; in development React can say
    // which one owns the update, and that is the line that finds the effect.
    if (typeof first === 'string' && first.startsWith('Maximum update depth') && captureOwnerStack) {
      const owner = captureOwnerStack()
      if (owner) push(`Render loop in ${owner.split('\n').filter(Boolean).slice(0, 4).join(' < ')}`, 'react')
    }
    consoleError.apply(console, args)
  }
  g.__aegraphErrorsInstalled = { onError, onRejection, consoleError }
}

export const recentErrors = (): LoggedError[] => [...log]
