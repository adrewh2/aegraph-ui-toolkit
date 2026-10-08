import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * The Python prelude's collections — the chained query API that mirrors the
 * JavaScript one — exercised under the machine's python3 with a stand-in
 * pandas (the collections need none of it; only `.df` does). Skipped where
 * there is no python3.
 */

const preludePath = fileURLToPath(new URL('../python/prelude.py', import.meta.url))
const hasPython = spawnSync('python3', ['--version']).status === 0

const STUB_PANDAS = `
class DataFrame:
    def __init__(self, *a, **k):
        self.rows = a[0] if a else []
    def __len__(self):
        return len(self.rows)
    def __getitem__(self, k):
        return [r.get(k) for r in self.rows]
    def __setitem__(self, k, v):
        pass
    def __contains__(self, k):
        return any(k in r for r in self.rows)
    @property
    def empty(self):
        return not self.rows
    def head(self, n=5):
        return DataFrame(self.rows[:n])
class Series: pass
class Index: pass
class Timestamp: pass
def to_datetime(v, **k): return v
def isna(v): return v is None
`
const STUB_NUMPY = `
integer = int
floating = float
class datetime64: pass
class ndarray: pass
def isnat(v): return False
def dtype(x): return x
def issubdtype(a, b): return False
def asarray(v): return v
`

const SNAPSHOT = {
  scope: { label: 'test' },
  entities: [
    ...Array.from({ length: 6 }, (_, i) => ({ id: `p${i}`, type: 'person', label: `P${i}`, tags: i % 2 ? ['reviewed'] : [], data: { born: 1800 + i, role: ['author', 'editor'][i % 2] }, createdAt: `2020-0${i + 1}-01T00:00:00Z`, updatedAt: '2020-01-01T00:00:00Z' })),
    { id: 'w0', type: 'paper', label: 'Notes', tags: [], data: { year: 1843 }, createdAt: '2020-01-01T00:00:00Z', updatedAt: '2020-01-01T00:00:00Z' },
    { id: 'w1', type: 'paper', label: 'More', tags: ['draft'], data: { year: 1850 }, createdAt: '2020-01-01T00:00:00Z', updatedAt: '2020-01-01T00:00:00Z' },
    { id: 'd0', type: 'document', label: 'Doc', tags: [], data: {}, createdAt: '2020-01-01T00:00:00Z', updatedAt: '2020-01-01T00:00:00Z' },
  ],
  relationships: [
    { id: 'r0', type: 'wrote', source: 'p0', target: 'w0', directed: true, data: { order: 1 } },
    { id: 'r1', type: 'wrote', source: 'p1', target: 'w0', directed: true, data: { order: 2 } },
    { id: 'r2', type: 'wrote', source: 'p1', target: 'w1', directed: true, data: {} },
    { id: 'r3', type: 'cites', source: 'w1', target: 'w0', directed: true, data: {} },
  ],
}

function runPython(exprs: Record<string, string>): Record<string, unknown> {
  const dir = mkdtempSync(join(tmpdir(), 'aegraph-py-'))
  mkdirSync(join(dir, 'pandas'))
  mkdirSync(join(dir, 'numpy'))
  writeFileSync(join(dir, 'pandas', '__init__.py'), STUB_PANDAS)
  writeFileSync(join(dir, 'numpy', '__init__.py'), STUB_NUMPY)
  const script = `
import json, sys
sys.path.insert(0, ${JSON.stringify(dir)})
src = open(${JSON.stringify(preludePath)}).read()
g = {}
exec(compile(src, 'prelude.py', 'exec'), g)
g['_aegraph_load'](${JSON.stringify(JSON.stringify(SNAPSHOT))})
out = {}
for name, expr in ${JSON.stringify(exprs)}.items():
    try:
        out[name] = eval(expr, g)
    except Exception as e:
        out[name] = 'ERROR: ' + repr(e)
print(json.dumps(out, default=lambda v: list(v) if isinstance(v, (set, frozenset)) else str(v)))
`
  const r = spawnSync('python3', ['-c', script], { encoding: 'utf8' })
  if (r.status !== 0) throw new Error(r.stderr)
  return JSON.parse(r.stdout.trim().split('\n').pop()!)
}

