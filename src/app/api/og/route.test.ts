/** Social cards consume the same customer identity as interactive site branding. */
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => ({ cloud: vi.fn(), asset: vi.fn(), docs: vi.fn() }))
vi.mock('@/lib/cloud-link/client', () => ({ getCloudSiteConfig: mocks.cloud }))
vi.mock('@/lib/admin/settings', async importOriginal => ({
  ...await importOriginal<typeof import('@/lib/admin/settings')>(),
  getBrandAsset: mocks.asset,
}))
vi.mock('@/lib/docs-json-config', () => ({ getDocsJsonConfig: mocks.docs }))
vi.mock('@/lib/site-config', () => ({ resolveSiteConfig: async () => ({ name: 'Customer', description: 'Customer documentation' }) }))
import { setContentAssetFetcher } from '@/lib/content-source/runtime'
import * as renderer from '@/lib/og-image'
import { GET } from './route'

const light = '<svg width="24" height="24" xmlns="http://www.w3.org/2000/svg"><path fill="red" d="M0 0h24v24H0z"/></svg>'
const dark = light.replace('red', 'blue')
let render: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  vi.clearAllMocks()
  mocks.cloud.mockResolvedValue(null)
  mocks.asset.mockResolvedValue(null)
  mocks.docs.mockReturnValue({ navbar: { logo: { light: '/customer-light.svg', dark: '/customer-dark.svg' } } })
  render = vi.spyOn(renderer, 'renderDocsOgImage')
  setContentAssetFetcher(async assetPath => {
    if (assetPath === '/customer-light.svg') return new Response(light)
    if (assetPath === '/customer-dark.svg') return new Response(dark)
    try {
      return new Response(await readFile(path.join(process.cwd(), 'public', assetPath)))
    } catch {
      return new Response(null, { status: 404 })
    }
  })
})

afterEach(() => {
  setContentAssetFetcher(null)
  vi.restoreAllMocks()
})

describe('GET /api/og', () => {
  it.each(['light', 'dark'])('renders configured %s SVG and custom site identity into a real PNG', async theme => {
    const network = vi.spyOn(globalThis, 'fetch')
    const response = await GET(new NextRequest(`https://customer.example/api/og?theme=${theme}`))
    const options = render.mock.calls[0][0] as renderer.DocsOgImageOptions
    expect(options.brandName).toBe('Customer')
    expect(Buffer.from(options.logoUri!.split(',')[1], 'base64').toString()).toBe(theme === 'dark' ? dark : light)
    const bytes = Buffer.from(await response.arrayBuffer())
    expect(response.headers.get('content-type')).toBe('image/png')
    expect(bytes.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
    expect(network.mock.calls.filter(([input]) => /^https?:/i.test(String(input)))).toEqual([])
  })

  it('keeps text-only branding when navbar.logo is explicitly null', async () => {
    mocks.docs.mockReturnValue({ navbar: { logo: null } })
    const response = await GET(new NextRequest('https://customer.example/api/og'))
    expect((render.mock.calls[0][0] as renderer.DocsOgImageOptions).logoUri).toBeUndefined()
    expect((await response.arrayBuffer()).byteLength).toBeGreaterThan(0)
  })

  it('degrades missing authored artwork to the bundled image without failing the card', async () => {
    mocks.docs.mockReturnValue({ navbar: { logo: { light: '/missing.svg' } } })
    const response = await GET(new NextRequest('https://customer.example/api/og'))
    const options = render.mock.calls[0][0] as renderer.DocsOgImageOptions
    expect(options.logoIsSquare).toBe(true)
    expect(options.logoUri).toMatch(/^data:image\/svg\+xml;base64,/)
    expect((await response.arrayBuffer()).byteLength).toBeGreaterThan(0)
  })
})
