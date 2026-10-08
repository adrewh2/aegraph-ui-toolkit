import { Check, ChevronDown, Pencil, Plus, Save, Trash2, X } from 'lucide-react'
import { useState, type ComponentType } from 'react'
import { ConfirmDialog, Dialog } from '../../components/ui/Dialog'
import { DROPDOWN_GAP, Menu, type MenuItem } from '../../components/ui/Menu'
import { useToast } from '../../components/ui/useToast'
import { displayLabel } from '../../core/entity/entity'
import { useEntityStore, useStoreVersion } from '../../core/entity/hooks'
import type { AnyEntity, EntityId } from '../../core/entity/types'
import { formatDate } from '../../lib/format'

/**
 * One kind of saved graph artefact — a filter, a layout, a style, an
 * analysis — as the explorer holds it: nothing loaded, or a saved entity
 * loaded and either as saved or edited since. The entity is never written
 * by an edit: what is on screen is a working copy, and only Save writes it
 * back (or Save as… makes a new one). Loading another never asks about the
 * edits — a filter, a layout or a style is cheap to make again, and the
 * saved one is untouched. Two renderings share the logic: `SavedPicker`,
 * a dropdown button (the toolbar's analysis picker), and `PartHeader`, the
 * strip at the top of the Filter, Layout and Style panels.
 */
export interface SavedProps {
  /** The type listed — or, with `types`, several (a type and its subtypes). */
  type: string
  types?: readonly string[]
  noun: string
  icon: ComponentType<{ size?: number }>
  activeId?: EntityId
  /** Edited since it was loaded or last saved. */
  dirty: boolean
  /** One-line description of the current state. */
  summary: string
  onLoad: (entity: AnyEntity) => void
  /** Persist the current state; `existing` when updating the loaded one. */
  onSave: (name: string, existing?: AnyEntity) => void
  onClear: () => void
  clearLabel?: string
}

/** The pieces both renderings are made of: the list, the menu, the dialogs. */
function useSaved({ type, types, noun, activeId, dirty, summary, onLoad, onSave, onClear, clearLabel = 'Reset' }: SavedProps) {
  const store = useEntityStore()
  useStoreVersion(store)
  const toast = useToast()
  const [menu, setMenu] = useState<{ x: number; y: number; width: number; anchor: Element } | null>(null)
  const [naming, setNaming] = useState<'new' | 'rename' | null>(null)
  const [name, setName] = useState('')
  const [pendingDelete, setPendingDelete] = useState<AnyEntity | null>(null)

  const saved = (types ? store.query({ type: [...types] }) : store.ofType(type)).sort((a, b) => b.meta.updatedAt.localeCompare(a.meta.updatedAt))
  const active = activeId ? store.get(activeId) : undefined
  const title = active ? displayLabel(active) : `Unsaved ${noun}`

  const saveExisting = () => {
    if (!active) return
    onSave(displayLabel(active), active)
    toast(`${cap(noun)} saved`)
  }
  const saveAs = () => (setName(active ? `${displayLabel(active)} copy` : ''), setNaming('new'))
  const openMenu = (e: { currentTarget: Element }) => setMenu(menu ? null : { x: e.currentTarget.getBoundingClientRect().left, y: e.currentTarget.getBoundingClientRect().bottom + DROPDOWN_GAP, width: e.currentTarget.getBoundingClientRect().width, anchor: e.currentTarget })

  const loadItems: MenuItem[] = [
    { kind: 'label' as const, label: `Saved ${plural(noun)}` },
    ...(saved.length
      ? saved.map<MenuItem>((e) => ({
          kind: 'item',
          label: `${displayLabel(e)}  ·  ${formatDate(e.meta.updatedAt)}`,
          icon: e.id === activeId ? Check : undefined,
          onSelect: () => onLoad(e),
        }))
      : [{ kind: 'item' as const, label: `No saved ${plural(noun)} yet`, disabled: true, onSelect: () => {} }]),
  ]
  const manageItems: MenuItem[] = [
    ...(active
      ? [
          { kind: 'item', label: `Save changes to “${displayLabel(active)}”`, icon: Save, disabled: !dirty, onSelect: saveExisting } as MenuItem,
          { kind: 'item', label: 'Rename…', icon: Pencil, onSelect: () => (setName(displayLabel(active)), setNaming('rename')) } as MenuItem,
          { kind: 'item', label: 'Delete…', icon: Trash2, danger: true, onSelect: () => setPendingDelete(active) } as MenuItem,
        ]
      : []),
    { kind: 'item' as const, label: `Save as new ${noun}…`, icon: Save, onSelect: saveAs },
    { kind: 'item' as const, label: clearLabel, icon: X, onSelect: onClear },
  ]

  const dialogs = (
    <>
      <Dialog
        open={naming !== null}
        title={naming === 'rename' ? `Rename ${noun}` : `Save ${noun}`}
        description={naming === 'new' ? summary : undefined}
        onClose={() => setNaming(null)}
        footer={
          <>
            <button className="btn" onClick={() => setNaming(null)}>
              Cancel
            </button>
            <button
              className="btn btn--primary"
              disabled={!name.trim()}
              onClick={() => {
                if (naming === 'rename' && active) store.update(active.id, { label: name.trim() })
                else onSave(name.trim())
                toast(naming === 'rename' ? 'Renamed' : `${cap(noun)} saved`)
                setNaming(null)
              }}
            >
              {naming === 'rename' ? 'Rename' : 'Save'}
            </button>
          </>
        }
      >
        <div className="field">
          <label>Name</label>
          <input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && name.trim() && (naming === 'rename' && active ? store.update(active.id, { label: name.trim() }) : onSave(name.trim()), setNaming(null))} />
        </div>
      </Dialog>
      <ConfirmDialog
        open={!!pendingDelete}
        title={`Delete ${noun} “${pendingDelete ? displayLabel(pendingDelete) : ''}”?`}
        message="The saved definition is removed. Nothing else changes."
        confirmLabel="Delete"
        danger
        onConfirm={() => {
          if (pendingDelete) {
            store.remove(pendingDelete.id)
            if (pendingDelete.id === activeId) onClear()
          }
          setPendingDelete(null)
        }}
        onCancel={() => setPendingDelete(null)}
      />
    </>
  )

  const askRename = () => active && (setName(displayLabel(active)), setNaming('rename'))
  const askDelete = () => active && setPendingDelete(active)

  return { active, title, saved, menu, setMenu, openMenu, loadItems, manageItems, saveExisting, saveAs, askRename, askDelete, dialogs }
}

