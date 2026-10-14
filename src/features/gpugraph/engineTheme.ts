import { themeToken, themeTokens } from '../../app/theme'
import { PAPER_ENGINE_COLORS, type EngineColors } from './engine/engine'

/**
 * The engine's colours (`GraphEngine.setColors`) from the theme on screen: the ground is `--canvas`, the labels
 * `--text` on a `--canvas-halo`, edge labels `--text-muted`, the selected node's ring `--canvas-select`, the hovered
 * and path nodes `--canvas-path` (Paper's rust, apart from the selection's colour in every theme), the default edge `--canvas-edge`. Each resolves to Paper's own value in
 * Paper. Read again when the theme changes (`onThemeChange`), which costs one frame and one label pass.
 */
export function engineColors(el?: Element): EngineColors {
  const t = themeTokens(el)
  const lit = themeToken('--canvas-path', PAPER_ENGINE_COLORS.hover, el)
  return {
    background: t.canvas,
    label: t.text,
    labelHalo: t.canvasHalo,
    edgeLabel: t.textMuted,
    select: t.canvasSelect,
    hover: lit,
    path: lit,
    node: PAPER_ENGINE_COLORS.node,
    edge: t.canvasEdge,
  }
}
