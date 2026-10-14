/**
 * Per-deployment feature flags: whole features a deployment can turn off.
 *
 * A deployment (aegraph.dev, aegraph.sh, a fork) sets `AEGRAPH_FEATURES_OFF` — comma-separated names from `FEATURES`
 * below — when it builds. `vite.config.ts` reads it, reports unknown names and drops them, and hands the rest to the
 * bundle as the compile-time constant `__AEGRAPH_FEATURES_OFF__`. In Node (the headless engine, the tests) there is no
 * such constant and the same variable is read from the environment when this module loads. Unset means everything
 * on, as it always was.
 *
 * A user can turn a feature off too, for themselves, in the account menu's settings (`UserSettings.featuresOff`). That
 * layer is read from this browser's settings when this module loads — every surface below asks `featureOn` while it
 * builds its lists, so a change applies on the next load (the menu offers *Reload to apply*). A feature the deployment
 * turned off cannot be turned back on by a user.
 *
 * A feature that is off is gone from the build's surface: its sidebar rows and counts, its routes (they show
 * `FeatureOff` instead of loading the feature's code), its tools (`assistant/toolFeatures.ts`), its docs page, and
 * every link into its views. Its data stays data — the entities remain in the Library and the tables, and bundles
 * carrying them open. A new feature that can be knocked out registers here, and each surface asks `featureOn`.
 *
 * Pure: no DOM, no React — `vite.config.ts` imports it to check the names at build.
 */

export interface FeatureDef {
  /** The name a sentence uses: "Maps is turned off on this deployment." */
  label: string
  /** What it removes, in a few words — the build's report and the docs. */
  what: string
  /** The addresses that are the feature's pages (that path and everything below it). */
  routes: readonly string[]
  /** A feature that lives inside another is off whenever that one is. */
  needs?: string
}

export const FEATURES = {
  maps: { label: 'Maps', what: 'the Maps pages, the map views in the inspector, the map tools', routes: ['/maps'] },
  globe: { label: 'The globe', what: 'the globe stage of the Maps page and the globe tools', routes: [], needs: 'maps' },
  videos: { label: 'Videos', what: 'the Videos pages, the video player, the video tools', routes: ['/videos'] },
  audio: { label: 'Audio', what: 'the Audio pages, the audio player, the audio tools', routes: ['/audio', '/music'] },
} as const satisfies Record<string, FeatureDef>

export type FeatureName = keyof typeof FEATURES
export const FEATURE_NAMES = Object.keys(FEATURES) as FeatureName[]

const isFeature = (s: string): s is FeatureName => Object.prototype.hasOwnProperty.call(FEATURES, s)

/** `"maps, globe,typo"` → the known names, in `FEATURES` order, and the rest. Case and spaces do not matter. */
export function parseFeaturesOff(raw: string | undefined): { off: FeatureName[]; unknown: string[] } {
  const words = (raw ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
  return { off: FEATURE_NAMES.filter((n) => words.includes(n)), unknown: [...new Set(words.filter((w) => !isFeature(w)))] }
}

/** Baked in by `vite.config.ts` (`define`); absent in Node. */
declare const __AEGRAPH_FEATURES_OFF__: string | undefined

function configured(): string | undefined {
  if (typeof __AEGRAPH_FEATURES_OFF__ === 'string') return __AEGRAPH_FEATURES_OFF__
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
  return env?.AEGRAPH_FEATURES_OFF
}

const OFF: ReadonlySet<FeatureName> = new Set(parseFeaturesOff(configured()).off)

/** Where the account menu keeps this browser's settings (`features/account/settings.ts`); read here without React. */
export const ACCOUNT_SETTINGS_KEY = 'aegraph:account:settings'

/** The features a stored settings value turns off: known names only, whatever else it holds. */
export function userFeaturesOff(raw: string | null | undefined): FeatureName[] {
  try {
    const list = (JSON.parse(raw ?? '{}') as { featuresOff?: unknown }).featuresOff
    return Array.isArray(list) ? FEATURE_NAMES.filter((n) => list.includes(n)) : []
  } catch {
    return []
  }
}

function storedUserOff(): string | null {
  try {
    return (globalThis as { localStorage?: Storage }).localStorage?.getItem(ACCOUNT_SETTINGS_KEY) ?? null
  } catch {
    return null
  }
}

/** The user's own switches, as this page loaded them: a change to the setting applies on the next load. */
const USER_OFF: ReadonlySet<FeatureName> = new Set(userFeaturesOff(storedUserOff()))

/** Whether the deployment itself turned the feature off (or the feature it lives in): no setting brings it back. */
export function deploymentOff(name: FeatureName): boolean {
  if (OFF.has(name)) return true
  const def: FeatureDef = FEATURES[name]
  return !!def.needs && isFeature(def.needs) && deploymentOff(def.needs)
}

/** Whether this page has the feature: neither the deployment nor the user turned it off, nor the feature it lives in. */
export function featureOn(name: FeatureName): boolean {
  if (OFF.has(name) || USER_OFF.has(name)) return false
  const def: FeatureDef = FEATURES[name]
  return !def.needs || !isFeature(def.needs) || featureOn(def.needs)
}

/** The user's switches this page loaded with — what the settings must differ from for a reload to change anything. */
export const loadedUserFeaturesOff = (): FeatureName[] => FEATURE_NAMES.filter((n) => USER_OFF.has(n))

/** The features this deployment has turned off (those that follow from another included), in `FEATURES` order. */
export const featuresOff = (): FeatureName[] => FEATURE_NAMES.filter((n) => !featureOn(n))

/** The sentence every surface uses for a feature that is off: on this deployment, or in the user's settings. */
export const turnedOff = (name: FeatureName) => (deploymentOff(name) ? `${FEATURES[name].label} is turned off on this deployment.` : `${FEATURES[name].label} is turned off in your settings.`)

const under = (path: string, route: string) => path === route || (path.startsWith(route) && /^[/?#]/.test(path.slice(route.length)))

/**
 * The feature a path belongs to, on or off: `/maps/x` is maps, `/videos` videos, and the Maps page in globe mode
 * (`/maps/<id>?view=globe`) the globe. Undefined for everything else.
 */
export function featureOfPath(path: string): FeatureName | undefined {
  const p = path.trim()
  const found = FEATURE_NAMES.find((n) => FEATURES[n].routes.some((r) => under(p, r)))
  if (found === 'maps' && /[?&]view=globe(?:[&#]|$)/.test(p)) return 'globe'
  return found
}

/** The feature that is off and keeps this path from opening, if any (a globe address is off when maps is). */
export function pathOff(path: string): FeatureName | undefined {
  const f = featureOfPath(path)
  return f && !featureOn(f) ? (f === 'globe' && !featureOn('maps') ? 'maps' : f) : undefined
}
