import { useEffect, useState } from 'react'

/** How long a guarded confirmation's yes stays disabled after it appears or changes. */
export const ARM_DELAY_MS = 500

/**
 * Whether a guarded question's yes may be pressed: not for `ARM_DELAY_MS` after it opens or its `content` changes (a
 * new question in the same dialog), then yes. Always yes when not guarded. A question that appears under a keystroke
 * or a click meant for something else — a tool asked it, not the user — must not be answered by that keystroke.
 */
export function useArmed(open: boolean, guarded: boolean, content: unknown): boolean {
  const [seen, setSeen] = useState({ open, content })
  const [armed, setArmed] = useState(false)
  // A new question (or the dialog opening again) disarms at once, in the same render — not one frame later.
  if (seen.open !== open || seen.content !== content) {
    setSeen({ open, content })
    setArmed(false)
  }
  useEffect(() => {
    if (!guarded || !open) return
    const t = setTimeout(() => setArmed(true), ARM_DELAY_MS)
    return () => clearTimeout(t)
  }, [open, guarded, content])
  return !guarded || armed
}
