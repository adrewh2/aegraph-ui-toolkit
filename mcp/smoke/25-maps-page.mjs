/**
 * The Maps page driven by hand, with no network: the sidebar to it, the
 * New map button and its dialog, two places added by pasting Google Maps
 * links into the page's own search box, the list and the map agreeing on
 * what is there, a reload finding it all again, and `/maps/new` (backlog
 * b28). Step 12 covers the same ground through the tools; this one is
 * the page's own controls, which is where the buttons that stop working
 * are. Needs GL=1 (Leaflet, sigma).
 * It needs no declared starting state (b35) and deliberately has none:
 * everything it counts it made itself on a map it made itself, so a
 * project another step left open and a filter left in the explorer
 * change nothing it looks at. Run under a profile dirtied with both, it
 * is 15 of 15 — which is the shape to copy, rather than the reset.
 *   GL=1 node mcp/drive.mjs mcp/smoke/25-maps-page.mjs
 * or `npm run smoke:maps-page`.
 *
 * Links with a name in them (`/place/<name>/@lat,lng,17z`) are used on
 * purpose: a bare coordinate link sends the page to reverse geocoding,
 * which is a live service and has no business in a smoke run.
 */
import { check } from './lib.mjs'

const NAME = 'Smoke map (by hand)'
/** Why /maps/new does nothing, printed with the run so the reason travels with the check. */
const B28 = 'b28 — /maps/new is matched by the /maps/:id route, so the page looks for a map whose id is "new", finds none, and shows an empty one instead of making a map'
const LINKS = [
  ['Smoke Hotel', 'https://www.google.com/maps/place/Smoke+Hotel/@48.8600,2.3400,17z'],
  ['Smoke Louvre', 'https://www.google.com/maps/place/Smoke+Louvre/@48.8606,2.3376,17z'],
]

/** What the Maps page is showing: the address, the map it is on, the list, and the pins drawn (clusters counted). */
const PAGE = `(() => {
  const clustered = [...document.querySelectorAll('.geo-cluster__count')].map((c) => Number(c.textContent) || 0).reduce((a, b) => a + b, 0)
  return {
    url: location.pathname,
    subtitle: document.querySelector('.page-subtitle')?.textContent ?? '',
    list: [...document.querySelectorAll('.geo-all__list tbody tr')].map((r) => r.textContent),
    tab: Number(document.querySelector('.geo-all__list .res__tab.is-active .count')?.textContent ?? -1),
    pins: document.querySelectorAll('.geo-pin--place').length + clustered,
    leaflet: !!document.querySelector('.leaflet-container'),
    body: document.body.innerText.trim().length,
  }
})()`

/**
 * Clicks Maps in the sidebar, whichever sidebar the profile has: unfolded it is a nested entry under Resources;
 * folded to the icon rail the nested entries live in the group's flyout, so Resources is clicked first and the
 * entry taken from there. Both are what a person does; which one they see is a setting, not a state of the page.
 */
const GO_TO_MAPS = `(() => {
  const named = (nodes, label) => [...nodes].find((n) => n.textContent.trim() === label)?.closest('button')
  const direct = named(document.querySelectorAll('.sb-item__label'), 'Maps')
  if (direct) {
    direct.click()
    return 'the entry under Resources'
  }
  const group = named(document.querySelectorAll('.sb-item__label'), 'Resources')
  if (!group) return 'no Resources in the sidebar'
  group.click()
  return 'the rail: Resources opened'
})()`
const CLICK_FLYOUT_MAPS = `(() => {
  const entry = [...document.querySelectorAll('.sb-flyout__label')].find((n) => n.textContent.trim() === 'Maps')?.closest('button')
  if (!entry) return 'no Maps in the flyout'
  entry.click()
  return 'ok'
})()`

/** Types into an input the way a person does, so React's onChange runs. */
const typeInto = (selector, text) => `(() => {
  const el = document.querySelector(${JSON.stringify(selector)})
  if (!el) return 'no ' + ${JSON.stringify(selector)}
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  setter.call(el, ${JSON.stringify(text)})
  el.dispatchEvent(new Event('input', { bubbles: true }))
  return 'ok'
})()`

const clickOne = (selector) => `(() => {
  const el = document.querySelector(${JSON.stringify(selector)})
  if (!el) return 'no ' + ${JSON.stringify(selector)}
  el.click()
  return 'ok'
})()`

/** Waits for the page to answer, rather than for a guessed number of seconds. */
const until = async ({ evaluate, sleep }, want, tries = 16) => {
  let last = null
  for (let i = 0; i < tries; i++) {
    await sleep(500)
    last = await evaluate(PAGE)
    if (want(last)) return last
  }
  return last
}

