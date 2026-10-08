import { Save } from 'lucide-react'
import { SaveAsIcon } from './SavedPicker'
import { useState } from 'react'
import { Dialog } from '../../components/ui/Dialog'
import { useToast } from '../../components/ui/useToast'
import { createEntity, displayLabel } from '../../core/entity/entity'
import { useEntityStore, useStoreVersion } from '../../core/entity/hooks'
import type { AnyEntity, EntityId } from '../../core/entity/types'
import type { MetricsOptions } from '../../core/graph/metrics/types'
import { graphSceneTypeFor, SCENE_PARTS, type SceneData, type ScenePart, type SceneView } from '../../core/graph/scene'
import { SceneMenu } from './SceneMenu'

export interface PartState {
  /** Saved entity currently loaded for this part, if any. */
  id?: EntityId
  /** Local changes since it was loaded/saved. */
  dirty: boolean
  /** One-line description of the current state. */
  summary: string
  /** There is nothing to save for this part (no metrics computed): the scene leaves it out. */
  absent?: boolean
}

interface Props {
  renderer: '2d' | '3d'
  /** The exact renderer, saved so loading the scene shows it on the same one. */
  mode: '2d' | '3d'
  sceneId?: EntityId
  projectId?: EntityId
  analysis: { auto: boolean; options: MetricsOptions }
  parts: Record<ScenePart, PartState>
  /** Persist one part; returns the entity id (creating a new entity when `existing` is undefined), or nothing when the part is absent. */
  savePart: (part: ScenePart, name: string, existing?: AnyEntity) => EntityId | undefined
  /** The view and the UI as they stand, and a small picture of the view. */
  captureView: () => Promise<{ view: SceneView; preview?: string; stats: { nodes: number; edges: number } }>
  /** Load a scene picked from the menu; unload the current one (its parts stay). */
  onLoad: (scene: AnyEntity) => void
  onUnload: () => void
  onSaved: (sceneId: EntityId) => void
}

/**
 * The scene's name and its two buttons in the toolbar: **Save** writes the
 * view back into the scene it came from (lit only while something changed),
 * **Save as…** names a new one. A scene is filter + layout + style (+ the
 * analysis when metrics were computed, the renderer, the dataset and the
 * analysis settings) and everything about the view and the UI besides — the
 * camera, the toolbar's toggles, the selection, the panels — with a small
 * picture of the view, so loading it puts the screen back as it was. Saving
 * saves whatever parts aren't saved yet, so the scene always references
 * real entities, and the dialog shows exactly what will happen to each
 * part. The scene is an entity of the page's subtype, listed on the Scenes
 * page with the others; loading one is from there or from its Entities row.
 */
