import type { RuleHelper } from '../../core/constraints/rules'
import type { Language } from '../../scripting/types'

/**
 * What a script can call, as data: each helper with its signature, a
 * sentence, and the argument the completion should offer for it (a type,
 * a relationship, a tag, a metric…). This is the vocabulary the editor
 * completes and documents on hover, the Reference drawer lists, and the
 * scaffolds are written with. It mirrors src/scripting/prelude.js and
 * prelude.py — change one, change the other.
 */

export type ScriptArg = 'type' | 'rel' | 'tag' | 'metric' | 'id' | 'unit' | 'agg' | 'lib'

export interface ScriptHelper extends Omit<RuleHelper, 'arg'> {
  /** Where it belongs in the reference. */
  group: string
  arg?: ScriptArg
  /** For a member of `ds` / `aegraph`: the object it hangs off. */
  of?: 'ds' | 'aegraph'
  /** Which argument (0-based) the completion offers `arg` for; default 0; -1 for every argument. */
  argIndex?: number
}

const H = (group: string, name: string, signature: string, doc: string, extra: Partial<ScriptHelper> = {}): ScriptHelper => ({ group, name, signature, doc, ...extra })

/** `ds.` in JavaScript and Visual scripts. */
export const DS_MEMBERS: ScriptHelper[] = [
  H('dataset', 'entities', 'ds.entities', 'Every entity: { id, type, label, description?, tags, data, createdAt, updatedAt }. Long text is cut; huge values are replaced by { $omitted, kind, items, bytes }.', { of: 'ds' }),
  H('dataset', 'relationships', 'ds.relationships', 'Every relationship: { id, type, source, target, directed, data }.', { of: 'ds' }),
  H('dataset', 'get', 'ds.get(id) → entity', 'An entity by id.', { of: 'ds', arg: 'id' }),
  H('dataset', 'byType', "ds.byType('incident', 'deploy') → entities", 'Entities of one or more types.', { of: 'ds', arg: 'type', argIndex: -1 }),
  H('dataset', 'types', 'ds.types() → string[]', 'The entity types in use.', { of: 'ds' }),
  H('dataset', 'tagged', "ds.tagged('tag') → entities", 'Entities carrying a tag.', { of: 'ds', arg: 'tag' }),
  H('dataset', 'where', 'ds.where((e) => …) → entities', 'Entities matching a predicate.', { of: 'ds' }),
  H('dataset', 'count', 'ds.count() → number', 'How many entities.', { of: 'ds' }),
  H('graph', 'out', "ds.out(id, type?) → relationships", 'Relationships leaving an entity, optionally of one type.', { of: 'ds', arg: 'rel', argIndex: 1 }),
  H('graph', 'in', "ds.in(id, type?) → relationships", 'Relationships arriving at an entity.', { of: 'ds', arg: 'rel', argIndex: 1 }),
  H('graph', 'neighbors', "ds.neighbors(id, type?) → entities", 'The entities at the other end, both directions, optionally through one relationship type.', { of: 'ds', arg: 'rel', argIndex: 1 }),
  H('graph', 'degree', "ds.degree(id, type?) → number", 'How many relationships touch an entity.', { of: 'ds', arg: 'rel', argIndex: 1 }),
  H('graph', 'metric', "ds.metric('pagerank', id) → number | undefined", 'A metric from the latest Insights/analyze run: pagerank, betweenness, community, degree…', { of: 'ds', arg: 'metric' }),
  H('graph', 'metricNames', 'ds.metricNames() → string[]', 'The metrics the latest analysis run computed.', { of: 'ds' }),
  H('project', 'project', 'ds.project', 'The open project: { id, label, description?, includes, createdAt, updatedAt } — null in the Library.', { of: 'ds' }),
  H('project', 'scope', 'ds.scope', '{ label, projectId? } — what the dataset is.', { of: 'ds' }),
  H('project', 'ontology', 'ds.ontology', 'Every type in use or declared: { type, label, category, kind, parent?, description?, color?, count, properties: [{ key, label?, kind?, description?, options?, required? }] }.', { of: 'ds' }),
  H('project', 'type', "ds.type('incident') → definition", 'One type’s definition from the ontology.', { of: 'ds', arg: 'type' }),
  H('project', 'properties', "ds.properties('incident') → [{ key, kind, count, coverage, declared, sample? }]", 'The properties entities of a type carry — declared on the type or seen in the data — with how many carry each.', { of: 'ds', arg: 'type' }),
  H('project', 'tags', 'ds.tags() → [{ tag, count, color?, description? }]', 'The tags in use, most used first.', { of: 'ds' }),
  H('project', 'describe', 'ds.describe() → summary', 'Everything a script can reach, as one plain object: the project, the types with their properties, the relationship types and what they join, the tags, the metrics. log(ds.describe()) to look around.', { of: 'ds' }),
]