export default async ({ call, evaluate, sleep }) => {
  // Wait for the app itself, not for a guessed number of seconds: the first run of a profile has a boot screen in
  // front of the sidebar, and a click into nothing fails every check after it for a reason that is not the page's.
  let up = false
  for (let i = 0; i < 24 && !up; i++) {
    await sleep(500)
    up = await evaluate(`document.querySelectorAll('.sb-item').length > 0`)
  }
  check('the app is up, with the sidebar on it', up)

  // To the page the way it is reached.
  const how = await evaluate(GO_TO_MAPS)
  if (how.startsWith('the rail')) {
    await sleep(400)
    const clicked = await evaluate(CLICK_FLYOUT_MAPS)
    check('the sidebar reaches Maps', clicked === 'ok', `${how}, then ${clicked}`)
  } else {
    check('the sidebar reaches Maps', how === 'the entry under Resources', how)
  }
  let p = await until({ evaluate, sleep }, (s) => s.url === '/maps' && s.leaflet)
  check('the Maps page opens with a map on it', p.url === '/maps' && p.leaflet, JSON.stringify({ url: p.url, leaflet: p.leaflet }))

  // New map: the primary button in the page head, then the dialog's name field and Create.
  check('New map opens the dialog', (await evaluate(clickOne('.res__head-actions .btn--primary'))) === 'ok')
  await sleep(600)
  check('the dialog asks for a name', (await evaluate(typeInto('.dialog .field .input', NAME))) === 'ok')
  await sleep(200)
  check('Create makes the map', (await evaluate(clickOne('.dialog .btn--primary'))) === 'ok')
  p = await until({ evaluate, sleep }, (s) => /^\/maps\/.+/.test(s.url) && s.url !== '/maps/new')
  const mapUrl = p.url
  check('the page goes to the new map and says whose it is', /^\/maps\/[^/]+$/.test(mapUrl) && p.subtitle.includes(NAME), JSON.stringify({ url: mapUrl, subtitle: p.subtitle }))
  const mapId = mapUrl.split('/')[2]

  // Two places, pasted as Google Maps links into the page's own search box.
  for (const [label, link] of LINKS) {
    check(`the search box takes the link for ${label}`, (await evaluate(typeInto('.geo__search-box input', link))) === 'ok')
    await sleep(500)
    check(`and offers to add ${label}`, (await evaluate(clickOne('.geo__result'))) === 'ok')
    await sleep(900)
  }
  p = await until({ evaluate, sleep }, (s) => s.list.length >= LINKS.length && s.pins >= LINKS.length)
  check('both places are on the map and in the list, and the two agree', p.list.length === 2 && p.pins === 2 && p.tab === 2 && LINKS.every(([label]) => p.list.some((row) => row.includes(label))), JSON.stringify({ rows: p.list.length, tab: p.tab, pins: p.pins }))

  // Saved and reopened: a reload is the honest test that the page wrote what it drew.
  await evaluate(`location.reload(); 1`)
  // Both the rows and the pins, not just the rows: the map draws a beat after the table has its rows, and asking
  // only for the rows reads the moment in between as a map that lost its pins.
  p = await until({ evaluate, sleep }, (s) => s.url === mapUrl && s.list.length >= 2 && s.pins >= 2)
  check('a reload finds the map and both places again', p.url === mapUrl && p.subtitle.includes(NAME) && p.list.length === 2 && p.pins === 2, JSON.stringify({ url: p.url, subtitle: p.subtitle, rows: p.list.length, pins: p.pins }))

  // Tidy before the dead address, not after it: a delete asks the tab to confirm, and `/maps/new` has no page to
  // ask on — the call times out there and the run quietly leaves its map behind (which is how this was found).
  // And wait for the bridge first: the reload above took the tab's websocket with it, and until the tab announces
  // its tools again every call is answered with "Unknown tool" by the server alone.
  for (let i = 0; i < 40; i++) {
    if ((await call('aegraph_bridge_status')).tools?.length) break
    await sleep(500)
  }
  const held = (await call('map_state', { map_id: mapId })).features.map((f) => f.id)
  const gone = await call('delete_entities', { ids: [...held, mapId] })
  check('the run takes its map and both places away with it', gone.deleted === held.length + 1, `${gone.deleted} deleted of ${held.length + 1}`)

  // `/maps/new` is the address every other page uses for "make one".
  await evaluate(`location.assign('/maps/new'); 1`)
  const n = await until({ evaluate, sleep }, (s) => s.url !== '/maps/new' || s.body > 200)
  // Recorded as it is, not as it should be: the run fails when someone fixes it, which is how the row and b28 go.
  // Dead in full: the address stands, the page is there, and it draws no map, names no map and lists nothing.
  const dead = n.url === '/maps/new' && n.body > 200 && !n.leaflet && !n.subtitle && n.list.length === 0
  check('/maps/new is still the dead address b28 records', dead, dead ? '' : `it does something now — ${JSON.stringify({ url: n.url, map: n.leaflet, subtitle: n.subtitle, rows: n.list.length })}: close b28 and make this a real check`)
  console.log(`     ${B28}`)
}
