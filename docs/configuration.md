# Configuration

Every environment variable aegraph-ui-toolkit reads, where, and what happens without it. The app itself needs none: `npm install && npm run dev` gives the whole workspace on this machine, with the assistant as Claude Code over the bridge. A deployed copy is a static site and reads no variable at run time — there are no accounts and no server functions. Variables configure the dev server, the bridge on each developer's machine, the headless engine, the build's demos, and the scripted driver.

Locally they go in `.env.local` (gitignored; `.env.example` is the template). On a host that builds the site (Vercel, say) the build's variables are the project's environment variables. A **build-time** variable is read when `vite build` or `prebuild` runs, so changing it needs a rebuild; a **runtime** one is read when the process runs. A **secret** must never reach the browser or the repository; a **public** one may (it is harmless).

## The app in the browser

The browser bundle carries one variable of ours, a list of features to leave out: `import.meta.env.DEV` and `MODE` are Vite's own. The keys a user brings — an Anthropic API key for the assistant, an OpenAI key for voice — are entered in the assistant settings and kept in that browser's localStorage; nothing configures them at build time.

| Variable | Read in | When | Kind | Default | Without it |
| --- | --- | --- | --- | --- | --- |
| `AEGRAPH_FEATURES_OFF` | `vite.config.ts` (baked in as `__AEGRAPH_FEATURES_OFF__`), read by `src/app/features.ts` | build | public | none — every feature on | Every feature is in the build. Comma-separated, any of: **`maps`** — the Maps sidebar row and its count, `/maps…` (a "Maps is turned off on this deployment" page instead, its chunk never loaded), the inspector's map views, the Maps docs page, the map tools (`create_map`, `add_location`, `add_path`, `add_area`, `annotate_map`, `enrich_location`, `map_state`, `map_import`), and with them the globe; **`globe`** — the Maps page's Globe stage (`?view=globe` shows the turned-off page), *Open on the globe*, `globe` and `globe_load`; **`videos`** — the Videos row, `/videos…`, the player in the inspector, `create_video`, `annotate_video`, `capture_video_frame`; **`audio`** — the Audio row, `/audio…`, the player, `create_audio`, `annotate_audio` (`control_playback` goes when both players do). Places, paths, areas, videos and tracks stay in the Library and its tables, and bundles carrying them open; a link into a view that is off goes to the Entities table or the turned-off page. Unknown names are reported by the build and ignored. The headless engine reads the same variable from its environment when it starts |

## The Claude Code bridge (`mcp/server.mjs`, each developer's machine)

Set in the shell that starts `claude` (or `npm run mcp`), not in `.env.local`.

