/**
 * The single catch-all for default and locale-prefixed documentation pages.
 * A unified route keeps the client and server App Router trees identical while
 * still resolving secondary locales from the first URL segment.
 */

import type { Metadata } from 'next'
import { notFound, redirect } from 'next/navigation'
import { ApiLayout } from '@/components/api/api-layout'
import { ManualApiEndpoint } from '@/components/api/manual-api-endpoint'
import { OperationPanel } from '@/components/api/operation-panel'
import { resolvePlaygroundDisplay } from '@/lib/openapi/playground-display'
import { DocHeader } from '@/components/docs/doc-header'
import { DocPagination } from '@/components/docs/doc-pagination'
import { DocLayout } from '@/components/docs/doc-layout'
import { LocaleFallbackBanner } from '@/components/docs/locale-fallback-banner'
import { LocaleStaleBanner } from '@/components/docs/locale-stale-banner'
import { LocalizedSidebarHydrator } from '@/components/layout/localized-sidebar-hydrator'
import { LocaleAvailabilityHydrator } from '@/components/layout/locale-availability'
import { JsonLdScript } from '@/components/seo/json-ld-script'
import { lookupApiOperationForFrontmatter } from '@/data/api-reference'
import { ensureDocPublication, getApiPlaygroundDisplay, getDocEntries, getEyebrowMode, getSeoConfig, isDocPublished, loadNavContext } from '@/data/docs'
import { getDocFromParams } from '@/data/get-doc'
import { loadRootDocumentRedirect } from '@/lib/document-root-redirect'
import { hasDocTranslation } from '@/lib/i18n/translation-source'
import { buildAgentAlternateLinks } from '@/lib/agent-discovery'
import { isRemoteContentSource } from '@/lib/content-source'
import { docPathFromSlug, resolveDocRoute } from '@/lib/i18n/doc-route'
import { getContentI18nConfig } from '@/lib/i18n/content'
import { localizeDocNavigation } from '@/lib/i18n/navigation'
import { localizedPath } from '@/lib/i18n/config'
import { buildLocaleAlternates } from '@/lib/i18n/metadata'
import {
  getEffectiveI18nConfig,
  getRepositoryI18nConfig,
} from '@/lib/i18n/request'
import { plainInlineText } from '@/lib/inline-code'
import { markdownToPlainText } from '@thallylabs/core/content'
import { buildDocPageJsonLd } from '@/lib/json-ld'
import { pageFullTitle } from '@/lib/page-meta'
import { buildOgImageUrl, formatOgBreadcrumb, formatOgDisplayUrl } from '@/lib/og'
import { resolveBuildSiteConfig } from '@/lib/site-config'
import { getSiteUrl } from '@/lib/site-url'
import { isReaderAuthActive } from '@/lib/reader-auth/config'
import { getReaderContext } from '@/lib/reader-auth/context'
import { canReaderViewResolvedDoc, denyDocumentAccess } from '@/lib/reader-auth/page-gate'

interface PageProps {
  params: Promise<{ slug?: Array<string> }>
}

export async function generateStaticParams() {
  // Render the optional catch-all root once during the build so the shell
  // can establish its request boundary. An empty params array would select
  // on-demand SSG and reject live policy headers at runtime. The dynamic
  // bailout prevents repository content from being baked into managed pages.
  // Reader auth uses the same boundary: every page then varies by reader
  // (content and sidebar), so none may be prerendered into shared HTML. The
  // root render reads the reader cookie, which marks the route dynamic.
  if (isRemoteContentSource() || isReaderAuthActive()) return [{ slug: [] }]

  // Anonymous view only: restricted pages are never prerendered.
  const docs = getDocEntries()
  const i18n = getRepositoryI18nConfig()
  const defaultLocaleParams = docs.map((doc) => ({ slug: doc.slug }))
  const secondaryLocales = i18n.locales.filter(
    (locale) => locale.code !== i18n.defaultLocale,
  )
  const localizedParams = await Promise.all(
    secondaryLocales.flatMap(({ code }) =>
      docs.map(async (doc) =>
        (await hasDocTranslation(doc.slug, code))
          ? { slug: [code, ...doc.slug] }
          : null,
      ),
    ),
  )

  return [
    ...defaultLocaleParams,
    ...localizedParams.filter(
      (entry): entry is { slug: Array<string> } => entry !== null,
    ),
  ]
}

/**
 * The description a page's tags and structured data carry, as plain text. The
 * header renders a code span in the page's own description as code; tags read
 * its text. A page bound to an OpenAPI operation with no description of its own
 * shows the operation's description on the page, so its tags carry that, as one
 * plain line (the description is Markdown).
 */
