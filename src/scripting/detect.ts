import type { Language } from './types'

/** Which language a script is written in, from its text; explicit choices win over this. */
export function detectLanguage(code: string): Language {
  const py = [/^\s*(import|from)\s+\w+/m, /^\s*def\s+\w+\(.*\):/m, /^\s*(if|for|while|with|elif|else|try|except)\b.*:\s*$/m, /\bprint\(/, /\bpd\.|\bnp\.|\bpx\.|\bgo\./, /\bNone\b|\bTrue\b|\bFalse\b/, /\blambda\s+\w*:/, /#\s/, /\.(groupby|reset_index|to_period|value_counts|iloc|loc|describe|to_frame)\b/, /\b(entities|relationships|metrics)\[/]
  const js = [/\b(const|let|var)\s+\w+\s*=/, /=>/, /\breturn\s+(figure|table|scene)\(/, /\bds\.(byType|entities|get|neighbors)\b/, /;\s*$/m, /\bfunction\b/, /\/\//, /===|!==/, /\bnull\b|\bundefined\b/]
  const view = [/\bfrom\s+['"]three/, /\bTHREE\./, /\bdocument\.(getElementById|createElement|body|querySelector)/, /\brequestAnimationFrame\b/, /\bd3\.(select|forceSimulation|scale)/, /\bPlotly\.(newPlot|react)/, /\bWebGLRenderer\b/, /\bcanvas\b/i, /\baegraph\.(result|width|height)\b/]
  const score = (rules: RegExp[]) => rules.reduce((n, r) => n + (r.test(code) ? 1 : 0), 0)
  if (score(view) >= 2 || /\bfrom\s+['"]three|\bTHREE\.|\bd3\.select|\bPlotly\.newPlot/.test(code)) return 'view'
  const p = score(py)
  const j = score(js)
  if (p === j) return /^\s*(import|from)\s/m.test(code) ? 'python' : 'js'
  return p > j ? 'python' : 'js'
}
