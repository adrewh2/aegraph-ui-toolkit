/**
 * A flight recorder for the tab. Chrome kills a renderer that runs out of memory with no error the page can catch
 * and no trace left behind, so the tab keeps its own: every SAMPLE_MS a handful of numbers — the JS heap, how long
 * the main thread was blocked since the last sample, where the app is, how much is mounted, how big the stored chat
 * transcripts are — in a short ring buffer written to localStorage, which survives the crash. A page that ends
 * normally (a reload, a navigation away, closing it) says so on `pagehide`; one that does not was killed, and the
 * next load keeps its last minute as `lastCrash`. The assistant's `app_diagnostics` returns both.
 *
 * Per tab: every tab of the origin shares localStorage, so each keeps its record under its own id — kept in
 * sessionStorage, which a reload of the same tab keeps and no other tab sees — and a crash is found by the tab that
 * crashed, when it is reloaded. The crash records of every tab are kept (the newest few), each naming its tab.
 *
 * Cheap on purpose: no store walks, no DOM trees — a few property reads and querySelector counts; the transcript
 * sizes (localStorage key lengths) every fifth sample.
 */

const PREFIX = 'aegraph:memwatch:tab:'
const CRASH_PREFIX = 'aegraph:memwatch:crash:'
const KEEP_CRASHES = 5
/** Another tab's record not written for this long, and not ended cleanly, is a tab that was killed. */
const ORPHAN_MS = 15_000

/** This tab's id: the same across its reloads, different in every other tab. */
function tabId(): string {
  try {
    const k = 'aegraph:memwatch:id'
    const v = sessionStorage.getItem(k) ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
    sessionStorage.setItem(k, v)
    return v
  } catch {
    return 'tab'
  }
}
let KEY = PREFIX + 'tab'
const SAMPLE_MS = 2000
const KEEP = 30 // a minute of samples

export interface MemorySample {
  /** Epoch ms. */
  t: number
  /** JS heap in use / allocated, MB (Chrome only). */
  heap?: number
  total?: number
  /** Main-thread time lost to long tasks (>50 ms) since the previous sample, ms; and the longest one. */
  blocked: number
  longest: number
  route: string
  /** Pages kept mounted, canvases on the page, transcript items on screen. */
  pages: number
  canvases: number
  items: number
  /** Stored chat transcripts: how many, their total size and the largest (KB) — every fifth sample. */
  chats?: { count: number; kb: number; largestKb: number }
  /** What held the long frames since the previous sample (Long Animation Frame timing): the scripts that ran longest. */
  frames?: { ms: number; scripts: string[] }[]
}

interface Record {
  started: number
  clean: boolean
  samples: MemorySample[]
}

export interface CrashRecord extends Record {
  /** When the next load found it. */
  foundAt: number
  /** Which tab (see tabId) — several tabs of the app can be open at once. */
  tab: string
}

let samples: MemorySample[] = []
let blocked = 0
let longest = 0
let n = 0
let started = 0
/** Long frames since the last sample, with the scripts that held them. */
let frames: { ms: number; scripts: string[] }[] = []

/** One script of a long frame, as far as Chrome can name it: what invoked it, the function, the file and line. */
type LoafScript = { invoker?: string; sourceFunctionName?: string; sourceURL?: string; sourceCharPosition?: number; duration: number }
const nameOf = (s: LoafScript) => `${Math.round(s.duration)}ms ${s.sourceFunctionName || '(anonymous)'} @ ${(s.sourceURL ?? '').replace(/^.*\/src\//, 'src/').replace(/\?.*$/, '')}:${s.sourceCharPosition ?? ''} ← ${s.invoker ?? ''}`

const read = <T>(key: string): T | undefined => {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : undefined
  } catch {
    return undefined
  }
}
const write = (key: string, value: unknown) => {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* storage full: the recorder is the first thing to give way */
  }
}

function chatSizes(): MemorySample['chats'] {
  let count = 0
  let bytes = 0
  let largest = 0
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (!k?.startsWith('aegraph:ai:session:')) continue
      const len = (localStorage.getItem(k) ?? '').length
      count++
      bytes += len
      largest = Math.max(largest, len)
    }
  } catch {
    return undefined
  }
  return { count, kb: Math.round(bytes / 1024), largestKb: Math.round(largest / 1024) }
}

function sample() {
  const mem = (performance as Performance & { memory?: { usedJSHeapSize: number; totalJSHeapSize: number } }).memory
  const s: MemorySample = {
    t: Date.now(),
    ...(mem ? { heap: Math.round(mem.usedJSHeapSize / 1e6), total: Math.round(mem.totalJSHeapSize / 1e6) } : {}),
    blocked: Math.round(blocked),
    longest: Math.round(longest),
    route: location.pathname,
    pages: document.querySelectorAll('.app-page').length,
    canvases: document.querySelectorAll('canvas').length,
    items: document.querySelectorAll('.ai__items > *').length,
    ...(n++ % 5 === 0 ? { chats: chatSizes() } : {}),
    ...(frames.length ? { frames: frames.slice(-4) } : {}),
  }
  blocked = 0
  longest = 0
  frames = []
  samples = [...samples.slice(-(KEEP - 1)), s]
  write(KEY, { started, clean: false, samples } satisfies Record)
}

