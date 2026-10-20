/** Site identity resolution and HTTP image contracts across hosting modes. */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => ({ cloud: vi.fn(), asset: vi.fn(), docs: vi.fn() }))
vi.mock('@/lib/cloud-link/client', () => ({ getCloudSiteConfig: mocks.cloud }))
vi.mock('@/lib/admin/settings', async importOriginal => ({
  ...await importOriginal<typeof import('@/lib/admin/settings')>(),
  getBrandAsset: mocks.asset,
}))
vi.mock('@/lib/docs-json-config', () => ({ getDocsJsonConfig: mocks.docs }))
import { resolveBrandAsset } from './brand-assets'
import { GET as logo } from '@/app/api/brand/logo/route'
import { GET as favicon } from '@/app/api/brand/favicon/route'

const origin = 'https://customer.example'
const uploaded = `data:image/png;base64,${Buffer.from('uploaded').toString('base64')}`

describe('consistent brand resolution', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.cloud.mockResolvedValue(null)
    mocks.asset.mockResolvedValue(null)
    mocks.docs.mockReturnValue({ navbar: { logo: { light: '/logo.svg', dark: '/logo-dark.svg' } }, favicon: { light: '/icon.svg', dark: '/icon-dark.svg' } })
  })

  it.each(['logo', 'favicon'] as const)('%s uses managed before admin before authored artwork in both modes', async kind => {
    mocks.cloud.mockResolvedValue({ siteConfig: { portable: { branding: { [kind]: '/managed.png', [`${kind}Dark`]: '/managed-dark.png' } } } })
    mocks.asset.mockResolvedValue(uploaded)
    expect(await resolveBrandAsset(kind, 'dark', origin)).toEqual({ path: '/managed-dark.png' })
    expect(await resolveBrandAsset(kind, 'light', origin)).toEqual({ path: '/managed.png' })
    expect(mocks.asset).not.toHaveBeenCalled()
    mocks.cloud.mockResolvedValue(null)
    expect(await resolveBrandAsset(kind, 'dark', origin)).toEqual({ dataUri: uploaded })
    mocks.asset.mockResolvedValue(null)
    expect(await resolveBrandAsset(kind, 'dark', origin)).toEqual({ path: kind === 'logo' ? '/logo-dark.svg' : '/icon-dark.svg' })
    expect(await resolveBrandAsset(kind, 'light', origin)).toEqual({ path: kind === 'logo' ? '/logo.svg' : '/icon.svg' })
  })

  it('falls back from absent dark variants to light at every layer', async () => {
    mocks.cloud.mockResolvedValue({ siteConfig: { portable: { branding: { logo: '/managed.png' } } } })
    expect(await resolveBrandAsset('logo', 'dark', origin)).toEqual({ path: '/managed.png' })
    mocks.cloud.mockResolvedValue(null)
    mocks.asset.mockImplementation(async key => key === 'logo' ? uploaded : null)
    expect(await resolveBrandAsset('logo', 'dark', origin)).toEqual({ dataUri: uploaded })
    mocks.asset.mockResolvedValue(null)
    mocks.docs.mockReturnValue({ navbar: { logo: { light: '/only.svg' } } })
    expect(await resolveBrandAsset('logo', 'dark', origin)).toEqual({ path: '/only.svg' })
  })

  it('recovers independently from Cloud and admin lookup failures', async () => {
    mocks.cloud.mockRejectedValue(new Error('offline'))
    mocks.asset.mockResolvedValue(uploaded)
    expect(await resolveBrandAsset('logo', 'light', origin)).toEqual({ dataUri: uploaded })
    mocks.asset.mockRejectedValue(new Error('offline'))
    expect(await resolveBrandAsset('logo', 'light', origin)).toEqual({ path: '/logo.svg' })
  })

  it('rejects external destinations and SVG data uploads', async () => {
    mocks.cloud.mockResolvedValue({ siteConfig: { portable: { branding: { logo: 'https://evil.example/a.svg' } } } })
    mocks.asset.mockResolvedValue('data:image/svg+xml;base64,PHN2Zz4=')
    expect(await resolveBrandAsset('logo', 'light', origin)).toEqual({ path: '/logo.svg' })
    mocks.docs.mockReturnValue({ navbar: { logo: { light: '//evil.example/logo.svg' } } })
    expect(await resolveBrandAsset('logo', 'light', origin)).toBeNull()
  })

  it('preserves explicitly disabled logo without disabling the favicon', async () => {
    mocks.docs.mockReturnValue({ navbar: { logo: null }, favicon: { light: '/icon.svg' } })
    expect(await resolveBrandAsset('logo', 'dark', origin)).toEqual({ disabled: true })
    expect(await resolveBrandAsset('favicon', 'dark', origin)).toEqual({ path: '/icon.svg' })
  })

  it('serves authored redirects and raster upload bytes through the existing routes', async () => {
    const response = await logo(new NextRequest(`${origin}/api/brand/logo?mode=dark`))
    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe(`${origin}/logo-dark.svg`)
    mocks.asset.mockResolvedValue(uploaded)
    const icon = await favicon(new NextRequest(`${origin}/api/brand/favicon`))
    expect(icon.headers.get('content-type')).toBe('image/png')
    expect(await icon.text()).toBe('uploaded')
  })

  it('retains safe default favicon and missing-logo responses with no custom config', async () => {
    mocks.docs.mockReturnValue({})
    expect((await logo(new NextRequest(`${origin}/api/brand/logo`))).status).toBe(404)
    const icon = await favicon(new NextRequest(`${origin}/api/brand/favicon?mode=dark`))
    expect(icon.headers.get('location')).toBe('/brand/default-favicon-dark.svg')
  })
})
