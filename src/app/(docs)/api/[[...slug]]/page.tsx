/** Authored API documents share the docs renderer; generated operations use the API shell. */

import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { ApiLayout } from '@/components/api/api-layout'
import { OperationPanel } from '@/components/api/operation-panel'
import { resolvePlaygroundDisplay } from '@/lib/openapi/playground-display'
import { getSiteUrl } from '@/lib/site-url'
import { pageFullTitle } from '@/lib/page-meta'
import { JsonLdScript } from '@/components/seo/json-ld-script'
import { apiReferenceConfig, getOpenApiSpecUrl } from '@/config/api-reference'
import { getAllApiOperationNodes, getApiOperationBySlug, getApiOperationNodes } from '@/data/api-reference'
import { getApiPlaygroundDisplay, getApiSpecLinkVisible, getBreadcrumbs, getSeoConfig, getDocEntries, loadDocEntries } from '@/data/docs'
import { getContentSource, isRemoteContentSource } from '@/lib/content-source'
import { findDocSource } from '@/lib/i18n/translation-source'
import { buildAgentAlternateLinks } from '@/lib/agent-discovery'
import { buildApiOperationJsonLd } from '@/lib/json-ld'
import { buildOgImageUrl, formatOgBreadcrumb, formatOgDisplayUrl } from '@/lib/og'
import { resolveBuildSiteConfig } from '@/lib/site-config'
import DocsPage, { generateMetadata as generateDocsMetadata } from '@/app/(docs)/[[...slug]]/page'
import { isReaderAuthActive } from '@/lib/reader-auth/config'
import { getReaderContext } from '@/lib/reader-auth/context'
import { canReaderSeeUnmarkedContent, denyDocumentAccess } from '@/lib/reader-auth/page-gate'
import { loadNavigationSnapshot } from '@/lib/navigation-snapshot-server'
import { SidebarCollectionsHydrator } from '@/components/layout/sidebar-hydrator'

interface PageProps {
  params: Promise<{ slug?: Array<string> }>
}

export async function generateStaticParams() {
  // Visit the optional catch-all root so the shell can mark assets builds
  // dynamic; returning no params incorrectly selects on-demand SSG.
  // Reader-auth sites render per request (see the document route).
  if (isRemoteContentSource() || isReaderAuthActive()) return [{ slug: [] }]
  const apiNodes = await getAllApiOperationNodes()
  const apiParams = apiNodes.map((node) => ({ slug: node.slug }))

  // The dedicated API route also owns api.mdx and api/index.mdx at its root.
  // Enumerate that empty slug as well as nested authored pages.
  const mdxParams = getDocEntries()
    .filter((doc) => doc.slug[0] === 'api')
    .map((doc) => ({ slug: doc.slug.slice(1) }))

  return [...mdxParams, ...apiParams]
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const resolved = await params
  const siteUrl = getSiteUrl()

  const node = await getApiOperationBySlug(resolved.slug)
  const specUrl = node ? getOpenApiSpecUrl(siteUrl, node.operation.specId) : null
  if (node) {
    // Generated operations carry no frontmatter: they follow the site default.
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
      alternates: {
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

  return generateDocsMetadata({ params: Promise.resolve({ slug: ['api', ...(resolved.slug ?? [])] }) })
}

export default async function ApiReferencePage({ params }: PageProps) {
  const resolved = await params
  const content = await renderApiReferencePage({ params: Promise.resolve(resolved) })
  const snapshot = await loadNavigationSnapshot(`api:${resolved.slug?.[0] ?? 'default'}`)
  return <><SidebarCollectionsHydrator collections={snapshot.collections} scope={snapshot.scope} snapshot={snapshot} />{content}</>
}

async function renderApiReferencePage({ params }: PageProps) {
  const resolved = await params
  const siteUrl = getSiteUrl()
  const effectiveSite = resolveBuildSiteConfig()
  const reader = await getReaderContext()

  // An authored root owns /api even when it is restricted or unpublished.
  // Resolve its source independently of visible navigation, then delegate all
  // publication/access decisions to the same renderer used by other docs.
  if (!resolved.slug?.length) {
    if (await findDocSource(getContentSource(), 'api')) {
      return DocsPage({ params: Promise.resolve({ slug: ['api'] }) })
    }
    // Without a root document, retain the API landing-page redirects.
    const firstMdx = (await loadDocEntries(reader)).find(
      (doc) => doc.slug[0] === 'api' && doc.slug.length > 1,
    )
    if (firstMdx) {
      redirect(firstMdx.href)
    }
    const defaultNodes = canReaderSeeUnmarkedContent(reader) ? await getApiOperationNodes(apiReferenceConfig.defaultSpecId) : []
    if (defaultNodes.length > 0) {
      redirect(defaultNodes[0].href)
    }
    denyDocumentAccess(reader, '/api')
  }

  // OpenAPI operation match
  const node = await getApiOperationBySlug(resolved.slug)
  const specUrl = node ? getOpenApiSpecUrl(siteUrl, node.operation.specId) : null
  if (node) {
    if (!canReaderSeeUnmarkedContent(reader)) denyDocumentAccess(reader, `/api/${resolved.slug.join('/')}`)
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
      breadcrumb: getBreadcrumbs(node.href),
    })

    return (
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
    )
  }

  // MDX under /api is still an authored document, so share its locale,
  // robots, and hreflang behavior with the primary document route.
  return DocsPage({ params: Promise.resolve({ slug: ['api', ...resolved.slug] }) })
}
