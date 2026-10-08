import { describe, expect, it } from 'vitest'
import { parseDot, writeDot } from '../dot'

const SAMPLE = `
// A comment
digraph G {
  rankdir=LR;
  node [shape=box, fontname="Helvetica"];
  edge [color=gray];
  subgraph cluster_people {
    label = "People";
    style=filled;
    Plato [label="Plato of Athens", class="person ancient"];
    Aristotle;
  }
  subgraph cluster_works { label="Works"; Republic [shape=note, label="The Republic"] }
  Plato -> Aristotle [label="taught", style=bold];
  Plato -> Republic -> Ethics [label="wrote"];
  Aristotle:e -> Ethics:w;
  "Nicomachean Ethics" -> Ethics [style=dotted]
  Unknown /* inline */ [label=<<b>HTML</b>>];
  a -> { b c } [label="fan"];
}
`

describe('parseDot', () => {
  const d = parseDot(SAMPLE)

  it('reads header, graph attrs, and kind', () => {
    expect(d.kind).toBe('digraph')
    expect(d.attrs.name).toBe('G')
    expect(d.attrs.rankdir).toBe('LR')
    expect(d.warnings).toEqual([])
  })

  it('reads nodes with defaults, labels, shapes, classes, and groups', () => {
    const plato = d.nodes.find((n) => n.id === 'Plato')!
    expect(plato).toMatchObject({ label: 'Plato of Athens', shape: 'box', group: 'cluster_people', classes: ['person', 'ancient'] })
    expect(plato.attrs.fontname).toBe('Helvetica')
    expect(d.nodes.find((n) => n.id === 'Aristotle')!.group).toBe('cluster_people')
    expect(d.nodes.find((n) => n.id === 'Republic')).toMatchObject({ label: 'The Republic', shape: 'note', group: 'cluster_works' })
    expect(d.nodes.find((n) => n.id === 'Ethics')!.group).toBeUndefined()
    expect(d.nodes.find((n) => n.id === 'Nicomachean Ethics')).toBeDefined()
    expect(d.nodes.find((n) => n.id === 'Unknown')!.label).toBe('<b>HTML</b>')
  })

  it('reads groups', () => {
    expect(d.groups.map((g) => [g.id, g.label])).toEqual([
      ['cluster_people', 'People'],
      ['cluster_works', 'Works'],
    ])
    expect(d.groups[0].attrs.style).toBe('filled')
  })

  it('reads edges, chains, ports, fan-out, and defaults', () => {
    const e = d.edges
    expect(e.find((x) => x.source === 'Plato' && x.target === 'Aristotle')).toMatchObject({ label: 'taught', style: 'bold', directed: true })
    expect(e.find((x) => x.source === 'Plato' && x.target === 'Republic')!.label).toBe('wrote')
    expect(e.find((x) => x.source === 'Republic' && x.target === 'Ethics')!.label).toBe('wrote')
    expect(e.find((x) => x.source === 'Aristotle' && x.target === 'Ethics')).toBeDefined()
    expect(e.find((x) => x.source === 'Nicomachean Ethics')!.style).toBe('dotted')
    expect(e.filter((x) => x.source === 'a').map((x) => x.target).sort()).toEqual(['b', 'c'])
    expect(e.every((x) => x.attrs.color === 'gray')).toBe(true)
  })

  it('tolerates junk without giving up', () => {
    const bad = parseDot('graph { a -- b; ??? c -- d }')
    expect(bad.kind).toBe('graph')
    expect(bad.edges.length).toBe(2)
    expect(bad.edges[0].directed).toBe(false)
    expect(bad.warnings.length).toBeGreaterThan(0)
  })

  it('round-trips through writeDot', () => {
    const out = writeDot(d)
    const again = parseDot(out)
    expect(again.nodes.map((n) => n.id).sort()).toEqual(d.nodes.map((n) => n.id).sort())
    expect(again.edges.length).toBe(d.edges.length)
    expect(again.groups.map((g) => g.label)).toEqual(['People', 'Works'])
    expect(again.nodes.find((n) => n.id === 'Plato')).toMatchObject({ label: 'Plato of Athens', shape: 'box', classes: ['person', 'ancient'] })
    expect(out).toContain('rankdir=LR')
  })
})
