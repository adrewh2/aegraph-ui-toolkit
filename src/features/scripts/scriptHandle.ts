import type { Language, Output } from '../../scripting/types'

/** What the mounted Scripts page exposes to the assistant: set code, run it, read what came back. */
export interface ScriptRunView {
  outputs: Output[]
  error?: string
  logs: string[]
  ms: { load: number; run: number; snapshot: number }
}
export interface ScriptHandle {
  getState: () => { scriptId?: string; code: string; language: Language; running: boolean; result?: ScriptRunView }
  setCode: (code: string, language?: Language) => void
  /** `forId`: the script entity the run belongs to (its lastRun and language are written there); `null` for an unsaved run; default the page's current script. */
  run: (code?: string, language?: Language, forId?: string | null) => Promise<ScriptRunView | undefined>
  load: (id: string) => void
}

const g = globalThis as unknown as { __aegraphScripts?: { handle: ScriptHandle | null; listeners: Set<() => void> } }
const reg = (g.__aegraphScripts ??= { handle: null, listeners: new Set() })

export function registerScriptHandle(h: ScriptHandle): () => void {
  reg.handle = h
  reg.listeners.forEach((l) => l())
  return () => {
    if (reg.handle === h) reg.handle = null
    reg.listeners.forEach((l) => l())
  }
}
export const getScriptHandle = (): ScriptHandle | null => reg.handle
export function waitForScriptPage(timeoutMs = 5000): Promise<ScriptHandle | null> {
  if (reg.handle) return Promise.resolve(reg.handle)
  return new Promise((resolve) => {
    const done = (h: ScriptHandle | null) => {
      reg.listeners.delete(check)
      clearTimeout(timer)
      resolve(h)
    }
    const check = () => reg.handle && done(reg.handle)
    reg.listeners.add(check)
    const timer = setTimeout(() => done(null), timeoutMs)
  })
}
