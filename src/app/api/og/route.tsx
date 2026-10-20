/**
 * Dynamic social-image endpoint for documentation pages.
 */
import { type NextRequest } from 'next/server'
import { renderDocsOgImage, type OgImageFont } from '@/lib/og-image'
import { resolveOgConfig } from '@/lib/og'
import { resolveBrandAsset } from '@/lib/brand-assets'
import { publicBrandImageDataUri, readPublicAsset } from '@/lib/public-asset-data'
import { resolveSiteConfig } from '@/lib/site-config'

// Node is required because the admin storage adapter may use Node facilities.
export const runtime = 'nodejs'

async function loadFont(path: string, name: string, weight: 400 | 700): Promise<OgImageFont> {
  const bytes = await readPublicAsset(path, 2 * 1024 * 1024)
  if (!bytes) {
    throw new Error(`Unable to load OG font: ${path}`)
  }

  return {
    name,
    data: Uint8Array.from(bytes).buffer,
    weight,
    style: 'normal',
  }
}

async function buildLeafDataUri(color: string): Promise<string | undefined> {
  const bytes = await readPublicAsset('/brand/default-logo-light.svg', 512 * 1024)
  if (!bytes) return undefined
  const svg = bytes.toString('utf8').replace(/fill="[^"]+"/, `fill="${color}"`)
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`
}

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl
  const theme = searchParams.get('theme') === 'dark' ? 'dark' : 'light'
  const effectiveSite = await resolveSiteConfig(request.nextUrl.origin)
  const og = resolveOgConfig(
    theme,
    searchParams.get('accent') || undefined,
    effectiveSite,
    request.nextUrl.origin,
  )
  const title = searchParams.get('title') || `${effectiveSite.name} Documentation`
  const description = searchParams.get('description') || effectiveSite.description
  const crumb = searchParams.get('crumb') || 'Documentation'
  const url = searchParams.get('url') || og.domain

  const brand = await resolveBrandAsset('logo', theme, request.nextUrl.origin)
  const requestedLogo = brand?.dataUri ?? (brand?.path ? await publicBrandImageDataUri(brand.path) : null)
  const logoUri = brand?.disabled ? undefined : requestedLogo ?? (await buildLeafDataUri(og.leaf))

  const fonts = await Promise.all([
    loadFont('/fonts/og/PlusJakartaSans-700.ttf', 'Jakarta', 700),
    loadFont('/fonts/og/Inter-400.woff', 'Inter', 400),
    loadFont('/fonts/og/JetBrainsMono-400.woff', 'Mono', 400),
  ])

  return renderDocsOgImage({
    title,
    description,
    crumb,
    url,
    brandName: og.logoText,
    logoUri,
    logoIsSquare: !requestedLogo,
    palette: og,
    fonts,
  })
}
