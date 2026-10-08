import type { SVGProps } from 'react'

/**
 * The Entities mark: a rounded hexagon with a dot at its centre. Drawn to
 * Lucide's conventions (24-unit box, 2px round strokes, currentColor) so it
 * sits alongside the rest of the sidebar icons. The stroke is a touch heavier
 * than Lucide's 2 because the hexagon's diagonals anti-alias lighter than the
 * neighbours' straight edges at 16px.
 */
export function EntityIcon({ size = 16, strokeWidth = 2.35, ...rest }: { size?: number; strokeWidth?: number } & Omit<SVGProps<SVGSVGElement>, 'width' | 'height'>) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...rest}>
      <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
      <circle cx="12" cy="12" r="2.4" fill="currentColor" stroke="none" />
    </svg>
  )
}
