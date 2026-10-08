import { ChevronDown, ChevronRight, Minus, Pencil, Plus, Undo2 } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { displayLabel } from '../../../core/entity/entity'
import { useEntityStore, useTypeRegistry } from '../../../core/entity/hooks'
import type { AnyEntity, EntityId } from '../../../core/entity/types'
import { diffList, diffProperties, diffText, excalidrawElements, hunks, isImageValue, isLongText, isOpaqueText, isRecordList, type ListDiff, type PropertyChange } from '../../../core/projects/versioning'
import { entityHref } from '../../../app/routes'
import { formatNumber } from '../../../lib/format'
import { DataImage } from '../../../components/RemoteImage'

/** One entity's change: added, modified (both versions) or removed. */
export type EntityChange = { kind: 'added'; after: AnyEntity } | { kind: 'modified'; before: AnyEntity | undefined; after: AnyEntity } | { kind: 'removed'; before: AnyEntity }

export const changeId = (c: EntityChange) => (c.kind === 'removed' ? c.before.id : c.after.id)
const changeEntity = (c: EntityChange) => (c.kind === 'removed' ? c.before : c.after)

/** Working changes or a commit's, as one list. */
export function toChanges(x: { added: AnyEntity[]; modified: (AnyEntity | { before: AnyEntity | undefined; after: AnyEntity })[]; removed: AnyEntity[] }, before?: (id: EntityId) => AnyEntity | undefined): EntityChange[] {
  const out: EntityChange[] = []
  for (const e of x.added) out.push({ kind: 'added', after: e })
  for (const m of x.modified) {
    if ('after' in m && 'before' in m) out.push({ kind: 'modified', before: m.before, after: m.after })
    else out.push({ kind: 'modified', before: before?.(m.id), after: m })
  }
  for (const e of x.removed) out.push({ kind: 'removed', before: e })
  return out
}

/** The counts line: +3 ~2 −1. */
export function ChangeCounts({ added, modified, removed, className }: { added: number; modified: number; removed: number; className?: string }) {
  return (
    <span className={`vh-counts ${className ?? ''}`}>
      <span className="vh-counts__add" title={`${formatNumber(added)} added`}>
        +{formatNumber(added)}
      </span>
      <span className="vh-counts__mod" title={`${formatNumber(modified)} modified`}>
        ~{formatNumber(modified)}
      </span>
      <span className="vh-counts__del" title={`${formatNumber(removed)} removed`}>
        −{formatNumber(removed)}
      </span>
    </span>
  )
}

const PAGE = 200

/**
 * The GitHub-style file list, for entities: one row per change, grouped
 * added / modified / removed, each row opening to its property diff. A
 * `before` resolver fetches the earlier version of a modified entity when
 * the list did not come with one (working changes: HEAD's copy).
 */
