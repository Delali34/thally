/**
 * Canonical origin resolution for the server-only Cloud handshake.
 * Keep reusable helpers outside route modules, whose exports Next validates.
 */

import type { NextRequest } from 'next/server'

function firstForwardedValue(value: string | null): string | null {
  return value?.split(',')[0]?.trim() || null
}

function configuredSiteOrigin(): string | null {
  const configured = (
    process.env.THALLY_SITE_URL ??
    process.env.DOX_SITE_URL ??
    process.env.NEXT_PUBLIC_SITE_URL
  )?.trim()
  if (!configured) return null

  try {
    const url = new URL(configured)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    return url.origin
  } catch {
    return null
  }
}

/** Resolve the canonical or externally visible origin without provider APIs. */
export function getExternalSiteUrl(request: NextRequest): string {
  const configured = configuredSiteOrigin()
  if (configured) return configured

  const fallback = new URL(request.url)
  const host = firstForwardedValue(request.headers.get('x-forwarded-host'))
  const protocol = firstForwardedValue(request.headers.get('x-forwarded-proto'))
  const candidate = host ? `${protocol === 'http' ? 'http' : 'https'}://${host}` : fallback.origin
  const url = new URL(candidate)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return fallback.origin
  return url.origin
}
