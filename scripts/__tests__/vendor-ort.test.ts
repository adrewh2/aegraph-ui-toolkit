import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = resolve(__dirname, '../..')
const version = (p: string) => JSON.parse(readFileSync(resolve(ROOT, 'node_modules', p, 'package.json'), 'utf8')).version as string

describe('search by meaning runs this origin’s own ONNX runtime', () => {
  it('copies the runtime transformers.js is built against', () => {
    const vendor = readFileSync(resolve(ROOT, 'scripts/vendor.mjs'), 'utf8')
    const files = JSON.parse(/const ORT_FILES = (\[[^\]]*\])/.exec(vendor)![1].replace(/'/g, '"')) as string[]
    for (const f of files) expect(existsSync(resolve(ROOT, 'node_modules/onnxruntime-web/dist', f)), f).toBe(true)
    const wanted = JSON.parse(readFileSync(resolve(ROOT, 'node_modules/@huggingface/transformers/package.json'), 'utf8')).dependencies['onnxruntime-web']
    expect(version('onnxruntime-web')).toBe(wanted)
  })

  it('points the runtime at the copy, not the CDN', () => {
    const embedder = readFileSync(resolve(ROOT, 'src/features/search/embedder.ts'), 'utf8')
    expect(embedder).toMatch(/wasmPaths = ORT_PATH/)
    expect(embedder).toContain("ORT_PATH = '/vendor/ort/'")
  })
})
