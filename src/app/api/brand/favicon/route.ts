/** Serve resolved site branding, keeping missing artwork a safe image fallback. */
import type { NextRequest } from 'next/server'
import { brandAssetResponse, resolveBrandAsset } from '@/lib/brand-assets'

export const runtime = 'nodejs'

/** Managed assets override uploads and authored docs.json paths in either mode. */
export async function GET(request: NextRequest) {
  const mode = request.nextUrl.searchParams.get('mode') === 'dark' ? 'dark' : 'light'
  const asset = await resolveBrandAsset('favicon', mode, request.nextUrl.origin)
  return brandAssetResponse(asset, request.nextUrl.origin) ?? new Response(null, {
    status: 302,
    headers: { Location: `/brand/default-favicon-${mode}.svg` },
  })
}
