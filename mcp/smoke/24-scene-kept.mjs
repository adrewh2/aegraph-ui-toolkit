/**
 * The Unigraph picture survives being left and come back to. Two things
 * used to throw it away on the way in, and this run watches for both
 * across a round trip through the sidebar.
 *   The tab: the sidebar links to the bare `/unigraph`, and the host sent
 * its open tab there — off `/unigraph/2d?session=…`, the part naming the
 * view and the session — so the explorer was torn down and a new one
 * built a moment later, when the address corrected itself.
 *   The canvas: a page behind the one in front stays mounted but hidden,
 * and a hidden element measures nothing, which the engine took for a size
 * of one pixel — the buffers shrank to a pixel and the drawn picture went
 * with them.
 * Starts from the Library with a fresh view: it needs a picture to
 * watch, and the explorer draws whatever its remembered filter allows —
 * a narrow one from another step leaves nothing on the canvas and this
 * reads as an engine with no nodes. Chosen after 'library' was tried and
 * failed exactly that way under a profile dirtied on purpose (b35).
 *   GL=1 node mcp/drive.mjs mcp/smoke/24-scene-kept.mjs
 * or `npm run smoke:scene-kept`.
 */
import { check, startFrom } from './lib.mjs'

/** The engine and its own canvases as they stand: the buffer sizes are what a lost picture shows up in. */
const SHOT = `(() => {
  const gpu = (window.__aegraphGpuGraphs?.handles ?? []).at(-1)
  const e = gpu?.engine
  return {
    route: location.pathname + location.search,
    handles: (window.__aegraphGpuGraphs?.handles ?? []).length,
    nodes: e?.graph?.nodeCount ?? -1,
    buffers: (e?.canvases ?? []).map((c) => c.width),
    cameraW: e?.camera?.width ?? -1,
    frames: e?.stats?.frames ?? -1,
    errors: (window.__aegraphErrors ?? []).length,
  }
})()`

/** Samples the same shot every 50ms while the page is switched away and back, so the moment in between is seen. */
const WATCH = `(() => {
  window.__kept = []
  const tick = () => {
    window.__kept.push(${SHOT})
    if (window.__kept.length < 240) setTimeout(tick, 50)
  }
  tick()
  return 1
})()`

/** Clicks a sidebar item by its name — the affordance a person uses; an unknown name is reported, not silently skipped. */
const clickNav = (label) => `(() => {
  const item = [...document.querySelectorAll('.sb-item')].find((b) => b.querySelector('.sb-item__label')?.textContent.trim() === ${JSON.stringify(label)})
  if (!item) return 'no sidebar item called ${label}'
  item.click()
  return 'ok'
})()`

export default async ({ call, evaluate, sleep, logs }) => {
  await startFrom({ call, evaluate, sleep }, 'fresh')
  await evaluate(`location.assign('/unigraph/2d'); 1`)
  // Wait for the canvases to stop changing size, not merely for the engine to have drawn. A canvas begins at the
  // browser's default 300x150 and is sized by the observer a frame or two later, and the two do not always land
  // in the same frame; watching from before that reads the sizing itself as the picture being thrown away, and
  // reports 300px against 624px as if a page behind had done it.
  let before = null
  let steady = 0
  for (let i = 0; i < 20; i++) {
    await sleep(1000)
    const now = await evaluate(SHOT)
    const drawing = now.frames > 0 && now.nodes > 0 && now.buffers.length > 0 && now.buffers.every((w) => w > 300)
    steady = drawing && before && now.buffers.join() === before.buffers.join() ? steady + 1 : 0
    before = now
    if (steady >= 2) break
  }
  check('Unigraph draws a picture to begin with, at a size that has settled', before.nodes > 0 && before.frames > 0 && before.buffers.every((w) => w > 300) && steady >= 2, JSON.stringify({ nodes: before.nodes, frames: before.frames, buffers: before.buffers, steadyReadings: steady }))

  await evaluate(WATCH)
  await sleep(300)
  check('the sidebar takes us to Entities', (await evaluate(clickNav('Entities'))) === 'ok')
  await sleep(3000)
  check('the sidebar brings us back to Unigraph', (await evaluate(clickNav('Unigraph'))) === 'ok')
  await sleep(5000)

  const seen = await evaluate(`window.__kept`)
  const after = await evaluate(SHOT)
  // The size each canvas is drawn at, taken from both ends of the trip: a sample under it is the picture being
  // thrown away, whichever end the settled reading came from.
  const full = before.buffers.map((w, i) => Math.max(w, after.buffers[i] ?? 0))
  const sized = seen.filter((s) => s.buffers.length === full.length)
  const shrunk = sized.filter((s) => s.buffers.some((w, i) => w < full[i]))
  const camera = Math.max(before.cameraW, after.cameraW)
  const smallCamera = seen.filter((s) => s.cameraW > 0 && s.cameraW < camera)
  check('the canvases are never resized away while the page is behind', shrunk.length === 0, shrunk.length ? `${shrunk.length} of ${sized.length} samples, smallest ${Math.min(...shrunk.flatMap((s) => s.buffers))}px against ${full.join('/')}px` : '')
  check('and the camera never takes the hidden page’s size', smallCamera.length === 0, smallCamera.length ? `${smallCamera.length} samples down to ${Math.min(...smallCamera.map((s) => s.cameraW))}px against ${camera}px` : '')
  check('the engine is the same one, with the same picture in it', after.handles === before.handles && after.nodes === before.nodes, JSON.stringify({ handles: [before.handles, after.handles], nodes: [before.nodes, after.nodes] }))
  // The address the tab was on, session and all: the sidebar's bare `/unigraph` is "back to where I was", so the
  // same session comes back rather than a new one being minted for a tab sent to the bare address.
  check('the tab comes back to the session it was on', after.route === before.route, `${before.route} → ${after.route}`)
  // Nothing without a canvas: a torn-down explorer shows as a moment with no engine at all.
  const gone = seen.filter((s) => !s.buffers.length)
  check('and the explorer is never torn down on the way in', gone.length === 0, gone.length ? `${gone.length} of ${seen.length} samples had no canvas at all` : '')
  // A fresh engine counts its frames from zero: the count only ever climbs while the same one is drawing.
  const restarted = seen.filter((s, i) => i > 0 && s.frames >= 0 && seen[i - 1].frames > s.frames)
  check('the engine is not rebuilt behind the picture', restarted.length === 0, restarted.length ? `frame count fell ${restarted.length} time(s), to ${restarted.map((s) => s.frames).join(', ')}` : '')
  check('it is drawing again on the way back in', after.frames > before.frames, `${after.route}, ${before.frames} → ${after.frames} frames`)
  check('and the round trip logged nothing', after.errors === 0 && logs.length === 0, `${after.errors} page errors, ${logs.length} console — ${String(logs[0] ?? '').slice(0, 80)}`)
}
