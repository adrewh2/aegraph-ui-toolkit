// Constellations — the graph as columns of time.
//
// The most connected entities (services, datastores, teams…) stand in a
// ring. Everything that happened to them — incidents, deploys, alerts,
// snapshots — orbits its column at a height given by when it happened:
// the floor is the earliest event, the top the latest. A luminous plane
// sweeps upward through time; events light up as it passes and dim again
// above it, so you watch the history play. Dependency ties between the
// pillars arc overhead.
//
// Drag to orbit · scroll to zoom · hover for details · space pauses the sweep · R resets
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js'

// ── Which entities are pillars, which are events ─────────────────────
const HUBS = 24
const MAX_EVENTS = 6000
const timeOf = (e) => {
  const d = e.data
  for (const k of ['startedAt', 'deployedAt', 'firedAt', 'startsAt', 'weekEndsAt', 'monthStartsAt', 'completedAt']) if (d[k]) return ms(d[k])
  return ms(e.createdAt)
}
const byDegree = sortBy(ds.entities, (e) => ds.degree(e.id), true)
const hubs = byDegree.slice(0, HUBS)
const hubSet = new Set(hubs.map((h) => h.id))
// Events are the pillars' neighbours that belong to populous types (structure like teams and zones stays out).
const typeCount = new Map([...groupBy(ds.entities, 'type')].map(([t, list]) => [t, list.length]))
const events = []
for (const h of hubs) for (const n of ds.neighbors(h.id)) {
  if (hubSet.has(n.id) || (typeCount.get(n.type) ?? 0) < 10) continue
  const t = timeOf(n)
  if (Number.isFinite(t)) events.push({ e: n, hub: h.id, t })
}
events.sort((a, b) => a.t - b.t)
const step = Math.max(1, Math.ceil(events.length / MAX_EVENTS))
const shown = events.filter((_, i) => i % step === 0)
// The floor is the 1st percentile so a few old stragglers don't stretch the scale; the top is the latest.
const t0 = shown[Math.floor(shown.length * 0.01)]?.t ?? 0
const t1 = shown[shown.length - 1]?.t ?? 1
const H = 360
const yOf = (t) => Math.max(0, (t - t0) / Math.max(1, t1 - t0)) * H
console.log(hubs.length, 'pillars,', shown.length, 'events from', isoDate(t0), 'to', isoDate(t1))

// ── Scene ────────────────────────────────────────────────────────────
const scene = new THREE.Scene()
scene.background = new THREE.Color('#07090f')
scene.fog = new THREE.FogExp2('#07090f', 0.0009)
const camera = new THREE.PerspectiveCamera(55, aegraph.width() / aegraph.height(), 1, 6000)
camera.position.set(0, 320, 760)
const renderer = new THREE.WebGLRenderer({ antialias: true })
renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
renderer.setSize(aegraph.width(), aegraph.height())
document.getElementById('app').appendChild(renderer.domElement)
const controls = new OrbitControls(camera, renderer.domElement)
controls.enableDamping = true
controls.target.set(0, H / 2, 0)
// The viewpoint survives runs and reloads.
const cam = aegraph.recall('camera'); if (cam) { camera.position.fromArray(cam.p); controls.target.fromArray(cam.t) }
controls.addEventListener('end', () => aegraph.remember('camera', { p: camera.position.toArray(), t: controls.target.toArray() }))
controls.autoRotate = true
controls.autoRotateSpeed = 0.35
const composer = new EffectComposer(renderer)
composer.addPass(new RenderPass(scene, camera))
const bloom = new UnrealBloomPass(new THREE.Vector2(aegraph.width(), aegraph.height()), 0.55, 0.5, 0.4)
composer.addPass(bloom)

// Colours: one hue per entity type; severity overrides when an event carries one.
const types = ds.types()
const hue = (type) => types.indexOf(type) / Math.max(1, types.length)
const typeColor = (type) => new THREE.Color().setHSL(hue(type), 0.65, 0.6)
const SEVERITY = { S1: '#ff3b5c', S2: '#ff9f43', S3: '#ffd166', S4: '#8892a6' }
const colorOf = (e) => (e.data.severity && SEVERITY[e.data.severity] ? new THREE.Color(SEVERITY[e.data.severity]) : typeColor(e.type))

