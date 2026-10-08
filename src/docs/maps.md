# Maps

A **map** is a resource: a saved view (centre, zoom, base layer). What is on it are three kinds of knowledge entity, each with a place on Earth and optionally *when* it mattered:

- a **location** — a point, with an address;
- a **path** — a line: a route, a journey, a border (its length is computed);
- an **area** — a polygon: a site, a district, a zone (its area is computed).

Each carries a `mapId` — the map it belongs to — or none. **Maps** (`/maps`) is the index of your maps, as Documents and Images have theirs: a card or a row per map with a picture of what is on it — the view fitted to its own locations, paths and areas (not to where the map was last left), drawn over that area's tiles in the colours the map gives them, a city of points sampled to a few thousand so the index stays quick — and when it was last touched; search, a tag, a sort. **New map** (`/maps/new`) makes one where the page last looked and asks for its name; open a map (`/maps/<id>`) to see just its own places; **Everything on one map** (`/maps/all`) shows every location, path and area in the workspace at once, whatever map they belong to — the picker on a map page switches between all of these. Because places are ordinary entities they can be tagged, linked to people and documents, and browsed in the Entities table like everything else.

Tiles come from OpenStreetMap (streets), Esri (satellite) and OpenTopoMap (terrain); nothing needs an API key.

## Adding things

