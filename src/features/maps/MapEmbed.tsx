import { ChevronDown, ChevronRight } from 'lucide-react'
import { useState } from 'react'
import type { EntityId } from '../../core/entity/types'
import { MapList, MapPendingDialog, MapStage, MapTimeline, MapToolbar, useMapWorkbench } from './MapWorkbench'
import type { MapEntity } from './maps'
import '../documents/DocumentsView.css'
import './maps.css'

/** The map workbench in the detail panel: the same map, tools and lists as the page, stacked. */
export default function MapEmbed({ map, onOpen }: { map: MapEntity; onOpen: (id: EntityId) => void }) {
  const wb = useMapWorkbench(map, { onOpenEntity: onOpen })
  const [list, setList] = useState<'places' | 'notes'>('places')
  const [open, setOpen] = useState(false)
  return (
    <div className="geo-embed">
      <div className="geo-embed__bar">
        <MapToolbar wb={wb} compact />
      </div>
      <div className="geo-embed__map">
        <MapStage wb={wb} compact />
      </div>
      <div style={{ padding: '0 8px' }}>
        <MapTimeline wb={wb} />
      </div>
      {/* The lists fold so the map keeps the room; the header still says what's there. */}
      <div className={`geo-embed__lists ${open ? 'is-open' : ''}`}>
        <div className="geo__side-tabs">
          <button className="btn btn--sm btn--icon btn--ghost" title={open ? 'Hide the lists' : 'Show the lists'} onClick={() => setOpen((v) => !v)}>
            {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </button>
          <button className={`insp__tab ${list === 'places' && open ? 'is-active' : ''}`} onClick={() => (setList('places'), setOpen(true))}>
            Places · {wb.visiblePlaces.length}
          </button>
          <button className={`insp__tab ${list === 'notes' && open ? 'is-active' : ''}`} onClick={() => (setList('notes'), setOpen(true))}>
            Notes · {wb.visibleNotes.length}
          </button>
        </div>
        {open && (
          <div className="geo__side-body">
            <MapList wb={wb} kind={list} />
          </div>
        )}
      </div>
      <MapPendingDialog wb={wb} />
    </div>
  )
}
