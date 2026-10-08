import { Lock, Unlock } from 'lucide-react'
import { useState } from 'react'
import { Dialog } from '../../components/ui/Dialog'
import { displayLabel } from '../../core/entity/entity'
import { headerComment, scriptKindOf, SCRIPT_SUBTYPES, type ScriptEntity, type ScriptSubtype } from './script'
import { Select } from '../../components/ui/Select'

/**
 * The dialogs of the Scripts page. Details: what a saved script carries
 * beside its code — name, description, kind — and its lock; a locked
 * script's fields are read-only until it is unlocked here. Save as: a name
 * for a new script (the first save, or a copy). Unsaved: what to do with
 * edits before an action that would replace them.
 */

export interface ScriptDetails {
  label: string
  description: string
  subtype: ScriptSubtype | null
  locked: boolean
  /** The entity types the script reads; empty means the whole project. */
  types: string[]
}

export function ScriptDetailsDialog({ script, onClose, onSave }: { script: ScriptEntity; onClose: () => void; onSave: (details: ScriptDetails) => void }) {
  const [label, setLabel] = useState(displayLabel(script))
  const [description, setDescription] = useState(script.description ?? '')
  const [subtype, setSubtype] = useState<ScriptSubtype | null>(scriptKindOf(script.type) ?? null)
  const [locked, setLocked] = useState(!!script.data.locked)
  const [types, setTypes] = useState((script.data.types ?? []).join(', '))
  // A locked script's fields open only once the lock is unticked: the lock is the one thing it lets you change.
  // Ticking the lock on an unlocked script leaves the fields open until the details are saved.
  const readOnly = !!script.data.locked && locked
  const fromCode = !script.description?.trim() ? headerComment(script.data.code) : ''
  const submit = () =>
    onSave({
      label: label.trim() || displayLabel(script),
      description,
      subtype,
      locked,
      types: types
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean),
    })
  return (
    <Dialog
      open
      title="Script details"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn--primary" onClick={submit}>
            Save details
          </button>
        </>
      }
    >
      <div className="sc__details">
        <div className="field">
          <label>Name</label>
          <input className="input" autoFocus={!readOnly} value={label} disabled={readOnly} onChange={(e) => setLabel(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} />
        </div>
        <div className="field">
          <label>Description</label>
          <textarea className="input" rows={5} value={description} disabled={readOnly} placeholder={fromCode ? `Until there is one, the comment the script opens with stands in:\n${fromCode.slice(0, 200)}` : 'What this script shows and how to read it (Markdown)'} onChange={(e) => setDescription(e.target.value)} />
        </div>
        <div className="field">
          <label>Kind</label>
          <Select className="input" value={subtype ?? ''} disabled={readOnly} onChange={(e) => setSubtype((e.target.value || null) as ScriptSubtype | null)}>
            <option value="">None — a plain script</option>
            {SCRIPT_SUBTYPES.map((k) => (
              <option key={k.id} value={k.id}>
                {k.label} — {k.hint}
              </option>
            ))}
          </Select>
        </div>
        <div className="field">
          <label>Types it reads</label>
          <input className="input" value={types} disabled={readOnly} placeholder="Every type in the project" onChange={(e) => setTypes(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} />
          <p className="sc__hint">
            A script is handed the whole project unless it says otherwise. Name the types it reads — <code>genus, ward</code> — and it gets those, their subtypes and the relationships between them: what makes a project of hundreds of thousands of
            entities scriptable, and what makes every first run faster.
          </p>
        </div>
        <label className="sc__lock">
          <input type="checkbox" checked={locked} onChange={(e) => setLocked(e.target.checked)} />
          {locked ? <Lock size={13} /> : <Unlock size={13} />}
          <span>
            <b>Locked</b> — the code, name, description and kind cannot be overwritten and the script cannot be deleted; Save as makes a copy. {locked ? 'Untick to edit it.' : ''}
          </span>
        </label>
      </div>
    </Dialog>
  )
}

export function SaveAsDialog({ initial, title, onClose, onSubmit }: { initial: string; title: string; onClose: () => void; onSubmit: (label: string) => void }) {
  const [label, setLabel] = useState(initial)
  const submit = () => onSubmit(label.trim() || 'Script')
  return (
    <Dialog
      open
      title={title}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn--primary" onClick={submit}>
            Save
          </button>
        </>
      }
    >
      <div className="field">
        <label>Name</label>
        <input className="input" autoFocus value={label} placeholder="Degree by type, Orphan papers…" onChange={(e) => setLabel(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} onFocus={(e) => e.target.select()} />
      </div>
    </Dialog>
  )
}

/**
 * Edits that would be lost by what was asked (opening another script, a new
 * script, a template…): save them first, let them go, or stay.
 */
export function UnsavedDialog({ name, canSave, onSave, onDiscard, onClose }: { name: string; /** False when the script is unsaved or locked: the save is a Save as. */ canSave: boolean; onSave: () => void; onDiscard: () => void; onClose: () => void }) {
  return (
    <Dialog
      open
      title="Unsaved changes"
      description={`“${name}” has edits that have not been saved. They are kept as a draft only while you stay on it.`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn--danger" onClick={onDiscard}>
            Discard
          </button>
          <button className="btn btn--primary" onClick={onSave}>
            {canSave ? 'Save' : 'Save as…'}
          </button>
        </>
      }
    />
  )
}
