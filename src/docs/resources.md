# Documents & media

Knowledge arrives as material: a document someone wrote, a page they found, a picture, a talk, a track, a chat. aegraph keeps each whole, in a viewer built for it, and lets meaning attach to exact places in it — a passage, a box on a picture, a moment in a video — as **annotations** that are entities like everything else. This page is the tour of those applets; [About](/docs/about) says why they are shaped this way, [Diagrams](/docs/diagrams) and [Maps](/docs/maps) have their own pages.

Every one of these is a `resource`-category entity, so it also sits in the **Entities** table (category *Resources*) with the same actions the dedicated page offers — New, Rename, Duplicate, Move to…, Download, Convert, Export to dataset… — declared once and mirrored there (`features/resources/capabilities.tsx`). Drop a file on the Entities table and it goes to the right importer.

## Annotations

An annotation is an `annotation` entity carrying a comment (and optionally a still, a tag, a link to what it is about) plus an `annotates` relationship to the thing annotated. The relationship's **selector** says where: a text quote (`exact` with `prefix`/`suffix`), a character range, a pixel region on an image, a moment or span in a video or track (with an optional region of the frame), a point on a map with a radius and a time, or nothing — a note on the whole. Selectors are in [the file format](/docs/spec); they are how highlights, boxes and markers travel with the data and how the assistant can be told "annotate the part that says…". The **Annotations** tab of any inspector lists what has been said about an entity; the *Annotate…* item on every context menu adds to it.

## Documents

**Documents** (`/documents`) is a tree of `document` entities: Markdown and plain text, PDFs, and folders (a folder is a document with `extension: folder`; the hierarchy is `data.parentId`). The tree searches titles, tags and content, drags between folders, and has *Move to…*, *Rename*, *Duplicate*, *Download* and *Delete* (a folder takes its contents). Import `.md`, `.txt` and `.pdf` files by dropping them on the page.

- **Markdown and text**: a rich editor (headings, lists, tasks, quotes, code, tables, links, images) with an outline on the left, a plain-text mode, `⌘B` `⌘I` `⌘K`, autosave (`⌘S` flushes), word and character counts. The label is the title; a leading `#` heading in the content is the document's own.
- **Annotate a passage**: select text and *Annotate*. The comment becomes an annotation anchored by the exact quote; highlights show in the text, tinted by the annotation's tag, and list in the **Annotations** panel with a click to jump.
- **PDFs**: by URL, or uploaded (to 15 MB, kept inline as a data URL so the file travels in exports and bundles) and shown in the built-in viewer. A PDF stored with the document or served by this site opens at once; one on another site names its host and waits for **Load from …** (or opens in a new tab) — the browser's viewer cannot be sandboxed, and loading it tells that host the document was opened. With Third-party services off, only the link is offered.
- **Folders** open as an index of what they hold; a project's documents can be organised into as many as you like.
- **Selecting several** on the Documents, Images, Videos, Audio and Diagrams indexes, as cards or as a list: drag across them (or from empty space) to rubber-band, `⌘`-click to toggle, `⇧`-click to extend, `⌘A` for all; a press on empty space, or `Esc`, lets the selection go. Selected ones delete together.
- The **Info** panel is the standard inspector — fields, relationships, JSON, validation — so a document's links to the places, people or claims it is about are one tab away.

Rendering is dependency-free and safe: Markdown is parsed to a tree and rendered as React elements, never as HTML strings, and `javascript:` links are dropped.

## Web pages

A `webpage` is a URL with whatever was captured about it (title, author, a screenshot, the text). Save one from **Entities › New › Webpage** or over MCP (`annotate_webpage` captures and annotates in one go); passages are annotated by quote like a document's. The framed page is the reading view — another site's page in a frame of its own, sent no referrer, and loaded only with Third-party services on; a page on this site is shown as a link instead. The captured text is what search and the assistant see.

## Images

