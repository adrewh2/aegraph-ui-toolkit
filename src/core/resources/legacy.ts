import type { AnyEntity } from '../entity/types'

/**
 * What the boot upgrades (`migrate.ts`) go by, besides a type's name: when an entity was made. Every build that wrote
 * the old types (`music`, `place`, `display`, the map → place `shows`) shipped before this date, so an entity made on
 * or after it is not the old app's, whatever its type is called.
 */
export const LEGACY_BEFORE = '2026-09-16'

/** Made by a build before the upgrades: its creation date says so. No date, no claim. */
export const madeBeforeUpgrades = (e: AnyEntity): boolean => typeof e.meta?.createdAt === 'string' && e.meta.createdAt < LEGACY_BEFORE
