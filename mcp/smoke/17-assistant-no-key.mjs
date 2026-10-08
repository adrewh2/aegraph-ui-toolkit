/**
 * The assistant when nothing can answer: no API key on this machine (the
 * Claude API is never called from a local run) and the Claude Code
 * bridge switched off. What matters is that the panel says so — in the
 * placeholder before you type and in the thread after you send — rather
 * than swallowing the message or throwing. The driver connects the
 * bridge at startup, so this run turns it off first and puts it back
 * afterwards. No key is entered: there is none here, and the panel must
 * be honest without one.
 *   GL=1 node mcp/drive.mjs mcp/smoke/17-assistant-no-key.mjs
 * or `npm run smoke:assistant`.
 */
import { check } from './lib.mjs'

const PANEL = `(() => {
  const p = document.querySelector('.ai')
  if (!p) return { open: false }
  const input = p.querySelector('textarea')
  return {
    open: true,
    model: p.querySelector('.ai__model')?.textContent.trim() ?? null,
    placeholder: input ? input.getAttribute('placeholder') : null,
    says: p.innerText.replace(/[ ]+/g, ' ').trim(),
    errors: (window.__aegraphErrors ?? []).length,
  }
})()`
const BRIDGE = `(() => {
  const b = document.querySelector('.bridge-item')
  return b ? { text: b.innerText.replace(/[ ]+/g, ' ').trim(), connected: b.classList.contains('bridge-item--connected') } : null
})()`
/** The settings dialog's own switch, the way a person reaches it. */
const setBridge = (on) => `(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  document.querySelector('.bridge-item').click(); await wait(400)
  const toggle = document.querySelector('.bridge-toggle input')
  if (toggle && toggle.checked !== ${on}) toggle.click()
  await wait(300)
  const done = [...document.querySelectorAll('.dialog .btn')].find((b) => b.textContent.trim() === 'Done')
  if (done) done.click()
  return 1
})()`
const toggle = `window.dispatchEvent(new CustomEvent('aegraph:assistant')); 1`

export default async ({ evaluate, sleep, logs }) => {
  await evaluate(`location.assign('/'); 1`)
  await sleep(8000)
  check('the assistant is closed until it is asked for', (await evaluate(PANEL)).open === false)
  await evaluate(toggle)
  await sleep(2000)
  const connected = await evaluate(PANEL)
  check('it opens on the keystroke the app listens for', connected.open === true)
  check('with the bridge connected it names Claude Code and takes a question', connected.model === 'Claude Code' && /Ask Claude Code/.test(connected.placeholder ?? ''), `${connected.model} · ${connected.placeholder}`)
  check('and the bridge row agrees', (await evaluate(BRIDGE))?.connected === true, JSON.stringify(await evaluate(BRIDGE)))
  await evaluate(toggle)
  await sleep(1200)
  check('the same keystroke closes it', (await evaluate(PANEL)).open === false)

  // Now the state a visitor without Claude Code is in.
  await evaluate(setBridge(false))
  await sleep(1800)
  const off = await evaluate(BRIDGE)
  check('turning the bridge off is visible in the sidebar', off?.connected === false && /off/i.test(off.text), JSON.stringify(off))
  await evaluate(toggle)
  await sleep(2000)
  const idle = await evaluate(PANEL)
  check('the box says what is missing before a word is typed', /Connect Claude Code/i.test(idle.placeholder ?? ''), String(idle.placeholder))

  await evaluate(`(() => {
    const t = document.querySelector('.ai textarea')
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
    set.call(t, 'hello')
    t.dispatchEvent(new Event('input', { bubbles: true }))
    t.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    return 1
  })()`)
  await sleep(2500)
  const answered = await evaluate(PANEL)
  check('the message is kept in the thread rather than swallowed', /hello/.test(answered.says), answered.says.slice(0, 80))
  check('and the answer says plainly what to do about it', /connect the bridge/i.test(answered.says) && /Claude Code/.test(answered.says), answered.says.split('\n').at(-1)?.slice(0, 120) ?? '')
  check('nothing threw while it had nowhere to send', answered.errors === 0 && logs.length === 0, `${answered.errors} page errors, ${logs.length} console`)

  await evaluate(setBridge(true))
  await sleep(1500)
  check('the bridge comes back on when it is switched on again', (await evaluate(BRIDGE))?.connected === true)
}
