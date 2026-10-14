/**
 * A tool as a saved session or scene names it. Before the box tool, `select` was the only other tool and a drag on
 * empty space moved the camera — the hand's behaviour now — so an old `select` (and anything unknown) is the hand.
 */
export const explorerTool = (v: unknown): 'pan' | 'box' | 'path' => (v === 'path' || v === 'box' ? v : 'pan')
