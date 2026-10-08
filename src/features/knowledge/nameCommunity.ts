import type { EntityId } from '../../core/entity/types'

/** A request to name a community, raised anywhere and answered by the one NameCommunityDialog mounted with the app. */
export interface NameCommunityRequest {
  /** The community's number in the metrics run. */
  community: number
  /** The run the number belongs to (a metrics slice key or a report key). */
  metricsKey: string
  members: EntityId[]
  /** The analysis's own name for it, offered as the default. */
  suggested?: string
  /** What it is made of, in words — shown under the name so the user can tell what they are naming. */
  profile?: string
}

export const NAME_COMMUNITY_EVENT = 'aegraph:name-community'

export function requestNameCommunity(req: NameCommunityRequest) {
  window.dispatchEvent(new CustomEvent<NameCommunityRequest>(NAME_COMMUNITY_EVENT, { detail: req }))
}

/**
 * The name to offer. An analysis names a community in a sentence of its own
 * and often quotes it ("Systems and infrastructure"); the quotes are the
 * analysis's punctuation, not part of the name, so they come off — as does
 * a trailing full stop and the whitespace around it all.
 */
export function suggestedName(suggested: string | undefined): string {
  const s = (suggested ?? '').trim()
  const unquoted = /^["“'‘](.*)["”'’]$/s.exec(s)?.[1] ?? s
  return unquoted.trim().replace(/\.$/, '').trim()
}

/**
 * Who is in it, in the words the user knows them by: the first few names and
 * how many more there are. An id that names nothing (a member removed since
 * the run) is shown as itself rather than skipped — that it is still counted
 * is the honest thing, and the line explains a count that looks too high.
 */
export function memberSample(members: readonly EntityId[], nameOf: (id: EntityId) => string | undefined, max = 6): { names: string[]; more: number } {
  const names = members.slice(0, max).map((id) => nameOf(id) || id)
  return { names, more: Math.max(0, members.length - names.length) }
}

/** That line, written out: what it is made of, then who is in it. */
export function describeMembers(sample: { names: string[]; more: number }, profile?: string): string {
  const who = [sample.names.join(', '), sample.more ? `… and ${sample.more.toLocaleString('en-US')} more` : ''].filter(Boolean).join(' ')
  return [profile, who].filter(Boolean).join(' · ')
}
