/** Shared managed, admin, and authored branding resolution for image consumers. */

import { getBrandAsset, isValidBrandAsset } from '@/lib/admin/settings'
import { getCloudSiteConfig } from '@/lib/cloud-link/client'
import { getDocsJsonConfig } from '@/lib/docs-json-config'
import { publicBrandAssetPath } from '@/lib/public-brand-asset'

export interface ResolvedBrandAsset {
  /** Authored paths stay local; only validated admin uploads use data URIs. */
  path?: string
  dataUri?: string
  /** An explicitly text-only navbar also omits the logo from social cards. */
  disabled?: boolean
}

interface AuthoredBranding {
  navbar?: { logo?: { light?: string; dark?: string } | null }
  favicon?: { light?: string; dark?: string }
}

function modePath(light?: string, dark?: string, mode: 'light' | 'dark' = 'light'): string | null {
  return (mode === 'dark' ? [dark, light] : [light])
    .map(publicBrandAssetPath)
    .find((candidate) => candidate !== null) ?? null
}

/** Resolve each layer independently so an unavailable service cannot hide file defaults. */
export async function resolveBrandAsset(
  kind: 'logo' | 'favicon',
  mode: 'light' | 'dark',
  siteOrigin: string,
): Promise<ResolvedBrandAsset | null> {
  const docs = getDocsJsonConfig<AuthoredBranding>()
  if (kind === 'logo' && docs.navbar?.logo === null) return { disabled: true }

  try {
    const cloud = await getCloudSiteConfig(siteOrigin)
    const branding = cloud?.siteConfig.portable.branding
    const path = modePath(branding?.[kind], branding?.[`${kind}Dark`], mode)
    if (path) return { path }
  } catch {
    // Single-site admin and authored assets remain useful during a Cloud outage.
  }

  for (const key of mode === 'dark' ? [`${kind}-dark` as const, kind] : [kind]) {
    try {
      const dataUri = await getBrandAsset(key)
      if (dataUri && isValidBrandAsset(dataUri)) return { dataUri }
    } catch {
      // A missing dark upload must not prevent the light upload or file fallback.
    }
  }

  const asset = kind === 'logo' ? docs.navbar?.logo : docs.favicon
  const path = modePath(asset?.light, asset?.dark, mode)
  return path ? { path } : null
}

/** Keep image routes' existing redirect/byte contracts while sharing precedence. */
export function brandAssetResponse(asset: ResolvedBrandAsset | null, origin: string): Response | null {
  if (asset?.path) return Response.redirect(new URL(asset.path, origin), 302)
  if (!asset?.dataUri) return null
  const match = /^data:(image\/[a-z]+);base64,(.+)$/.exec(asset.dataUri)
  if (!match) return null
  return new Response(Buffer.from(match[2], 'base64'), {
    headers: { 'content-type': match[1], 'cache-control': 'public, max-age=300' },
  })
}
