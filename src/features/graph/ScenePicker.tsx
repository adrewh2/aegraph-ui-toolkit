import { Check, ChevronDown, Clapperboard, Pencil, Save, Trash2, X } from 'lucide-react'
import { useState } from 'react'
import { ConfirmDialog, Dialog } from '../../components/ui/Dialog'
import { Menu, type MenuItem } from '../../components/ui/Menu'
import { useToast } from '../../components/ui/useToast'
import { displayLabel } from '../../core/entity/entity'
import { useEntityStore, useStoreVersion } from '../../core/entity/hooks'
import type { AnyEntity, EntityId } from '../../core/entity/types'
import type { MetricsOptions } from '../../core/graph/metrics/types'
import { SCENE_PARTS, SCENE_TYPE, type SceneData, type ScenePart } from '../../core/graph/scene'
import { formatDate } from '../../lib/format'

export interface PartState {
  /** Saved entity currently loaded for this part, if any. */
  id?: EntityId
  /** Local changes since it was loaded/saved. */
  dirty: boolean
  /** One-line description of the current state. */
  summary: string
}

interface Props {
  renderer: '2d' | '3d'
  sceneId?: EntityId
  projectId?: EntityId
  analysis: { auto: boolean; options: MetricsOptions }
  parts: Record<ScenePart, PartState>
  /** Persist one part; returns the entity id (creating a new entity when `existing` is undefined). */
  savePart: (part: ScenePart, name: string, existing?: AnyEntity) => EntityId
  onLoad: (scene: AnyEntity) => void
  onUnload: () => void
  onSaved: (sceneId: EntityId) => void
}

/**
 * The scene picker. A scene is filter + layout + style (+ 2D/3D). Saving one
 * saves whatever parts aren't saved yet, so the scene always references
 * real entities; the dialog shows exactly what will happen to each part.
 */
