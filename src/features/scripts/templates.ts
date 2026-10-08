/** Starting points shown in the Templates menu — each a complete, runnable script over any dataset. */
import type { Language } from '../../scripting/types'
import constellations from './examples/constellations.js?raw'

export const TEMPLATES: { label: string; language?: Language; code: string }[] = [
  {
    label: 'Entities created per month, by type',
    code: `// Entities created per month, by type
const byType = groupBy(ds.entities, 'type')
const traces = []
for (const [type, list] of byType) {
  const m = rollup(list, (e) => bin(e.createdAt, 'month'))
  traces.push(bar(m.map((r) => r.key), m.map((r) => r.value), { name: type }))
}
return figure(traces, { title: 'Entities created per month', barmode: 'stack', yaxis: { title: 'entities' } })`,
  },
  {
    label: 'A field over time, with a rolling mean',
    code: `// Weekly mean of a numeric field, with a 4-week rolling mean
// Change type, field and date to fit your data.
const type = ds.types()[0]
const rows = ds.byType(type)
const field = Object.keys(rows[0]?.data ?? {}).find((k) => typeof rows[0].data[k] === 'number')
const weekly = rollup(rows, (e) => bin(e.createdAt, 'week'), (e) => e.data[field], 'mean')
const x = weekly.map((r) => r.key)
const y = weekly.map((r) => r.value)
return figure([line(x, y, { name: field }), line(x, rolling(y, 4), { name: '4-week mean', line: { dash: 'dot' } })], { title: \`\${type} · \${field} per week\` })`,
  },
  {
    label: 'Before / after a date',
    code: `// Compare a metric before and after a change
const cutoff = '2025-11-14'
const rows = ds.byType('incident')
const value = (e) => e.data.duration_min
const before = rows.filter((e) => e.data.startedAt < cutoff).map(value)
const after = rows.filter((e) => e.data.startedAt >= cutoff).map(value)
log('before', before.length, 'after', after.length)
return {
  ...figure([box(before, { name: 'before' }), box(after, { name: 'after' })], { title: \`Duration before and after \${cutoff}\`, yaxis: { type: 'log' } }),
  ...table([
    { period: 'before', n: before.length, median: median(before), p90: quantile(before, 0.9) },
    { period: 'after', n: after.length, median: median(after), p90: quantile(after, 0.9) },
  ]),
}`,
  },
  {
    label: 'Top entities by a metric (run Insights first)',
    code: `// Top 20 by PageRank from the latest analysis run
const scored = ds.entities.map((e) => ({ label: e.label, type: e.type, pagerank: ds.metric('pagerank', e.id), degree: ds.degree(e.id) })).filter((r) => r.pagerank !== undefined)
if (!scored.length) return { text: 'No metrics yet — run Insights (or analyze) first.' }
const top = topK(scored, 'pagerank', 20)
return { ...figure(bar(top.map((r) => r.label), top.map((r) => r.pagerank), { name: 'PageRank' }), { title: 'Top 20 by PageRank', xaxis: { type: 'category' } }), ...table(top) }`,
  },
  {
    label: 'A scene: place entities on a timeline by type',
    code: `// Lay entities out on a timeline: x by creation date, one row per type
const types = ds.types()
const t0 = min(ds.entities.map((e) => ms(e.createdAt)))
const t1 = max(ds.entities.map((e) => ms(e.createdAt)))
const positions = {}
for (const e of ds.entities) {
  const x = ((ms(e.createdAt) - t0) / Math.max(1, t1 - t0)) * 2400
  positions[e.id] = { x, y: types.indexOf(e.type) * 120 }
}
return scene(positions, { label: 'Timeline by type' })`,
  },
  {
    label: 'Python · pandas + plotly express',
    language: 'python',
    code: `# Incidents per month by cause, with pandas and plotly express
import plotly.express as px
inc = by_type('incident')
inc['month'] = inc['startedAt'].dt.to_period('M').dt.to_timestamp()
m = inc.groupby(['month', 'root_cause_category']).size().reset_index(name='incidents')
px.bar(m, x='month', y='incidents', color='root_cause_category', title='Incidents per month by cause')`,
  },
  {
    label: 'Python · 3D scatter (WebGL)',
    language: 'python',
    code: `# Three numeric fields in 3D — change the type and columns to fit your data
import plotly.express as px
df = by_type('incident')
px.scatter_3d(df, x='time_to_detect_min', y='duration_min', z='customers_affected', color='severity', hover_name='label', log_z=True, title='Detect × resolve × blast radius')`,
  },
  {
    label: 'Python · matplotlib',
    language: 'python',
    code: `# A matplotlib figure is shown as an image
import matplotlib
matplotlib.use('agg')
import matplotlib.pyplot as plt
counts = entities['type'].value_counts()
fig, ax = plt.subplots(figsize=(8, 4))
counts.plot.barh(ax=ax)
ax.set_title('Entities by type')
fig`,
  },
  {
    label: 'Python · networkx over the graph',
    language: 'python',
    code: `# PageRank with networkx, top 15 as a table
import networkx as nx
g = graph()
pr = nx.pagerank(g)
top = sorted(pr.items(), key=lambda kv: -kv[1])[:15]
table([{ 'entity': get(i)['label'], 'type': get(i)['type'], 'pagerank': round(v, 4), 'degree': degree(i) } for i, v in top])`,
  },
  { label: 'Visual · Constellations — the graph as columns of time', language: 'view', code: constellations },
  {
    label: 'Visual · three.js graph in 3D',
    language: 'view',
    code: `// Entities as spheres, relationships as lines; drag to orbit, scroll to zoom
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'

const scene = new THREE.Scene()
scene.background = new THREE.Color('#faf9f6')
const camera = new THREE.PerspectiveCamera(60, aegraph.width() / aegraph.height(), 0.1, 10000)
camera.position.set(0, 120, 520)
const renderer = new THREE.WebGLRenderer({ antialias: true })
renderer.setPixelRatio(devicePixelRatio)
renderer.setSize(aegraph.width(), aegraph.height())
document.getElementById('app').appendChild(renderer.domElement)
const controls = new OrbitControls(camera, renderer.domElement)
controls.enableDamping = true

// Up to 2,000 entities on a spiral, one ring height per type; size by degree, colour by type.
const types = ds.types()
const nodes = ds.entities.slice(0, 2000)
const pos = new Map()
nodes.forEach((e, i) => {
  const r = 40 + 9 * Math.sqrt(i)
  const a = i * 2.39996
  pos.set(e.id, new THREE.Vector3(r * Math.cos(a), (types.indexOf(e.type) - types.length / 2) * 28, r * Math.sin(a)))
})
const sphere = new THREE.SphereGeometry(1, 12, 12)
for (const e of nodes) {
  const m = new THREE.Mesh(sphere, new THREE.MeshStandardMaterial({ color: new THREE.Color().setHSL(types.indexOf(e.type) / Math.max(1, types.length), 0.6, 0.5) }))
  m.position.copy(pos.get(e.id))
  m.scale.setScalar(1.5 + Math.sqrt(ds.degree(e.id)))
  scene.add(m)
}
const pts = []
for (const r of ds.relationships) {
  const a = pos.get(r.source)
  const b = pos.get(r.target)
  if (a && b) pts.push(a, b)
}
scene.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: 0x8a8a8a, transparent: true, opacity: 0.25 })))
scene.add(new THREE.AmbientLight(0xffffff, 0.9))
const sun = new THREE.DirectionalLight(0xffffff, 1.2)
sun.position.set(1, 2, 1)
scene.add(sun)
console.log(nodes.length, 'entities,', pts.length / 2, 'edges')

addEventListener('resize', () => { camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight) })
;(function frame() { requestAnimationFrame(frame); controls.update(); renderer.render(scene, camera) })()`,
  },
  {
    label: 'Visual · d3 force layout (SVG)',
    language: 'view',
    code: `// A d3 force-directed layout of the first 400 entities, coloured by type
const d3 = await aegraph.load('d3')
const nodes = ds.entities.slice(0, 400).map((e) => ({ id: e.id, type: e.type, label: e.label, degree: ds.degree(e.id) }))
const ids = new Set(nodes.map((n) => n.id))
const links = ds.relationships.filter((r) => ids.has(r.source) && ids.has(r.target)).map((r) => ({ source: r.source, target: r.target }))
const color = d3.scaleOrdinal(d3.schemeTableau10).domain(ds.types())
const svg = d3.select('#app').append('svg').attr('viewBox', [0, 0, aegraph.width(), aegraph.height()]).style('width', '100%').style('height', '100%')
const link = svg.append('g').attr('stroke', '#bbb').attr('stroke-opacity', 0.6).selectAll('line').data(links).join('line')
const node = svg.append('g').selectAll('circle').data(nodes).join('circle').attr('r', (d) => 3 + Math.sqrt(d.degree)).attr('fill', (d) => color(d.type))
node.append('title').text((d) => d.label + ' · ' + d.type)
const sim = d3.forceSimulation(nodes).force('link', d3.forceLink(links).id((d) => d.id).distance(30)).force('charge', d3.forceManyBody().strength(-40)).force('center', d3.forceCenter(aegraph.width() / 2, aegraph.height() / 2))
sim.on('tick', () => { link.attr('x1', (d) => d.source.x).attr('y1', (d) => d.source.y).attr('x2', (d) => d.target.x).attr('y2', (d) => d.target.y); node.attr('cx', (d) => d.x).attr('cy', (d) => d.y) })
node.call(d3.drag().on('start', (ev, d) => { sim.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y }).on('drag', (ev, d) => { d.fx = ev.x; d.fy = ev.y }).on('end', (ev, d) => { sim.alphaTarget(0); d.fx = null; d.fy = null }))`,
  },
]
