import { memo } from 'react'
import type { AnyEntity, EntityId, Relationship } from '../../core/entity/types'
import { displayLabel } from '../../core/entity/entity'
import { edgePath, shapeOutline, straightRoute, type EdgeGeom, type NodeGeom } from '../../core/diagrams/geometry'
import type { ProjectionData } from '../../core/graph/projection'

/**
 * One layer of the Scenes page: a projection's groups, edges and nodes in
 * scene coordinates. The active layer takes the pointer (its `data-*`
 * attributes are what the stage's drag handlers read); the others are drawn
 * faded and inert, so several projections can sit in one coordinate space.
 */

export interface LayerView {
  id: string
  data: ProjectionData
  rels: Relationship[]
  active: boolean
  opacity: number
}

interface Props {
  layer: LayerView
  k: number
  selected: EntityId | null
  selectedGroup: string | null
  entityOf: (id: EntityId) => AnyEntity | undefined
  colorOf: (e: AnyEntity | undefined, geom: NodeGeom) => string
}

/*
 * What a scene draws in the theme's colours (SVG attributes take the CSS tokens): a group's tint, outline and title
 * on the canvas, a diagram's captured edges. Each mix is within a step or two of Paper's old literal (#bbb, #666, #333).
 * A node's own text stays dark: it sits on the node's fill, the type's colour, not on the canvas.
 */
const GROUP_FILL = 'color-mix(in srgb, var(--text) 2%, transparent)'
const GROUP_STROKE = 'color-mix(in srgb, var(--text) 30%, var(--surface))'
const GROUP_TITLE = 'color-mix(in srgb, var(--text) 68%, var(--surface))'
const CAPTURED_EDGE = 'color-mix(in srgb, var(--text) 91%, var(--surface))'
const NODE_TEXT = '#1f1e1b'

