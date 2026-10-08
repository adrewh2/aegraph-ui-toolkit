import { Maximize2, MousePointer2, Square, ZoomIn, ZoomOut } from 'lucide-react'
import { useCallback, useState } from 'react'
import { useToast } from '../../components/ui/useToast'
import { useEntityStore, useStoreVersion } from '../../core/entity/hooks'
import type { EntityId } from '../../core/entity/types'
import { updateAnnotationSelector } from '../../core/resources/annotations'
import { ImageAnnotator, type Tool } from './ImageAnnotator'
import { RegionDialog } from './ImagesView'
import { annotateImage, regionAnnotationsOf, type Box, type ImageAnnotation, type ImageEntity } from './images'
import './images.css'

/** The image with its region annotations — select to move/resize, or draw a new box. */
export default function ImageEmbed({ image }: { image: ImageEntity }) {
  const store = useEntityStore()
  useStoreVersion(store)
  const toast = useToast()
  const [tool, setTool] = useState<Tool>('select')
  const [selected, setSelected] = useState<EntityId | null>(null)
  const [pendingBox, setPendingBox] = useState<Box | null>(null)
  const [zoom, setZoom] = useState<number | 'fit'>('fit')
  const [scale, setScale] = useState(1)
  const regions = regionAnnotationsOf(store, image.id)
  const colorOf = useCallback((a: ImageAnnotation) => a.annotation.tags.map((t) => store.getTagInfo(t).color).find(Boolean), [store])

  return (
    <div className="ie">
      <div className="ie__bar" title="Scroll or pinch over the image to zoom · drag with the select tool, hold Space, or use the middle button to pan">
        <button className={`btn btn--sm btn--icon ${tool === 'select' ? 'is-on' : ''}`} title="Select" onClick={() => setTool('select')}>
          <MousePointer2 size={13} />
        </button>
        <button className={`btn btn--sm btn--icon ${tool === 'draw' ? 'is-on' : ''}`} title="Draw a box to annotate" onClick={() => setTool('draw')}>
          <Square size={13} />
        </button>
        <span className="muted">{regions.length ? `${regions.length} region${regions.length === 1 ? '' : 's'}` : 'Draw a box to annotate a region'}</span>
        <span className="spacer" />
        <button className="btn btn--sm btn--icon" title="Zoom out" onClick={() => setZoom(Math.max(0.05, scale / 1.25))}>
          <ZoomOut size={13} />
        </button>
        <button className="btn btn--sm ie__zoom" title="Reset to 100%" onClick={() => setZoom(1)}>
          {Math.round(scale * 100)}%
        </button>
        <button className="btn btn--sm btn--icon" title="Zoom in" onClick={() => setZoom(Math.min(8, scale * 1.25))}>
          <ZoomIn size={13} />
        </button>
        <button className={`btn btn--sm btn--icon ${zoom === 'fit' ? 'is-on' : ''}`} title="Fit to view" onClick={() => setZoom('fit')}>
          <Maximize2 size={13} />
        </button>
      </div>
      <ImageAnnotator
        image={image}
        annotations={regions}
        tool={tool}
        zoom={zoom}
        onZoom={setZoom}
        onScale={setScale}
        onLoaded={(size) => {
          // Region crops need the natural size; URL imports that couldn't be probed get it here.
          if (image.data.width !== size.width || image.data.height !== size.height) store.update(image.id, { data: { ...image.data, ...size } })
        }}
        pending={pendingBox}
        selectedId={selected}
        onSelect={setSelected}
        onDraw={(box) => setPendingBox(box)}
        onChange={(id, box) => {
          const a = regions.find((r) => r.annotation.id === id)
          if (a) updateAnnotationSelector(store, a.relationshipId, { kind: 'region', ...box })
        }}
        onDelete={(id) => store.remove(id)}
        colorOf={colorOf}
      />
      {pendingBox && (
        <RegionDialog
          image={image}
          box={pendingBox}
          onClose={() => setPendingBox(null)}
          onSubmit={(comment, tags) => {
            const a = annotateImage(store, image, pendingBox, comment, tags)
            setPendingBox(null)
            setSelected(a.id)
            setTool('select')
            toast('Annotation created')
          }}
        />
      )}
    </div>
  )
}