/** Start recording (once, at boot). Keeps the previous page's record when that page did not end normally. */
export function startMemoryWatch() {
  if (started || typeof window === 'undefined') return
  started = Date.now()
  const tab = tabId()
  KEY = PREFIX + tab
  const previous = read<Record>(KEY)
  if (previous && !previous.clean && previous.samples?.length) {
    write(CRASH_PREFIX + started, { ...previous, foundAt: started, tab } satisfies CrashRecord)
    // Only the newest few.
    for (const old of crashKeys().slice(0, -KEEP_CRASHES)) localStorage.removeItem(old)
  }
  // The first version's shared keys (every tab wrote one record, so tabs overwrote each other's): gone.
  try {
    localStorage.removeItem('aegraph:memwatch')
    localStorage.removeItem('aegraph:memwatch:last-crash')
  } catch {
    /* ignore */
  }
  // Other tabs' records: one that stopped without ending cleanly was a tab killed and never reloaded (a new tab
  // opened instead) — kept as a crash. A clean one older than a day is dropped.
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i)
      if (!k?.startsWith(PREFIX) || k === KEY) continue
      const r = read<Record>(k)
      const last = r?.samples?.at(-1)?.t ?? 0
      if (r && !r.clean && last && last < started - ORPHAN_MS) {
        write(CRASH_PREFIX + last, { ...r, foundAt: started, tab: k.slice(PREFIX.length) } satisfies CrashRecord)
        localStorage.removeItem(k)
      } else if (r?.clean && (r.started ?? 0) < started - 86_400_000) localStorage.removeItem(k)
    }
    for (const old of crashKeys().slice(0, -KEEP_CRASHES)) localStorage.removeItem(old)
  } catch {
    /* ignore */
  }
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        blocked += e.duration - 50
        longest = Math.max(longest, e.duration)
      }
    }).observe({ type: 'longtask', buffered: false })
  } catch {
    /* no long-task timing in this browser: blocked stays 0 */
  }
  // Long frames, with who held them. Each one over 300 ms is written at once — the next interval may never come.
  try {
    new PerformanceObserver((list) => {
      let heavy = false
      for (const e of list.getEntries() as (PerformanceEntry & { scripts?: LoafScript[] })[]) {
        if (e.duration < 150) continue
        frames.push({ ms: Math.round(e.duration), scripts: [...(e.scripts ?? [])].sort((a, b) => b.duration - a.duration).slice(0, 4).map(nameOf) })
        if (e.duration > 300) heavy = true
      }
      if (heavy) sample()
    }).observe({ type: 'long-animation-frame', buffered: false })
  } catch {
    /* no Long Animation Frame timing here */
  }
  // Ended normally: a reload, a navigation away, the tab closed. A crash never gets here.
  addEventListener('pagehide', () => write(KEY, { started, clean: true, samples } satisfies Record))
  sample()
  setInterval(sample, SAMPLE_MS)
}

/** The last minute of this page, newest last. */
export const recentSamples = (): MemorySample[] => samples

function crashKeys(): string[] {
  const keys: string[] = []
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (k?.startsWith(CRASH_PREFIX)) keys.push(k)
    }
  } catch {
    /* ignore */
  }
  return keys.sort()
}

/** The last minute of the last page — in any tab — that was killed rather than closed, if any. */
export const lastCrash = (): CrashRecord | undefined => {
  const k = crashKeys().at(-1)
  return k ? read<CrashRecord>(k) : undefined
}

/** Every crash record kept, newest last: when each was found and in which tab. */
export const crashes = (): { tab: string; foundAt: number; lastSample?: MemorySample }[] =>
  crashKeys().flatMap((k) => {
    const c = read<CrashRecord>(k)
    return c ? [{ tab: c.tab, foundAt: c.foundAt, lastSample: c.samples.at(-1) }] : []
  })

/**
 * localStorage as it stands: how much this origin holds, the heaviest key families, and whether a write still
 * succeeds. A full store fails every write quietly — transcripts stop being kept, and so does this recorder.
 */
export function storageReport(): { kb: number; keys: number; writable: boolean; heaviest: { family: string; keys: number; kb: number }[] } {
  const families = new Map<string, { keys: number; bytes: number }>()
  let bytes = 0
  let keys = 0
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (!k) continue
      const len = (k.length + (localStorage.getItem(k) ?? '').length) * 2 // UTF-16, as the quota counts
      bytes += len
      keys++
      const family = k.replace(/[:-][A-Za-z0-9_.-]{6,}$/, '')
      const f = families.get(family) ?? { keys: 0, bytes: 0 }
      f.keys++
      f.bytes += len
      families.set(family, f)
    }
  } catch {
    /* unreadable */
  }
  let writable = true
  try {
    localStorage.setItem('aegraph:memwatch:probe', 'x'.repeat(1024))
    localStorage.removeItem('aegraph:memwatch:probe')
  } catch {
    writable = false
  }
  const heaviest = [...families].sort((a, b) => b[1].bytes - a[1].bytes).slice(0, 8).map(([family, f]) => ({ family, keys: f.keys, kb: Math.round(f.bytes / 1024) }))
  return { kb: Math.round(bytes / 1024), keys, writable, heaviest }
}
