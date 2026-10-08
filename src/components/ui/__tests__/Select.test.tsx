import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Select } from '../Select'

/** The trigger shows the current choice's text (not its value), carries the value, and sizes to every choice. */
describe('Select', () => {
  it('shows the chosen option’s label from the same children a native select takes', () => {
    const html = renderToString(
      <Select value="all" onChange={() => {}} className="gx-select">
        <option value="auto">Labels: auto</option>
        <optgroup label="More">
          {['all', 'none'].map((v) => (
            <option key={v} value={v}>
              Labels: {v}
            </option>
          ))}
        </optgroup>
      </Select>,
    )
    expect(html).toContain('data-value="all"')
    expect(html).toContain('class="select-trigger gx-select"')
    // The current label, and each choice once more as a hidden sizer.
    expect(html).toMatch(/<span>Labels: <!-- -->all<\/span>|<span>Labels: all<\/span>/)
    expect(html.match(/select-trigger__ghost/g)).toHaveLength(3)
    expect(html).not.toContain('<select')
  })

  it('says it opens a menu, and whether it is open', () => {
    const html = renderToString(
      <Select value="a" onChange={() => {}}>
        <option value="a">A</option>
      </Select>,
    )
    expect(html).toContain('aria-haspopup="menu"')
    expect(html).toContain('aria-expanded="false"')
  })
})