export function ScenePicker({ renderer, sceneId, projectId, analysis, parts, savePart, onLoad, onUnload, onSaved }: Props) {
  const store = useEntityStore()
  useStoreVersion(store)
  const toast = useToast()
  const [menu, setMenu] = useState<{ x: number; y: number; anchor: Element } | null>(null)
  const [dialog, setDialog] = useState<'new' | 'update' | 'rename' | null>(null)
  const [name, setName] = useState('')
  const [pendingDelete, setPendingDelete] = useState<AnyEntity | null>(null)

  const scenes = store.ofType(SCENE_TYPE).sort((a, b) => b.meta.updatedAt.localeCompare(a.meta.updatedAt))
  const active = sceneId ? store.get(sceneId) : undefined
  const sceneData = active?.data as SceneData | undefined
  // Dirty when any part deviates from what the scene references, or has unsaved edits, or the renderer changed.
  const dirty = !!active && (SCENE_PARTS.some(({ key, idKey }) => parts[key].id !== sceneData?.[idKey] || parts[key].dirty) || sceneData?.renderer !== renderer || (sceneData?.projectId ?? undefined) !== projectId || !!sceneData?.analysis?.auto !== analysis.auto)
  const title = active ? displayLabel(active) : 'Unsaved scene'

  const commit = (label: string, existing?: AnyEntity) => {
    const data: SceneData = { renderer, ...(existing?.data as SceneData | undefined) }
    for (const { key, idKey } of SCENE_PARTS) {
      const p = parts[key]
      const ent = p.id ? store.get(p.id) : undefined
      // Unsaved → new entity named after the scene; dirty → update in place; clean → reference as is.
      data[idKey] = !ent ? savePart(key, `${label} · ${key === 'rendering' ? 'style' : key}`) : p.dirty ? savePart(key, displayLabel(ent), ent) : ent.id
    }
    data.renderer = renderer
    data.projectId = projectId
    data.analysis = analysis
    if (existing) {
      store.update(existing.id, { label, data })
      onSaved(existing.id)
    } else {
      const e = { id: crypto.randomUUID(), kind: 'entity' as const, type: SCENE_TYPE, label, tags: [], data, meta: { createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), source: 'user' } }
      store.upsert(e)
      onSaved(e.id)
    }
    toast(`Scene “${label}” saved`)
    setDialog(null)
  }

  const items: MenuItem[] = [
    { kind: 'label', label: 'Saved scenes' },
    ...(scenes.length
      ? scenes.map<MenuItem>((e) => ({ kind: 'item', label: `${displayLabel(e)}  ·  ${(e.data as SceneData).renderer?.toUpperCase() ?? ''}  ·  ${formatDate(e.meta.updatedAt)}`, icon: e.id === sceneId ? Check : undefined, onSelect: () => onLoad(e) }))
      : [{ kind: 'item' as const, label: 'No saved scenes yet', disabled: true, onSelect: () => {} }]),
    { kind: 'sep' },
    ...(active
      ? [
          { kind: 'item', label: `Save changes to “${displayLabel(active)}”`, icon: Save, disabled: !dirty, onSelect: () => (setName(displayLabel(active)), setDialog('update')) } as MenuItem,
          { kind: 'item', label: 'Rename…', icon: Pencil, onSelect: () => (setName(displayLabel(active)), setDialog('rename')) } as MenuItem,
          { kind: 'item', label: 'Delete…', icon: Trash2, danger: true, onSelect: () => setPendingDelete(active) } as MenuItem,
        ]
      : []),
    { kind: 'item' as const, label: 'Save as new scene…', icon: Save, onSelect: () => (setName(''), setDialog('new')) },
    { kind: 'item' as const, label: 'Unload scene (keep parts)', icon: X, disabled: !active, onSelect: onUnload },
  ]

  return (
    <>
      <button className={`btn btn--sm gx-picker gx-picker--scene ${dirty ? 'is-dirty' : ''}`} onClick={(e) => setMenu(menu ? null : { x: e.currentTarget.getBoundingClientRect().left, y: e.currentTarget.getBoundingClientRect().bottom + 4, anchor: e.currentTarget })} title="A scene is a filter + a layout + a style, in 2D or 3D">
        <Clapperboard size={13} />
        <span className="gx-picker__label">
          {title}
          {dirty && ' •'}
        </span>
        <ChevronDown size={12} />
      </button>
      {menu && <Menu x={menu.x} y={menu.y} anchor={menu.anchor} items={items} onClose={() => setMenu(null)} />}

      <Dialog
        open={dialog === 'new' || dialog === 'update'}
        title={dialog === 'update' ? `Save changes to “${active ? displayLabel(active) : ''}”` : 'Save scene'}
        description={`A scene is the combination of a filter, a layout, and a style, viewed in ${renderer.toUpperCase()}. Parts that aren't saved yet will be saved with the scene.`}
        onClose={() => setDialog(null)}
        footer={
          <>
            <button className="btn" onClick={() => setDialog(null)}>
              Cancel
            </button>
            <button className="btn btn--primary" disabled={!name.trim()} onClick={() => commit(name.trim(), dialog === 'update' ? active : undefined)}>
              {dialog === 'update' ? 'Save changes' : 'Save scene'}
            </button>
          </>
        }
      >
        <div className="field">
          <label>Scene name</label>
          <input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && name.trim() && commit(name.trim(), dialog === 'update' ? active : undefined)} />
        </div>
        <div className="scene-parts">
          {SCENE_PARTS.map(({ key, label }) => {
            const p = parts[key]
            const ent = p.id ? store.get(p.id) : undefined
            const status = !ent ? { text: `will be saved as “${name.trim() || '…'} · ${key === 'rendering' ? 'style' : key}”`, cls: 'badge--info' } : p.dirty ? { text: `“${displayLabel(ent)}” — changes will be saved`, cls: 'badge--warn' } : { text: `“${displayLabel(ent)}”`, cls: 'badge--ok' }
            return (
              <div key={key} className="scene-part">
                <span className="scene-part__label">{label}</span>
                <span className={`badge ${status.cls}`}>{!ent ? 'new' : p.dirty ? 'update' : 'saved'}</span>
                <span className="scene-part__status">{status.text}</span>
                <span className="scene-part__summary muted">{p.summary}</span>
              </div>
            )
          })}
          <div className="scene-part">
            <span className="scene-part__label">View</span>
            <span className="badge">{renderer.toUpperCase()}</span>
            <span className="scene-part__status muted">Loading the scene switches to this view.</span>
          </div>
        </div>
      </Dialog>

      <Dialog
        open={dialog === 'rename'}
        title="Rename scene"
        onClose={() => setDialog(null)}
        footer={
          <>
            <button className="btn" onClick={() => setDialog(null)}>
              Cancel
            </button>
            <button className="btn btn--primary" disabled={!name.trim()} onClick={() => (active && store.update(active.id, { label: name.trim() }), setDialog(null))}>
              Rename
            </button>
          </>
        }
      >
        <div className="field">
          <label>Name</label>
          <input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} />
        </div>
      </Dialog>

      <ConfirmDialog
        open={!!pendingDelete}
        title={`Delete scene “${pendingDelete ? displayLabel(pendingDelete) : ''}”?`}
        message="Only the scene is removed; its filter, layout, and style stay saved."
        confirmLabel="Delete"
        danger
        onConfirm={() => {
          if (pendingDelete) {
            store.remove(pendingDelete.id)
            if (pendingDelete.id === sceneId) onUnload()
          }
          setPendingDelete(null)
        }}
        onCancel={() => setPendingDelete(null)}
      />
    </>
  )
}