| Variable | Read in | When | Kind | Default | Without it |
| --- | --- | --- | --- | --- | --- |
| `AEGRAPH_HOSTED_ORIGIN` | `mcp/server.mjs` | runtime | public | `https://aegraph.sh` | The one deployed site whose pages may connect to this machine's bridge besides loopback pages: this edition's own site by default; your deployment's origin instead, or empty so only loopback pages connect |
| `AEGRAPH_BRIDGE_ORIGINS` | `mcp/server.mjs` | runtime | public | loopback on any port, plus the hosted origin when `AEGRAPH_HOSTED_ORIGIN` names one | Replaces the whole list of page origins allowed to connect |
| `AEGRAPH_BRIDGE_TOKEN` | `mcp/server.mjs` | runtime | **secret** (per machine) | none | Any allowed page can connect; with it, the tab must present `?token=` (set in the app's bridge settings) |
| `AEGRAPH_BRIDGE_PORT` | `mcp/server.mjs` | runtime | public | `8787` | The first port tried, on 127.0.0.1 |
| `AEGRAPH_BRIDGE_PORT_SPAN` | `mcp/server.mjs` | runtime | public | `10` | How many ports after it are tried when it is taken |
| `AEGRAPH_BRIDGE_TIMEOUT_MS` | `mcp/server.mjs`, `mcp/attach.mjs` | runtime | public | `120000` (attach: `900000`) | How long one tool call may take |
| `AEGRAPH_BRIDGE_WAIT_MS` | `mcp/server.mjs` | runtime | public | `8000` | How long a call waits for a tab to connect |
| `AEGRAPH_CLAUDE_BIN` | `mcp/server.mjs` | runtime | public | `claude` on `PATH` | The Claude Code binary the in-app chat runs; without one, the panel cannot chat |
| `AEGRAPH_CLAUDE_ARGS` | `mcp/server.mjs` | runtime | public | none | Extra arguments for each chat turn (a model, a setting); flags that would widen permissions are dropped |
| `AEGRAPH_CLAUDE_LINGER_MS` | `mcp/server.mjs` | runtime | public | `5000` | How long a finished chat turn's process may take to exit before it is put down |
| `AEGRAPH_BRIDGE_CHAT`, `AEGRAPH_BRIDGE_FOR_TAB` | `mcp/server.mjs` | runtime | internal | — | Set by the bridge for its own chat child. Do not set them |
| `XDG_CACHE_HOME` | `mcp/chat.mjs` | runtime | public | `~/Library/Caches` (macOS), `~/.cache` | Where the chat's empty working folder is made (`aegraph/chat`) |

A chat turn's `claude -p` gets only the environment Claude Code needs — its own sign-in, `ANTHROPIC_*` / `CLAUDE_*`, cloud-provider and proxy variables, locale and paths (`mcp/chat.mjs › chatEnv`) — never the rest of the bridge's.

## The headless engine (`src/headless/server.ts`)

| Variable | Read in | When | Kind | Default | Without it |
| --- | --- | --- | --- | --- | --- |
| `AEGRAPH_WORKSPACE` | `src/headless/server.ts` | runtime | public | the first argument | The workspace file to open when no path is given; with neither, it prints its usage and exits |
| `AEGRAPH_HEADLESS_PORT` | `src/headless/server.ts` | runtime | public | none (stdio) | Serves over stdio, one client per process; with it, streamable HTTP on that loopback port |
| `AEGRAPH_HEADLESS_TOKEN` | `src/headless/server.ts` | runtime | **secret** | a random token, printed at start | HTTP clients must send the printed token |
| `AEGRAPH_HEADLESS_CONFIRM` | `src/headless/server.ts` | runtime | public | `refuse` over HTTP (stdio allows) | Destructive tools over HTTP are refused; `allow` lets them run |
| `AEGRAPH_FEATURES_OFF` | `src/app/features.ts` (no build constant in Node) | runtime, at start | public | none | All the tools. Set as for the build (above), the engine leaves out the same features' tools — so a fork's headless server offers what its site does |

## The build and the dev server

The dev server also serves two routes of its own, for its own page only (`scripts/devOrigin.mjs › localApiRoute`): `/api/openai` (voice, `dev/openai.ts`, with `OPENAI_API_KEY`) and `/api/fetch` (the `web_fetch` tool's reader, `dev/fetch.ts`, which reads no variable). Nothing in `dev/` is deployed.

| Variable | Read in | When | Kind | Default | Without it |
| --- | --- | --- | --- | --- | --- |
| `AEGRAPH_DEMOS_DIR` | `scripts/demos/fetch.mjs`, `vite.config.ts` | build, dev | public | `../aegraph-ui-demos` or `~/workspace/aegraph-ui-demos` when one exists | Demos come from the copies aegraph.dev publishes (`AEGRAPH_DEMOS_SITE`) — the usual case, since `aegraph-ui-demos` is private — or from GitHub with `AEGRAPH_DEMOS_TOKEN` |
| `AEGRAPH_DEMOS_REPO` | `scripts/demos/fetch.mjs` | build | public | `adrewh2/aegraph-ui-demos` | The repository the build reads demos from |
| `AEGRAPH_DEMOS_REF` | `scripts/demos/fetch.mjs` | build | public | `main` | The branch, tag or commit; pin a commit for a reproducible build |
| `AEGRAPH_DEMOS_TOKEN` | `scripts/demos/fetch.mjs` | build | **secret** | none | With no checkout either, the build takes the demos a site publishes (`AEGRAPH_DEMOS_SITE`) |
| `AEGRAPH_DEMOS_SITE` | `scripts/demos/fetch.mjs` | build | public | `https://aegraph.dev` | With no checkout and no token, the demos come from this site's published copies (`/demos/catalog.json`, https only, no redirects); `off` for none — then the Demos tab is empty and the first run opens no default project (said once, on screen) |
| `AEGRAPH_DEMOS_LIVE` | `vite.config.ts` | dev | public | on | `0` makes the dev server serve the built copies instead of the checkout, as a build would |
| `AEGRAPH_LOCAL_DEMOS` | `vite.config.ts` | dev | private (paths on this machine) | none | No **On this machine** datasets on the Projects dialog. `Label=/abs/path;Label=/abs/dir;…` |
| `OPENAI_API_KEY` | `vite.config.ts › localApi`, `dev/openai.ts` | dev | **secret** | none | The dev server's `/api/openai` answers 503 and voice uses the browser's own recogniser and voice (or a key the user enters in the assistant settings) |

## The scripted driver and the smoke suite (`mcp/drive.mjs`, `mcp/attach.mjs`, `mcp/smoke*.mjs`)

For people running checks by hand; nothing in the app reads these.

| Variable | Read in | Default | What it does |
| --- | --- | --- | --- |
| `CHROME_PATH` | `mcp/drive.mjs` (`mcp/chromePath.mjs`) | Chrome's install path on macOS and Windows; on Linux the first of `google-chrome`, `google-chrome-stable`, `chromium`, `chromium-browser` on `PATH` | The Chrome or Chromium to launch; with none found the driver stops and says to set it |
| `CHROME_FLAGS` | `mcp/drive.mjs` | none | Extra Chrome flags, e.g. `--disable-features=LocalNetworkAccessChecks` to drive a deployed site |
| `GL` | `mcp/drive.mjs`, `mcp/smoke.mjs` | off (`--disable-gpu`) | `1` software WebGL; `hw` the machine's GPU (Metal flags: a Mac) |
| `PROFILE` | `mcp/drive.mjs` | `./mcp-profile` | The Chrome profile, which holds the Library between runs |
| `DOWNLOADS` | `mcp/drive.mjs`, smoke steps | `./downloads` | Where the tab's downloads land |
| `BRIDGE_PORT` | `mcp/drive.mjs` | random in 9400–9699 | This run's bridge port |
| `CALL_TIMEOUT_MS` | `mcp/drive.mjs` | `600000` | How long one `call` may take |
| `VERBOSE` | `mcp/drive.mjs`, `mcp/attach.mjs` | off | Shows the bridge server's log |
| `WAIT_MS` | `mcp/attach.mjs` | `30000` | How long to wait for a tab to connect |
| `SMOKE_BUNDLE`, `SHOTS` | smoke steps | set by `mcp/smoke.mjs` | Internal to the suite |

## Forking for your organisation

The repository carries a few defaults that name its author's deployment. A fork that deploys its own site changes these:

| What | Where | Change it to |
| --- | --- | --- |
| The hosted origin the bridge trusts | `AEGRAPH_HOSTED_ORIGIN` (default `https://aegraph.sh`, `mcp/server.mjs`) | Your deployment's origin, set in each developer's environment (or the default in `mcp/server.mjs`); empty for none |
| The web-fetch user agent | `USER_AGENT` in `dev/fetch.ts` (names `https://aegraph.dev/docs/assistant`) | A URL of yours, so a site that sees the requests knows whose they are |
| What the site offers | `AEGRAPH_FEATURES_OFF` (default none, `vite.config.ts` › `src/app/features.ts`) | The features your deployment leaves out — `maps`, `globe`, `videos`, `audio` — set in the build's environment (and in the headless engine's, to match) |
| The Wikipedia user agent | `HEADERS` in `src/features/maps/wikipedia.ts` | Wikimedia asks callers to identify themselves: your name and a contact |
| The demos repository | `AEGRAPH_DEMOS_REPO` (default `adrewh2/aegraph-ui-demos`, `scripts/demos/fetch.mjs`) | Your own demos repository, or none; pin `AEGRAPH_DEMOS_REF` to a commit |
| The project a first visit opens | `DEFAULT_DEMO`, `DEFAULT_DEMO_KEY` and `DEFAULT_DEMO_TAB` in `src/app/providers.tsx` (Aurora; its whole graph in 3D, live) | One of your demos' ids; bump the key to open it once more on existing installs; `DEFAULT_DEMO_TAB` names a scene of the demo (settled positions, its own force settings) for a first frame that is the finished picture |
| Code owners | `.github/CODEOWNERS` | Your team's handles |
| Where vulnerabilities are reported | `SECURITY.md` (*Found a vulnerability?*, at the top: a private advisory on the repository's Security tab) and the comment in `.github/ISSUE_TEMPLATE/config.yml` | Your repository's advisories, or your security contact |
| The repository and badges | `package.json › repository` (add one), and any badges you add to `README.md` | Your repository |
| The site named in the manual | `src/docs/assistant.md`, `src/docs/privacy.md`, `src/docs/exchange.md` (the Spotify callback) | Your site's address |

Then, for the deployment itself: build with `npm run build` (the demos variables above if you ship demos) and serve `dist/` with `vercel.json`'s headers. There is nothing else to set up — no accounts, no keys on the server. `SECURITY.md` has the checklist for deploying to an organisation.
