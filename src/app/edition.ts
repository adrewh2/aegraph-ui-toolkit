/**
 * Which edition of the app this is, and where its code lives — read by the Claude Code dialog (the one command that
 * clones, installs and runs it) and the sidebar (a link to the repository, where it is public). aegraph-ui is the
 * source of truth; its public edition, aegraph-ui-toolkit, is cut from it on a branch that overrides this file.
 */
export const EDITION = {
  /** The repository's name: the folder a clone makes. */
  name: 'aegraph-ui-toolkit',
  /** The repository, on GitHub. */
  repo: 'https://github.com/adrewh2/aegraph-ui-toolkit',
  /** Where this edition is deployed. */
  site: 'https://aegraph.sh',
  /** The repository is private: a clone needs access to it. */
  privateRepo: false,
  /** A link to the repository at the foot of the sidebar (for an edition whose code anyone can read). */
  repoLinkInSidebar: true,
} as const

/** The one command that puts this edition on a machine with Claude Code connected: clone, install, and `then`. */
export function localSetupCommand(then: 'claude' | 'npm run dev'): string {
  return `git clone ${EDITION.repo}.git && cd ${EDITION.name} && npm install && ${then}`
}
