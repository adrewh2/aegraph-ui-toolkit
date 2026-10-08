import { BarChart3 } from 'lucide-react'
import { PlotWorkbench } from '../plots/PlotWorkbench'
import { usePaneTitle } from '../workstation/paneContext'
import '../scenes/scenes.css'
import './analytics.css'

/** A Charts tab: the plot tool, titled after the tab when the tab has a name. */
export function ChartsView() {
  const name = usePaneTitle()
  return (
    <div className="pj an__charts">
      <PlotWorkbench
        title={
          <span className="an__title" title="Pick rows, a kind of chart, and what the axes read">
            <BarChart3 size={16} /> Charts{name ? <span className="an__title-name"> — {name}</span> : null}
          </span>
        }
      />
    </div>
  )
}
