/**
 * The GPU explorer, driven as a person opens it: `/unigraph` lands on a
 * session, the engine draws real frames of the explorer's own slice, the
 * page registers both handles (the GPU engine's and the shared
 * explorer's), and the 3D tab is the same session on the other renderer
 * rather than a new one. Software WebGL is enough for all of it, which
 * is the point — the page must not need a real GPU to open.
 * Starts from the Library with a fresh view: the explorer reads back the
 * filter it was left with, and a narrow one from another step empties the
 * picture, which reads here as an engine that draws nothing (b35).
 *   GL=1 node mcp/drive.mjs mcp/smoke/15-unigraph.mjs
 * or `npm run smoke:unigraph`.
 */
import { check, startFrom } from './lib.mjs'

/** What the page has mounted: the two handle registries, the canvases, and the engine's own frame counter. */
const PAGE = `(() => {
  const gpu = (window.__aegraphGpuGraphs?.handles ?? []).at(-1)
  const explorer = (window.__aegraphExplorers?.handles ?? []).at(-1)
  const canvas = [...document.querySelectorAll('canvas')].map((c) => c.className || '(none)')
  const stats = gpu?.engine?.stats ?? null
  return {
    route: location.pathname,
    gpu: !!gpu,
    source: gpu?.getSource?.() ?? null,
    explorer: !!explorer,
    dims: explorer?.dims ?? null,
    sliceNodes: explorer?.getSlice?.().nodes.length ?? null,
    canvas,
    frames: stats?.frames ?? null,
    drawCalls: stats?.drawCalls ?? null,
    nodesInView: stats?.nodesInView ?? null,
    gated: !!document.querySelector('.lg-gate'),
    errors: (window.__aegraphErrors ?? []).length,
  }
})()`

export default async ({ call, evaluate, sleep, logs }) => {
  await startFrom({ call, evaluate, sleep }, 'fresh')
  await evaluate(`location.assign('/unigraph'); 1`)
  await sleep(12000)
  const two = await evaluate(PAGE)
  check('/unigraph opens a 2D session', two.route === '/unigraph/2d' && two.dims === 2, JSON.stringify({ route: two.route, dims: two.dims }))
  check('the page registers the engine and the explorer it shares', two.gpu && two.explorer && two.source === 'explorer', JSON.stringify({ gpu: two.gpu, explorer: two.explorer, source: two.source }))
  check('it has a GL canvas and a labels canvas', two.canvas.includes('gg-gl') && two.canvas.includes('gg-labels'), two.canvas.join(', '))
  check('the engine has drawn frames, not just mounted', two.frames > 0 && two.drawCalls > 0, `${two.frames} frames, ${two.drawCalls} draw calls`)
  check('what it draws is the explorer slice, and none of it is invented', two.nodesInView > 0 && two.nodesInView <= two.sliceNodes, `${two.nodesInView} of ${two.sliceNodes} in view`)
  check('nothing is gated away on a graph this size', !two.gated)

  await evaluate(`location.assign('/unigraph/3d'); 1`)
  await sleep(9000)
  const three = await evaluate(PAGE)
  check('the 3D tab is the same session on the other renderer', three.route === '/unigraph/3d' && three.dims === 3 && three.sliceNodes === two.sliceNodes, JSON.stringify({ route: three.route, dims: three.dims, nodes: three.sliceNodes }))
  check('and it draws too', three.frames > 0 && three.drawCalls > 0 && three.nodesInView > 0, `${three.frames} frames, ${three.nodesInView} in view`)
  check('neither renderer logged an error', three.errors === 0 && logs.length === 0, `${three.errors} page errors, ${logs.length} console`)
}
