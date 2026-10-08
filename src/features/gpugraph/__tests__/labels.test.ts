import { describe, expect, it } from 'vitest'
import { COOLDOWN_MS, HOLD_MS, LabelLayer, type LabelSource } from '../engine/labels'
import { N_LABEL } from '../engine/types'

/**
 * Label inertia: a label that is showing keeps its cell for the hold even
 * when a bigger hub moves into it; one that has just gone waits out the
 * cooldown before it may return; leaving the view ends it at once.
 */

const fakeCanvas = () => {
  const drawn: string[] = []
  const ctx = {
    setTransform() {},
    clearRect() {},
    measureText: (t: string) => ({ width: t.length * 7 }),
    strokeText() {},
    fillText(t: string) {
      drawn.push(t)
    },
  }
  return { canvas: { width: 800, height: 600, getContext: () => ctx } as unknown as HTMLCanvasElement, drawn }
}

/** Two nodes whose labels want the same cell; `candidates` lists the hub first. */
function source(x: number[], y: number[], degreeOrder: number[]): LabelSource & { flags: Uint32Array } {
  const flags = new Uint32Array(x.length).fill(N_LABEL)
  return {
    flags,
    labels: x.map((_, i) => `node ${i}`),
    labelFallback: null,
    nodeFlags: flags,
    project: (i, out) => {
      out.x = x[i]
      out.y = y[i]
      return true
    },
    width: 800,
    height: 600,
    candidates: (out) => {
      out.set(degreeOrder)
      return degreeOrder.length
    },
    radiusPx: () => 3,
  }
}

describe('label inertia', () => {
  it('a showing label keeps its cell for the hold, then yields to the hub; the loser waits out the cooldown', () => {
    const { canvas, drawn } = fakeCanvas()
    const layer = new LabelLayer(canvas)
    const none = new Uint32Array(0)
    // Node 1 (the smaller) shows alone at t=0; node 0 (the hub) arrives in the same cell at t=100.
    const far = source([100, 100], [100, 500], [0, 1])
    layer.draw(far, 1, 'some', none, 0, 300, 0)
    expect(drawn).toEqual(['node 0', 'node 1'])
    drawn.length = 0
    const same = source([100, 100], [100, 100], [0, 1])
    // The hub goes out of view: node 1 shows alone and is the incumbent from t=50.
    const only1 = source([-500, 100], [100, 100], [0, 1])
    layer.draw(only1, 1, 'some', none, 0, 300, 50)
    expect(drawn).toEqual(['node 1'])
    drawn.length = 0
    // Within the hold the incumbent keeps the cell even though the hub is the better candidate.
    layer.draw(same, 1, 'some', none, 0, 300, 100)
    expect(drawn).toEqual(['node 1'])
    drawn.length = 0
    // Past the hold the hub wins the cell; node 1 goes.
    layer.draw(same, 1, 'some', none, 0, 300, 50 + HOLD_MS + 1)
    expect(drawn).toEqual(['node 0'])
    drawn.length = 0
    // The hub leaves; node 1 may not come straight back — not within the cooldown, then yes.
    layer.draw(only1, 1, 'some', none, 0, 300, 50 + HOLD_MS + 100)
    expect(drawn).toEqual([])
    drawn.length = 0
    layer.draw(only1, 1, 'some', none, 0, 300, 50 + HOLD_MS + 1 + COOLDOWN_MS + 1)
    expect(drawn).toEqual(['node 1'])
  })
  it('leaving the view ends a label at once, and the focus always draws', () => {
    const { canvas, drawn } = fakeCanvas()
    const layer = new LabelLayer(canvas)
    const src = source([100], [100], [0])
    layer.draw(src, 1, 'some', new Uint32Array(0), 0, 300, 0)
    expect(drawn).toEqual(['node 0'])
    drawn.length = 0
    const gone = source([-5000], [100], [0])
    layer.draw(gone, 1, 'some', new Uint32Array(0), 0, 300, 10)
    expect(drawn).toEqual([])
    // Focus labels ignore the hold and the cooldown.
    layer.draw(src, 1, 'focus', new Uint32Array([0]), 1, 300, 20)
    expect(drawn).toEqual(['node 0'])
  })
})
