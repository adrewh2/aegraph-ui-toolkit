import type { SVGProps } from 'react'

/**
 * The Unigraph mark: a hub and two neighbours, one above and one below the
 * line of sight, so the shape reads as a fragment of a graph rather than a
 * tidy symbol. Drawn to Lucide's conventions (24-unit box, round strokes,
 * currentColor) so it sits with the rest of the sidebar. The lines stop at
 * each circle's edge instead of running under it, which is what keeps the
 * nodes legible at 16px.
 */
export function UnigraphIcon({ size = 16, strokeWidth = 2, ...rest }: { size?: number; strokeWidth?: number } & Omit<SVGProps<SVGSVGElement>, 'width' | 'height'>) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...rest}>
      <circle cx="7.13" cy="13.01" r="2.73" />
      <circle cx="14.08" cy="5.68" r="2.19" />
      <circle cx="17.42" cy="18.32" r="2.19" />
      <path d="M9.01 11.03 12.57 7.27" />
      <path d="M9.56 14.26 15.47 17.32" />
    </svg>
  )
}
