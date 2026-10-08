import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { BlockInfo } from '../../../core/slides/slides'
import { Composition } from '../Composition'

const leaf = (id: string): BlockInfo => ({ id, label: id, kind: 'stats', items: [{ label: id, value: '1' }], children: [], text: '', showTitle: true })
const row = (id: string, children: string[]): BlockInfo => ({ id, label: id, kind: 'row', items: [], children, text: '', showTitle: true })

describe('Composition', () => {
  it('draws each block once, however the rows repeat it — thirty doubling rows stay a handful of blocks', () => {
    const blocks = new Map<string, BlockInfo>()
    blocks.set('leaf', leaf('leaf'))
    let next = 'leaf'
    for (let i = 0; i < 30; i++) {
      const id = `r${i}`
      blocks.set(id, row(id, [next, next]))
      next = id
    }
    const html = renderToStaticMarkup(<Composition id={next} blocks={blocks} labelOf={() => undefined} />)
    expect(html.length).toBeLessThan(20_000)
    expect(html.match(/data-block="leaf"/g)?.length ?? 0).toBeLessThanOrEqual(1)
  })

  it('draws a block that contains itself once', () => {
    const blocks = new Map<string, BlockInfo>([['a', row('a', ['a', 'b'])], ['b', leaf('b')]])
    const html = renderToStaticMarkup(<Composition id="a" blocks={blocks} labelOf={() => undefined} />)
    expect(html.match(/data-block="b"/g)).toHaveLength(1)
  })
})