async function tagDescription(doc: { description: string; openapi?: Parameters<typeof lookupApiOperationForFrontmatter>[0] }): Promise<string> {
  if (doc.description) return plainInlineText(doc.description)
  if (!doc.openapi) return ''
  const { node } = await lookupApiOperationForFrontmatter(doc.openapi)
  return markdownToPlainText(node?.operation.description ?? '')
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const routeParams = await params
  const buildI18n = await getEffectiveI18nConfig()
  const route = resolveDocRoute(routeParams.slug, buildI18n)
  const doc = await getDocFromParams(
    route.docSlug,
    route.isLocaleRoute ? route.locale : undefined,
  )
  if (!doc) return {}
  // The page 404s when its documented operation is hidden or excluded; give it no title, canonical or social preview.
  await ensureDocPublication()
  if (!isDocPublished(doc.id, route.isLocaleRoute ? route.locale : undefined)) return {}
  // A page this reader may not see gets no title, description or preview image.
  const reader = await getReaderContext()
  if (!(await canReaderViewResolvedDoc(doc, reader, route.isLocaleRoute ? route.locale : undefined))) return {}

  const siteUrl = getSiteUrl()
  const primaryHref = docPathFromSlug(doc.slug)
  const requestedHref = route.isLocaleRoute
    ? localizedPath(primaryHref, route.locale, buildI18n.defaultLocale)
    : primaryHref
  const hasTranslation = !route.isLocaleRoute || !doc.isFallback
  const canonicalHref = hasTranslation ? requestedHref : primaryHref
  const availableI18n = await getContentI18nConfig(route.docSlug, buildI18n)
  const nav = await loadNavContext(doc.id, route.isLocaleRoute ? route.locale : undefined, reader)
  const description = await tagDescription(doc)
  const ogImageUrl = buildOgImageUrl({
    title: doc.title,
    description,
    crumb: formatOgBreadcrumb(nav.breadcrumb, doc.title, doc.group),
    url: formatOgDisplayUrl(canonicalHref, siteUrl),
  })
  const isNoindex = doc.noindex || doc.hidden || !hasTranslation
  const siteName = resolveBuildSiteConfig().name
  const fullTitle = pageFullTitle({
    title: doc.title,
    ogTitle: doc.ogTitle,
    siteName,
    separator: getSeoConfig().titleSeparator,
  })
  const socialTitle = fullTitle ?? doc.title
  const socialDescription = doc.ogDescription ?? description

  return {
    title: fullTitle ? { absolute: fullTitle } : doc.title,
    description,
    ...(isNoindex
      ? { robots: { index: false, follow: !doc.noindex && !doc.hidden } }
      : {}),
    alternates: {
      canonical: `${siteUrl}${canonicalHref}`,
      // A fallback or noindex page cannot participate in an indexable
      // hreflang cluster, even when other translations of the slug exist.
      ...(!isNoindex ? { languages: buildLocaleAlternates(siteUrl, primaryHref, availableI18n) } : {}),
      types: buildAgentAlternateLinks(canonicalHref, siteUrl),
    },
    openGraph: {
      title: socialTitle,
      description: socialDescription,
      url: `${siteUrl}${canonicalHref}`,
      siteName,
      type: 'website',
      images: [doc.ogImage ? { url: doc.ogImage } : { url: ogImageUrl, width: 1200, height: 630 }],
    },
    twitter: {
      card: 'summary_large_image',
      title: doc.twitterTitle ?? socialTitle,
      description: doc.twitterDescription ?? socialDescription,
      images: [doc.twitterImage ?? doc.ogImage ?? ogImageUrl],
    },
  }
}

