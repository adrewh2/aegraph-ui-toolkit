/**
 * Whether a string from data is a colour and nothing else. A tag's colour, a
 * node's override, a pin's fill all arrive from bundles, imports and tool
 * calls, and some reach markup or a `style` — so `red"><img onerror=…>` or
 * `red;background:url(https://…)` must be refused here, not escaped later.
 * A hex, `rgb()`/`rgba()`/`hsl()`/`hsla()` over numbers, or a bare name.
 */
const COLOR = /^(#[0-9a-f]{3,4}|#[0-9a-f]{6}|#[0-9a-f]{8}|(rgba?|hsla?)\([0-9.,%\s/+-]*(deg|turn|rad)?[0-9.,%\s/+-]*\)|[a-z]{3,20})$/i

export const isCssColor = (v: unknown): v is string => typeof v === 'string' && v.length <= 64 && COLOR.test(v.trim())

/** The colour, trimmed, when it is one; otherwise the fallback. */
export const cssColor = (v: unknown, fallback: string): string => (isCssColor(v) ? v.trim() : fallback)
