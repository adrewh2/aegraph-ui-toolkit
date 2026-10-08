/**
 * Spotify sign-in from the browser: the Authorization Code flow with PKCE,
 * which needs a Client ID and no secret. The user registers an app at
 * developer.spotify.com, adds this origin's callback as a redirect URI and
 * pastes the Client ID here; tokens live in this browser's localStorage
 * and nothing passes through a server of ours.
 *
 * Spotify's rules for the redirect URI: HTTPS, or a loopback address over
 * HTTP — `http://127.0.0.1:5173/spotify/callback` works, `localhost` is
 * refused — and it must match the registered one exactly.
 */

import { requireExternalServices } from '../account/settings'

const ACCOUNTS = 'https://accounts.spotify.com'
export const SPOTIFY_API = 'https://api.spotify.com/v1'
export const CALLBACK_PATH = '/spotify/callback'

const CLIENT_KEY = 'aegraph:spotify:client-id'
const AUTH_KEY = 'aegraph:spotify:auth'
/** The in-flight login (verifier and state), in sessionStorage: it only has to survive the round trip. */
const PKCE_KEY = 'aegraph:spotify:pkce'

/** What the import reads. `user-read-private` is for the account's country and plan on the listener entity. */
export const SCOPES = ['playlist-read-private', 'playlist-read-collaborative', 'user-library-read', 'user-follow-read', 'user-top-read', 'user-read-private']

export interface SpotifyAuth {
  clientId: string
  accessToken: string
  refreshToken?: string
  /** Epoch ms. */
  expiresAt: number
  scope?: string
}

const ls = () => (typeof localStorage !== 'undefined' ? localStorage : undefined)

export const spotifyRedirectUri = () => `${location.origin}${CALLBACK_PATH}`

// A browser with site data blocked (a private window, third-party-cookie rules) throws on every storage call, and
// the card reads the id while it renders: it must come back empty rather than take the Projects dialog down with it.
export function getClientId(): string {
  try {
    return ls()?.getItem(CLIENT_KEY) ?? ''
  } catch {
    return ''
  }
}
export function setClientId(id: string) {
  try {
    const s = ls()
    if (!s) return
    if (id.trim()) s.setItem(CLIENT_KEY, id.trim())
    else s.removeItem(CLIENT_KEY)
  } catch {
    /* not remembered for next time; the sign-in in flight carries the id itself */
  }
}

// Parsed once per stored value: a subscriber (useSyncExternalStore) needs the same object back until it changes.
let cached: { raw: string | null; auth: SpotifyAuth | null } | undefined
export function getSpotifyAuth(): SpotifyAuth | null {
  let raw: string | null = null
  try {
    raw = ls()?.getItem(AUTH_KEY) ?? null
  } catch {
    /* no storage */
  }
  if (cached && cached.raw === raw) return cached.auth
  let auth: SpotifyAuth | null = null
  try {
    const a = raw ? (JSON.parse(raw) as SpotifyAuth) : null
    auth = a && typeof a.accessToken === 'string' ? a : null
  } catch {
    auth = null
  }
  cached = { raw, auth }
  return auth
}
function setSpotifyAuth(a: SpotifyAuth | null) {
  const s = ls()
  if (!s) return
  if (a) s.setItem(AUTH_KEY, JSON.stringify(a))
  else s.removeItem(AUTH_KEY)
  for (const l of listeners) l()
}

type Listener = () => void
const listeners = new Set<Listener>()
/** Called when the signed-in state changes (a card re-renders on it). */
export function onSpotifyAuthChange(l: Listener): () => void {
  listeners.add(l)
  return () => {
    listeners.delete(l)
  }
}

export function signOutSpotify() {
  setSpotifyAuth(null)
}

// ── PKCE ───────────────────────────────────────────────────────────────

