import { featureOn, type FeatureName } from '../../app/features'

/**
 * Which tools belong to a feature a deployment can turn off (`app/features.ts`). The one place the tool set is
 * decided against the flags: `createAppTools` (the tab: the assistant, the bridge's `tools/list`) and the headless
 * engine's `createHeadlessTools` both pass their list through `toolsOn`, so a tool of a feature that is off is never
 * registered — not offered, not callable, not in the generated reference on `/docs/assistant`.
 *
 * A tool listed under several features (`control_playback`, which drives either player) stays while any of them is on.
 */
export const TOOL_FEATURES: Record<string, readonly FeatureName[]> = {
  create_map: ['maps'],
  add_location: ['maps'],
  add_path: ['maps'],
  add_area: ['maps'],
  annotate_map: ['maps'],
  enrich_location: ['maps'],
  map_state: ['maps'],
  map_import: ['maps'],
  globe: ['globe'],
  globe_load: ['globe'],
  create_video: ['videos'],
  annotate_video: ['videos'],
  capture_video_frame: ['videos'],
  create_audio: ['audio'],
  annotate_audio: ['audio'],
  control_playback: ['videos', 'audio'],
}

/** Whether a tool is offered by this build: it belongs to no feature, or to one that is on. */
export const toolOn = (name: string, on: (f: FeatureName) => boolean = featureOn) => {
  const features = TOOL_FEATURES[name]
  return !features || features.some(on)
}

/** The tools this build offers, of those given. */
export function toolsOn<T extends { name: string }>(tools: T[], on: (f: FeatureName) => boolean = featureOn): T[] {
  return tools.filter((t) => toolOn(t.name, on))
}