/** The chained query API, the same in both languages: listed once in the reference, completed from the inference. */
export const COLLECTION_API: ScriptHelper[] = [
  H('collections', 'entities', 'entities', 'Every entity, as a collection: entities.types.person.filter({ min_degree: 2 }).neighbors(\'wrote\').sort(\'label\').table(). Every step is a new collection; the array (list) itself still works.'),
  H('collections', 'relationships', 'relationships', 'Every relationship, as a collection: relationships.types.wrote.filter({ source_type: \'person\' }).targets().'),
  H('collections', 'types', 'entities.types.person · entities.types[\'schema:type\']', 'The members of one type; a plural finds the singular (types.documents). .types.list() names them.'),
  H('collections', 'type', "entities.type('a', 'b') → collection", 'The members of one or more types.'),
  H('collections', 'get', 'entities.get(id) → record', 'The member with this id.'),
  H('collections', 'filter', 'entities.filter(fn | { types, tags, all_tags, text, has, data, min_degree, max_degree, rel, ids, created_after, … })', 'A predicate, or a spec — keys in snake_case (as in Python: filter(min_degree=2)) or camelCase. relationships: types, source, target, source_type, target_type, directed, has, data, text.'),
  H('collections', 'where', 'entities.where(fn)', 'Members matching a predicate.'),
  H('collections', 'exclude', 'entities.exclude(spec | fn)', 'The complement of a filter.'),
  H('collections', 'sort', "entities.sort('data.born', desc?)", "By a field, a 'data.x' path or a function; a copy."),
  H('collections', 'top', "entities.top('data.born', n)", 'The n largest.'),
  H('collections', 'take', 'entities.take(n) · skip(n) · sample(n) · first() · last() · count() · ids() · labels()', 'Slices and lookups.'),
  H('collections', 'unique', "entities.unique('type') · pluck('data.x') · group('type') · rollup(key, value?, agg?)", 'Values, grouping and aggregation over members.'),
  H('collections', 'neighbors', "entities.neighbors(rel?, dir?) · out(rel?) · into(rel?) · links(rel?) · degrees(rel?) · tagged(tag)", 'Graph steps from the members: the entities at the other ends, the relationships touching them.'),
  H('collections', 'sources', 'relationships.sources() · targets() · ends() · from(id | entities) · to(id | entities)', 'From relationships to their ends, and filters by end (Python: from_).'),
  H('collections', 'table', 'entities.table(columns?) · tags() · properties() · describe() · json()', 'Outputs and introspection over members. Python adds .df, the members as a DataFrame.'),
]