const randomString = (n: number) => {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~'
  const bytes = crypto.getRandomValues(new Uint8Array(n))
  return Array.from(bytes, (b) => chars[b % chars.length]).join('')
}
const base64url = (bytes: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

/** Leaves the page for Spotify's consent screen; `completeSpotifyLogin` finishes on the way back. */
export async function beginSpotifyLogin(clientId: string): Promise<void> {
  requireExternalServices('Signing in to Spotify')
  const id = clientId.trim()
  if (!id) throw new Error('A Spotify Client ID is needed')
  if (!crypto?.subtle) throw new Error('PKCE needs a secure context (HTTPS, or 127.0.0.1)')
  setClientId(id)
  const verifier = randomString(64)
  const challenge = base64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)))
  const state = randomString(16)
  try {
    sessionStorage.setItem(PKCE_KEY, JSON.stringify({ verifier, state, clientId: id, back: location.pathname + location.search }))
  } catch {
    // Without the verifier on the way back there is no completing this, so say why here rather than fail cryptically at the callback.
    throw new Error('This browser is not storing anything for the page (a private window, or site data blocked), so the Spotify sign-in cannot finish')
  }
  const q = new URLSearchParams({ response_type: 'code', client_id: id, redirect_uri: spotifyRedirectUri(), scope: SCOPES.join(' '), code_challenge_method: 'S256', code_challenge: challenge, state })
  location.assign(`${ACCOUNTS}/authorize?${q}`)
}

/** On the callback page: exchange the code for tokens. Returns where to go back to. */
export async function completeSpotifyLogin(params: URLSearchParams): Promise<{ back: string }> {
  const raw = sessionStorage.getItem(PKCE_KEY)
  sessionStorage.removeItem(PKCE_KEY)
  const pending = raw ? (JSON.parse(raw) as { verifier: string; state: string; clientId: string; back?: string }) : null
  const err = params.get('error')
  if (err) throw new Error(err === 'access_denied' ? 'Spotify access was declined' : `Spotify: ${err}`)
  const code = params.get('code')
  if (!code) throw new Error('No code came back from Spotify')
  if (!pending) throw new Error('No sign-in was in progress in this tab (start again from the Datasets page)')
  if (params.get('state') !== pending.state) throw new Error('The sign-in state did not match — start again')
  const tokens = await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: spotifyRedirectUri(), client_id: pending.clientId, code_verifier: pending.verifier })
  setSpotifyAuth({ clientId: pending.clientId, ...tokens })
  return { back: pending.back && !pending.back.startsWith(CALLBACK_PATH) ? pending.back : '/datasets' }
}