/** Memoised: panning changes only the wrapper transform, so thousands of nodes are not re-rendered per move. */
export const SceneLayer = memo(function SceneLayer({ layer, k, selected, selectedGroup, entityOf, colorOf }: Props) {
  const { data, rels, active } = layer
  const h = 8 / k
  const corners = ['nw', 'ne', 'sw', 'se'] as const
  return (
    <g className={`pj__layer ${active ? 'is-active' : 'is-inert'}`} opacity={layer.opacity} pointerEvents={active ? undefined : 'none'}>
      {data.background && <rect x={0} y={0} width={data.width} height={data.height} fill={data.background} />}
      {Object.entries(data.groups).map(([gid, g]) => {
        const isSel = active && selectedGroup === gid
        return (
          <g key={gid} data-group={active ? gid : undefined} className={`pj__group ${isSel ? 'is-selected' : ''}`}>
            <rect x={g.x} y={g.y} width={g.width} height={g.height} rx={4} fill={g.fill ?? GROUP_FILL} stroke={isSel ? 'var(--select)' : (g.stroke ?? GROUP_STROKE)} strokeWidth={isSel ? 2 / k : undefined} strokeDasharray={g.fill ? undefined : '4 3'} />
            <text x={g.label?.x ?? g.x + 8} y={g.label?.y ?? g.y + 16} fontSize={12} fill={GROUP_TITLE}>
              {g.title ?? gid}
            </text>
            {isSel &&
              corners.map((c) => {
                const cx = c.includes('e') ? g.x + g.width : g.x
                const cy = c.includes('s') ? g.y + g.height : g.y
                return <rect key={c} data-group-corner={c} className={`pj__handle pj__handle--${c}`} x={cx - h / 2} y={cy - h / 2} width={h} height={h} fill="var(--surface)" stroke="var(--select)" strokeWidth={1.5 / k} />
              })}
          </g>
        )
      })}
      {rels.map((r) => {
        const a = data.nodes[r.source.id]
        const b = data.nodes[r.target.id]
        const captured = data.edges[r.id]
        const geom: EdgeGeom = captured ?? { points: straightRoute(a, b), curve: 'line', arrowEnd: r.directed }
        const stroke = geom.stroke ?? (captured ? CAPTURED_EDGE : '#8a8780')
        const hot = selected === r.source.id || selected === r.target.id
        return (
          <g key={r.id} data-edge={active ? r.id : undefined} className={`pj__edge ${hot ? 'is-hot' : ''}`}>
            <path d={edgePath(geom)} fill="none" stroke={stroke} strokeWidth={(geom.strokeWidth ?? 1.5) + (hot ? 1 : 0)} strokeDasharray={geom.dashed ? '6 4' : undefined} markerEnd={geom.arrowEnd ? 'url(#pj-arrow)' : undefined} markerStart={geom.arrowStart ? 'url(#pj-arrow)' : undefined} />
            {(geom.label || r.label || !captured) && (
              <text x={geom.label?.x ?? (a.x + b.x) / 2} y={geom.label?.y ?? (a.y + b.y) / 2 - 6} fontSize={11} textAnchor="middle" fill={stroke}>
                {r.label ?? r.type}
              </text>
            )}
          </g>
        )
      })}
      {Object.entries(data.nodes).map(([id, geom]) => {
        const entity = entityOf(id)
        const label = entity ? displayLabel(entity) : id
        const fill = colorOf(entity, geom)
        const stroke = geom.stroke ?? '#1f1e1b'
        const isSel = selected === id
        const outline = shapeOutline(geom)
        const rot = geom.rotation ? `rotate(${(geom.rotation * 180) / Math.PI} ${geom.x} ${geom.y})` : undefined
        const lines = label.split('\n')
        const fs = geom.fontSize ?? 13
        const sw = (geom.strokeWidth ?? 1.5) + (isSel ? 1.5 : 0)
        return (
          <g key={id} data-node={active ? id : undefined} data-rot={rot} className={`pj__node ${isSel ? 'is-selected' : ''} ${entity ? '' : 'is-missing'}`} transform={rot}>
            {geom.shape === 'text' ? (
              <rect x={geom.x - geom.width / 2} y={geom.y - geom.height / 2} width={geom.width} height={geom.height} fill="transparent" stroke={isSel ? 'var(--select)' : 'none'} strokeDasharray="4 3" />
            ) : geom.shape === 'ellipse' || geom.shape === 'circle' ? (
              <ellipse cx={geom.x} cy={geom.y} rx={geom.width / 2} ry={geom.height / 2} fill={fill} stroke={stroke} strokeWidth={sw} strokeDasharray={geom.dashed ? '6 4' : undefined} />
            ) : outline ? (
              <polygon points={outline} fill={fill} stroke={stroke} strokeWidth={sw} strokeDasharray={geom.dashed ? '6 4' : undefined} />
            ) : (
              <rect x={geom.x - geom.width / 2} y={geom.y - geom.height / 2} width={geom.width} height={geom.height} rx={geom.shape === 'rounded' ? 8 : 2} fill={fill} stroke={stroke} strokeWidth={sw} strokeDasharray={geom.dashed ? '6 4' : undefined} />
            )}
            {active &&
              isSel &&
              geom.shape !== 'text' &&
              corners.map((c) => {
                const cx = c.includes('e') ? geom.x + geom.width / 2 : geom.x - geom.width / 2
                const cy = c.includes('s') ? geom.y + geom.height / 2 : geom.y - geom.height / 2
                return <rect key={c} data-corner={c} className={`pj__handle pj__handle--${c}`} x={cx - h / 2} y={cy - h / 2} width={h} height={h} fill="var(--surface)" stroke="var(--select)" strokeWidth={1.5 / k} />
              })}
            <text x={geom.x} y={geom.y - ((lines.length - 1) * fs * 1.2) / 2} fontSize={fs} textAnchor="middle" dominantBaseline="central" fill={geom.color ?? (geom.shape === 'text' ? 'var(--text)' : NODE_TEXT)}>
              {lines.map((ln, i) => (
                <tspan key={i} x={geom.x} dy={i === 0 ? 0 : fs * 1.2}>
                  {ln}
                </tspan>
              ))}
            </text>
          </g>
        )
      })}
    </g>
  )
})