export default async function DocsPage({ params }: PageProps) {
  const routeParams = await params
  const i18n = await getEffectiveI18nConfig()
  const route = resolveDocRoute(routeParams.slug, i18n)
  // Read before resolving the page so a missing and a restricted page take
  // the same path (and so reader-auth sites always render per request).
  const reader = await getReaderContext()
  const requestedPath = `/${(routeParams.slug ?? []).join('/')}`
  const doc = await getDocFromParams(
    route.docSlug,
    route.isLocaleRoute ? route.locale : undefined,
  )
  if (!doc) {
    // Imported sites may intentionally have no introduction.mdx. Only the
    // missing root gets a navigation fallback; private introductions and all
    // ordinary missing paths retain their existing access/404 behavior.
    if (!route.docSlug?.length) {
      const target = await loadRootDocumentRedirect({ i18n, reader, locale: route.isLocaleRoute ? route.locale : undefined })
      if (target) redirect(target)
    }
    denyDocumentAccess(reader, requestedPath)
  }
  if (!(await canReaderViewResolvedDoc(doc, reader, route.isLocaleRoute ? route.locale : undefined))) {
    denyDocumentAccess(reader, requestedPath)
  }

  const siteUrl = getSiteUrl()
  const effectiveSite = resolveBuildSiteConfig()
  const primaryHref = docPathFromSlug(doc.slug)
  const availableI18n = await getContentI18nConfig(route.docSlug, i18n)
  const localeAvailability = (
    <LocaleAvailabilityHydrator
      path={primaryHref}
      locales={availableI18n.locales.map((locale) => locale.code)}
    />
  )
  const contentLocale =
    route.isLocaleRoute && !doc.isFallback
      ? route.locale
      : i18n.defaultLocale
  const canonicalHref =
    route.isLocaleRoute && !doc.isFallback
      ? localizedPath(primaryHref, route.locale, i18n.defaultLocale)
      : primaryHref
  const nav = await localizeDocNavigation(
    await loadNavContext(doc.id, route.isLocaleRoute ? route.locale : undefined, reader),
    route.isLocaleRoute ? route.locale : i18n.defaultLocale,
    i18n.defaultLocale,
  )
  const jsonLd = buildDocPageJsonLd({
    siteUrl,
    siteName: effectiveSite.name,
    pageUrl: `${siteUrl}${canonicalHref}`,
    id: doc.id,
    title: doc.title,
    description: await tagDescription(doc),
    keywords: doc.keywords,
    lastUpdated: doc.lastUpdated,
    locale: contentLocale,
    breadcrumb: nav.breadcrumb,
  })
  const localeNotice =
    route.isLocaleRoute && doc.isFallback ? (
      <LocaleFallbackBanner
        locale={route.locale}
        defaultLocale={i18n.defaultLocale}
      />
    ) : route.isLocaleRoute && doc.isStale ? (
      <LocaleStaleBanner primaryHref={primaryHref} />
    ) : null
  const localizedNavigation = route.isLocaleRoute ? (
    <LocalizedSidebarHydrator locale={route.locale} />
  ) : null

  const playground = resolvePlaygroundDisplay(doc.playground, getApiPlaygroundDisplay())
  if (doc.openapi) {
    const lookup = await lookupApiOperationForFrontmatter(doc.openapi)
    // A hidden or excluded operation is withheld on purpose: 404 on every site.
    // Only a reference that cannot be resolved at all keeps the authored page, with a notice.
    if (lookup.node === null && lookup.reason === 'withheld') notFound()
    const operationNode = lookup.node

    if (!operationNode) {
      const Body = doc.component
      return (
        <>
          {localeAvailability}
          {localizedNavigation}
          <JsonLdScript data={jsonLd} />
          <DocLayout doc={doc} locale={contentLocale} navigation={nav}>
            {localeNotice}
            <p role="note" className="not-prose rounded-md border border-border bg-muted px-4 py-3 text-sm text-muted-foreground">
              The API endpoint for this page could not be loaded, so only the page text is shown.
            </p>
            <Body />
          </DocLayout>
        </>
      )
    }

    const Body = doc.component
    return (
      <>
        {localeAvailability}
        {localizedNavigation}
        <div className="space-y-10" lang={contentLocale}>
          <JsonLdScript data={jsonLd} />
          {localeNotice}
          <div className="not-prose">
            <DocHeader doc={doc} eyebrow={getEyebrowMode() === 'path' ? nav.groupPath : nav.group} showDescription={doc.descriptionPlacement !== 'operation'} />
          </div>
          <ApiLayout>
            <OperationPanel operation={operationNode.operation} showDescription={!doc.description || doc.descriptionPlacement === 'operation'} playground={playground} locale={contentLocale}>
              <Body />
            </OperationPanel>
          </ApiLayout>
          <div className="not-prose">
            <DocPagination prev={nav.prev} next={nav.next} />
          </div>
        </div>
      </>
    )
  }

  const Content = doc.component

  return (
    <>
      {localeAvailability}
      {localizedNavigation}
      <JsonLdScript data={jsonLd} />
      <DocLayout doc={doc} locale={contentLocale} navigation={nav} endpoint={doc.manualApi ? <ManualApiEndpoint operation={doc.manualApi} playground={playground} locale={contentLocale} /> : undefined}>
        {localeNotice}
        <Content />
      </DocLayout>
    </>
  )
}