// Pillars on a ring, labelled.
const R = 300
const hubPos = new Map()
const hubMeshes = []
const label = (text, color) => {
  const c = document.createElement('canvas')
  c.width = 512
  c.height = 96
  const g = c.getContext('2d')
  g.font = '600 40px -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif'
  g.fillStyle = color
  g.textAlign = 'center'
  g.fillText(text.length > 26 ? text.slice(0, 25) + '…' : text, 256, 62)
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), transparent: true, depthWrite: false }))
  s.scale.set(96, 18, 1)
  return s
}
hubs.forEach((h, i) => {
  const a = (i / hubs.length) * Math.PI * 2
  const p = new THREE.Vector3(R * Math.cos(a), 0, R * Math.sin(a))
  hubPos.set(h.id, p)
  const c = typeColor(h.type)
  const m = new THREE.Mesh(new THREE.SphereGeometry(7 + Math.log2(1 + ds.degree(h.id)), 24, 24), new THREE.MeshStandardMaterial({ color: c, emissive: c, emissiveIntensity: 0.25, roughness: 0.4 }))
  m.position.copy(p)
  m.userData = { entity: h, hub: true }
  scene.add(m)
  hubMeshes.push(m)
  const column = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 0.6, H, 6), new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: 0.12 }))
  column.position.set(p.x, H / 2, p.z)
  scene.add(column)
  const l = label(h.label, '#' + c.getHexString())
  l.position.set(p.x * 1.08, 26, p.z * 1.08)
  scene.add(l)
})

// Ties between pillars arc overhead.
const arcs = []
for (const r of ds.relationships) {
  const a = hubPos.get(r.source)
  const b = hubPos.get(r.target)
  if (!a || !b || a === b) continue
  const mid = a.clone().add(b).multiplyScalar(0.5)
  mid.y = H + 40 + a.distanceTo(b) * 0.25
  arcs.push(new THREE.QuadraticBezierCurve3(a.clone().setY(H), mid, b.clone().setY(H)).getPoints(24))
}
if (arcs.length) {
  const pts = []
  for (const line of arcs) for (let i = 1; i < line.length; i++) pts.push(line[i - 1], line[i])
  scene.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: '#7aa2ff', transparent: true, opacity: 0.35 })))
}

// Events: one instanced mesh, a helix around each pillar.
const inst = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 8, 8), new THREE.MeshStandardMaterial({ roughness: 0.5, emissive: '#ffffff', emissiveIntensity: 0 }), shown.length)
const lit = new Float32Array(shown.length * 3)
const dim = new Float32Array(shown.length * 3)
const tmp = new THREE.Object3D()
const perHub = new Map()
shown.forEach((ev, i) => {
  const p = hubPos.get(ev.hub)
  const k = (perHub.get(ev.hub) ?? 0) + 1
  perHub.set(ev.hub, k)
  const ang = k * 2.39996
  const rad = 10 + 14 * Math.abs(Math.sin(k * 0.7))
  tmp.position.set(p.x + rad * Math.cos(ang), yOf(ev.t), p.z + rad * Math.sin(ang))
  const size = ev.e.data.customers_affected ? 1.2 + Math.log10(1 + ev.e.data.customers_affected) * 0.9 : 1 + Math.min(3, Math.sqrt(ds.degree(ev.e.id)) * 0.3)
  tmp.scale.setScalar(size)
  tmp.updateMatrix()
  inst.setMatrixAt(i, tmp.matrix)
  const c = colorOf(ev.e)
  lit.set([c.r, c.g, c.b], i * 3)
  dim.set([c.r * 0.12, c.g * 0.12, c.b * 0.12], i * 3)
  inst.setColorAt(i, new THREE.Color(c.r * 0.12, c.g * 0.12, c.b * 0.12))
})
inst.instanceMatrix.needsUpdate = true
if (inst.instanceColor) inst.instanceColor.needsUpdate = true
scene.add(inst)

// The sweep: a glowing disc rising through time.
const sweep = new THREE.Mesh(new THREE.RingGeometry(R - 60, R + 60, 96), new THREE.MeshBasicMaterial({ color: '#9ec5ff', transparent: true, opacity: 0.18, side: THREE.DoubleSide, depthWrite: false }))
sweep.rotation.x = -Math.PI / 2
scene.add(sweep)
const floor = new THREE.Mesh(new THREE.RingGeometry(R - 70, R + 70, 128), new THREE.MeshBasicMaterial({ color: '#1b2233', side: THREE.DoubleSide, transparent: true, opacity: 0.7 }))
floor.rotation.x = -Math.PI / 2
floor.position.y = -1
scene.add(floor)
scene.add(new THREE.AmbientLight('#ffffff', 0.35))
const key = new THREE.PointLight('#ffffff', 2.5, 0, 0)
key.position.set(200, 500, 300)
scene.add(key)

