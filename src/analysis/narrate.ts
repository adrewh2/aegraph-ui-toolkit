import { analysisInfo, type Finding, type Report } from './types'

/** A report as Markdown: the headline findings, then each analysis in turn. */
export function narrate(report: Report, opts: { top?: number; perAnalysis?: number } = {}): string {
  const top = report.findings.slice(0, opts.top ?? 5)
  const lines: string[] = []
  lines.push(`**${report.scope.label}** — ${report.nodes.toLocaleString('en-US')} entities, ${report.edges.toLocaleString('en-US')} relationships; ${report.runs.length} analyses in ${(report.ms / 1000).toFixed(1)} s.`, '')
  if (top.length) {
    lines.push('**Most interesting**', '')
    for (const f of top) lines.push(`- ${line(f)}`)
    lines.push('')
  }
  for (const run of report.runs) {
    const info = analysisInfo(run.id)
    lines.push(`**${info.label}** · _${info.question}_`)
    if (!run.findings.length) lines.push(`- ${run.note ?? 'Nothing stood out.'}`)
    for (const f of run.findings.slice(0, opts.perAnalysis ?? 4)) lines.push(`- ${line(f)}`)
    lines.push('')
  }
  return lines.join('\n').trim()
}

const line = (f: Finding) => `${f.title}. ${f.detail}${f.visual ? ` _(${f.visual.kind}: ${f.visual.title})_` : ''}`
