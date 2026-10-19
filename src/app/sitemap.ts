import type { MetadataRoute } from 'next'
import { canReaderViewPage, getSeoConfig, getVisiblePageIds, loadDocEntries } from '@/data/docs'
import { getAllApiOperationNodes } from '@/data/api-reference'

import { getRequestOrigin } from '@/lib/cloud-link/request'
import { localizedPath } from '@/lib/i18n/config'
import { getContentI18nConfig } from '@/lib/i18n/content'
import { buildLocaleAlternates } from '@/lib/i18n/metadata'
import { getEffectiveI18nConfig } from '@/lib/i18n/request'
import { getIndexableDocTranslation } from '@/lib/i18n/translation-source'
import { getReaderAuthConfig } from '@/lib/reader-auth/config'
import { canReaderAccessUnmarkedContent, ANONYMOUS_READER } from '@/lib/reader-auth/access'

/**
 * Crawlers are anonymous: the sitemap is always the anonymous reader's view,
 * whoever requests it, so a restricted page is never announced.
 */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const baseUrl = await getRequestOrigin()
  const allEntries = await loadDocEntries(ANONYMOUS_READER)
  const visibleIds = getSeoConfig().sitemap === 'navigable' ? getVisiblePageIds() : null
  const docEntries = allEntries.filter((doc) => !doc.hidden && !doc.noindex && (!visibleIds || visibleIds.has(doc.id)))
  const apiNodes = canReaderAccessUnmarkedContent(ANONYMOUS_READER, getReaderAuthConfig()) ? await getAllApiOperationNodes() : []
  const i18n = await getEffectiveI18nConfig()

  const docPages: MetadataRoute.Sitemap = (
    await Promise.all(
      docEntries.map(async (doc) => {
        // `doc.href` is the URL the page is served at: `/introduction` when the
        // site redirects `/` there, else `/`.
        const href = doc.href
        const contentI18n = await getContentI18nConfig(doc.slug, i18n)
        // A translation may restrict a page further than its primary file.
        const openLocales = await Promise.all(contentI18n.locales.map(async (locale) =>
          locale.code === i18n.defaultLocale || await canReaderViewPage(doc.id, ANONYMOUS_READER, locale.code)))
        const availableI18n = { ...contentI18n, locales: contentI18n.locales.filter((_, index) => openLocales[index]) }
        const languages = buildLocaleAlternates(baseUrl, href, availableI18n)
        return Promise.all(availableI18n.locales.map(async (locale) => {
          const translation = locale.code === i18n.defaultLocale
            ? null
            : await getIndexableDocTranslation(doc.slug, locale.code)
          // Build/check-out mtimes do not prove when prose changed. Only an
          // authored date can safely become a crawler-visible lastmod value.
          const updated = locale.code === i18n.defaultLocale
            ? doc.lastUpdated
            : translation?.lastUpdated
          return {
            url: `${baseUrl}${localizedPath(href, locale.code, i18n.defaultLocale)}`,
            changeFrequency: 'weekly' as const,
            priority: doc.href === '/' ? 1.0 : 0.7,
            alternates: { languages },
            ...(updated && !Number.isNaN(new Date(updated).valueOf())
              ? { lastModified: new Date(updated) }
              : {}),
          }
        }))
      }),
    )
  ).flat()

  const apiPages: MetadataRoute.Sitemap = apiNodes.map((node) => ({
    url: `${baseUrl}${node.href}`,
    changeFrequency: 'weekly',
    priority: 0.6,
  }))

  const staticPages: MetadataRoute.Sitemap = visibleIds ? [] : [
    // /changelog is only served when the site has a changelog page.
    ...(allEntries.some((doc) => doc.id === 'changelog')
      ? [{ url: `${baseUrl}/changelog`, changeFrequency: 'weekly' as const, priority: 0.5 }]
      : []),
    {
      url: `${baseUrl}/llms.txt`,
      changeFrequency: 'weekly',
      priority: 0.4,
    },
    {
      url: `${baseUrl}/ai.txt`,
      changeFrequency: 'monthly',
      priority: 0.3,
    },
  ]

  return [...docPages, ...apiPages, ...staticPages]
}