describe.skipIf(!hasPython)('python collections', () => {
  it('chains the same way as JavaScript: types namespace, filters by spec, graph steps, sort/top/table', () => {
    const r = runPython({
      plural: "entities.types.documents.get('d0')['label']",
      byName: "entities.types['person'].ids()",
      kwargs: 'entities.filter(min_degree=2, types={"person", "paper"}).ids()',
      dictSpec: "entities.filter({'minDegree': 1, 'maxDegree': 1, 'rel': 'wrote'}).ids()",
      tags: "entities.filter(tags='reviewed').count()",
      data: "entities.filter(data={'role': 'editor'}).labels()",
      dataList: "entities.filter(data={'role': ['editor', 'author']}, types='person').count()",
      text: "entities.filter(text='not').ids()",
      has: "entities.filter(has='year').ids()",
      created: "entities.filter(created_after='2020-03-15').ids()",
      neighbors: "entities.types.person.neighbors('wrote').labels()",
      out: "entities.types.paper.into('wrote').sources().sort('label', True).labels()",
      relFilter: "relationships.filter(source_type='person', target='w0').ids()",
      relFrom: "relationships.from_(entities.types.person.take(1)).ids()",
      relTypes: 'relationships.types.list()',
      sortPath: "entities.types.person.sort('data.born', True).first()['id']",
      top: "entities.top('data.born', 2).ids()",
      unique: "entities.unique('type')",
      group: "{k: v.count() for k, v in entities.group('type').items()}",
      rollup: "[(r['key'], r['value'], r['n']) for r in entities.rollup('type', 'data.born', 'mean')]",
      rollupItems: "entities.rollup('type')[1]['items'].__class__.__name__",
      exclude: "entities.exclude(types='person').ids()",
      table: "entities.types.paper.table(['label', 'data.year'])",
      describe: "entities.types.person.describe()['properties']",
      where: "entities.where(lambda e: e['id'] == 'w1').labels()",
      slice: 'entities[1:3].__class__.__name__',
      listLen: 'len(entities.types.person)',
      dfCol: "entities['type'][:2]",
      dfAttr: 'entities.head(1).__class__.__name__',
      chainLambda: "entities.types.person.filter(lambda e: e['data']['born'] > 1803).ids()",
      typesIn: "'papers' in entities.types",
      mixed: "entities.types.person.filter(tags='reviewed').out('wrote').targets().labels()",
      // The JavaScript helpers, by their Python names.
      helpers: "[bin('2020-03-15T10:20:00Z', 'month'), bin('2020-03-15', 'week'), iso_date(ms('2020-03-15T10:20:00Z')), round(days_between('2020-01-01', '2020-01-31')), mean([1, 2, None, 3]), median([3, 1, 2]), distinct(['a', 'a', 'b']), count([1, 2])]",
      helpers2: "[[r['key'], r['value']] for r in rollup(entities.types.person, 'data.role', 'data.born', 'max')]",
      helpers3: "[top_k(entities, 'data.born', 1)[0]['id'], sort_by(entities.types.paper, 'data.year', True)[0]['id'], list(group_by(entities, 'type').keys()), rolling([1, 2, 3, 4], 2)]",
      trace: "bar(['a'], [1], name='n')",
      byName2: "entities.filter('paper').ids()",
    })
    expect(r).toEqual({
      plural: 'Doc',
      byName: ['p0', 'p1', 'p2', 'p3', 'p4', 'p5'],
      kwargs: ['p1', 'w0', 'w1'],
      dictSpec: ['p0', 'w1'],
      tags: 3,
      data: ['P1', 'P3', 'P5'],
      dataList: 6,
      text: ['w0'],
      has: ['w0', 'w1'],
      created: ['p3', 'p4', 'p5'],
      neighbors: ['Notes', 'More'],
      out: ['P1', 'P0'],
      relFilter: ['r0', 'r1'],
      relFrom: ['r0'],
      relTypes: ['wrote', 'cites'],
      sortPath: 'p5',
      top: ['p5', 'p4'],
      unique: ['person', 'paper', 'document'],
      group: { person: 6, paper: 2, document: 1 },
      rollup: [
        ['document', null, 1],
        ['paper', null, 2],
        ['person', 1802.5, 6],
      ],
      rollupItems: 'Entities',
      exclude: ['w0', 'w1', 'd0'],
      table: { table: { columns: ['label', 'data.year'], rows: [['Notes', 1843], ['More', 1850]] } },
      describe: ['born:int', 'role:str'],
      where: ['More'],
      slice: 'Entities',
      listLen: 6,
      dfCol: ['person', 'person'],
      dfAttr: 'DataFrame',
      chainLambda: ['p4', 'p5'],
      typesIn: true,
      mixed: ['Notes', 'More'],
      helpers: ['2020-03-01T00:00:00.000Z', '2020-03-09T00:00:00.000Z', '2020-03-15', 30, 2, 2, 2, 2],
      helpers2: [['author', 1804], ['editor', 1805]],
      helpers3: ['p5', 'w1', ['person', 'paper', 'document'], [null, 1.5, 2.5, 3.5]],
      trace: { type: 'bar', x: ['a'], y: [1], name: 'n' },
      byName2: ['w0', 'w1'],
    })
  })
})
