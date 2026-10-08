import type { Language } from '../../scripting/types'

/**
 * Drafts: every edit on the Scripts page is kept here as you type, one per
 * script (and one for the unsaved script, under `new`), so leaving the page
 * and coming back — or reloading — never loses work. Saving commits a draft
 * into the script entity and drops it; the picker marks scripts that carry
 * one. Per browser, like the rest of the page's remembered state.
 *
 * A draft that cannot be kept (localStorage full, or refused) is not passed
 * over in silence: `writeDraft` says so, and the page tells the owner once,
 * so a reload is not trusted to bring back what was never written.
 */
export type LangChoice = Language | 'auto'
export interface Draft {
  code: string
  language: LangChoice
  at: string
}
export const NEW = 'new'
const KEY = 'aegraph:scripts:drafts'

export function readDrafts(): Record<string, Draft> {
  try {
    const raw = localStorage.getItem(KEY)
    const v = raw ? (JSON.parse(raw) as Record<string, Draft>) : {}
    return v && typeof v === 'object' ? v : {}
  } catch {
    return {}
  }
}

export const readDraft = (id: string): Draft | undefined => readDrafts()[id]

/** False when the drafts could not be written (no storage, or over quota). */
function write(drafts: Record<string, Draft>): boolean {
  try {
    if (Object.keys(drafts).length) localStorage.setItem(KEY, JSON.stringify(drafts))
    else localStorage.removeItem(KEY)
    return true
  } catch {
    return false
  }
}

/** Keep the editor's contents as the draft of `id`. False when this browser would not keep it: the edit is only in the editor. */
export function writeDraft(id: string, code: string, language: LangChoice): boolean {
  const drafts = readDrafts()
  const cur = drafts[id]
  if (cur && cur.code === code && cur.language === language) return true
  drafts[id] = { code, language, at: new Date().toISOString() }
  return write(drafts)
}

export function clearDraft(id: string) {
  const drafts = readDrafts()
  if (!(id in drafts)) return
  delete drafts[id]
  write(drafts)
}

const LAST_KEY = 'aegraph:scripts:last'
/** The script the page was last on, so a bare /scripts (a workstation tab, the sidebar) reopens it instead of a template. */
export function readLastScript(): string | undefined {
  try {
    return localStorage.getItem(LAST_KEY) ?? undefined
  } catch {
    return undefined
  }
}
export function writeLastScript(id: string | undefined) {
  try {
    if (id) localStorage.setItem(LAST_KEY, id)
    else localStorage.removeItem(LAST_KEY)
  } catch {
    /* no storage */
  }
}

const STATE_KEY = 'aegraph:scripts:state'
/** What a visual script asked to remember (`aegraph.remember`), per script — a camera, a toggle — handed back on its next run. */
export function readScriptState(id: string): Record<string, unknown> {
  try {
    const all = JSON.parse(localStorage.getItem(STATE_KEY) ?? '{}') as Record<string, Record<string, unknown>>
    return all[id] ?? {}
  } catch {
    return {}
  }
}
export function writeScriptState(id: string, state: Record<string, unknown>) {
  try {
    const all = JSON.parse(localStorage.getItem(STATE_KEY) ?? '{}') as Record<string, Record<string, unknown>>
    all[id] = state
    localStorage.setItem(STATE_KEY, JSON.stringify(all))
  } catch {
    /* no storage, or over quota: the scene just starts fresh next time */
  }
}
