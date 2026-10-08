/** Tiny inline-SVG bar chart: one bar per bin, no axes, no chart library. */
export function Histogram({ counts, labels, width = 240, height = 44, color = 'var(--accent, #0ea5e9)' }: { counts: number[]; labels?: string[]; width?: number; height?: number; color?: string }) {
  const max = Math.max(1, ...counts)
  const n = counts.length || 1
  const bw = width / n
  return (
    <svg className="gx-hist" viewBox={`0 0 ${width} ${height}`} width="100%" height={height} preserveAspectRatio="none" role="img" aria-label="distribution">
      {counts.map((c, i) => {
        const h = (c / max) * (height - 2)
        return <rect key={i} x={i * bw + 0.5} y={height - h} width={Math.max(0.5, bw - 1)} height={h} fill={color} opacity={0.85}>{labels?.[i] ? <title>{`${labels[i]}: ${c}`}</title> : <title>{String(c)}</title>}</rect>
      })}
    </svg>
  )
}
