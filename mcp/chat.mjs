/**
 * How a chat turn from the app's panel runs `claude -p` — kept apart from the
 * server so every rule here is tested on its own.
 *
 * The turn's prompt carries workspace text (the selection, the open document,
 * the assistant's notes), and tool results carry more; any of it may have been
 * written by someone else to steer the model. So the child Claude Code gets
 * **the app's tools and nothing else**: no shell, no file reads or edits, no
 * web fetch, no sub-agents — `--tools ""` removes the built-in set and the
 * deny list names each one again in case a version reads the flag differently.
 * It runs in a directory of its own, not in this repository (so no project
 * settings, no `.env.local`, no source within reach), with only the
 * environment Claude Code needs to sign in and reach its API.
 * `AEGRAPH_CLAUDE_ARGS` may add a model or a setting, never a permission.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** Every built-in tool, denied by name as well as removed by `--tools ""`. */
export const BUILTIN_TOOLS = ['Bash', 'BashOutput', 'KillShell', 'Edit', 'MultiEdit', 'Write', 'NotebookEdit', 'Read', 'Glob', 'Grep', 'LS', 'WebFetch', 'WebSearch', 'Task', 'Agent', 'TodoWrite', 'SlashCommand', 'Skill']

/** `AEGRAPH_CLAUDE_ARGS` flags that would widen what the child may do; each is dropped with its value. */
const REFUSED = new Set([
  '--permission-mode', '--dangerously-skip-permissions', '--allow-dangerously-skip-permissions', '--allowedTools', '--allowed-tools',
  '--disallowedTools', '--disallowed-tools', '--tools', '--add-dir', '--mcp-config', '--strict-mcp-config', '--permission-prompt-tool',
  '--permission-prompts', '--settings', '--setting-sources', '--plugin-dir', '--agents',
])
/** Of those, the ones that take no value. */
const BARE = new Set(['--dangerously-skip-permissions', '--allow-dangerously-skip-permissions', '--strict-mcp-config'])

/** `AEGRAPH_CLAUDE_ARGS` with every permission-widening flag (and its values) taken out; `refused` names them. */
export function filterClaudeArgs(list) {
  const kept = []
  const refused = []
  for (let i = 0; i < list.length; i++) {
    const a = list[i]
    const flag = a.split('=')[0]
    if (!REFUSED.has(flag)) {
      kept.push(a)
      continue
    }
    refused.push(flag)
    if (a.includes('=') || BARE.has(flag)) continue
    // Variadic flags (`--allowedTools A B`) take every value up to the next flag.
    while (i + 1 < list.length && !list[i + 1].startsWith('-')) i++
  }
  return { kept, refused }
}

/** What `claude --effort` takes; anything else is not passed. */
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']

/** The `claude` argument list for one turn. */
export function chatArgs(msg, mcpConfig, extra = []) {
  const args = [
    '-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    '--mcp-config', mcpConfig, '--strict-mcp-config',
    // Default mode whatever the terminal's, the app's tools pre-allowed (the app confirms its destructive ones), and
    // no built-in tool at all: nothing here may run a command or touch a file on this machine.
    '--permission-mode', 'default', '--tools', '', '--disallowedTools', ...BUILTIN_TOOLS,
    '--allowedTools', 'mcp__aegraph', '--permission-prompt-tool', 'mcp__aegraph__permission_prompt',
    // The user's settings file stays out — its hooks (a status line, a logger) would run on every chat turn and its
    // permission rules would widen this one's. Their CLAUDE.md and memory still load (chatEnv). The working
    // directory holds no project settings, so this leaves none.
    '--setting-sources', 'project,local',
  ]
  // Never an element that starts with a dash, which a parser could take for a flag.
  if (typeof msg.resume === 'string' && /^\w[\w-]*$/.test(msg.resume)) args.push('--resume', msg.resume)
  if (typeof msg.model === 'string' && /^\w[\w.-]*$/.test(msg.model)) args.push('--model', msg.model)
  if (EFFORTS.includes(msg.effort)) args.push('--effort', msg.effort)
  if (typeof msg.system === 'string' && msg.system) args.push('--append-system-prompt', msg.system)
  return [...args, ...extra]
}

