/** Same-origin, server-only trigger for a site's Thally Cloud handshake. */

import { NextResponse, type NextRequest } from 'next/server'
import { connectCloudSite } from '@/lib/cloud-link/client'
import { getExternalSiteUrl } from '@/lib/cloud-link/handshake-request'

export const runtime = 'nodejs'

/**
 * POST /api/cloud/handshake
 *
 * The browser calls this route without credentials. The server reads the
 * private site token, exchanges it with Thally Cloud, and returns only a safe status.
 */
export async function POST(request: NextRequest): Promise<Response> {
  const result = await connectCloudSite(getExternalSiteUrl(request))
  return NextResponse.json(result, {
    status: result.status === 'connected' || result.status === 'not_configured' ? 200 : 503,
    headers: { 'Cache-Control': 'no-store' },
  })
}