async function tokenRequest(body: Record<string, string>): Promise<Omit<SpotifyAuth, 'clientId'>> {
  requireExternalServices('Signing in to Spotify')
  const res = await fetch(`${ACCOUNTS}/api/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) })
  const json = (await res.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string; error?: string; error_description?: string }
  if (!res.ok || !json.access_token) throw new Error(json.error_description ?? json.error ?? `${res.status} ${res.statusText} from Spotify`)
  return { accessToken: json.access_token, refreshToken: json.refresh_token, expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000, scope: json.scope }
}

let refreshing: Promise<SpotifyAuth> | null = null
/** A usable access token, refreshed when it is about to expire. Throws when signed out or the refresh is refused (the auth is then cleared). */
export async function spotifyAccessToken(): Promise<string> {
  const a = getSpotifyAuth()
  if (!a) throw new Error('Not signed in to Spotify')
  if (a.expiresAt - Date.now() > 60_000) return a.accessToken
  if (!a.refreshToken) {
    setSpotifyAuth(null)
    throw new Error('The Spotify session expired — sign in again')
  }
  refreshing ??= tokenRequest({ grant_type: 'refresh_token', refresh_token: a.refreshToken, client_id: a.clientId })
    .then((t) => {
      const next = { clientId: a.clientId, ...t, refreshToken: t.refreshToken ?? a.refreshToken }
      setSpotifyAuth(next)
      return next
    })
    .catch((err) => {
      setSpotifyAuth(null)
      throw err
    })
    .finally(() => {
      refreshing = null
    })
  return (await refreshing).accessToken
}

// ── Pacing ─────────────────────────────────────────────────────────────
// Spotify meters calls over a rolling 30-second window, and a development-mode app gets a small share: hundreds of
// playlist pages back to back trip it. Calls are spaced out, the gap widens after a 429 and narrows again on a run
// of successes, and a 429 is waited out with a growing pause (Retry-After is not exposed to browser code across
// origins, so the wait cannot follow it).
const GAP_MIN_MS = 150
const GAP_MAX_MS = 2000
let gapMs = GAP_MIN_MS
let nextAllowed = 0
let successes = 0
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function pace(signal?: AbortSignal) {
  const now = Date.now()
  const wait = nextAllowed - now
  nextAllowed = Math.max(now, nextAllowed) + gapMs
  if (wait > 0) await abortable(sleep(wait), signal)
}
function abortable<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return p
  return new Promise((res, rej) => {
    const onAbort = () => rej(new DOMException('The import was stopped', 'AbortError'))
    if (signal.aborted) return onAbort()
    signal.addEventListener('abort', onAbort, { once: true })
    p.then(res, rej).finally(() => signal.removeEventListener('abort', onAbort))
  })
}

type WaitListener = (seconds: number, attempt: number) => void
let onWait: WaitListener | null = null
/** Told when a call is waiting out a rate limit (the import dialog shows it). */
export function setSpotifyWaitListener(l: WaitListener | null) {
  onWait = l
}

/**
 * Where a call goes: a path under /v1, or a full URL the API handed back (a page's `next`) — which is data from a
 * response, so it is followed only when it is the API itself. The bearer token goes with the request; a `next` that
 * named another host would hand it the user's Spotify session.
 */
export function spotifyApiUrl(path: string): string {
  const api = new URL(SPOTIFY_API)
  const refuse = () => new Error(`Not a Spotify Web API address: ${path.slice(0, 120)}`)
  const absolute = /^[a-z][a-z0-9+.-]*:/i.test(path)
  if (!absolute && (!path.startsWith('/') || path.startsWith('//') || path.startsWith('/\\'))) throw refuse()
  let url: URL
  try {
    url = new URL(absolute ? path : `${SPOTIFY_API}${path}`)
  } catch {
    throw refuse()
  }
  if (url.origin !== api.origin || !url.pathname.startsWith(`${api.pathname}/`) || url.username || url.password) throw refuse()
  return url.href
}

/**
 * One call to the Web API, as JSON. A 429 is waited out and tried again,
 * a 401 refreshes the token once. `path` is relative to /v1 or a full URL
 * (the API's `next` links).
 */
export async function spotifyFetch<T>(path: string, signal?: AbortSignal, attempt = 0): Promise<T> {
  requireExternalServices('The Spotify import')
  const url = spotifyApiUrl(path)
  const token = await spotifyAccessToken()
  await pace(signal)
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` }, signal })
  if (res.status === 429) {
    if (attempt >= 10) throw new Error(`Spotify kept answering 429 Too Many Requests for minutes on ${url.replace(SPOTIFY_API, '').replace(/\?.*$/, '')} — the app's quota is spent for now; try again later, or import fewer parts`)
    gapMs = Math.min(GAP_MAX_MS, gapMs * 2)
    successes = 0
    const header = Number(res.headers.get('retry-after'))
    const wait = Math.min(120, header > 0 ? header + 1 : 5 * 2 ** Math.min(attempt, 4))
    onWait?.(wait, attempt + 1)
    await abortable(sleep(wait * 1000), signal)
    onWait?.(0, attempt + 1)
    return spotifyFetch<T>(path, signal, attempt + 1)
  }
  if (res.status === 401 && attempt === 0) {
    const a = getSpotifyAuth()
    if (a) {
      // Force a refresh by expiring what we have.
      setSpotifyAuth({ ...a, expiresAt: 0 })
      return spotifyFetch<T>(path, signal, attempt + 1)
    }
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: { message?: string; reason?: string } | string }
    const detail = typeof body.error === 'string' ? body.error : [body.error?.message, body.error?.reason].filter(Boolean).join(' — ')
    const where = url.replace(SPOTIFY_API, '').replace(/\?.*$/, '')
    const hint = res.status === 403 ? ' (403 from Spotify usually means the app has no Web API access ticked in its settings, or this account is not on its User Management list — development-mode apps serve only the owner and up to 5 added users)' : ''
    throw new Error(`${res.status} ${detail || res.statusText} on ${where}${hint}`)
  }
  if (++successes >= 40 && gapMs > GAP_MIN_MS) {
    gapMs = Math.max(GAP_MIN_MS, Math.round(gapMs * 0.75))
    successes = 0
  }
  return (await res.json()) as T
}
