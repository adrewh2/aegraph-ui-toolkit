import { createHash, timingSafeEqual } from 'node:crypto'

/** Whether a connection's token is the bridge's, compared in constant time: both sides are hashed first, so the lengths match and neither length leaks. */
const digest = (s) => createHash('sha256').update(String(s)).digest()
export const tokenMatches = (given, expected) => typeof given === 'string' && timingSafeEqual(digest(given), digest(expected))
