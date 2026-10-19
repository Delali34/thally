/** Trusted rendering is optional, PNG-only, byte-bound, and tied to source SVG evidence. */
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { runUrlMigration } from '../url-run.js'
import type { MigrationCapturedAsset, UrlMigrationRunOptions } from '../url-run-types.js'

const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><div>Diagram</div></foreignObject></svg>')
const png = Buffer.from('iVBORw0KGgo=', 'base64')
const asset = { url: 'https://docs.example.test/diagram.svg', contentType: 'image/svg+xml', content: svg }
function run(rasterizeSvg?: UrlMigrationRunOptions['rasterizeSvg']) {
  return runUrlMigration({ sourceUrl: 'https://docs.example.test/guide', rasterizeSvg, captureProvider: { capture: async ({ url }) => {
    if (url.pathname !== '/guide') throw new Error('Missing index')
    return { finalUrl: url, contentType: 'text/html', body: '<main><article><h1>Guide</h1><p>Read the original technical diagram.</p><img src="/diagram.svg"></article></main>', assets: [asset] }
  } } })
}

describe('optional trusted SVG rasterization', () => {
  it('retains strict source rejection without an explicit renderer', async () => {
    const result = await run()
    expect(result.validation.status).toBe('partial')
    expect(result.validation.issues.some(issue => issue.code === 'asset-failed')).toBe(true)
    expect(result.bundle.assets).toEqual([])
  })

  it('records the original SVG digest and rewrites only the original asset destination', async () => {
    const received: MigrationCapturedAsset[] = []
    const result = await run(async input => { received.push(input); return { ...input, contentType: 'image/png', content: png } })
    expect(result.validation.status).toBe('passed')
    expect(received).toHaveLength(1)
    expect(received[0].content).toEqual(svg)
    const receipt = result.checkpoint.records.find(record => record.page)!.assets![0]
    expect(receipt).toMatchObject({ url: asset.url, contentType: 'image/png', derivedFromSha256: createHash('sha256').update(svg).digest('hex') })
    expect(receipt.path.endsWith('.png')).toBe(true)
    expect(result.bundle.pages[0].body).toContain(`/${receipt.path}`)
    expect(result.bundle.assets[0].content).toEqual(png)
  })

  it.each([
    { ...asset },
    { ...asset, contentType: 'image/png', content: Buffer.from('<script>unsafe()</script>') },
    { ...asset, contentType: 'image/png', content: Buffer.alloc(10_000_001) },
  ])('rejects renderer output without bounded PNG evidence', async output => {
    const result = await run(async () => output)
    expect(result.validation.status).toBe('partial')
    expect(result.bundle.assets).toEqual([])
    expect(result.validation.issues.some(issue => issue.message.includes('bounded PNG'))).toBe(true)
  })
})
