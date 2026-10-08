import { useEffect, useMemo, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { Dialog } from '../../components/ui/Dialog'
import { useToast } from '../../components/ui/useToast'
import { CATEGORIES, CATEGORY_ORDER, type TypeCategory } from '../../core/entity/categories'
import { displayLabel } from '../../core/entity/entity'
import { useEntityStore, useTypeRegistry } from '../../core/entity/hooks'
import type { EntityId } from '../../core/entity/types'
import { isProjectEntity, scopeCounts } from '../../core/projects/project'
import { formatNumber } from '../../lib/format'
import { saveAsNewProject } from './projectActions'

const TAGS_SHOWN = 16

/**
 * "Save as new project": name and describe the copy on the left, review
 * what it will hold on the right — counts by category and type,
 * relationship types, tags, what the source includes — then save and
 * switch to it. The copy references the same entities; nothing is
 * duplicated.
 */
export function SaveAsProjectDialog({ open, from, onClose }: { open: boolean; from: EntityId | null; onClose: () => void }) {
  const store = useEntityStore()
  const registry = useTypeRegistry()
  const toast = useToast()
  const location = useLocation()
  const origin = from ? store.get(from) : undefined
  const originLabel = isProjectEntity(origin) ? displayLabel(origin) : 'Library'
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [home, setHome] = useState('')
  const [allTags, setAllTags] = useState(false)
  // Prefill from the source each time the dialog opens.
  useEffect(() => {
    if (!open) return
    setName(from ? `${originLabel} copy` : 'Library snapshot')
    setDescription((isProjectEntity(origin) && origin.description) || '')
    setHome((isProjectEntity(origin) && origin.data.home?.route) || location.pathname + location.search)
    setAllTags(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, from])
  const counts = useMemo(() => (open ? scopeCounts(store, from) : null), [open, store, from])
  if (!open || !counts) return null

  const byCategory = new Map<TypeCategory, [string, number][]>()
  for (const [type, n] of Object.entries(counts.byType)) {
    const cat = registry.categoryOf(type)
    byCategory.set(cat, [...(byCategory.get(cat) ?? []), [type, n]])
  }
  const relTypes = Object.entries(counts.byRelationshipType).sort((a, b) => b[1] - a[1])
  const includes = (isProjectEntity(origin) && origin.data.includes) || []
  const tags = allTags ? counts.tags : counts.tags.slice(0, TAGS_SHOWN)
  const submit = () => {
    if (!name.trim() || counts.entities === 0) return
    const r = saveAsNewProject(store, from, { label: name, description: description.trim() || undefined, home: home.trim() ? { route: home.trim() } : undefined }, { route: home.trim() || undefined })
    onClose()
    toast(`Saved “${displayLabel(r.project)}” · ${formatNumber(r.marked)} entities, now open`)
  }
  return (
    <Dialog
      open={open}
      className="save-as"
      title="Save as new project"
      description={`A new project holding what “${originLabel}” holds. Entities are referenced, not copied: a document, scene or workstation in both projects is one thing. The copy keeps this screen state and opens when you save.`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn--primary" onClick={submit} disabled={!name.trim() || counts.entities === 0}>
            Save and open
          </button>
        </>
      }
    >
      <div className="save-as__layout">
        <div className="save-as__form">
          <div className="field">
            <label>Name</label>
            <input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} />
          </div>
          <div className="field field--grow">
            <label>Description</label>
            <textarea className="input" rows={6} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What this copy is for" />
          </div>
          <div className="field">
            <label>Opens on</label>
            <input className="input" value={home} onChange={(e) => setHome(e.target.value)} placeholder="/workstation, /unigraph/2d?scene=…" spellCheck={false} />
          </div>
          <dl className="save-as__facts">
            <dt>From</dt>
            <dd>{originLabel}</dd>
            <dt>Includes</dt>
            <dd>{includes.length ? includes.map((i) => displayLabel(store.get(i) ?? ({ id: i } as never))).join(', ') : '—'}</dd>
          </dl>
        </div>

        <div className="save-as__review">
          <div className="save-as__totals">
            <div>
              <b>{formatNumber(counts.entities)}</b>
              <span>entities</span>
            </div>
            <div>
              <b>{formatNumber(counts.relationships)}</b>
              <span>relationships</span>
            </div>
            <div>
              <b>{formatNumber(counts.tags.length)}</b>
              <span>tags</span>
            </div>
          </div>
          {counts.entities === 0 && <div className="error-text">Nothing to save: this scope is empty.</div>}
          <div className="save-as__columns">
            <div className="save-as__col">
              {CATEGORY_ORDER.filter((c) => byCategory.has(c)).map((c) => (
                <section key={c} className="save-as__group">
                  <h4>{CATEGORIES[c].pluralLabel}</h4>
                  {(byCategory.get(c) ?? [])
                    .sort((a, b) => b[1] - a[1])
                    .map(([type, n]) => (
                      <div key={type} className="save-as__row">
                        <span>{registry.get(type).label}</span>
                        <span className="save-as__n">{formatNumber(n)}</span>
                      </div>
                    ))}
                </section>
              ))}
            </div>
            <div className="save-as__col">
              {relTypes.length > 0 && (
                <section className="save-as__group">
                  <h4>Relationships</h4>
                  {relTypes.map(([type, n]) => (
                    <div key={type} className="save-as__row">
                      <span>{type}</span>
                      <span className="save-as__n">{formatNumber(n)}</span>
                    </div>
                  ))}
                </section>
              )}
            </div>
          </div>
          {counts.tags.length > 0 && (
            <section className="save-as__group save-as__tags">
              <h4>Tags</h4>
              <p>
                {tags.map(([tag, n], i) => (
                  <span key={tag}>
                    {i > 0 && <span className="save-as__dot"> · </span>}
                    {tag} <span className="save-as__n">{formatNumber(n)}</span>
                  </span>
                ))}
                {counts.tags.length > TAGS_SHOWN && (
                  <button type="button" className="save-as__more" onClick={() => setAllTags((v) => !v)}>
                    {allTags ? 'fewer' : `+${formatNumber(counts.tags.length - TAGS_SHOWN)} more`}
                  </button>
                )}
              </p>
            </section>
          )}
        </div>
      </div>
    </Dialog>
  )
}
