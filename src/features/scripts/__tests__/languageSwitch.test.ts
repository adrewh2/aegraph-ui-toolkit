import { describe, expect, it } from 'vitest'
import { codeOfReply, pairOf, planSwitch } from '../languageSwitch'

/**
 * Switching languages: the assistant converts, the pair is cached, the
 * way back restores when nothing changed, an edit converts again, Visual
 * scripts are left alone.
 */
describe('planSwitch', () => {
  it('asks the assistant on a first switch; restores the original on the way back; converts again after an edit', () => {
    expect(planSwitch(null, 'js', 'python', 'a')).toEqual({ kind: 'assistant' })
    const pair = pairOf('js', 'a', 'python', 'b')
    // Back without touching the Python: the JavaScript exactly as it was, no conversion.
    expect(planSwitch(pair, 'python', 'js', 'b')).toEqual({ kind: 'cached', code: 'a' })
    // Forward again, still unchanged: cached too.
    expect(planSwitch(pair, 'js', 'python', 'a')).toEqual({ kind: 'cached', code: 'b' })
    // An edit on either side before switching: the assistant again.
    expect(planSwitch(pair, 'python', 'js', 'b2')).toEqual({ kind: 'assistant' })
    expect(planSwitch(pair, 'js', 'python', 'a2')).toEqual({ kind: 'assistant' })
  })
  it('leaves Visual scripts and same-language switches alone', () => {
    expect(planSwitch(null, 'view', 'python', 'x').kind).toBe('none')
    expect(planSwitch(null, 'js', 'view', 'x').kind).toBe('none')
    expect(planSwitch(null, 'js', 'js', 'x')).toEqual({ kind: 'none', reason: 'same language' })
  })
  it('reads the code out of an assistant reply', () => {
    expect(codeOfReply('Here you go:\n```python\nx = 1\n```\nDone.')).toBe('x = 1\n')
    expect(codeOfReply('x = 2')).toBe('x = 2\n')
  })
})