/** Bare names in JavaScript and Visual scripts. */
export const JS_HELPERS: ScriptHelper[] = [
  H('dataset', 'ds', 'ds', 'The dataset snapshot: entities, relationships, the project, the ontology, tags, metrics — and the helpers under ds.'),
  H('collections', 'entities', 'entities', 'Every entity, as a collection: entities.types.person.filter({ min_degree: 2 }).neighbors(\'wrote\').sort(\'label\').table(). Every step is a new collection; the array itself still works.'),
  H('collections', 'relationships', 'relationships', 'Every relationship, as a collection: relationships.types.wrote.filter({ source_type: \'person\' }).targets().'),
  H('collections', 'pathOf', "pathOf('data.x') → fn", "A reader for a field, a 'data.x' path or a function."),
  H('time', 'ms', 'ms(v) → number', 'Anything date-like to epoch milliseconds (NaN when it is not a date).'),
  H('time', 'bin', "bin(v, 'month') → string", "Floor a date to hour, day, week (Monday), month, quarter or year; an ISO string.", { arg: 'unit', argIndex: 1 }),
  H('time', 'daysBetween', 'daysBetween(a, b) → number', 'Days from a to b.'),
  H('time', 'hoursBetween', 'hoursBetween(a, b) → number', 'Hours from a to b.'),
  H('time', 'isoDate', 'isoDate(v) → string', 'YYYY-MM-DD of a date.'),
  H('lists', 'groupBy', 'groupBy(items, key) → Map', 'Items by a field name or a function.'),
  H('lists', 'rollup', "rollup(items, key, value?, agg = 'count') → [{ key, value, n, items }]", "Group and aggregate: count, sum, mean, median, min, max, distinct, or a function; sorted by key.", { arg: 'agg', argIndex: 3 }),
  H('lists', 'sortBy', 'sortBy(items, key, desc?) → items', 'A sorted copy.'),
  H('lists', 'topK', 'topK(items, key, k) → items', 'The k largest by a field.'),
  H('lists', 'rolling', 'rolling(xs, n) → numbers', 'A rolling mean over n points.'),
  H('lists', 'range', 'range(a, b, step) → numbers', 'a up to b.'),
  H('stats', 'sum', 'sum(xs)', 'The sum (non-numbers skipped).'),
  H('stats', 'count', 'count(xs)', 'The length.'),
  H('stats', 'mean', 'mean(xs)', 'The mean.'),
  H('stats', 'median', 'median(xs)', 'The median.'),
  H('stats', 'quantile', 'quantile(xs, p)', 'The p-quantile, p in 0–1.'),
  H('stats', 'min', 'min(xs)', 'The smallest.'),
  H('stats', 'max', 'max(xs)', 'The largest.'),
  H('stats', 'distinct', 'distinct(xs)', 'How many distinct values.'),
  H('stats', 'correlation', 'correlation(xs, ys)', 'Pearson’s r.'),
  H('outputs', 'figure', 'figure(traces, layout?) → output', 'A Plotly figure from traces (one or a list); layout is Plotly’s, or a title.'),
  H('outputs', 'line', 'line(x, y, opts?) → trace', 'A line trace; opts merge into it (name, line, marker…).'),
  H('outputs', 'scatter', 'scatter(x, y, opts?) → trace', 'A scatter trace.'),
  H('outputs', 'bar', 'bar(x, y, opts?) → trace', 'A bar trace.'),
  H('outputs', 'area', 'area(x, y, opts?) → trace', 'A filled area.'),
  H('outputs', 'box', 'box(y, opts?) → trace', 'A box plot of one series.'),
  H('outputs', 'histogram', 'histogram(x, opts?) → trace', 'A histogram.'),
  H('outputs', 'heatmap', 'heatmap(x, y, z, opts?) → trace', 'A heatmap.'),
  H('outputs', 'pie', 'pie(labels, values, opts?) → trace', 'A pie.'),
  H('outputs', 'table', 'table(rows, columns?) → output', 'A table from row objects or arrays.'),
  H('outputs', 'scene', 'scene(positions, { label?, groups?, scale? }) → output', 'Positions per entity id ({ x, y, width?, height? }) — opens on the Scenes page.'),
  H('outputs', 'log', 'log(...args)', 'Lines shown under the result.'),
  H('chart', 'axisValue', "axisValue(raw, ref?) → { v, temporal }", 'The chart tool’s reading of a value: dates to epoch ms, numeric strings to numbers.'),
  H('chart', 'binAxis', 'binAxis({ v, temporal }, unit | width)', 'Bin an axis value as the chart tool does.'),
  H('chart', 'axisOut', 'axisOut(v, temporal)', 'ms back to ISO for a temporal axis.'),
  H('chart', 'seriesOf', 'seriesOf(rows, key) → series', 'Series as the chart tool splits them: largest first, “other” past 24, “(none)” for missing.'),
  H('chart', 'plotColor', 'plotColor(i) → color', 'The chart palette.'),
  H('chart', 'markerSizes', 'markerSizes(values) → sizes', 'Marker sizes scaled as the chart tool does.'),
  H('chart', 'aggregate', "aggregate(values, 'mean')", 'One aggregate of a list.', { arg: 'agg', argIndex: 1 }),
]

/** `aegraph.` in Visual scripts. */
export const VIEW_MEMBERS: ScriptHelper[] = [
  H('frame', 'load', "aegraph.load('d3' | 'plotly') → module", 'Load a library served locally.', { of: 'aegraph', arg: 'lib' }),
  H('frame', 'width', 'aegraph.width() → number', 'The frame’s width in pixels.', { of: 'aegraph' }),
  H('frame', 'height', 'aegraph.height() → number', 'The frame’s height in pixels.', { of: 'aegraph' }),
  H('frame', 'result', 'aegraph.result(value)', 'Also send a figure, table or scene back (same contract as JavaScript scripts).', { of: 'aegraph' }),
  H('frame', 'remember', 'aegraph.remember(key, value)', 'Keep something per script across runs and reloads — a camera, a toggle.', { of: 'aegraph' }),
  H('frame', 'recall', 'aegraph.recall(key, fallback?) → value', 'What was remembered.', { of: 'aegraph' }),
]