export function SceneSave({ renderer, mode, sceneId, projectId, analysis, parts, savePart, captureView, onLoad, onUnload, onSaved }: Props) {
  const store = useEntityStore()
  useStoreVersion(store)
  const toast = useToast()
  const [naming, setNaming] = useState(false)
  const [name, setName] = useState('')

  const active = sceneId ? store.get(sceneId) : undefined
  const sceneData = active?.data as SceneData | undefined
  // Dirty when any part deviates from what the scene references, or has unsaved edits, or the renderer changed. The view
  // (camera, toggles, selection, panels) is not watched: it is captured at every save, and moving the camera alone is
  // not a change to answer for.
  const dirty = !!active && (SCENE_PARTS.some(({ key, idKey }) => (parts[key].absent ? !!sceneData?.[idKey] : parts[key].id !== sceneData?.[idKey] || parts[key].dirty)) || (sceneData?.mode ?? sceneData?.renderer) !== mode || (sceneData?.projectId ?? undefined) !== projectId || !!sceneData?.analysis?.auto !== analysis.auto)
  const [saving, setSaving] = useState(false)

  const commit = async (label: string, existing?: AnyEntity) => {
    setSaving(true)
    try {
      // The picture first, before a store write redraws anything.
      const { view, preview, stats } = await captureView()
      const data: SceneData = { renderer, ...(existing?.data as SceneData | undefined) }
      for (const { key, idKey } of SCENE_PARTS) {
        const p = parts[key]
        const ent = p.id ? store.get(p.id) : undefined
        // Absent → the scene has none; unsaved → new entity named after the scene; dirty → update in place; clean → reference as is.
        data[idKey] = p.absent ? undefined : !ent ? savePart(key, `${label} · ${key === 'rendering' ? 'style' : key}`) : p.dirty ? savePart(key, displayLabel(ent), ent) : ent.id
      }
      data.renderer = renderer
      data.mode = mode
      data.projectId = projectId
      data.analysis = analysis
      data.view = view
      data.preview = preview
      data.stats = stats
      // Unigraph's subtype, on a new scene and on one saved before it (the bare `scene`, the explorer's) alike.
      const type = graphSceneTypeFor()
      if (existing) {
        store.update(existing.id, { label, type, data })
        onSaved(existing.id)
      } else {
        const e = createEntity<SceneData>({ type, label, data, tags: [], meta: { source: 'user' } })
        store.upsert(e)
        onSaved(e.id)
      }
      toast(`Scene “${label}” saved`)
      setNaming(false)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="gx-scene">
      <SceneMenu active={active} dirty={dirty} onLoad={onLoad} onUnload={onUnload} />
      {/* Icon only: the scene's own name is beside them, so the words were saying what the icons already say. */}
      <button className="btn btn--sm btn--icon" aria-label="Save the scene" disabled={!active || !dirty || saving} title={active ? (dirty ? `Save the changes to “${displayLabel(active)}”` : 'Nothing changed since the scene was saved') : 'No scene loaded — Save as… makes one'} onClick={() => active && void commit(displayLabel(active), active)}>
        <Save size={16} />
      </button>
      <button className="btn btn--sm btn--icon" aria-label="Save as a new scene" title="Save as a new scene: the filter, layout, style and analysis with the view and the UI as they are" onClick={() => (setName(''), setNaming(true))}>
        <SaveAsIcon size={16} />
      </button>

      <Dialog
        open={naming}
        title="Save scene"
        description={`A scene is the combination of a filter, a layout, a style and the analysis, viewed in ${renderer.toUpperCase()}, with the camera, the toggles, the selection and the panels as they are now, and a small picture of the view. Parts that aren't saved yet will be saved with the scene.`}
        onClose={() => setNaming(false)}
        footer={
          <>
            <button className="btn" onClick={() => setNaming(false)}>
              Cancel
            </button>
            <button className="btn btn--primary" disabled={!name.trim() || saving} onClick={() => void commit(name.trim())}>
              {saving ? 'Saving…' : 'Save scene'}
            </button>
          </>
        }
      >
        <div className="field">
          <label>Scene name</label>
          <input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && name.trim() && !saving && void commit(name.trim())} />
        </div>
        <div className="scene-parts">
          {SCENE_PARTS.map(({ key, label }) => {
            const p = parts[key]
            const ent = p.id ? store.get(p.id) : undefined
            const status = p.absent ? { text: 'none — no metrics computed', cls: '' } : !ent ? { text: `will be saved as “${name.trim() || '…'} · ${key === 'rendering' ? 'style' : key}”`, cls: 'badge--info' } : p.dirty ? { text: `“${displayLabel(ent)}” — changes will be saved`, cls: 'badge--warn' } : { text: `“${displayLabel(ent)}”`, cls: 'badge--ok' }
            return (
              <div key={key} className="scene-part">
                <span className="scene-part__label">{label}</span>
                <span className={`badge ${status.cls}`}>{p.absent ? 'none' : !ent ? 'new' : p.dirty ? 'update' : 'saved'}</span>
                <span className="scene-part__status">{status.text}</span>
                <span className="scene-part__summary muted">{p.summary}</span>
              </div>
            )
          })}
          <div className="scene-part">
            <span className="scene-part__label">View</span>
            <span className="badge">{mode.toUpperCase()}</span>
            <span className="scene-part__status muted">Loading the scene switches to this renderer and puts the camera back.</span>
          </div>
        </div>
      </Dialog>
    </div>
  )
}
