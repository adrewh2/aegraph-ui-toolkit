/**
 * Where a sandbox's bootstrap is served from.
 *
 * Both script sandboxes load their bootstrap with `<script src>` rather than
 * writing it inline, because a frame inherits the app's
 * Content-Security-Policy and cannot widen it: an inline bootstrap stops
 * running the moment a `script-src` is enforced. So the two files live in
 * `public/sandbox/` and are served verbatim at a fixed path — `?url` on a
 * `.js` file under `src/` does not emit an asset, and the build simply
 * dropped them.
 *
 * A fixed path can be cached, and a cached bootstrap talking to a newer
 * engine would fail in a way nobody could read, so the URL carries the
 * protocol's version. **Bump it in the same commit as any change to the
 * messages an engine and its bootstrap exchange.**
 */
export const SANDBOX_PROTOCOL = 2

/** The absolute URL of a bootstrap under `public/sandbox/`, for a frame that has no base URL of its own. */
export const sandboxBootUrl = (path: string, origin: string): string => `${origin}${path}?v=${SANDBOX_PROTOCOL}`
