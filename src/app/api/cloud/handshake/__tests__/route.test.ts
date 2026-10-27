/** Same-origin Thally Cloud handshake route contract. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => ({ connectCloudSite: vi.fn() }))

vi.mock('@/lib/cloud-link/client', () => ({
  connectCloudSite: mocks.connectCloudSite,
}))

import * as handshakeRoute from '../route'
import { POST } from '../route'
import { getExternalSiteUrl } from '@/lib/cloud-link/handshake-request'

describe('POST /api/cloud/handshake', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.unstubAllEnvs()
  })

  afterEach(() => vi.unstubAllEnvs())

  it('exports only supported Next.js route entrypoints and configuration', () => {
    expect(Object.keys(handshakeRoute).sort()).toEqual(['POST', 'runtime'])
  })

  it('reports the forwarded deployment origin to the server-only client', async () => {
    mocks.connectCloudSite.mockResolvedValue({ status: 'connected' })
    const request = new NextRequest('http://internal:3040/api/cloud/handshake', {
      method: 'POST',
      headers: {
        'x-forwarded-host': 'docs.example.com',
        'x-forwarded-proto': 'https',
      },
    })

    const response = await POST(request)

    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toEqual({ status: 'connected' })
    expect(mocks.connectCloudSite).toHaveBeenCalledWith('https://docs.example.com')
  })

  it('falls back to the request origin when forwarding headers are absent', () => {
    const request = new NextRequest('https://docs.example.com/api/cloud/handshake')
    expect(getExternalSiteUrl(request)).toBe('https://docs.example.com')
  })

  it('prefers the configured canonical site URL on any hosting provider', () => {
    vi.stubEnv('THALLY_SITE_URL', 'https://docs.example.com/guides')
    const request = new NextRequest('https://provider-generated.example/api/cloud/handshake')

    expect(getExternalSiteUrl(request)).toBe('https://docs.example.com')
  })

  it('returns only a safe failure status when Thally Cloud cannot be reached', async () => {
    mocks.connectCloudSite.mockResolvedValue({ status: 'cloud_unreachable' })
    const response = await POST(
      new NextRequest('https://docs.example.com/api/cloud/handshake', {
        method: 'POST',
      }),
    )

    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ status: 'cloud_unreachable' })
  })
})
