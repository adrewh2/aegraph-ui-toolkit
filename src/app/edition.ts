import edition from './edition.json'

/**
 * Which edition of the app this is, and where its code lives — read by the Claude Code dialog (the one command that
 * clones, installs and runs it), the sidebar (a link to the repository, where it is public), the boot (the project a
 * first visit opens, `app/providers.tsx`) and the bridge (`mcp/server.mjs`: the one hosted site it trusts by default is
 * `site`). The values are in `edition.json` beside this file, the one file an edition changes: aegraph-ui is the source
 * of truth, and its public edition, aegraph-ui-toolkit, is cut from it on a branch whose only edition difference is that
 * file (docs/releasing-toolkit.md in aegraph-ui).
 */
export interface Edition {
  /** The repository's name: the folder a clone makes. */
  readonly name: string
  /** The repository, on GitHub. */
  readonly repo: string
  /** Where this edition is deployed — and the one hosted origin the Claude Code bridge trusts unless told otherwise. */
  readonly site: string
  /** The repository is private: a clone needs access to it. */
  readonly privateRepo: boolean
  /** A link to the repository at the foot of the sidebar (for an edition whose code anyone can read). */
  readonly repoLinkInSidebar: boolean
  /**
   * The project the app opens by default: a demo built into the deployment (scripts/demos/fetch.mjs), by its id in the
   * demos catalog and the title the boot shows while it opens. Opened once per `key`, on a first run and on existing
   * installs alike — bump the key to push a new default. A build without demos opens nothing.
   */
  readonly defaultDemo: {
    readonly id: string
    readonly title: string
    readonly key: string
    /**
     * The one tab the first run opens it on (`firstRunWorkstation`); null, its whole graph in 3D, live. A demo that
     * ships a scene for its first picture — settled positions, its own force settings — names the scene's address
     * here, so the first frame is the finished picture rather than a cloud pulling into shape.
     */
    readonly tab: { readonly path: string; readonly title: string } | null
  }
}

export const EDITION: Edition = edition

/** The one command that puts this edition on a machine with Claude Code connected: clone, install, and `then`. */
export function localSetupCommand(then: 'claude' | 'npm run dev'): string {
  return `git clone ${EDITION.repo}.git && cd ${EDITION.name} && npm install && ${then}`
}
