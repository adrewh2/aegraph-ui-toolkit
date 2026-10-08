/**
 * Sentence embeddings in the browser, for search by meaning without an API
 * key. The model (all-MiniLM-L6-v2, ~23 MB quantised) and the transformers
 * runtime are fetched only when a semantic search is actually run — never
 * on page load, never for a visitor who only reads — and only after the
 * user has said yes once; the browser then caches the files (Cache API),
 * so the download happens once per browser.
 */
import { requireExternalServices } from '../account/settings'

const MODEL = 'Xenova/all-MiniLM-L6-v2'
const ENABLED_KEY = 'aegraph:embeddings'
export const MODEL_SIZE_MB = 23

export type Embed = (texts: string[]) => Promise<Float32Array[]>

type Pipe = (texts: string[], opts: { pooling: 'mean'; normalize: boolean }) => Promise<{ tolist(): number[][] }>
let pipe: Promise<Pipe> | null = null
let ready = false
let progress: { file: string; loaded: number; total: number } | null = null

const ls = () => (typeof localStorage !== 'undefined' ? localStorage : undefined)

/** The user has agreed to the one-time download (remembered per browser). */
export const embeddingsAllowed = () => ls()?.getItem(ENABLED_KEY) === '1'
export function setEmbeddingsAllowed(on: boolean) {
  try {
    if (on) ls()?.setItem(ENABLED_KEY, '1')
    else ls()?.removeItem(ENABLED_KEY)
  } catch {
    /* ignore */
  }
}
/** The model is loaded in this tab and embeds run without a fetch. */
export const embeddingsReady = () => ready
export const embeddingsProgress = () => progress

/** Where the ONNX runtime's wasm and its loader are served from (copied by `scripts/vendor.mjs`). */
export const ORT_PATH = '/vendor/ort/'

/** Load the runtime and the model — a code-split chunk plus the model files, cached by the browser after the first time. */
async function load(): Promise<Pipe> {
  if (!pipe) {
    pipe = (async () => {
      // The model comes from a third party; the text is only ever read here, in this browser.
      requireExternalServices('Search by meaning')
      const t = await import('@huggingface/transformers')
      t.env.allowLocalModels = false
      // The runtime is this origin's own copy (`scripts/vendor.mjs`), never the CDN transformers.js defaults to: code
      // that runs in this origin is served by it. Only the model — weights, not code — comes from huggingface.co.
      const wasm = t.env.backends.onnx.wasm
      if (wasm) wasm.wasmPaths = ORT_PATH
      const p = await t.pipeline('feature-extraction', MODEL, {
        dtype: 'q8',
        progress_callback: (e: { status?: string; file?: string; loaded?: number; total?: number }) => {
          if (e.status === 'progress' && e.file) progress = { file: e.file, loaded: e.loaded ?? 0, total: e.total ?? 0 }
        },
      })
      ready = true
      progress = null
      return p as unknown as Pipe
    })()
    pipe.catch(() => {
      pipe = null
    })
  }
  return pipe
}

/** Normalised embeddings, one per text. Triggers the download the first time (see `embeddingsAllowed`). */
export const embed: Embed = async (texts) => {
  if (!texts.length) return []
  const p = await load()
  const out = await p(texts, { pooling: 'mean', normalize: true })
  return out.tolist().map((v) => Float32Array.from(v))
}

export function cosine(a: Float32Array, b: Float32Array): number {
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i] * b[i]
  return s
}

// ── Cache: embeddings by key, so a second query over the same vocabulary or entities embeds only what changed ──
const cache = new Map<string, Float32Array>()
const MAX_CACHE = 20_000

let override: Embed | null = null
/** Test seam: stand in for the model (and mark it downloaded) without touching the network. */
export function overrideEmbed(fn: Embed | null) {
  override = fn
  ready = !!fn
  cache.clear()
}

/** Embed texts by key, reusing what this tab has embedded before (key = id + version). */
export async function embedCached(items: { key: string; text: string }[], embedFn: Embed = override ?? embed): Promise<Float32Array[]> {
  const missing = items.filter((i) => !cache.has(i.key))
  if (missing.length) {
    const vecs = await embedFn(missing.map((i) => i.text))
    missing.forEach((i, k) => cache.set(i.key, vecs[k]))
    if (cache.size > MAX_CACHE) for (const k of [...cache.keys()].slice(0, cache.size - MAX_CACHE)) cache.delete(k)
  }
  return items.map((i) => cache.get(i.key)!)
}