**Images** (`/images`) is a gallery of `image` entities — uploads (to 10 MB, inline), pasted URLs, or files dropped on the page. Open one and **Draw box** drags a rectangle that becomes an annotation with a `region` selector in the picture's own pixel coordinates; **Select** moves and resizes boxes (the selector follows); `Delete` removes one; a note without a box is about the whole image. Zoom fits by default. An image on another site — one whose address came in a bundle, an import or from the assistant — is named by its host and waits for your click before it loads, here, on its card and in its crops (one you pasted yourself loads at once); with Third-party services off it is not loaded at all. Once loaded it shows again in this tab without asking. The assistant can look: `view_image` returns the pixels and the boxes already drawn — a picture on another site only after you say yes to its host — and `annotate_image` draws new ones — "find the logo and box it" works end to end.

## Videos

**Videos** (`/videos`) holds YouTube videos by link (watch, share, shorts and embed forms; `?t=` is honoured; title and channel from oEmbed). The player is YouTube's no-cookie embed in a sandboxed frame of its own, which the page drives with messages, so it can read and control playback without any script of YouTube's running in the app: **Note at m:ss** annotates the current moment or a span; **Draw box** pauses and takes a rectangle over the frame, stored as fractions of the frame so it survives resizing. Both are annotations with a `time` selector (`start`, `end?`, `region?`). The timeline shows markers and spans (click to seek); a box shows over the picture while playback is inside its window.

**Stills.** A YouTube frame cannot be read from a canvas, so the page captures the tab (`getDisplayMedia`, the current tab preferred): the first capture asks once, then stays open for the session. With *stills* on, every note and box keeps a JPEG of the frame on the annotation (`data.imageUrl`), cropped to the region when there is one, shown as a thumbnail everywhere the annotation appears. **Capture frame** saves a still on its own. Over MCP: `create_video`, `annotate_video`, `capture_video_frame` (which returns the still as an image, so the assistant can see what is on screen), and `control_playback`.

## Audio

**Audio** (`/audio`) lists Spotify tracks, albums, playlists and episodes — any `open.spotify.com` link or `spotify:` URI; artwork and title from oEmbed — and plays one through Spotify's embed — `open.spotify.com/embed` in a sandboxed frame of its own, driven by messages, with no script of Spotify's in the app — annotated by **moment** or **time range**: press `I` and `O` while listening to mark a range, drag its handles on the timeline, `Enter` to annotate, `L` to loop. The timeline packs overlapping spans into lanes; the selected one can be nudged with `←`/`→`. Spotify reports the duration only once playback starts, so the timeline uses a provisional length until then. Over MCP: `create_audio`, `annotate_audio`, `control_playback`.

**Your library as a graph.** The Projects dialog's Spotify card (Import tab) signs in with your own Spotify app (PKCE, no secret) and imports playlists, liked songs, saved albums, followed and top artists into one project with a six-type ontology — listener, playlist, track, album, artist, genre — and nine relationship types, everything linking back to Spotify; see [Import & export](/docs/exchange).

## Conversations

A `conversation` is a chat transcript kept whole — its messages, roles and times — from a **ChatGPT data export** loaded in the Projects dialog (Import tab) (parsed in the browser, stored only in this workspace, never bundled). The viewer shows it as a chat with search and *copy as Markdown*; a prepared export adds topics as entities, keywords as tags, summaries and sentiment, and — when the ChatGPT atlas is loaded beside it — each conversation is linked to its segments, regions, clusters and topics, so a transcript can be read from the graph and the graph from the transcript. Claude Code sessions export the same way (the trails tool writes them as `conversation` entities), which is how a session's work can be read back inside the app.

## Where the pieces meet

- **Diagrams** ([page](/docs/diagrams)) are resources too — Graphviz, Mermaid, Excalidraw — round-tripped to and from entities and kept as scenes.
- **Maps** ([page](/docs/maps)) hold places, and a place can carry a Wikipedia photo and paragraph (*Photos & summaries*) the way a document carries text.
- Everything above is browsable in **Entities** by type, linkable from the inspector, taggable, and visible to the assistant, which can read a document, look at an image or a frame, and annotate any of them by tool ([Assistant & MCP](/docs/assistant)).