// HUD: the date under the sweep, and a hover card.
const hud = document.createElement('div')
hud.style.cssText = 'position:absolute;left:16px;top:12px;color:#cfd8ea;font:13px -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;pointer-events:none;text-shadow:0 1px 2px #000'
hud.innerHTML = '<div style="font-size:22px;font-weight:600" id="date"></div><div style="opacity:.7">' + hubs.length + ' pillars · ' + shown.length.toLocaleString() + ' events · drag to orbit · scroll to zoom · space pauses · R resets</div>'
document.getElementById('app').appendChild(hud)
const card = document.createElement('div')
card.style.cssText = 'position:absolute;display:none;max-width:320px;padding:8px 10px;border-radius:8px;background:rgba(10,13,22,.92);color:#e8eefc;font:12.5px -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;pointer-events:none;border:1px solid rgba(160,180,220,.25)'
document.getElementById('app').appendChild(card)

// ── Interaction ──────────────────────────────────────────────────────
const ray = new THREE.Raycaster()
const mouse = new THREE.Vector2(-2, -2)
let hover = null
renderer.domElement.addEventListener('pointermove', (e) => {
  mouse.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1)
  card.style.left = e.clientX + 14 + 'px'
  card.style.top = e.clientY + 14 + 'px'
})
let playing = true
addEventListener('keydown', (e) => {
  if (e.code === 'Space') { playing = !playing; e.preventDefault() }
  if (e.key === 'r' || e.key === 'R') { camera.position.set(0, 320, 760); controls.target.set(0, H / 2, 0); aegraph.remember('camera', null) }
})
addEventListener('resize', () => { camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight); composer.setSize(innerWidth, innerHeight) })

const detail = (e) => {
  const d = e.data
  const when = timeOf(e)
  const bits = [e.type, Number.isFinite(when) ? isoDate(when) : '', d.severity ? d.severity : '', d.root_cause_category ? d.root_cause_category : '', d.customers_affected ? d.customers_affected.toLocaleString() + ' customers' : '', d.duration_min ? d.duration_min + ' min' : '', d.version ? 'v' + d.version : ''].filter(Boolean)
  return '<b>' + e.label + '</b><br>' + bits.join(' · ') + (e.description ? '<br><span style="opacity:.75">' + e.description.slice(0, 160) + '</span>' : '')
}

// The sweep rises for ~50 s and starts again; events below it are lit, above it dim.
const PERIOD = 50000
let lastLit = 0
let start = performance.now()
function frame(now) {
  requestAnimationFrame(frame)
  if (!playing) start += now - (frame.prev ?? now)
  frame.prev = now
  const phase = ((now - start) % PERIOD) / PERIOD
  const y = phase * H
  sweep.position.y = y
  sweep.material.opacity = 0.14 + 0.06 * Math.sin(now / 300)
  const tAt = t0 + phase * (t1 - t0)
  hud.querySelector('#date').textContent = isoDate(tAt)
  // Light the events the plane has passed; when it wraps, dim everything.
  let k = lastLit
  if (k > 0 && yOf(shown[k - 1].t) > y) {
    for (let i = 0; i < shown.length; i++) inst.setColorAt(i, new THREE.Color(dim[i * 3], dim[i * 3 + 1], dim[i * 3 + 2]))
    k = 0
  }
  while (k < shown.length && yOf(shown[k].t) <= y) {
    inst.setColorAt(k, new THREE.Color(lit[k * 3], lit[k * 3 + 1], lit[k * 3 + 2]))
    k++
  }
  if (k !== lastLit) { lastLit = k; inst.instanceColor.needsUpdate = true }
  // Hover
  ray.setFromCamera(mouse, camera)
  const hits = ray.intersectObjects([inst, ...hubMeshes], false)
  const hit = hits[0]
  const target = hit ? (hit.object === inst ? shown[hit.instanceId].e : hit.object.userData.entity) : null
  if (target !== hover) {
    hover = target
    card.style.display = target ? 'block' : 'none'
    if (target) card.innerHTML = detail(target)
  }
  controls.update()
  composer.render()
}
requestAnimationFrame(frame)

aegraph.result(table(hubs.map((h) => ({ pillar: h.label, type: h.type, events: perHub.get(h.id) ?? 0, degree: ds.degree(h.id) }))))
