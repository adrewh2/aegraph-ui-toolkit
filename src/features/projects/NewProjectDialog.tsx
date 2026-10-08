import { useState } from 'react'
import { Dialog } from '../../components/ui/Dialog'
import { useToast } from '../../components/ui/useToast'
import { displayLabel } from '../../core/entity/entity'
import { useEntityStore } from '../../core/entity/hooks'
import { switchProject } from '../../core/projects/active'
import { createProject } from '../../core/projects/project'

/**
 * New project: a name and a description, then it is created and opened. Its own file because the sidebar's
 * switcher, the Projects page and the Projects dialog all show it — and the dialog is itself opened from the
 * switcher, so taking it from the switcher's file made an import cycle through the sidebar.
 */
export function NewProjectDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const store = useEntityStore()
  const toast = useToast()
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const submit = () => {
    if (!name.trim()) return
    const p = createProject({ label: name, description })
    store.upsert(p)
    setName('')
    setDescription('')
    onClose()
    switchProject(store, p.id, { route: '/' })
    toast(`Project “${displayLabel(p)}” created — everything you add now goes into it`)
  }
  return (
    <Dialog
      open={open}
      title="New project"
      description="A named scope over the Library. Entities you create or import while it is open belong to it; its layouts, scenes and workstations are its own."
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn--primary" onClick={submit} disabled={!name.trim()}>
            Create and open
          </button>
        </>
      }
    >
      <div className="field">
        <label>Name</label>
        <input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Thesis, ChatGPT export" onKeyDown={(e) => e.key === 'Enter' && submit()} />
      </div>
      <div className="field">
        <label>Description</label>
        <input className="input" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Optional" />
      </div>
    </Dialog>
  )
}