/** The environment Claude Code needs — sign-in, its API or cloud provider, a proxy — and nothing else of this process's. */
const ENV_KEEP = /^(PATH|HOME|USER|LOGNAME|SHELL|TERM|TZ|LANG|LC_\w+|TMPDIR|TEMP|TMP|XDG_\w+|ANTHROPIC_\w+|CLAUDE_\w+|DISABLE_\w+|MCP_\w+|NODE_EXTRA_CA_CERTS|SSL_CERT_FILE|SSL_CERT_DIR|REQUESTS_CA_BUNDLE|(HTTPS?|NO|ALL)_PROXY|(https?|no|all)_proxy|AWS_\w+|CLOUD_ML_REGION|GOOGLE_APPLICATION_CREDENTIALS|GOOGLE_CLOUD_PROJECT|VERTEX_REGION_\w+|APPDATA|LOCALAPPDATA|USERPROFILE|SYSTEMROOT|SystemRoot|COMSPEC|ComSpec|PATHEXT)$/
const SESSION_OWN = /^(CLAUDE_CODE_(SESSION_ID|BRIDGE_SESSION_ID|MESSAGING_\w+|ENTRYPOINT|SSE_PORT)|CLAUDE_PROJECT_DIR|CLAUDE_ENV_FILE)$/
export function chatEnv(env = process.env) {
  const out = {}
  for (const [k, v] of Object.entries(env)) if (ENV_KEEP.test(k) && v !== undefined) out[k] = v
  // A `claude` inside Claude Code's own process tree refuses to start; this one is a separate session on purpose.
  delete out.CLAUDECODE
  // The session that started this bridge — the developer's own, in a terminal — hands its identity down: its session
  // id, its project, its messaging socket and token. None of it is the chat's; with them the chat's turn would be
  // attributed to, or could reach, that session.
  for (const k of Object.keys(out)) if (SESSION_OWN.test(k)) delete out[k]
  // The developer's CLAUDE.md and Claude Code's memory are loaded as in any session of theirs: a chat through Claude
  // Code should know what their Claude Code knows. (Their hooks are not — see chatArgs.)
  return out
}

/**
 * Where the child runs: a directory of this user's that holds nothing. One directory, not one per turn, because
 * Claude Code files a session under its working directory and `--resume` must find it there. Under the user's
 * cache, never the shared /tmp, where another account could plant settings in it first.
 */
export function chatDir(env = process.env) {
  const base = env.XDG_CACHE_HOME || (process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Caches') : path.join(os.homedir(), '.cache'))
  const dir = path.join(base, 'aegraph', 'chat')
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const st = fs.lstatSync(dir)
  if (!st.isDirectory() || (typeof process.getuid === 'function' && st.uid !== process.getuid())) throw new Error(`${dir} is not a directory of this user's`)
  return dir
}

/** Longest question put to the user; a longer one is declined rather than shown in part. */
export const MAX_PROMPT_CHARS = 8000
const clip = (s, head, tail) => (s.length <= head + tail + 40 ? s : `${s.slice(0, head)}\n… [${s.length - head - tail} characters not shown] …\n${s.slice(-tail)}`)

/**
 * What the user is asked about a tool use: the whole of it, never a first few hundred characters with the payload
 * past the cut. A file write says where, how long, and how it begins and ends. `null` when it is too long to show
 * whole — the caller declines it.
 */
export function describeToolUse(name, input) {
  const i = input && typeof input === 'object' ? input : {}
  let detail
  if (typeof i.file_path === 'string' && (typeof i.content === 'string' || typeof i.new_string === 'string')) {
    const body = typeof i.content === 'string' ? i.content : i.new_string
    detail = `${i.file_path} (${body.length} characters)\n${clip(body, 600, 300)}`
  } else {
    const key = ['command', 'url', 'file_path', 'path', 'pattern', 'query', 'prompt'].find((k) => typeof i[k] === 'string')
    const rest = Object.fromEntries(Object.entries(i).filter(([k]) => k !== key && k !== 'description'))
    detail = key ? i[key] + (Object.keys(rest).length ? `\n${JSON.stringify(rest)}` : '') : JSON.stringify(i)
  }
  const text = `${name}: ${detail}`
  return text.length > MAX_PROMPT_CHARS ? null : text
}
