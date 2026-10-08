import { Cable, Copy } from 'lucide-react'
import { useEffect, useState } from 'react'
import { ConfirmDialog, Dialog } from '../../components/ui/Dialog'
import { useArmed } from '../../components/ui/useArmed'
import { useToast } from '../../components/ui/useToast'
import { EDITION, localSetupCommand } from '../../app/edition'
import { isLocalHost } from '../../core/ai/settings'
import { formatDate } from '../../lib/format'
import { useAppHost } from '../assistant/useAppHost'
import { bridge, useBridge } from './bridge'
import './BridgeStatus.css'

/**
 * Mounts the bridge into the running app and shows its state as a small
 * pill. Also renders the confirmation dialog for destructive tool calls
 * coming from Claude Code, and the permission questions a chat turn's
 * `claude -p` asks.
 */
export function BridgeStatus() {
  const host = useAppHost()
  const state = useBridge()
  const [open, setOpen] = useState(false)
  // A permission question's Allow waits a moment after it appears — or after the next one replaces it — like a tool's yes.
  const allowArmed = useArmed(state.confirm?.kind === 'permission', true, state.confirm?.id)

  useEffect(() => {
    bridge.attach(host)
  }, [host])

  return (
    <>
      <button
        className={`sb-item bridge-item bridge-item--${state.status}`}
        onClick={() => setOpen(true)}
        title={state.status === 'connected' ? `Claude Code bridge connected · ${state.servers} session${state.servers === 1 ? '' : 's'} · ${state.calls} calls` : state.status === 'connecting' ? 'Looking for the bridge server…' : 'Claude Code bridge is off'}
      >
        <span className="sb-item__icon">
          <Cable size={16} />
        </span>
        <span className="sb-item__label">Claude Code</span>
        <span className="bridge-item__state">{state.status === 'connected' ? (state.calls ? `${state.calls} calls` : 'connected') : state.status === 'connecting' ? 'connecting…' : 'off'}</span>
        <span className="bridge-item__dot" />
      </button>

      {open && <BridgeDialog onClose={() => setOpen(false)} />}

      {/* Keyed by the question: the next one waiting comes up as a dialog of its own — Cancel focused, yes not yet armed. */}
      <ConfirmDialog
        key={state.confirm?.id ?? 'none'}
        open={state.confirm?.kind === 'tool'}
        title={state.confirm?.danger ? 'Claude Code wants to delete something' : 'Claude Code wants your go-ahead'}
        message={state.confirm?.message ?? ''}
        confirmLabel={state.confirm?.yes || 'Yes'}
        danger={!!state.confirm?.danger}
        guarded
        onConfirm={() => state.confirm && bridge.answer(state.confirm.id, true)}
        onCancel={() => state.confirm && bridge.answer(state.confirm.id, false)}
      />

      {/* A permission Claude Code asks for is shown whole — the bridge sends the full request or declines it unasked —
          as written, in a scrolling box, and Cancel has the focus: Enter must never be the way something runs. */}
      {state.confirm?.kind === 'permission' && (
        <Dialog
          key={state.confirm.id}
          open
          title="Claude Code asks for permission"
          onClose={() => state.confirm && bridge.answer(state.confirm.id, false)}
          footer={
            <>
              <button className="btn" autoFocus onClick={() => state.confirm && bridge.answer(state.confirm.id, false)}>
                Cancel
              </button>
              <button className="btn btn--primary" disabled={!allowArmed} onClick={() => allowArmed && state.confirm && bridge.answer(state.confirm.id, true)}>
                Allow
              </button>
            </>
          }
        >
          <pre className="bridge-permission">{state.confirm.message}</pre>
        </Dialog>
      )}

      {/* ask_user over the bridge: the options as buttons; closing the dialog answers "none of these". */}
      {state.question && (
        <Dialog
          open
          title="Claude Code asks"
          onClose={() => state.question && bridge.answerQuestion(state.question.id, null)}
          footer={
            <button className="btn" onClick={() => state.question && bridge.answerQuestion(state.question.id, null)}>
              None of these
            </button>
          }
        >
          <p style={{ margin: '0 0 10px' }}>{state.question.message}</p>
          <div className="bridge-options">
            {state.question.options.map((o, i) => (
              <button key={o} className="btn" autoFocus={i === 0} onClick={() => state.question && bridge.answerQuestion(state.question.id, o)}>
                {o}
              </button>
            ))}
          </div>
        </Dialog>
      )}
    </>
  )
}

