/** Localized API navigation, with request-policy rendering for managed assets. */

import type { Metadata } from 'next'
import { getContentSource, isRemoteContentSource } from '@/lib/content-source'
import { redirect } from 'next/navigation'
import { ApiLayout } from '@/components/api/api-layout'
import { OperationPanel } from '@/components/api/operation-panel'
import { resolvePlaygroundDisplay } from '@/lib/openapi/playground-display'
import { JsonLdScript } from '@/components/seo/json-ld-script'
import { getSiteUrl } from '@/lib/site-url'
import { pageFullTitle } from '@/lib/page-meta'
import { apiReferenceConfig, getOpenApiSpecUrl } from '@/config/api-reference'
import { getAllApiOperationNodes, getApiOperationBySlug, getApiOperationNodes } from '@/data/api-reference'
import { getApiPlaygroundDisplay, getApiSpecLinkVisible, getBreadcrumbs, getSeoConfig, getDocEntries, loadDocEntries } from '@/data/docs'
import { findDocSource, getIndexableDocTranslation, hasDocTranslation } from '@/lib/i18n/translation-source'
import { buildAgentAlternateLinks } from '@/lib/agent-discovery'
import { buildApiOperationJsonLd } from '@/lib/json-ld'
import { buildOgImageUrl, formatOgBreadcrumb, formatOgDisplayUrl } from '@/lib/og'
import { localeDirection, type I18nConfig } from '@/lib/i18n/config'
import {
  getEffectiveI18nConfig,
  getRepositoryI18nConfig,
} from '@/lib/i18n/request'
import { resolveBuildSiteConfig } from '@/lib/site-config'
import DocsPage, { generateMetadata as generateDocsMetadata } from '@/app/(docs)/[[...slug]]/page'
import { isReaderAuthActive } from '@/lib/reader-auth/config'
import { getReaderContext } from '@/lib/reader-auth/context'
import { canReaderSeeUnmarkedContent, denyDocumentAccess } from '@/lib/reader-auth/page-gate'

interface PageProps {
  params: Promise<{ locale: string; slug?: Array<string> }>
}

function isValidSecondaryLocale(locale: string, i18n: I18nConfig): boolean {
  return i18n.locales.some((l) => l.code === locale && l.code !== i18n.defaultLocale)
}

/**
 * The full document slug for this route. When `locale` is not a secondary
 * locale, the route has only matched an authored page such as
 * `/platform/api/overview`, which must render exactly as the document route would.
 */
function documentSlug(resolved: { locale: string; slug?: Array<string> }): Array<string> {
  return [resolved.locale, 'api', ...(resolved.slug ?? [])]
}

/** Keep managed routes dynamic even before a secondary locale or spec exists. */
export async function generateStaticParams() {
  const i18n = getRepositoryI18nConfig()
  // Always visit one well-formed locale root to establish the shell's request
  // boundary. A default-only scaffold has no localized pages yet; enumerating
  // its locales/specs would return [] and freeze the route into on-demand SSG.
  // Reader-auth sites render per request (see the document route).
  if (isRemoteContentSource() || isReaderAuthActive()) return [{ locale: i18n.defaultLocale, slug: [] }]
  const secondaryLocales = i18n.locales.filter((l) => l.code !== i18n.defaultLocale)
  const nodes = await getAllApiOperationNodes()
  const docs = getDocEntries().filter((doc) => doc.slug[0] === 'api')
  const translatedDocs = await Promise.all(secondaryLocales.flatMap(({ code }) =>
    docs.map(async (doc) => (await hasDocTranslation(doc.slug, code)
      ? { locale: code, slug: doc.slug.slice(1) }
      : null)),
  ))
  return [
    ...secondaryLocales.flatMap(({ code }) => nodes.map((node) => ({ locale: code, slug: node.slug }))),
    ...translatedDocs.filter((entry): entry is NonNullable<typeof entry> => entry !== null),
  ]
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const resolved = await params
  const i18n = await getEffectiveI18nConfig()
  if (!isValidSecondaryLocale(resolved.locale, i18n)) {
    return generateDocsMetadata({ params: Promise.resolve({ slug: documentSlug(resolved) }) })
  }
  const siteUrl = getSiteUrl()
  const node = await getApiOperationBySlug(resolved.slug)
  const specUrl = node ? getOpenApiSpecUrl(siteUrl, node.operation.specId) : null
  if (!node) {
    return generateDocsMetadata({ params: Promise.resolve({ slug: documentSlug(resolved) }) })
  }
  if (!canReaderSeeUnmarkedContent(await getReaderContext())) return {}
  const title = node.operation.title
  const description = node.operation.description ?? `${node.operation.method} ${node.operation.path}`
  const ogImageUrl = buildOgImageUrl({
    title,
    description,
    crumb: formatOgBreadcrumb(getBreadcrumbs(node.href), title, 'API Reference'),
    url: formatOgDisplayUrl(node.href, siteUrl),
  })

  const fullTitle = pageFullTitle({
    title,
    siteName: resolveBuildSiteConfig().name,
    separator: getSeoConfig().titleSeparator,
  })

  return {
    title: fullTitle ? { absolute: fullTitle } : title,
    description,
    robots: { index: false, follow: true },
    alternates: {
      // OpenAPI operation prose is source-language content. Localized routes
      // provide localized navigation without claiming a translated document.
      canonical: `${siteUrl}${node.href}`,
      types: {
        ...buildAgentAlternateLinks(node.href, siteUrl),
        ...(specUrl ? { 'application/vnd.oai.openapi': specUrl } : {}),
      },
    },
    openGraph: {
      title,
      description,
      images: [{ url: ogImageUrl, width: 1200, height: 630 }],
    },
    twitter: {
      card: 'summary_large_image',
      title,
      description,
      images: [ogImageUrl],
    },
  }
}