export function ChangeList({ changes, resolveBefore, onRevert, emptyText = 'No changes.' }: { changes: EntityChange[]; resolveBefore?: (id: EntityId) => Promise<AnyEntity | undefined>; onRevert?: (c: EntityChange) => void; emptyText?: string }) {
  const registry = useTypeRegistry()
  const store = useEntityStore()
  const [open, setOpen] = useState<Set<EntityId>>(() => new Set())
  const [limit, setLimit] = useState(PAGE)
  const [typeFilter, setTypeFilter] = useState<string | null>(null)
  if (!changes.length) return <p className="vh-empty">{emptyText}</p>
  const toggle = (id: EntityId) =>
    setOpen((s) => {
      const n = new Set(s)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })
  const byType = new Map<string, number>()
  for (const c of changes) byType.set(changeEntity(c).type, (byType.get(changeEntity(c).type) ?? 0) + 1)
  const shown = (typeFilter ? changes.filter((c) => changeEntity(c).type === typeFilter) : changes).slice(0, limit)
  const groups: { kind: EntityChange['kind']; label: string; icon: ReactNode; items: EntityChange[] }[] = [
    { kind: 'added', label: 'Added', icon: <Plus size={12} />, items: shown.filter((c) => c.kind === 'added') },
    { kind: 'modified', label: 'Modified', icon: <Pencil size={12} />, items: shown.filter((c) => c.kind === 'modified') },
    { kind: 'removed', label: 'Removed', icon: <Minus size={12} />, items: shown.filter((c) => c.kind === 'removed') },
  ]
  const total = typeFilter ? changes.filter((c) => changeEntity(c).type === typeFilter).length : changes.length
  return (
    <div className="vh-list">
      {byType.size > 1 && (
        <div className="vh-types">
          <button className={`vh-type ${typeFilter === null ? 'is-active' : ''}`} onClick={() => setTypeFilter(null)}>
            All <span className="vh-type__n">{formatNumber(changes.length)}</span>
          </button>
          {[...byType]
            .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
            .map(([type, n]) => (
              <button key={type} className={`vh-type ${typeFilter === type ? 'is-active' : ''}`} onClick={() => setTypeFilter(typeFilter === type ? null : type)}>
                {registry.get(type).label} <span className="vh-type__n">{formatNumber(n)}</span>
              </button>
            ))}
        </div>
      )}
      {groups
        .filter((g) => g.items.length)
        .map((g) => (
          <section key={g.kind} className={`vh-group vh-group--${g.kind}`}>
            <h3 className="vh-group__head">
              {g.icon} {g.label} <span className="vh-group__n">{formatNumber(g.items.length)}</span>
            </h3>
            {g.items.map((c) => {
              const e = changeEntity(c)
              const id = changeId(c)
              const isOpen = open.has(id)
              const live = store.get(id)
              return (
                <div key={id} className={`vh-row ${isOpen ? 'is-open' : ''}`}>
                  <button className="vh-row__head" onClick={() => toggle(id)} aria-expanded={isOpen}>
                    {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                    <span className={`vh-mark vh-mark--${c.kind}`}>{c.kind === 'added' ? '+' : c.kind === 'removed' ? '−' : '~'}</span>
                    <span className="vh-row__type">{e.kind === 'relationship' ? `${registry.get(e.type).label} →` : registry.get(e.type).label}</span>
                    <span className="vh-row__label">{describe(e, store)}</span>
                    {c.kind === 'modified' && c.before && <span className="vh-row__summary">{summarize(diffProperties(c.before, c.after))}</span>}
                  </button>
                  <div className="vh-row__actions">
                    {live && c.kind !== 'removed' && (
                      <Link className="btn btn--sm btn--ghost" to={entityHref(live, registry)} title="Open the entity">
                        Open
                      </Link>
                    )}
                    {onRevert && (
                      <button className="btn btn--sm btn--ghost" title={c.kind === 'added' ? 'Take it back out of the project' : c.kind === 'removed' ? 'Put it back as it was' : 'Undo the edit: put back the committed version'} onClick={() => onRevert(c)}>
                        <Undo2 size={12} /> Revert
                      </button>
                    )}
                  </div>
                  {isOpen && <ChangeDetail change={c} resolveBefore={resolveBefore} />}
                </div>
              )
            })}
          </section>
        ))}
      {total > limit && (
        <button className="btn btn--sm vh-more" onClick={() => setLimit((n) => n + PAGE)}>
          Show {formatNumber(Math.min(PAGE, total - limit))} more of {formatNumber(total)}
        </button>
      )}
    </div>
  )
}

/** "A → B" for a relationship, the label for anything else. */
function describe(e: AnyEntity, store: ReturnType<typeof useEntityStore>): string {
  if (e.kind !== 'relationship') return displayLabel(e)
  const end = (id: EntityId) => {
    const x = store.get(id)
    return x ? displayLabel(x) : id
  }
  return `${end(e.source.id)} → ${end(e.target.id)}${e.label ? ` (${e.label})` : ''}`
}

function summarize(changes: PropertyChange[]): string {
  if (!changes.length) return 'bookkeeping only'
  const paths = changes.map((c) => c.path.replace(/^data\./, ''))
  return paths.length <= 3 ? paths.join(', ') : `${paths.slice(0, 3).join(', ')} +${paths.length - 3}`
}

/** The property table (or, for an added/removed entity, its properties) with long texts as line diffs. */
function ChangeDetail({ change, resolveBefore }: { change: EntityChange; resolveBefore?: (id: EntityId) => Promise<AnyEntity | undefined> }) {
  const needsLookup = change.kind === 'modified' && !change.before && !!resolveBefore
  const [before, setBefore] = useState<AnyEntity | undefined | 'loading'>(() => (change.kind === 'modified' ? (change.before ?? (needsLookup ? 'loading' : undefined)) : undefined))
  const id = changeId(change)
  useEffect(() => {
    if (!needsLookup) return
    let cancelled = false
    resolveBefore!(id).then((b) => !cancelled && setBefore(b))
    return () => {
      cancelled = true
    }
  }, [needsLookup, resolveBefore, id])
  if (change.kind === 'modified' && before === 'loading') return <div className="vh-detail vh-empty">Loading the committed version…</div>
  const a = change.kind === 'added' ? undefined : change.kind === 'removed' ? change.before : (before as AnyEntity | undefined)
  const b = change.kind === 'removed' ? undefined : change.after
  const changes = diffProperties(a, b)
  const e = change.kind === 'removed' ? change.before : change.after
  return (
    <div className="vh-detail">
      <div className="vh-detail__id">
        <code>{e.id}</code>
        {change.kind === 'modified' && !a && <span className="badge badge--warn">earlier version not on this device</span>}
      </div>
      {changes.length === 0 ? (
        <p className="vh-empty">Same content; only bookkeeping (timestamps, project marks) differs.</p>
      ) : (
        <table className="vh-props">
          <thead>
            <tr>
              <th>Property</th>
              <th>Before</th>
              <th>After</th>
            </tr>
          </thead>
          <tbody>
            {changes.map((c) => (
              <PropertyRow key={c.path} change={c} />
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

/**
 * One property, rendered by what it holds: a picture side by side, a list of
 * records (messages, annotations, an Excalidraw scene's elements) item by
 * item, long text as a line diff, anything else as before/after.
 */
function PropertyRow({ change }: { change: PropertyChange }) {
  const { path, before, after } = change
  if (isImageValue(path, before) || isImageValue(path, after)) {
    return (
      <tr>
        <td className="vh-props__path">{path}</td>
        <td className="vh-props__before">{typeof before === 'string' ? <Picture src={before} /> : <Value v={before} />}</td>
        <td className="vh-props__after">{typeof after === 'string' ? <Picture src={after} /> : <Value v={after} />}</td>
      </tr>
    )
  }
  const sceneA = excalidrawElements(before)
  const sceneB = excalidrawElements(after)
  if ((sceneA || sceneB) && (before === undefined || sceneA) && (after === undefined || sceneB)) {
    return (
      <tr className="vh-props__text">
        <td className="vh-props__path">{path}</td>
        <td colSpan={2}>
          <ListDiffView diff={diffList(sceneA, sceneB)} noun="element" describe={describeElement} />
        </td>
      </tr>
    )
  }
  if ((isRecordList(before) || isRecordList(after)) && (before === undefined || isRecordList(before)) && (after === undefined || isRecordList(after))) {
    return (
      <tr className="vh-props__text">
        <td className="vh-props__path">{path}</td>
        <td colSpan={2}>
          <ListDiffView diff={diffList(before, after)} noun="item" describe={describeRecord} />
        </td>
      </tr>
    )
  }
  const long = (isLongText(before) || isLongText(after)) && (before === undefined || typeof before === 'string') && (after === undefined || typeof after === 'string')
  if (long && !isOpaqueText(before) && !isOpaqueText(after)) {
    return (
      <tr className="vh-props__text">
        <td className="vh-props__path">{path}</td>
        <td colSpan={2}>
          <TextDiff before={(before as string | undefined) ?? ''} after={(after as string | undefined) ?? ''} />
        </td>
      </tr>
    )
  }
  return (
    <tr>
      <td className="vh-props__path">{path}</td>
      <td className="vh-props__before">
        <Value v={before} />
      </td>
      <td className="vh-props__after">
        <Value v={after} />
      </td>
    </tr>
  )
}

function Picture({ src }: { src: string }) {
  return (
    <span className="vh-pic">
      <DataImage src={src} compact alt="" loading="lazy" />
      <span className="vh-pic__meta">{src.startsWith('data:') ? formatBytes(src.length) : src.replace(/^https?:\/\//, '').slice(0, 60)}</span>
    </span>
  )
}

/** A record in a list, in a few words: its label-ish field, else its type and key. */
function describeRecord(item: Record<string, unknown>, key: string): string {
  for (const k of ['label', 'title', 'name', 'text', 'content', 'role', 'type']) {
    const v = item[k]
    if (typeof v === 'string' && v.trim()) return v.length > 80 ? `${v.slice(0, 80)}…` : v
  }
  return key
}
function describeElement(item: Record<string, unknown>, key: string): string {
  const type = String(item.type ?? 'element')
  const text = typeof item.text === 'string' && item.text.trim() ? ` “${item.text.length > 40 ? `${item.text.slice(0, 40)}…` : item.text}”` : ''
  return `${type}${text} · ${key.slice(0, 8)}`
}

const LIST_ROWS = 60

/** Added / removed / changed items of a list, each changed one with its field changes (positions summarised). */
function ListDiffView({ diff, noun, describe }: { diff: ListDiff; noun: string; describe: (item: Record<string, unknown>, key: string) => string }) {
  const [all, setAll] = useState(false)
  const total = diff.added.length + diff.removed.length + diff.changed.length
  const rows: ReactNode[] = []
  let n = 0
  const push = (node: ReactNode) => {
    if (all || n < LIST_ROWS) rows.push(node)
    n++
  }
  for (const x of diff.added) push(<div key={`+${x.key}`} className="vh-line vh-line--add"><span className="vh-line__op">+</span>{describe(x.item, x.key)}</div>)
  for (const x of diff.removed) push(<div key={`-${x.key}`} className="vh-line vh-line--del"><span className="vh-line__op">−</span>{describe(x.item, x.key)}</div>)
  for (const x of diff.changed) {
    const moved = x.changes.filter((c) => /^(x|y|width|height|angle|points|seed|version|versionNonce|updated)$/.test(c.path))
    const rest = x.changes.filter((c) => !moved.includes(c))
    push(
      <div key={`~${x.key}`} className="vh-line vh-line--mod">
        <span className="vh-line__op">~</span>
        <span>
          {describe(x.after, x.key)}
          <span className="vh-row__summary">
            {' '}
            {rest.map((c) => `${c.path}: ${short(c.before)} → ${short(c.after)}`).join(' · ')}
            {moved.length ? `${rest.length ? ' · ' : ''}moved/resized` : ''}
          </span>
        </span>
      </div>,
    )
  }
  return (
    <div className="vh-text">
      <div className="vh-text__bar">
        <span>
          {formatNumber(diff.added.length)} added · {formatNumber(diff.removed.length)} removed · {formatNumber(diff.changed.length)} changed · {formatNumber(diff.unchanged)} unchanged {noun}s{diff.by ? ` (by ${diff.by})` : ' (by position)'}
        </span>
        {total > LIST_ROWS && (
          <button className="btn btn--sm btn--ghost" onClick={() => setAll((a) => !a)}>
            {all ? `Show first ${LIST_ROWS}` : `Show all ${formatNumber(total)}`}
          </button>
        )}
      </div>
      <div className="vh-text__body">{rows}</div>
    </div>
  )
}

const short = (v: unknown): string => {
  if (v === undefined) return '—'
  const s = typeof v === 'string' ? v : JSON.stringify(v)
  return s.length > 40 ? `${s.slice(0, 40)}…` : s
}

function Value({ v }: { v: unknown }) {
  if (v === undefined) return <span className="vh-absent">—</span>
  if (isOpaqueText(v)) return <span className="vh-opaque">{v.startsWith('data:') ? `${v.slice(5, v.indexOf(';') > 0 ? v.indexOf(';') : 30)} · ` : ''}{formatBytes(v.length)}</span>
  if (typeof v === 'string') return <span className="vh-str">{v}</span>
  if (typeof v === 'number' || typeof v === 'boolean' || v === null) return <code>{String(v)}</code>
  const s = JSON.stringify(v)
  return <code className="vh-json" title={s.length > 400 ? s.slice(0, 2000) : undefined}>{s.length > 400 ? `${s.slice(0, 400)}… (${formatBytes(s.length)})` : s}</code>
}

const formatBytes = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`)

/** A unified line diff with context folded. */
export function TextDiff({ before, after }: { before: string; after: string }) {
  const [full, setFull] = useState(false)
  const lines = diffText(before, after)
  const rows = full ? lines : hunks(lines, 3)
  const changed = lines.filter((l) => l.op !== ' ').length
  return (
    <div className="vh-text">
      <div className="vh-text__bar">
        <span>
          {formatNumber(lines.filter((l) => l.op === '+').length)} added · {formatNumber(lines.filter((l) => l.op === '-').length)} removed lines
        </span>
        {changed < lines.length && (
          <button className="btn btn--sm btn--ghost" onClick={() => setFull((f) => !f)}>
            {full ? 'Fold unchanged' : 'Show all lines'}
          </button>
        )}
      </div>
      <pre className="vh-text__body">
        {rows.map((r, i) =>
          'skipped' in r ? (
            <div key={i} className="vh-line vh-line--skip">
              ⋯ {formatNumber(r.skipped)} unchanged line{r.skipped === 1 ? '' : 's'}
            </div>
          ) : (
            <div key={i} className={`vh-line vh-line--${r.op === '+' ? 'add' : r.op === '-' ? 'del' : 'ctx'}`}>
              <span className="vh-line__op">{r.op}</span>
              {r.text || ' '}
            </div>
          ),
        )}
      </pre>
    </div>
  )
}

