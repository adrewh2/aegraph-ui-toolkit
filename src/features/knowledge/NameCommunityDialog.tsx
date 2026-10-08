import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Dialog } from '../../components/ui/Dialog'
import { useToast } from '../../components/ui/useToast'
import { displayLabel } from '../../core/entity/entity'
import { useEntityStore } from '../../core/entity/hooks'
import { browserHref } from '../../app/openIn'
import { communityEntityFor, nameCommunity } from './claims'
import { describeMembers, memberSample, NAME_COMMUNITY_EVENT, suggestedName, type NameCommunityRequest } from './nameCommunity'

/**
 * "Name this community" from anywhere — the Insights page, the graph's
 * context menu — without threading a dialog through each view: the caller
 * raises a request (a window event) and the one dialog, mounted with the
 * app, answers it. Naming makes a community entity every member belongs to.
 */
export function NameCommunityDialog() {
  const store = useEntityStore()
  const toast = useToast()
  const navigate = useNavigate()
  const [req, setReq] = useState<NameCommunityRequest | null>(null)
  const [label, setLabel] = useState('')
  const [description, setDescription] = useState('')

  useEffect(() => {
    const on = (e: Event) => {
      const r = (e as CustomEvent<NameCommunityRequest>).detail
      const existing = communityEntityFor(store, r.metricsKey, r.community)
      setLabel(existing ? displayLabel(existing) : suggestedName(r.suggested))
      setDescription(existing?.description ?? '')
      setReq(r)
    }
    window.addEventListener(NAME_COMMUNITY_EVENT, on)
    return () => window.removeEventListener(NAME_COMMUNITY_EVENT, on)
  }, [store])

  const existing = useMemo(() => (req ? communityEntityFor(store, req.metricsKey, req.community) : undefined), [store, req])
  const sample = useMemo(() => memberSample(req?.members ?? [], (id) => { const e = store.get(id); return e ? displayLabel(e) : undefined }), [store, req])
  if (!req) return null

  const close = () => setReq(null)
  const submit = () => {
    const name = label.trim()
    if (!name) return
    const r = nameCommunity(store, { label: name, description: description.trim() || undefined, members: req.members, community: req.community, metricsKey: req.metricsKey })
    toast(`${r.created ? 'Named' : 'Renamed'} “${name}” · ${r.members.toLocaleString()} member${r.members === 1 ? '' : 's'} linked`)
    close()
    navigate(browserHref(r.entity))
  }
  const n = req.members.length
  return (
    <Dialog
      open
      title={existing ? 'Rename this community' : 'Name this community'}
      description={`A community entity that ${n.toLocaleString()} member${n === 1 ? '' : 's'} will belong to through member-of relationships — so it can be filtered, styled, linked and asked about like anything else.`}
      onClose={close}
      footer={
        <>
          <button className="btn" onClick={close}>
            Cancel
          </button>
          <button className="btn btn--primary" onClick={submit} disabled={!label.trim()}>
            {existing ? 'Rename' : 'Create'}
          </button>
        </>
      }
    >
      <div className="field">
        <label>Name</label>
        <input className="input" autoFocus value={label} placeholder="What this group is about" onChange={(e) => setLabel(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} />
      </div>
      <div className="field">
        <label>Description</label>
        <textarea className="input" rows={2} value={description} placeholder="Optional — why these belong together" onChange={(e) => setDescription(e.target.value)} />
      </div>
      <p className="muted" style={{ fontSize: 12, margin: '4px 0 0' }}>
        {describeMembers(sample, req.profile)}
      </p>
    </Dialog>
  )
}