/** A dropdown button: the loaded name (or "Unsaved …"), a dot when edited, and everything in one menu. */
export function SavedPicker(props: SavedProps) {
  const { icon: Icon, dirty, summary } = props
  const s = useSaved(props)
  return (
    <>
      <button className={`btn btn--sm gx-picker ${dirty ? 'is-dirty' : ''}`} onClick={s.openMenu} title={summary}>
        <Icon size={13} />
        <span className="gx-picker__label">
          {s.title}
          {dirty && ' •'}
        </span>
        <ChevronDown size={12} />
      </button>
      {s.menu && <Menu dropdown minWidth={s.menu.width} x={s.menu.x} y={s.menu.y} anchor={s.menu.anchor} items={[...s.loadItems, { kind: 'sep' }, ...s.manageItems]} onClose={() => s.setMenu(null)} />}
      {s.dialogs}
    </>
  )
}

/**
 * The strip at the top of a panel, in the scene's pattern (`SceneSave`): the part as a dropdown — its icon, the
 * loaded one's name (or "Load filter"), a dot while it has changes the saved one has not, a chevron — then Save and
 * Save as… as icons, the only buttons. The dropdown lists the saved ones to load (the loaded one ticked) and holds
 * Rename…, Delete… and the panel's reset (clear the filter, unload the layout, the default style). Save writes the
 * loaded entity and is live only when there is one with changes; Save as… keeps what is here as a new one.
 */
export function PartHeader(props: SavedProps) {
  const { icon: Icon, dirty, summary, noun, clearLabel = 'Reset' } = props
  const s = useSaved(props)
  const loaded = !!s.active
  const items: MenuItem[] = [
    ...s.loadItems,
    { kind: 'sep' },
    ...(loaded
      ? [
          { kind: 'item', label: 'Rename…', icon: Pencil, onSelect: s.askRename } as MenuItem,
          { kind: 'item', label: 'Delete…', icon: Trash2, danger: true, onSelect: s.askDelete } as MenuItem,
        ]
      : []),
    { kind: 'item', label: clearLabel, icon: X, onSelect: props.onClear },
  ]
  return (
    <div className={`gx-part ${loaded ? 'is-loaded' : ''} ${dirty ? 'is-dirty' : ''}`}>
      <button
        className={`btn btn--sm gx-part__pick ${loaded && dirty ? 'is-dirty' : ''}`}
        aria-haspopup="menu"
        aria-expanded={!!s.menu}
        onClick={s.openMenu}
        title={loaded ? `${s.title}${dirty ? ' — changed since it was saved' : ''} · ${summary}\nClick to load another, rename or ${clearLabel.toLowerCase()}` : `${summary}\nLoad a saved ${noun}`}
      >
        <Icon size={16} />
        <span className="gx-part__label">{loaded ? s.title : `Load ${noun}`}</span>
        {loaded && dirty && <span className="gx-scene__dot" aria-label="Changed since it was saved" />}
        <ChevronDown size={12} />
      </button>
      <button className="btn btn--sm btn--icon" aria-label={`Save the ${noun}`} disabled={!loaded || !dirty} onClick={s.saveExisting} title={loaded ? (dirty ? `Save the changes to “${s.title}”` : `Nothing changed since the ${noun} was saved`) : `No ${noun} loaded — Save as… makes one`}>
        <Save size={16} />
      </button>
      <button className="btn btn--sm btn--icon" aria-label={`Save as a new ${noun}`} onClick={s.saveAs} title={loaded ? `Save as a new ${noun} — “${s.title}” stays as it was` : `Save as a new ${noun}`}>
        <SaveAsIcon size={16} />
      </button>
      {s.menu && <Menu dropdown minWidth={s.menu.width} x={s.menu.x} y={s.menu.y} anchor={s.menu.anchor} items={items} onClose={() => s.setMenu(null)} />}
      {s.dialogs}
    </div>
  )
}

/** Save as…: the disk with a plus at its bottom right, cut out of the disk by the button's own colour. */
export function SaveAsIcon({ size = 13 }: { size?: number }) {
  return (
    <span className="save-as-icon" aria-hidden>
      <Save size={size} />
      <span className="save-as-icon__plus">
        <Plus size={Math.max(8, Math.round(size * 0.62))} strokeWidth={3.5} />
      </span>
    </span>
  )
}

/** analysis → analyses, style → styles: enough English for the nouns the pickers use. */
const plural = (n: string) => (/is$/.test(n) ? `${n.slice(0, -2)}es` : /(s|x|z|ch|sh)$/.test(n) ? `${n}es` : /[^aeiou]y$/.test(n) ? `${n.slice(0, -1)}ies` : `${n}s`)
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
