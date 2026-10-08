import type { BetaRunnableTool } from '@anthropic-ai/sdk/lib/tools/BetaRunnableTool'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createEntity, createRelationship } from '../../../core/entity/entity'
import { EntityStore } from '../../../core/entity/store'
import '../../../core/graph/types'
import '../../../core/resources/types'
import { getProjectHistory } from '../../../core/projects/history'
import { MemoryBlobs } from '../../../core/projects/historyBlobs'
import { createProject } from '../../../core/projects/project'
import { createAppTools, type AppHost } from '../tools'

/** The version-control tools: changes, commit, history, restore, and the autosave setting on project_update. */

function host(store: EntityStore): AppHost {
  return { store, navigate: () => {}, getContext: () => ({ route: '/entities' }), confirm: async () => true }
}
const tool = (tools: ReturnType<typeof createAppTools>, name: string) => {
  const t = tools.find((x) => x.name === name) as BetaRunnableTool | undefined
  if (!t) throw new Error(`no tool ${name}`)
  return async (input: unknown) => {
    const r = await t.run(t.parse(input))
    return JSON.parse(typeof r === 'string' ? r : JSON.stringify(r)) as Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
  }
}

describe('version-control tools', () => {
  beforeEach(() => {
    const mem: Record<string, string> = {}
    const fake = { getItem: (k: string) => mem[k] ?? null, setItem: (k: string, v: string) => (mem[k] = v), removeItem: (k: string) => delete mem[k], clear: () => Object.keys(mem).forEach((k) => delete mem[k]), key: () => null, length: 0 }
    vi.stubGlobal('localStorage', fake)
    vi.stubGlobal('sessionStorage', { ...fake })
  })
  afterEach(() => vi.unstubAllGlobals())

  it('commits, lists, diffs and restores', async () => {
    const store = new EntityStore()
    getProjectHistory(store, new MemoryBlobs())
    store.upsert(createProject({ id: 'p', label: 'P' }))
    store.setScope('p')
    store.upsertMany([createEntity({ id: 'doc', type: 'document', label: 'Notes', data: { content: 'line one\nline two\nline three' } }), createEntity({ id: 'x', type: 'note', label: 'X' }), createRelationship({ id: 'r', type: 'references', source: 'doc', target: 'x' })])
    const tools = createAppTools(host(store))
    const changes = tool(tools, 'project_changes')
    const commit = tool(tools, 'project_commit')
    const history = tool(tools, 'project_history')
    const restore = tool(tools, 'project_restore')
    const update = tool(tools, 'project_update')

    let c = await changes({ detail: 'counts' })
    expect(c.head).toBeNull()
    expect(c.counts).toEqual({ added: 3, modified: 0, removed: 0, total: 3 })

    const first = await commit({ message: 'Initial' })
    expect(first.commit.stats).toEqual({ added: 3, modified: 0, removed: 0 })
    expect((await commit({ message: 'again' })).nothing_to_commit).toBe(true)

    store.update('doc', { data: { content: 'line one\nline 2\nline three\nline four' } })
    store.remove('x')
    c = await changes({ detail: 'full' })
    expect(c.counts).toEqual({ added: 0, modified: 1, removed: 2, total: 3 })
    const prop = c.modified[0].properties.find((p: { path: string }) => p.path === 'data.content')
    expect(prop.text_diff).toEqual(['- line two', '+ line 2', '+ line four'])
    expect(prop.added_lines).toBe(2)
    expect(c.removed.map((e: { id: string }) => e.id).sort()).toEqual(['r', 'x'])

    const second = await commit({ message: 'Edit the doc, drop x' })
    let log = await history({})
    expect(log.commits.map((x: { message: string }) => x.message)).toEqual(['Edit the doc, drop x', 'Initial'])
    const one = await history({ commit: second.commit.short })
    expect(one.modified[0].id).toBe('doc')
    expect(one.modified[0].properties[0].path).toBe('data.content')
    expect(one.removed.length).toBe(2)

    const r = await restore({ commit: first.commit.id })
    expect(r.commit.restoredFrom).toBe(first.commit.id)
    expect(store.get('doc')?.data.content).toBe('line one\nline two\nline three')
    expect(store.has('x')).toBe(true)
    log = await history({})
    expect(log.commits.length).toBe(3)

    store.update('doc', { label: 'Renamed' })
    expect((await restore({ entity: 'doc' })).result).toBe('restored')
    expect(store.get('doc')?.label).toBe('Notes')
    store.update('doc', { label: 'Renamed again' })
    // This host can only answer yes/no, which never discards: a yes saves the change as a commit instead.
    expect((await restore({ discard: true })).saved_instead.message).toBe('Save before discarding')
    expect(store.get('doc')?.label).toBe('Renamed again')
    store.update('doc', { label: 'Renamed a third time' })
    // The user's own words can carry the answer.
    const d = await restore({ discard: true, unsaved: 'discard' })
    // Back at HEAD: no commit results — the change is simply gone.
    expect(d.discarded.total).toBe(1)
    expect(d.commit).toBeUndefined()
    expect(d.upserted).toBe(1)
    expect(store.get('doc')?.label).toBe('Renamed again')
    expect((await changes({ detail: 'counts' })).counts.total).toBe(0)

    const u = await update({ autosave: false })
    expect(u.updated.versioning).toEqual({ autosave: false, autosaveDelay: 30 })
    const u2 = await update({ autosave_seconds: 5 })
    expect(u2.updated.versioning).toEqual({ autosave: false, autosaveDelay: 5 })
  })

  /** A project with three commits: a doc written, edited, then a note added and the doc edited again. */
  async function seeded() {
    const store = new EntityStore()
    getProjectHistory(store, new MemoryBlobs())
    store.upsert(createProject({ id: 'p', label: 'P' }))
    store.setScope('p')
    store.upsert(createEntity({ id: 'doc', type: 'document', label: 'Notes', data: { content: 'v1' } }))
    const confirmations: string[] = []
    const questions: { message: string; options: string[] }[] = []
    let answer = true
    let pick: string | null | 'confirm-only' = 'confirm-only'
    const h: AppHost = {
      ...host(store),
      confirm: async (m) => (confirmations.push(m), answer),
      // The question card: scripted answers; 'confirm-only' stands for a runner without one (falls back to confirm).
      choose: async (message, options) => {
        questions.push({ message, options })
        if (pick === 'confirm-only') throw new Error('choose should not be called on this host')
        return pick
      },
    }
    const tools = createAppTools(h)
    const t = (name: string) => tool(tools, name)
    const c1 = (await t('project_commit')({ message: 'First: the doc' })).commit
    store.update('doc', { data: { content: 'v2' } })
    const c2 = (await t('project_commit')({ message: 'Second: edit the doc' })).commit
    store.upsert(createEntity({ id: 'note', type: 'note', label: 'A note' }))
    store.update('doc', { data: { content: 'v3', extra: 1 } })
    const c3 = (await t('project_commit')({ message: 'Third: a note and another edit' })).commit
    const hNo: AppHost = { ...h, choose: undefined }
    return { store, t, c1, c2, c3, confirmations, questions, setAnswer: (v: boolean) => (answer = v), setPick: (v: string | null) => (pick = v), toolsWithoutChoose: createAppTools(hNo) }
  }

  it('names commits by id, short id, a unique prefix, HEAD, HEAD~n and HEAD^; refuses ambiguity and unknowns with a reason', async () => {
    const { t, c1, c2, c3 } = await seeded()
    const history = t('project_history')
    for (const ref of [c1.id, c1.short, c1.short.slice(0, 5), c1.id.replace(/-/g, '').slice(0, 9).toUpperCase(), 'HEAD~2']) expect((await history({ commit: ref })).commit.id, ref).toBe(c1.id)
    expect((await history({ commit: 'HEAD' })).commit.id).toBe(c3.id)
    expect((await history({ commit: 'head^' })).commit.id).toBe(c2.id)
    await expect(history({ commit: 'HEAD~9' })).rejects.toThrow(/past the first commit/)
    await expect(history({ commit: 'zzz' })).rejects.toThrow(/too short/)
    await expect(history({ commit: 'zzzzzzz' })).rejects.toThrow(/No commit "zzzzzzz"/)
    // Every id in the fixture starts with the same characters? Only when they collide — build a real ambiguity instead.
    const common = [c1, c2, c3].map((c) => c.id.replace(/-/g, ''))
    let k = 0
    while (k < 40 && new Set(common.map((x) => x.slice(0, k + 1))).size === 1) k++
    if (k >= 4) await expect(history({ commit: common[0].slice(0, k) })).rejects.toThrow(/matches 3 commits/)
  })

  it('an entity\'s own history, and its content at a commit', async () => {
    const { t, c1, c2, c3, store } = await seeded()
    const history = t('project_history')
    const log = await history({ entity: 'doc' })
    expect(log.history.map((x: { commit: { id: string }; change: string }) => [x.commit.id, x.change])).toEqual([
      [c3.id, 'modified'],
      [c2.id, 'modified'],
      [c1.id, 'added'],
    ])
    expect(log.history[0].changed.sort()).toEqual(['data.content', 'data.extra'])
    expect(log.uncommitted_changes).toBe(false)
    store.update('doc', { label: 'Notes (draft)' })
    expect((await history({ entity: 'doc' })).uncommitted_changes).toBe(true)
    expect((await history({ entity: 'note' })).history).toHaveLength(1)
    expect((await history({ entity: 'ghost' })).note).toMatch(/No commit .* touched/)

    const at = await history({ commit: c2.short, entity: 'doc', content: 'brief' })
    expect(at.content_after.data.content).toBe('v2')
    expect(at.modified).toHaveLength(1)
    const untouched = await history({ commit: c2.short, entity: 'note', content: 'full' })
    expect(untouched.note).toMatch(/did not touch/)
    expect(untouched.content_after).toBeNull()
    const long = 'x'.repeat(5000)
    store.update('doc', { data: { content: long } })
    const c4 = (await t('project_commit')({ message: 'Long' })).commit
    expect((await history({ commit: c4.id, entity: 'doc', content: 'brief' })).content_after.data.content).toMatch(/… \(5000 chars/)
    expect((await history({ commit: c4.id, entity: 'doc', content: 'full' })).content_after.data.content).toBe(long)
  })

  it('compares two commits, or a commit with the working tree, and lists what changed between them', async () => {
    const { t, c1, c3, store } = await seeded()
    const history = t('project_history')
    const d = await history({ from: c1.short, to: 'HEAD' })
    expect(d.from.id).toBe(c1.id)
    expect(d.to.id).toBe(c3.id)
    expect(d.counts).toEqual({ added: 1, modified: 1, removed: 0 })
    expect(d.modified[0].id).toBe('doc')
    expect(d.modified[0].properties.map((p: { path: string }) => p.path).sort()).toEqual(['data.content', 'data.extra'])
    store.remove('note')
    const w = await history({ from: c1.id, to: 'working' })
    expect(w.to).toBe('working')
    expect(w.counts).toEqual({ added: 0, modified: 1, removed: 0 }) // the note came and went since c1
    const narrowed = await history({ from: c1.id, entity: 'nothing' })
    expect(narrowed.counts.modified).toBe(1)
    expect(narrowed.modified).toEqual([])
    await expect(history({ from: c1.id, to: c1.id })).rejects.toThrow(/same commit/)
    await expect(history({ to: 'HEAD' })).rejects.toThrow(/needs `from`/)
  })

  it('filters the log by message, time and autosave', async () => {
    const { t, store } = await seeded()
    const history = t('project_history')
    const mem = getProjectHistory(store)
    store.update('doc', { label: 'auto' })
    await mem.commit('p', '', { auto: true })
    const all = await history({})
    expect(all.total).toBe(4)
    expect(all.commits[0].message).toBe('Autosave')
    expect(all.commits[0].ago).toBe('just now')
    expect((await history({ include_autosave: false })).matched).toBe(3)
    expect((await history({ message: 'DOC' })).commits.map((c: { message: string }) => c.message)).toEqual(['Second: edit the doc', 'First: the doc'])
    expect((await history({ since: '1h' })).matched).toBe(4)
    expect((await history({ until: '2000-01-01' })).matched).toBe(0)
    expect((await history({ since: '2000-01-01T00:00:00Z', limit: 2 })).truncated).toBe(2)
    await expect(history({ since: 'yesterday-ish' })).rejects.toThrow(/not a date/)
  })

  it('restore with unsaved changes shows them and asks: save first (undoable), discard, or cancel', async () => {
    const { t, c1, store, questions, setPick } = await seeded()
    const restore = t('project_restore')
    expect((await restore({ commit: 'HEAD' })).already_there).toBe(true)
    expect(questions).toHaveLength(0) // nothing unsaved: nothing to ask

    store.update('doc', { label: 'Unsaved edit' })
    store.upsert(createEntity({ id: 'n2', type: 'note', label: 'Scratch' }))
    setPick('Cancel')
    const cancelled = await restore({ commit: c1.short })
    expect(cancelled.cancelled).toBe(true)
    expect(cancelled.would_restore.id).toBe(c1.id)
    expect(cancelled.unsaved).toEqual({ added: 1, modified: 1, removed: 0, total: 2 })
    expect(cancelled.changes.modified[0]).toMatchObject({ id: 'doc', label: 'Unsaved edit' })
    expect(questions[0].options).toEqual(['Save them first', 'Discard them', 'Cancel'])
    expect(questions[0].message).toMatch(/“P” has 2 unsaved changes — 1 added: “Scratch” \(note\); 1 modified: “Unsaved edit” \(document\)\. Restoring [0-9a-f]{7} "First: the doc" would lose them/)
    expect(store.get('doc')?.label).toBe('Unsaved edit') // nothing happened

    setPick(null) // closed the card
    expect((await restore({ commit: c1.short })).reason).toMatch(/without choosing/)

    setPick('Save them first')
    const r = await restore({ commit: c1.short })
    expect(r.saved_first.message).toBe(`Before restoring ${c1.short}`)
    expect(r.restored.id).toBe(c1.id)
    expect(r.undo).toBe(`project_restore {commit: "${r.saved_first.short}"}`)
    expect(store.get('doc')?.data.content).toBe('v1')
    expect(store.has('n2')).toBe(false)
    const undone = await restore({ commit: r.saved_first.short })
    expect(store.get('doc')?.label).toBe('Unsaved edit')
    expect(store.has('n2')).toBe(true)
    expect(undone.saved_first).toBeUndefined()

    store.update('doc', { label: 'Throwaway' })
    setPick('Discard them')
    const gone = await restore({ commit: c1.short })
    expect(gone.discarded.total).toBe(1)
    expect(gone.saved_first).toBeUndefined()
    expect(gone.undo).toMatch(/the discarded changes are not in it/)
    expect(store.get('doc')?.data.content).toBe('v1')
  })

  it('the answer can come with the call when the user already said it, and a yes/no-only runner saves first or stops', async () => {
    const { t, c1, store, questions, confirmations, setAnswer, toolsWithoutChoose } = await seeded()
    const restore = t('project_restore')
    store.update('doc', { label: 'Unsaved edit' })
    const r = await restore({ commit: c1.short, unsaved: 'save' })
    expect(questions).toHaveLength(0)
    expect(r.saved_first).toBeDefined()
    // Discarding throws work away, so it is always the user's yes — a call that says "discard" is not their word.
    store.update('doc', { label: 'Again' })
    setAnswer(false)
    const refused = await restore({ commit: c1.short, unsaved: 'discard' })
    expect(refused.cancelled).toBe(true)
    expect(confirmations.at(-1)).toMatch(/throws them away for good\. Discard them\?/)
    expect(store.get('doc')?.label).toBe('Again')
    setAnswer(true)
    const d = await restore({ commit: c1.short, unsaved: 'discard' })
    expect(d.discarded.total).toBe(1)
    expect(questions).toHaveLength(0)
    confirmations.length = 0

    store.update('doc', { label: 'Once more' })
    const plain = tool(toolsWithoutChoose, 'project_restore')
    setAnswer(false)
    expect((await plain({ commit: c1.short })).cancelled).toBe(true)
    expect(confirmations[0]).toMatch(/Yes: save them first and go on\. No: stop here/)
    expect(store.get('doc')?.label).toBe('Once more')
    setAnswer(true)
    expect((await plain({ commit: c1.short })).saved_first.message).toMatch(/Before restoring/)
  })

  it('discard shows the changes and asks; saving instead keeps them as a commit; a no changes nothing', async () => {
    const { t, store, questions, setPick } = await seeded()
    const restore = t('project_restore')
    const changes = t('project_changes')
    expect((await restore({ discard: true })).nothing_to_discard).toBe(true)
    store.update('doc', { label: 'Throwaway' })
    setPick('Cancel')
    const no = await restore({ discard: true })
    expect(no.cancelled).toBe(true)
    expect(no.unsaved.total).toBe(1)
    expect(questions[0].message).toMatch(/Discarding would lose them/)
    expect(store.get('doc')?.label).toBe('Throwaway')
    setPick('Save them first')
    const kept = await restore({ discard: true })
    expect(kept.saved_instead.message).toBe('Save before discarding')
    expect(store.get('doc')?.label).toBe('Throwaway')
    expect((await changes({ detail: 'counts' })).counts.total).toBe(0)
    store.update('doc', { label: 'Really throwaway' })
    setPick('Discard them')
    const d = await restore({ discard: true })
    expect(d.discarded.total).toBe(1)
    expect(d.changes.modified[0].label).toBe('Really throwaway')
    expect(store.get('doc')?.label).toBe('Throwaway')
    await expect(restore({})).rejects.toThrow(/Give a commit/)
    await expect(restore({ discard: true, commit: 'HEAD' })).rejects.toThrow(/not both/)
  })

  it('reverting one entity says what it will undo and asks first', async () => {
    const { t, store, questions, setPick } = await seeded()
    const restore = t('project_restore')
    expect((await restore({ entity: 'doc' })).result).toBe('unchanged')
    store.update('doc', { label: 'Draft', data: { content: 'v4', extra: 1 } })
    setPick('Cancel')
    const no = await restore({ entity: 'doc' })
    expect(no.cancelled).toBe(true)
    expect(no.would).toBe('Revert “Draft” (document) to its committed version, undoing changes to label, data.content')
    expect(questions[0].options).toEqual(['Revert it', 'Cancel'])
    setPick('Revert it')
    const yes = await restore({ entity: 'doc' })
    expect(yes.result).toBe('restored')
    expect(yes.reverted).toEqual(['label', 'data.content'])
    expect(store.get('doc')?.label).toBe('Notes')
    store.upsert(createEntity({ id: 'new', type: 'note', label: 'New one' }))
    expect((await restore({ entity: 'new' })).result).toBe('removed')
    expect(questions[2].message).toBe('Take “New one” (note) out of the project — it was added since the last commit?')
    store.remove('note')
    // `unsaved` does not skip the question: reverting is always asked.
    expect((await restore({ entity: 'note', unsaved: 'discard' })).result).toBe('restored')
    expect(questions).toHaveLength(4)
    await expect(restore({ entity: 'nobody' })).rejects.toThrow(/No entity nobody/)
  })

  it('without a project open, every tool says so rather than guessing', async () => {
    const store = new EntityStore()
    getProjectHistory(store, new MemoryBlobs())
    const tools = createAppTools(host(store))
    for (const name of ['project_changes', 'project_history', 'project_commit', 'project_restore']) {
      await expect(tool(tools, name)(name === 'project_commit' ? { message: 'x' } : {})).rejects.toThrow(/No project is open/)
    }
  })

  it('a commit whose content is missing on this device is reported, not crashed on', async () => {
    const { c2, store } = await seeded()
    const mem = getProjectHistory(store)
    await mem.blobs.delete([c2.id])
    const fresh = new EntityStore()
    // A new history over the same commits but an empty blob store: every commit is missing.
    for (const e of store.library.all()) fresh.upsert(e)
    fresh.setScope('p')
    getProjectHistory(fresh, new MemoryBlobs())
    const tools = createAppTools(host(fresh))
    const one = await tool(tools, 'project_history')({ commit: 'HEAD' })
    expect(one.missing_blob).toBe(true)
    const log = await tool(tools, 'project_history')({ entity: 'doc' })
    expect(log.history.every((x: { change: string }) => x.change === 'unknown')).toBe(true)
    await expect(tool(tools, 'project_history')({ from: 'HEAD~1' })).rejects.toThrow(/no content on this device/)
    const c = await tool(tools, 'project_changes')({ detail: 'counts' })
    expect(c.missing_blobs).toBe(3)
  })
})
