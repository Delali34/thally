import { type NextRequest } from 'next/server'
import { getAllApiOperationNodes } from '@/data/api-reference'
import { canReaderViewPage, loadSidebarCollections, loadDocEntries } from '@/data/docs'
import { getIndexableDocTranslation } from '@/lib/i18n/translation-source'
import { localizedPath } from '@/lib/i18n/config'
import { getEffectiveI18nConfig } from '@/lib/i18n/request'
import { problemResponse } from '@/lib/http/problem'
import { findChangelogPages } from '@/lib/changelog'
import { getReaderAuthConfig } from '@/lib/reader-auth/config'
import { canReaderAccessUnmarkedContent } from '@/lib/reader-auth/access'
import { getReaderContextFromRequest } from '@/lib/reader-auth/context'
import { contentCacheControl } from '@/lib/reader-auth/cache'
import { navigationResponse } from '@/lib/navigation-snapshot-server'

export async function GET(request: NextRequest) {
  // Existing reserved content endpoint: navigation retains the same reader
  // gate without colliding with an authored /api/navigation documentation URL.
  if (request.nextUrl.searchParams.get('view') === 'navigation') return navigationResponse(request)
  const baseUrl = request.nextUrl.origin
  const i18n = await getEffectiveI18nConfig()
  const requestedLocale = request.nextUrl.searchParams.get('locale')
  if (requestedLocale && !i18n.locales.some((locale) => locale.code === requestedLocale)) {
    return problemResponse({
      status: 400,
      code: 'invalid_locale',
      title: 'Unsupported language',
      detail: 'The requested locale is not enabled for this site.',
      resolution: 'Use a language code enabled in the site configuration.',
      instance: request.nextUrl.pathname,
    })
  }
  const locale = requestedLocale ?? i18n.defaultLocale
  // The index lists exactly what this reader may open (anonymous by default).
  const reader = await getReaderContextFromRequest(request)
  const entries = await loadDocEntries(reader)
  const collections = await loadSidebarCollections(undefined, reader)
  const apiNodes = canReaderAccessUnmarkedContent(reader, getReaderAuthConfig()) ? await getAllApiOperationNodes() : []
  // Changelog feeds are anonymous projections (see `@/lib/changelog`).
  const hasChangelog = (await findChangelogPages()).length > 0

  // Build a lookup: href → { tab, group }
  const hrefToNav = new Map<string, { tab: string; group: string }>()
  for (const collection of collections) {
    for (const section of collection.sections) {
      for (const item of section.items) {
        const parts = section.title.split(' • ')
        hrefToNav.set(item.href, {
          tab: collection.label,
          group: parts[parts.length - 1] ?? section.title,
        })
      }
    }
  }

  const docPages = (await Promise.all(entries
    .filter((e) => !e.noindex && !e.hidden)
    .map(async (e) => {
      const translated = locale === i18n.defaultLocale
        ? null
        : await getIndexableDocTranslation(e.slug, locale)
      if (locale !== i18n.defaultLocale && !translated) return null
      // A translation may restrict its page further than the primary file.
      if (locale !== i18n.defaultLocale && !(await canReaderViewPage(e.id, reader, locale))) return null
      const nav = hrefToNav.get(e.href)
      return {
        type: 'doc' as const,
        id: e.id,
        title: translated?.title ?? e.title,
        description: translated?.description ?? e.description,
        url: `${baseUrl}${localizedPath(e.href, locale, i18n.defaultLocale)}`,
        api_url: `${baseUrl}/api/docs/${locale === i18n.defaultLocale ? '' : `${locale}/`}${e.id}`,
        json_ld_url: `${baseUrl}${localizedPath(e.href, locale, i18n.defaultLocale)}?format=ldjson`,
        tab: nav?.tab ?? '',
        group: nav?.group ?? '',
        ...(e.badge ? { badge: e.badge } : {}),
        ...((translated?.keywords ?? e.keywords).length ? { keywords: translated?.keywords ?? e.keywords } : {}),
        ...(e.lastVerified ? { last_verified: e.lastVerified } : {}),
        ...(e.verifiedVersion ? { verified_version: e.verifiedVersion } : {}),
      }
    }))).filter((entry): entry is NonNullable<typeof entry> => entry !== null)

  const apiPages = apiNodes.map((node) => ({
    type: 'api_operation' as const,
    id: node.slug.join('/'),
    title: node.operation.title,
    description: node.operation.description ?? `${node.operation.method} ${node.operation.path}`,
    url: `${baseUrl}${node.href}`,
    method: node.operation.method,
    path: node.operation.path,
    openapi_url: `${baseUrl}/openapi.yaml`,
    ...(node.operation.tags?.length ? { tags: node.operation.tags } : {}),
  }))

  const pages = locale === i18n.defaultLocale ? [...docPages, ...apiPages] : docPages

  return Response.json(
    {
      schema_version: '1',
      locale,
      as_of: new Date().toISOString(),
      total: pages.length,
      discovery: {
        llms_txt: `${baseUrl}/llms.txt`,
        llms_full_txt: `${baseUrl}/llms-full.txt`,
        ai_txt: `${baseUrl}/ai.txt`,
        skill: `${baseUrl}/skill.md`,
        agents: `${baseUrl}/AGENTS.md`,
        search: `${baseUrl}/api/search`,
        agent_readiness: `${baseUrl}/api/agent-readiness`,
        mcp: `${baseUrl}/api/mcp`,
        openapi: `${baseUrl}/openapi.yaml`,
        robots: `${baseUrl}/robots.txt`,
        sitemap: `${baseUrl}/sitemap.xml`,
        ...(hasChangelog
          ? { changelog_json_feed: `${baseUrl}/changelog/feed.json`, changelog_rss: `${baseUrl}/changelog/rss.xml` }
          : {}),
      },
      pages,
    },
    {
      headers: {
        'Cache-Control': contentCacheControl('public, s-maxage=3600, stale-while-revalidate=86400'),
        'Access-Control-Allow-Origin': '*',
      },
    },
  )
}
