# Brand marks

`BrandMark` (`src/components/icons/BrandMark.tsx`) draws the mark of the
service a dataset came from. Spotify's and Claude's marks ship with the app,
from Simple Icons, whose icon data is CC0.

ChatGPT's does not: OpenAI asked the open icon sets to remove it, so no copy
of it lives in this repository. To use the official one locally, save it here
as `chatgpt.svg` (a square, single-colour SVG reads best at 14–18px) and it is
rendered wherever a ChatGPT dataset is named — no code change, no rebuild.
The same works for any other brand id.

`*.svg` in this folder is gitignored: a logo you dropped in is yours to use,
not ours to redistribute.
