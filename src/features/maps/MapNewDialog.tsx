import { useState } from 'react'
import { Dialog } from '../../components/ui/Dialog'

/** Kept apart from MapsView so the Library's capabilities can import it without pulling Leaflet in. */
export function MapNewDialog({ onClose, onSubmit, initial, title = 'New map' }: { onClose: () => void; onSubmit: (label: string) => void; /** Renaming: the current name. */ initial?: string; title?: string }) {
  const [label, setLabel] = useState(initial ?? '')
  const submit = () => onSubmit(label.trim() || 'Untitled map')
  return (
    <Dialog
      open
      title={title}
      description={initial === undefined ? 'A blank map on OpenStreetMap tiles. Add locations by clicking, searching or pasting a Google Maps link; draw paths and areas; import KML / GeoJSON.' : undefined}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn--primary" onClick={submit}>
            {initial === undefined ? 'Create' : 'Rename'}
          </button>
        </>
      }
    >
      <div className="field">
        <label>Name</label>
        <input className="input" autoFocus value={label} placeholder="Field trip, Office locations, 1848 Europe…" onChange={(e) => setLabel(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} />
      </div>
    </Dialog>
  )
}