export default async function LocaleApiReferencePage({ params }: PageProps) {
  const resolved = await params
  const siteUrl = getSiteUrl()
  const i18n = await getEffectiveI18nConfig()
  const effectiveSite = resolveBuildSiteConfig()
  const reader = await getReaderContext()

  if (!isValidSecondaryLocale(resolved.locale, i18n)) {
    return DocsPage({ params: Promise.resolve({ slug: documentSlug(resolved) }) })
  }

  if (!resolved.slug?.length) {
    // Source lookup preserves normal translation fallback. The document
    // renderer remains responsible for locale, publication and reader policy.
    if (await findDocSource(getContentSource(), 'api', resolved.locale)) {
      return DocsPage({ params: Promise.resolve({ slug: [resolved.locale, 'api'] }) })
    }
    const mdxCandidates = (await loadDocEntries(reader)).filter(
      (doc) => doc.slug[0] === 'api' && doc.slug.length > 1,
    )
    const availableMdx = await Promise.all(mdxCandidates.map(async (doc) =>
      (await getIndexableDocTranslation(doc.slug, resolved.locale)) ? doc : null,
    ))
    const firstMdx = availableMdx.find((doc) => doc !== null)
    if (firstMdx) redirect(`/${resolved.locale}${firstMdx.href}`)
    const defaultNodes = canReaderSeeUnmarkedContent(reader) ? await getApiOperationNodes(apiReferenceConfig.defaultSpecId) : []
    if (defaultNodes.length > 0) {
      redirect(`/${resolved.locale}${defaultNodes[0].href}`)
    }
    denyDocumentAccess(reader, `/${resolved.locale}/api`)
  }

  const node = await getApiOperationBySlug(resolved.slug)
  const specUrl = node ? getOpenApiSpecUrl(siteUrl, node.operation.specId) : null
  if (!node) {
    // /{locale}/api/* also belongs to authored MDX; the OpenAPI operation
    // surface only owns slugs present in the spec.
    return DocsPage({ params: Promise.resolve({ slug: documentSlug(resolved) }) })
  }

  if (!canReaderSeeUnmarkedContent(reader)) denyDocumentAccess(reader, `/${resolved.locale}/api/${resolved.slug.join('/')}`)
  const pageUrl = `${siteUrl}${node.href}`
  const jsonLd = buildApiOperationJsonLd({
    siteUrl,
    siteName: effectiveSite.name,
    pageUrl,
    title: node.operation.title,
    description: node.operation.description ?? `${node.operation.method} ${node.operation.path}`,
    specUrl: specUrl ?? undefined,
    method: node.operation.method,
    path: node.operation.path,
    locale: i18n.defaultLocale,
    breadcrumb: getBreadcrumbs(node.href),
  })

  return (
    <div lang={i18n.defaultLocale} dir={localeDirection(i18n.defaultLocale)}>
      <ApiLayout>
        {specUrl && getApiSpecLinkVisible() ? (
          <p className="text-sm text-foreground/60">
            OpenAPI specification:{' '}
            <a href={specUrl} className="underline decoration-border underline-offset-2 hover:text-foreground">
              {specUrl}
            </a>
          </p>
        ) : null}
        <JsonLdScript data={jsonLd} />
        <OperationPanel operation={node.operation} showTitle playground={resolvePlaygroundDisplay(undefined, getApiPlaygroundDisplay())} />
      </ApiLayout>
    </div>
  )
}