- **Search** the box on the map (OpenStreetMap's Nominatim geocoder) and pick a result.
- **Paste a Google Maps link** into the same box — `…/maps/place/…/@lat,lng`, `…/maps?q=lat,lng`, a `geo:` URI, or a bare `lat, lng`. Short `maps.app.goo.gl` links need opening first; paste the long address-bar link.
- **Import** a **KML** file (Google Earth, My Maps exports) or **GeoJSON**: points become locations, lines paths, polygons areas, with their names, descriptions and TimeStamp / TimeSpan times. KMZ is a zip — unzip and import the `doc.kml` inside.
- **Add location** (top right), then click the map. The address is looked up for you.
- **Right-click** a location, a path, an area or a note, on the flat map or the globe, for its menu — *Show on map*, *Details*, *Pin note here*, *Find photo & summary*, then the menu every entity has, the same as its row in the table ([Tables](/docs/navigation#tables)): rename, edit, annotate, link, related, ask, chart, set property, projects, copy, delete. A right-click on empty map is the map's own: add a location or a note there, start a path, draw an area, copy the coordinates.
- **Add path**: click the map point by point; double-click (or Enter) finishes, Escape cancels.
- **Add area**: a lasso — press on the map, draw around the region, release. The stroke is thinned to the points that describe it.
- Drop a `.kml` / `.geojson` on the Library table to get a new map from it.

Drag a pin to correct a location. Everything links out to Google Maps and Google Earth.

The wheel and a trackpad zoom the flat map by how far they move, at once and by any fraction of a level — as the globe does — and the **+** / **−** buttons step by whole levels; a pan or a zoom is one camera move, nothing on the page re-renders for it.

## Points, pins and a city of them

A map draws its locations one of two ways, chosen under **Layers › Locations** (and kept on the map):

- **Points — every one, at every zoom.** Each location is a dot in the colour of its first coloured tag (else its type), drawn by [Unigraph](/docs/explorer)'s engine on one canvas over the tiles: the whole set at once, whatever its size — the *Street trees of Toronto* demo is 688,335 of them — with no bubbling and no element per pin. A zoom or a pan moves a camera, not the points, so it costs the same for a million as for ten; the dots shrink where they crowd and grow where they thin. Hover a point for its card, click it to select it (it grows, ringed), press and drag it to move the location. **Relationships between two locations on the map are drawn as lines between their points** (in the link's tag colour, an arrow for a directed one) — the map as a graph: which trees stand next to which, which stations a line joins. A map of 2,000 locations or more draws points unless told otherwise.
- **Pins, bubbled where they crowd.** Each location is a pin, and pins that would pile up on screen become one **bubble** — the count in the middle, a ring in the colours of what is inside — that zooms to its members on click; zoom in and the bubbles split until every pin stands alone. The way to see *how many* are in a neighbourhood at a glance. Fewer than 2,000 locations draw this way unless told otherwise; it holds at any size too (the pins are read once into an index, the points sorted by their screen cell at the deepest zoom in Morton order, so any zoom's bubbles are runs of that order and a zoom step clusters what is in view in a tenth of a second), and past a few thousand pins the map draws the view plus a screen's margin rather than the whole world.

**Unigraph** on the map's toolbar opens the rows in [Unigraph](/docs/explorer) each where it is on Earth (the `geo` [placement](/docs/positions) as the rule in force, so no layout moves them), with everything the graph explorer does at hand — the styles, the metrics, the relationships among them, a scene to save; the same entities the map draws, as a graph. Either way, where you left the map is remembered on the map entity without counting as a change to the project, and hovering a pin or a point on a map of thousands shows its card without looking the place up on Wikipedia (a city's inventory is not landmarks); *Photos & summaries* and a pin's *Find photo & summary* still do. A card opens over a pin, point, path or area under the pointer only when the **ⓘ button at the top right of the map**, beside *Fit everything*, is on — it is off to begin with, so the map stays uncovered while you read it; switching it off again takes away the card on screen. The switch is yours rather than a map's — it holds for every map and across reloads. Over MCP, `create_map` takes `pins` (`points` or `bubbles`) and `map_state` reports it; `update_entity` on the map's `data.pins` changes it.

## The table beside the map

The table on the right is the standard entity table over what is on the map, under tabs — **All · Locations · Paths · Areas**, and **Notes** on a map — and the map draws exactly the rows the table shows: a tab, the search, a column filter or the **Types** menu narrows both. Types lists every type on the map under its kind — *Locations* › Airport, Hotel, Sight…; *Areas* › Island — so a whole kind, or one type, is a tick. A subtype reads as what it is a kind of: the type column says *Area · Island*.

**Folding it away.** The handle on the map's right edge takes the table off the screen so the map fills the pane — a city of street trees or a globe of flights is worth the width — and brings it back; the fold holds for every map and across reloads. A link can ask for it folded with `?list=0` (`/maps/<id>?list=0`, and `?view=globe` for the globe), which is how a project's own opening tab lands on its map alone; the address is not remembered, so a link that asks for the map alone doesn't change how your own maps open.

How the table opens is data, so a project can bring it: a type definition's `table` (columns first, hidden, the sort — `location` with *When* first and rows in date order, say, which every kind of location inherits) and a map's own `data.table` (which kinds the All tab shows by default, its sort, extra columns). The `table_layout` tool sets both; see [the file format](/docs/spec).

## Notes at a point — and a time

**Pin a note**, click the map, and write. A pinned note is an annotation on the map with a `geo` selector: latitude, longitude, an optional radius in metres, and optionally an **at** time or an **at – until** span. Notes show as numbered amber pins (with their radius as a circle) and appear in the map's Annotations like any other annotation.

## The timeline

When anything on the map carries a time — a location's *when*, a path's span, a note's *at* — a timeline appears under the map. Drag the two handles to show only what falls in that window; undated things always show. *All time* clears it.

## Everywhere else

- The **Library** and **Entities** tables have a Maps tab; a map's detail panel opens on the live map with the same tools, and a location's, path's or area's on a small map with links out.
- **Export** a map as GeoJSON or KML (locations, paths, areas *and* notes, with times), from the map page or the Library row menu.
- The assistant and MCP tools `create_map`, `add_location` (coordinates, a link, or an address to geocode), `add_path` and `add_area` (points as `"lat, lng; lat, lng; …"` or `[[lng, lat], …]`), `annotate_map` (a note at a point and time), `map_import` (KML or GeoJSON, as text or from a URL) and `map_state` (the map as a listing, or as a GeoJSON / KML file with `format`) do the same things by name.

## The globe

**Globe** — the switch beside **2D** at the top of the Maps page — shows the same page on Earth as a 3D globe: the same map (or everything), the same selection, the same layer (satellite, streets or terrain; plus *Night lights* from the layer menu), the same table and details pane, the same timeline. Both stages stay mounted, so switching is instant — and the view carries over: the stage you switch to shows the same centre at the height that shows what the other's zoom showed, so only the projection changes. The globe's camera is remembered between visits. Locations are points, paths great-circle arcs (one per leg), areas filled polygons, coloured by their first coloured tag or by type. Past a few hundred features the globe draws every track leg and every location in one pass — a location a dot of a few pixels at any distance, so a city's 688,335 trees read as the city, not as one smear — and thousands of flights play smoothly at sixty frames a second: hovering finds the point or leg under the pointer through an index rather than a search, a selection fades the rest without redrawing anything, and from far away the globe draws a uniform sample of a crowded city's points, enough for a few per pixel, growing to every one of them as you come closer. Everything the flat map does with the pointer, the globe does too: hover a location, a leg or an area and it is ringed, its card opens (with the ⓘ cards on; off, its name shows at the bottom left — on either stage); click to select, click the empty globe to clear; press and drag a location or a pinned note to move it; right-click for the map's menu; **Add location** and **Pin note** place by a click, **Add path** click by click (Enter or a double-click finishes) and **Add area** by lasso, drawn on the globe as you go. Notes pinned to the map are its numbered markers there as well. The globe zooms as deep as the flat map does — down to a street, at the same tile detail — and a location's dot grows from a couple of pixels where a city crowds the view to the flat map's size where trees stand apart. The globe's camera is remembered per map; a map you have not looked at on the globe before opens framed on its places. Subtypes count: a `flight` whose type says `parent: path` is a path here, an `airport` under `location` a location.

**The timeline** under the stage and the table appears when things carry times: a histogram of when they happen, the window the map is filtered to (drag its edges or its body, or drag on the track to draw a new one; click the track to put the playhead there), and a playhead with play / pause, speed and back-to-start. The window and the playhead filter both stages and the table: at a moment, what is happening then — spans covering it, instants just before it, undated things always.

Over MCP, `globe` opens the page in globe mode on a map (or everything) and drives it — `mode`, `state`, `fly`, `fit`, `select`, `layer`, `window`, `time`, `spin` — and **`globe_load`** is the one call for "put this journey on the globe": it writes the places and legs into the entity system as location and path entities (dated, tagged, with their source, on a new or existing map) and opens the map in globe mode, fitted. A flight is a two-point path with the departure as `at` and the arrival as `until`; the coordinates come from whatever the caller has, not from the app. The *Flights today* demo, in the Projects dialog's Demos tab, is 7,310 of them.