function BridgeDialog({ onClose }: { onClose: () => void }) {
  const state = useBridge()
  const [url, setUrl] = useState(state.url)
  return (
    <Dialog
      open
      title="Claude Code bridge"
      description="Lets Claude Code drive this tab through the same tools as the in-app assistant — on your Claude subscription, no API key. Run the MCP server from the repo (it's registered in .mcp.json) and Claude Code will see the tools once this tab connects."
      onClose={onClose}
      footer={
        <button className="btn btn--primary" onClick={onClose}>
          Done
        </button>
      }
    >
      <label className="bridge-toggle">
        <input type="checkbox" checked={state.enabled} onChange={(e) => bridge.setEnabled(e.target.checked)} />
        <span>
          Enable bridge
          <span className="muted"> — {state.status === 'connected' ? `connected to ${state.servers} session${state.servers === 1 ? '' : 's'} · ${state.calls} call${state.calls === 1 ? '' : 's'}` : state.status === 'connecting' ? 'waiting for a server' : 'off'}</span>
        </span>
      </label>
      {state.lastCall && (
        <div className="muted" style={{ fontSize: 12 }}>
          Last call: <span className="mono">{state.lastCall.name}</span> {state.lastCall.ok ? 'ok' : 'failed'} · {formatDate(state.lastCall.at)}
        </div>
      )}
      <div className="field">
        <label>Server URL</label>
        <div style={{ display: 'flex', gap: 8 }}>
          <input className="input" style={{ flex: 1 }} value={url} onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && bridge.setUrl(url)} />
          <button className="btn" onClick={() => bridge.setUrl(url)} disabled={url === state.url}>
            Apply
          </button>
        </div>
        <span className="muted" style={{ fontSize: 12 }}>
          Default <span className="mono">ws://127.0.0.1:8787</span>; set <span className="mono">AEGRAPH_BRIDGE_PORT</span> on the server to change it. The nine ports after it are tried too: each Claude Code session runs its own server, and the next session takes the next free port.
        </span>
      </div>
      <BridgeHowTo />
    </Dialog>
  )
}

/**
 * The dialog's one command to copy. On a deployed site, running the app on your machine: the clone, the install and
 * `npm run dev` — Claude Code is connected to the app running there, not to the site. On this machine's own dev server,
 * connecting Claude Code: `claude` in the checkout, which starts the bridge from the project's `.mcp.json`. The
 * repository is this edition's (`app/edition.ts`).
 */
export function BridgeHowTo() {
  const local = isLocalHost()
  return (
    <div className="bridge-howto">
      {local ? (
        <>
          <div className="bridge-howto__title">In this checkout, in a terminal</div>
          <CopyCommand command="claude" />
          <div className="muted" style={{ fontSize: 12 }}>
            Claude Code starts the bridge from <span className="mono">.mcp.json</span> (it asks once to approve the <span className="mono">aegraph</span> server; <span className="mono">/mcp</span> shows it) and this tab connects. Then ask it anything: <span className="mono">summarize the open document</span>. One-shot: <span className="mono">claude -p "tag every document that mentions annotations"</span>.
          </div>
        </>
      ) : (
        <>
          <div className="bridge-howto__title">Run the app on your machine</div>
          <CopyCommand command={localSetupCommand('npm run dev')} />
          <div className="muted" style={{ fontSize: 12 }}>
            In a terminal with <span className="mono">git</span> and Node 22+{EDITION.privateRepo ? ' (the repository is private: cloning it needs access)' : ''}. It clones <span className="mono">{EDITION.name}</span>, installs it and starts it; open <span className="mono">http://localhost:5173</span> (the first run downloads the Python runtime and the demos). Claude Code connects to the app running there: its Claude Code dialog has the one command for that.
          </div>
        </>
      )}
    </div>
  )
}

/** A command on one line with a button that copies it. */
function CopyCommand({ command }: { command: string }) {
  const toast = useToast()
  const copy = () =>
    navigator.clipboard.writeText(command).then(
      () => toast('Copied — paste it into a terminal'),
      () => toast(command),
    )
  return (
    <div className="bridge-howto__cmd">
      <pre>{command}</pre>
      <button className="btn btn--sm" onClick={copy} title="Copy the command">
        <Copy size={13} /> Copy
      </button>
    </div>
  )
}