export const VIEW_HELPERS: ScriptHelper[] = [H('frame', 'aegraph', 'aegraph', 'The frame: load(lib), width(), height(), result(v), remember(k, v), recall(k).'), H('frame', 'document', 'document', 'The frame’s DOM; #app is an empty div filling it.'), ...JS_HELPERS]

/** Bare names in Python scripts. */
export const PY_HELPERS: ScriptHelper[] = [
  H('dataset', 'ds', 'ds', "The raw snapshot dict: ds['entities'], ds['relationships'], ds.get('metrics'), ds['ontology'], ds.get('project'), ds['tags']."),
  H('collections', 'entities', 'entities', "Every entity, as a collection: entities.types.person.filter(min_degree=2).neighbors('wrote').sort('label').table(). Every step is a new collection; the list itself still works, and entities.df (or any DataFrame method or column — entities['type'], entities.groupby(...)) is the DataFrame."),
  H('collections', 'relationships', 'relationships', "Every relationship, as a collection: relationships.types.wrote.filter(source_type='person').targets(); .df is the DataFrame."),
  H('dataset', 'metrics', 'metrics', 'A DataFrame indexed by entity id with the latest analysis columns (pagerank, betweenness, community…).'),
  H('dataset', 'by_type', "by_type('incident', 'deploy') → DataFrame", 'Entities of some types, with date-like columns parsed.', { arg: 'type', argIndex: -1 }),
  H('dataset', 'get', 'get(id) → dict', 'An entity by id.', { arg: 'id' }),
  H('graph', 'out', 'out(id, type=None) → list', 'Relationships leaving an entity.', { arg: 'rel', argIndex: 1 }),
  H('graph', 'inn', 'inn(id, type=None) → list', 'Relationships arriving at an entity.', { arg: 'rel', argIndex: 1 }),
  H('graph', 'neighbors', 'neighbors(id, type=None) → list', 'The entities at the other end.', { arg: 'rel', argIndex: 1 }),
  H('graph', 'degree', 'degree(id, type=None) → int', 'How many relationships touch an entity.', { arg: 'rel', argIndex: 1 }),
  H('graph', 'metric', "metric('pagerank', id) → float | None", 'A metric from the latest analysis run.', { arg: 'metric' }),
  H('graph', 'graph', 'graph() → networkx.DiGraph', 'The dataset as a networkx graph.'),
  H('project', 'project', 'project', 'The open project as a dict, or None in the Library.'),
  H('project', 'ontology', 'ontology', 'Every type in use or declared, as dicts: type, label, category, kind, parent, properties…'),
  H('project', 'type_def', "type_def('incident') → dict", 'One type’s definition.', { arg: 'type' }),
  H('project', 'properties', "properties('incident') → DataFrame", 'The properties entities of a type carry: key, kind, count, coverage, declared.', { arg: 'type' }),
  H('project', 'tags', 'tags', 'The tags in use: [{ tag, count, color?, description? }].'),
  H('project', 'describe', 'describe() → dict', 'Everything a script can reach, as one dict — print(describe()) to look around.'),
  H('outputs', 'figure', 'figure(traces, layout=None) → dict', 'A Plotly figure from trace dicts (plotly.express or graph_objects figures work directly).'),
  H('outputs', 'table', 'table(rows, columns=None) → dict', 'A table from dicts or lists (a DataFrame displays as a table by itself).'),
  H('outputs', 'scene', 'scene(positions, label=None, groups=None, scale=None) → dict', 'Positions per entity id — opens on the Scenes page.'),
  H('outputs', 'print', 'print(...)', 'Lines shown under the result.'),
]

export function helpersFor(language: Language): { bare: ScriptHelper[]; members: ScriptHelper[] } {
  if (language === 'python') return { bare: PY_HELPERS, members: [] }
  if (language === 'view') return { bare: VIEW_HELPERS, members: [...DS_MEMBERS, ...VIEW_MEMBERS] }
  return { bare: JS_HELPERS, members: DS_MEMBERS }
}

export const GROUP_LABELS: Record<string, string> = { collections: 'Collections — the chained query API', dataset: 'Dataset', graph: 'Graph & metrics', project: 'Project, ontology, tags', time: 'Time', lists: 'Lists', stats: 'Statistics', outputs: 'Outputs', chart: 'Chart conventions', frame: 'The frame' }

export const BIN_UNITS = ['hour', 'day', 'week', 'month', 'quarter', 'year']
export const AGGS = ['count', 'sum', 'mean', 'median', 'min', 'max', 'distinct']
export const VIEW_LIBS = ['d3', 'plotly']
