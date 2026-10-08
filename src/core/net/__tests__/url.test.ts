import { afterEach, describe, expect, it, vi } from 'vitest'
import { classifyUrl, isPrivateHost } from '../url'

afterEach(() => vi.unstubAllGlobals())

describe('classifyUrl on a page', () => {
  const onPage = () => vi.stubGlobal('location', new URL('http://127.0.0.1:5199/projects'))

  it('knows this origin from someone else’s', () => {
    onPage()
    expect(classifyUrl('/datasets/x.ae.json').kind).toBe('own')
    expect(classifyUrl('http://127.0.0.1:5199/a').kind).toBe('own')
    const v = classifyUrl('https://example.org/g.graphml')
    expect(v).toMatchObject({ kind: 'elsewhere', host: 'example.org' })
  })

  it('refuses what is not http(s), and credentials in the URL', () => {
    onPage()
    expect(classifyUrl('javascript:alert(1)').kind).toBe('refused')
    expect(classifyUrl('file:///etc/passwd').kind).toBe('refused')
    expect(classifyUrl('data:text/plain,hi').kind).toBe('refused')
    expect(classifyUrl('https://user:pw@example.org/').kind).toBe('refused')
  })

  it('leaves another loopback port to the confirmation, not a refusal — a page cannot read it without CORS anyway', () => {
    onPage()
    expect(classifyUrl('http://127.0.0.1:8080/').kind).toBe('elsewhere')
  })
})

describe('classifyUrl with no page (the headless engine)', () => {
  it('refuses a relative URL and every private address', () => {
    vi.stubGlobal('location', undefined)
    expect(classifyUrl('/datasets/x.ae.json').kind).toBe('refused')
    for (const u of ['http://127.0.0.1:5432/', 'http://localhost/', 'http://169.254.169.254/latest/meta-data/', 'http://10.0.0.8/', 'http://192.168.1.1/', 'http://172.20.0.1/', 'http://[::1]/', 'http://[fd00::1]/', 'http://[::ffff:127.0.0.1]/', 'http://2130706433/', 'http://0x7f.1/', 'http://0.0.0.0/'])
      expect(classifyUrl(u).kind, u).toBe('refused')
    expect(classifyUrl('https://example.org/').kind).toBe('elsewhere')
  })
})

describe('isPrivateHost', () => {
  it('passes public names and addresses', () => {
    for (const h of ['example.org', '8.8.8.8', '172.32.0.1', '[2606:4700::1111]']) expect(isPrivateHost(h), h).toBe(false)
  })
})
