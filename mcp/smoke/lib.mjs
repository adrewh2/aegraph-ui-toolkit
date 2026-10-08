export const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !detail ? '' : ` — ${detail}`}`)
  // Finish the step's cleanup, but never report a failed smoke as a green command.
  if (!ok) process.exitCode = 1
}
export const LABEL = 'Smoke project'

/**
 * A step's tidy-up, checked rather than hoped for. Call it after the step's own delete with every id the step
 * made: it asks the store what is still there. Written because step 25's tidy was a swallowed
 * `.catch(() => {})` and had never once worked — three maps and six places were sitting in the shared profile
 * before anyone looked, and the run that was supposed to notice used a fresh profile, so it noticed nothing.
 * A delete raises a confirmation in the tab (the driver accepts it), so tidy from a page that can answer: not
 * from a dead address like `/maps/new`, and not before the tab has announced its tools again after a reload.
 */
export const tidied = async (evaluate, ids, before) => {
  const wanted = ids.filter(Boolean)
  const left = await evaluate(`(() => { const want = new Set(${JSON.stringify(wanted)}); return window.__aegraph.store.library.all().filter((e) => want.has(e.id)).map((e) => e.type + ' ' + e.id) })()`)
  check('the run takes what it made away with it', left.length === 0, left.length ? `${left.length} of ${wanted.length} left behind: ${left.join(', ').slice(0, 160)}` : '')
  // And the profile is the size it was. Naming ids is not enough on its own: a step that makes three entities and
  // six relationships and deletes the three passes the check above and still grows the shared profile every run.
  // 237 entities from one step were sitting in mcp-profile when this was written.
  if (before !== undefined) {
    const now = await counted(evaluate)
    check('and the profile is the size it found it', now === before, `${before} → ${now}`)
  }
}

/** How much is in the library, for the size check above: read it before the step makes anything. */
export const counted = async (evaluate) => evaluate(`window.__aegraph.store.library.all().length`)

/**
 * The state a step starts from, said out loud. The steps share one profile, and several change what the next
 * one sees: the open project scopes every page and every tool, and the remembered view — filter, layout, held
 * positions, the workstation arrangement — is read back on mount. Until wake-up 141 no step said which state
 * it wanted, so its result depended on what ran before it: step 11 reported 4 of 9 because an earlier step had
 * left a project open and it was reading thirty entities, and step 15's three failures were a filter another
 * step had left behind. Neither was a defect in the page it was testing.
 *
 *   'library'  the Library open and nothing of the suite's own left in the store, with the remembered view as
 *              the profile has it — what a step wants when it relies on a page being arranged already.
 *   'fresh'    the same, and the remembered view cleared: no filter, no layout, no workstation.
 *
 * It prints what it did, so a run's log says which state it began from rather than leaving the reader to guess.
 */
export const startFrom = async ({ call, evaluate, sleep }, state = 'library') => {
  const stale = (await call('project_list')).projects.filter((p) => /^(Smoke|Probe)/.test(p.label ?? p.name ?? ''))
  for (const p of stale) {
    // A project another run left behind holds entities this one will count; exclusive_entities takes those with it.
    try {
      await call('project_delete', { id: p.id, exclusive_entities: true })
    } catch {
      /* already gone */
    }
  }
  await call('project_open', {})
  const ids = await evaluate(`window.__aegraph.store.library.all().filter((e) => e.id.startsWith('dg-') || /smoke|probe/i.test(e.label ?? '') || (e.tags ?? []).some((t) => /^smoke-|^probe-/.test(t))).map((e) => e.id)`)
  if (ids.length) await call('delete_entities', { ids })
  let cleared = 0
  if (state === 'fresh') {
    cleared = await evaluate(`(() => { const keys = Object.keys(localStorage).filter((k) => /^aegraph:(explorer|workstation|entities|analytics|plots|display|graph)/.test(k)); for (const k of keys) localStorage.removeItem(k); return keys.length })()`)
    // The pages read those keys when they mounted, so removing them under a live page changes nothing until it is
    // loaded again. The reload takes the tab's websocket with it: wait for the tab to announce its tools before
    // handing the step a bridge that answers "Unknown tool" to everything.
    await evaluate(`location.reload(); 1`)
    for (let i = 0; i < 60; i++) {
      await sleep(500)
      if ((await call('aegraph_bridge_status')).tools?.length) break
    }
  }
  console.log(`     starting from the ${state === 'fresh' ? 'Library with a fresh view' : 'Library'}: ${stale.length} project(s) and ${ids.length} entities swept${state === 'fresh' ? `, ${cleared} view keys cleared, page reloaded` : ''}`)
}

/**
 * The app's dropdowns are its own (`components/ui/Select`), not the browser's: a `.select-trigger` button whose
 * choices open in a `.menu`. `trigger` is an expression for the button. `selectOptions` opens it and returns the
 * choices' text; `selectPick` picks the first choice whose text matches `match` (a regex source; with `other`, the
 * first choice that is not the current one) — opening the menu first when it is not already open — and returns the
 * text picked, or null.
 */
export async function selectOptions({ evaluate, sleep }, trigger) {
  const opened = await evaluate(`(() => { const b = ${trigger}; if (!b) return false; if (!document.querySelector('.menu')) b.click(); return true })()`)
  if (!opened) return null
  await sleep(300)
  return evaluate(`[...document.querySelectorAll('.menu .menu__item')].map((b) => b.textContent.trim())`)
}
export async function selectPick({ evaluate, sleep }, trigger, match, { other = false } = {}) {
  if ((await selectOptions({ evaluate, sleep }, trigger)) === null) return null
  const picked = await evaluate(`(() => {
    const items = [...document.querySelectorAll('.menu .menu__item')].filter((b) => !b.disabled)
    const re = new RegExp(${JSON.stringify(match ?? '')}, 'i')
    // The current choice is the focused one as the menu opens.
    const b = ${other ? 'items.find((x) => x !== document.activeElement && x.textContent.trim())' : 'items.find((x) => re.test(x.textContent))'}
    if (!b) return null
    b.click()
    return b.textContent.trim()
  })()`)
  await sleep(300)
  return picked
}
