# Privacy & security

Your data stays where you put it. This page says exactly what that means: what
never leaves your machine, what does and when, and how to run aegraph where an
organisation's rules apply. The repository's `SECURITY.md` says the same for
the people who run a deployment.

## Where your work lives

Everything you make — entities, documents, scenes, charts, projects — is in
**this browser**, in its own database. There is no aegraph account and no
aegraph server: nothing is uploaded, nothing is synced, and no usage is
measured. Clearing the browser's data for this site erases the workspace, which
is why a project worth keeping is one you have saved. **Clear this browser…**
on the *This browser* page (`/browser`, from the settings menu) does exactly
that from inside the app, and its **stashes** are copies of the workspace kept
in the same browser to restore later — they stay when the app clears it, but go
with the rest when the browser's own settings delete the site's data (see
[This browser](/docs/navigation#this-browser)). A stash holds your keys — the
Claude and OpenAI keys, the Spotify sign-in, the bridge's address — only when
you tick **Include keys in stashes**: it is a plain copy that clearing never
deletes, so a key entered once would otherwise outlive every clear. Clearing
deletes the keys with the rest; restoring a stash without keys keeps the ones you
have now. A browser keeps at most ten stashes.

A project leaves the browser only when you ask, and only to where you say:

- **Save** writes a bundle (`.ae.json`, or the packed `.aeb`) to your Downloads
  or to the **projects folder** you pick once — a folder on your own disk.
- **Publish** writes one self-contained page (`.html`) you can open anywhere or
  send to someone. It is a file, not a site: publishing uploads nothing.
- **Export** on a chart, a dataset or a scene writes that one thing to a file.

Pick a projects folder somewhere you would keep any other document. Not a
source tree: a project full of real data, committed by accident, is the one
mistake that is hard to take back — see *Working in a clone* below.

## What reaches the network

Nothing here runs unless you open the feature that needs it, and none of it
sends your entities anywhere.

| When you… | aegraph asks | and tells it |
| --- | --- | --- |
| open **Maps** (a map, or the index of maps, whose cards draw each map's area) or the **globe** | OpenStreetMap, Esri, OpenTopoMap (the terrain layer) | the area on screen, or on the card |
| choose the globe's **night** layer | unpkg.com (the night image) | that you chose it |
| search for a place, or ask the assistant to map one | OpenStreetMap's Nominatim | the place text |
| drop a pin on a map (its address is looked up for the dialog) | OpenStreetMap's Nominatim | the pin's coordinates |
| **enrich** a location, or open its card on the map | Wikipedia, and its photos from `upload.wikimedia.org` | that place's name |
| use **voice** with the browser's own recogniser | Google (Chrome) or Apple (Safari), the browser's speech service | the sound of what you say while voice is on |
| hear a reply in one of Chrome's **Google voices** (or Edge's online ones) | Google (or Microsoft) | the text being read aloud |
| turn on **search by meaning** | Hugging Face, once | nothing — the model comes to your browser and the text is read there |
| import **linked data** | the endpoint you typed | your query |
| add a **YouTube video** or open one | YouTube: `www.youtube.com/oembed` for the title when you add it, the player from `www.youtube-nocookie.com`, the thumbnail from `i.ytimg.com` | that you added or opened that video, and this site's address (the player needs it) |
| add a **Spotify link** or open one | Spotify: `open.spotify.com` for the title and the player, the cover from `i.scdn.co` | that you added or opened that item |
| **sign in to Spotify** and import your library | `accounts.spotify.com` (the sign-in), `api.spotify.com` (the library) | your Spotify session, and the requests for your library; the token goes to `api.spotify.com` and nowhere else |
| open a saved **web page** | that site, in a frame of its own — never this site's origin | what any visit tells a site; no referrer |
| ask for a graph, places, a bundle or an image **from a URL**, or have the assistant look at one (`view_image`) or put one on an entity (you, or the assistant) | that host, after you say yes to it by name | that you fetched that address |
| **load** a remote image in a chat, a note, a table, the inspector, an image's viewer, a thumbnail, a capture or a map card | that host, when you click | that you looked |
| **load** a PDF that lives on another site | that host, when you click | that you opened it |
| ask the assistant to **read a page** (`web_fetch`) | that host, after you say yes to it by name (once for the conversation, and again for an address there with a long query or path) — directly, or — when the app runs locally — through the dev server's `/api/fetch` when the host does not let the browser read it; a redirect to a host you have not said yes to is asked about first | the address; never a cookie or sign-in of yours |

There is no aegraph server behind a deployed copy: no account, no sign-in and
no function that sees your conversations. With your own Anthropic key the
assistant talks straight from your browser to the Claude API, and with your own
OpenAI key voice talks straight to OpenAI; the conversation and the context the
assistant is given travel with them, to the provider whose key it is. Running
locally the assistant is Claude Code over the bridge, and the Claude API is
never called from your machine; voice may use the `OPENAI_API_KEY` in
`.env.local` through the dev server, and a page the browser may not read is
read by the dev server's `/api/fetch`, on your machine, which sees the address
and what came back and keeps neither. Only the assistant's own call reaches
those routes: an image, a link or a PDF address written into a chat, a
document or a bundle that points at them (`/api/…`) is refused, so text
someone else wrote cannot have the dev server fetch an address for it.

## Offline mode

**Third-party services**, in the settings menu (the button at the foot of the
sidebar), is the one switch over all of it. It is **on** — turn it off and
nothing in the app calls anyone but this site:

- the map, the globe and the cards on the index of maps draw your places on
  plain ground, no tiles fetched, and the map says so;
- place search, Wikipedia enrichment, linked-data import and search by meaning
  refuse, each naming itself and where to turn it back on;
- a YouTube or Spotify player does not load, and an embedded web page is not
  fetched — its address and your annotations stay where they are;
- adding a YouTube video or a Spotify link asks neither for its title — the item
  is made from the link alone — and Spotify sign-in and import refuse;
- no picture on another host is loaded — a thumbnail, an image added by its
  address, a photo on a map card — and none offers a click to load it; one
  carried in the data itself still shows;
- voice listens only with a recogniser on the device (Chrome's on-device speech,
  once installed) and reads only with a voice on the device; otherwise it says
  why — OpenAI transcription and voices with your own key (or the one in
  `.env.local`) are the assistant's, not a third party's;
- a `/open?url=…` link to another site's project is not offered, and a dropped
  pin's address is not looked up.

Nothing you have made is changed or hidden by the switch: enrichment already
stored on an entity is still there to read. The assistant is not covered by
it — it is the provider whose key you gave it, or Claude Code on your machine,
not a third party — and the assistant settings are where it is set up or
turned off. Over MCP the setting is
`account` › `external_services`.

## Data someone sends you

A project, a diagram or a document you were sent is data, not something that
gets to run. A diagram's picture is rebuilt from what draws and shown as an
image, which can run nothing and fetch nothing — and a picture that cannot be
cleaned is refused with a note rather than drawn. Scripts run walled off from
the app, with no way to reach your workspace or your keys, and a
script that arrived in a bundle, an import or a template runs only when you
press **Run**: only code you have run or saved in this browser runs again by
itself. A chart a script draws is cleaned of every address it would fetch
before it is shown. A bundle's constraints arrive switched off, for you to read
and turn on. A `/open?url=…` link that
points at another site says whose it is and asks before it fetches anything,
because what it opens becomes your workspace — and with Third-party services off
it fetches nothing and says why. An embedded web page is only ever
someone else's page, never one from this site.

A bundle changes only what is its own: the entities of its own project. It
never writes into your other projects or your Library's other entities, never
makes one of your projects part of its own, and cannot date its copies in the
future to stay newer than your edits.

A constraint's JavaScript check runs in a small interpreter of its own, which
sees the entities it judges and nothing else — no network, no storage, no page.
A colour, a link or a PDF address that arrives in a file is checked for being
exactly that before it is drawn or opened, and an address that points at this
dev server's own routes (`/api/…`) is refused. A remote image in the assistant's
answers, an imported chat, or an entity's image property in a table or the
inspector waits for your click, because loading it tells its host that you
looked — and, if the text was written to leak something, what. The same holds
wherever a picture's address comes from data: an image's viewer and its crops,
the thumbnails on the image, video and audio pages, a capture saved with an
annotation, a page's screenshot, the photos on a map card. Only the provider's
own thumbnail of a thing you added — a YouTube poster (`i.ytimg.com`), a Spotify
cover (`i.scdn.co`), a Wikipedia photo (`upload.wikimedia.org`) — loads without a
click, because whatever its address carries goes to that provider and not to
whoever wrote the data. Once you load a picture it shows again in this tab
without asking; a reload asks again. That goes for an
address written without its scheme too (`//host/…`), which the browser would
send to that host all the same.

A YouTube or Spotify player is the provider's page in a sandboxed frame of its
own — the provider's origin, never this one — which the app drives with
messages. No script of YouTube's or Spotify's ever runs in the app's page, where
it could read your keys and your workspace. A PDF on another site waits the same way: the
browser's PDF viewer cannot be sandboxed, so only a PDF stored with the
document, or served by this site, opens without asking.

## When the assistant reads what others wrote

Documents, entities, bundles and web pages can contain text written to look
like instructions to the assistant. It is told that only your messages are
instructions, but that is not what keeps you safe: the tools are. Fetching
from another site asks you, naming the host — reading a page, looking at a
picture, putting a picture's address on an entity; turning third-party
services on or off, discarding or
reverting work, removing a project, opening a bundle that would replace
entities you have, deleting a slide or a block with text of its own, turning
the microphone on, and every change to the assistant's memory — a new note
included — all ask you too, and nothing the assistant passes to a tool skips
the question. A question names what it is about in quotes, on one line, so a
label cannot pass itself off as part of the question; it starts on **Cancel**,
and its yes cannot be pressed for half a second after it appears. The
assistant's memory is only ever what it wrote in this browser — a note that
arrives in a bundle is shown to it as someone else's, never as its own, and a
bundle that would replace the assistant's own memory is not opened.

Running locally with Claude Code, a chat turn from the panel gets the app's
tools and nothing else: no shell, no files, and no web but the app's own
`web_fetch`, which asks you per host like any other tool. And everything a tool hands
back to Claude Code is marked as data, so the model reading your workspace is
told, each time, that nothing in it is an instruction.

## A file that is not what it says

A project file is read with limits: one that decompresses to more than 128 MB — 512 MB
for the pack (`.aeb`), the form the very big projects come in — is refused rather than read, because a small file can be built to expand until the
tab runs out of memory. So is a value nested more than 64 levels deep, and a
pack holding more than five million entities. A field name that would reach into how objects work,
rather than name a field, is refused too. None of that is something an ordinary
bundle comes near. A data file attached to a chat — CSV, text, Excel, Parquet —
is read in the browser, never sent anywhere to be read, and with the same kind
of limits: its size, its rows, columns, cells and text, and what it
decompresses to. A graph file has its own: its size, its nodes and edges. An
XML graph file that declares a document type is refused before it is read.

## Your API key

A key you enter is kept in this browser and sent straight to the provider. It
never goes into a bundle, a published page or a project: the view state a
project carries is a fixed list — the workstation, the tables, the explorer —
and no key is on it, nor is it in a stash unless you include keys. A deployed
copy holds no key of its own: it is a static site.

A saved bundle does carry the project's **conversations**: your chats with the
assistant that belong to it, and the assistant's memory document for it, are
entities of the project like any other — so a bundle you send someone carries
them. A **published page** leaves both out. A bundle also carries what the
project's scenes, slides and diagrams reference by id, and nothing else from the
Library: a cell or a note that merely contains another entity's id is not
followed.

## Working in a clone

If you run aegraph from a clone of the repository, four guards keep your data
out of it, and they are independent on purpose:

- **The app refuses to save there.** Point the projects folder at a checkout —
  aegraph's own, or any git repository — and it is refused with a sentence
  saying why; nothing is remembered and nothing is written. A folder that
  becomes a repository later is dropped at the next save, which goes to
  Downloads instead.
- **`.gitignore`** ignores every shape the app writes — bundles, packs,
  published pages, exports, anything under `public/datasets`, every `.env` but
  the example — wherever in the tree it is; the few datasets the project ships
  are allowed back one at a time.
- **A pre-commit hook** refuses the same files even when one was forced past
  `.gitignore`, and anything over 5 MB.
- **A pre-push hook** reads every commit you are about to send and refuses the
  same shapes — the last point at which the data is still only yours, since a
  pull request publishes what it carries. `npm install` installs both hooks, so
  a fresh clone is guarded before its first commit; `git config --get
  core.hooksPath` should print `.githooks`.

A clone also reaches the network on its own before the app does: `npm run dev`
and `npm run build` fetch the Python runtime (jsDelivr, PyPI) and the demo
projects — from a checkout of the demos repository when there is one, else
from the copies aegraph.dev publishes (`AEGRAPH_DEMOS_SITE`; `off` for none).
That is the build fetching files, not the app sending anything of yours. The
dev server's own routes (voice, the page reader, the local demos) answer this
machine alone, even when the server is started on the network with `--host`.

One rule follows from all of it: **keep your projects outside the clone.** Not
only because of what might be committed — `git clean -fdx` deletes every
ignored file in a tree, and a bundle saved into a clone is an ignored file.

## Running it for an organisation

A deployed copy is a static site with no accounts and nothing on the server to
configure: each person brings their own Anthropic key, or chats through their
own Claude Code over the bridge. Give the
Claude Code bridge `AEGRAPH_BRIDGE_ORIGINS` (your deployment, and nothing else)
and `AEGRAPH_BRIDGE_TOKEN` on every machine that runs it — without the first,
the bridge refuses any page but your dev server and the site `AEGRAPH_HOSTED_ORIGIN` names
(aegraph.sh unless you set it; empty for none), and naming your own deployment is how its pages get in.
A deployment can also leave whole features out of its build —
`AEGRAPH_FEATURES_OFF=maps,globe,videos,audio` — and then their pages, views and
tools are not there at all, so nothing asks a tile server, Wikipedia, YouTube or
Spotify on their behalf; places, videos and tracks you bring stay in the Library
as data. `SECURITY.md` in the repository has the full checklist.
