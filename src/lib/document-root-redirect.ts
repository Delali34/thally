/**
 * Missing-home fallback for authored/imported documentation. Navigation order
 * chooses candidates; the ordinary document resolver and exact reader gate
 * decide whether a candidate really exists and can be served to this reader.
 */
import 'server-only'
import { getPathMatch } from 'next/dist/shared/lib/router/utils/path-match'
import { getRedirectsConfig, isDocPublished, loadSidebarCollections } from '@/data/docs'
import type { NavigationNode } from '@/data/docs'
import { lookupApiOperationForFrontmatter } from '@/data/api-reference'
import { getDocFromParams } from '@/data/get-doc'
import type { I18nConfig } from '@/lib/i18n/config'
import { docPathFromSlug, resolveDocRoute } from '@/lib/i18n/doc-route'
import { canReaderViewResolvedDoc } from '@/lib/reader-auth/page-gate'
import type { ReaderContext } from '@/lib/reader-auth/access'

interface RootDocumentOptions {
  i18n: I18nConfig
  locale?: string
  reader: ReaderContext
}

function* pageHrefs(nodes: Array<NavigationNode>): Generator<string> {
  for (const node of nodes) {
    if (node.type === 'page') yield node.item.href
    else yield* pageHrefs(node.group.nodes)
  }
}

/**
 * Find the first directly served, reader-visible internal document. Redirect
 * sources are omitted rather than following aliases into root/cyclic/external
 * chains. Next's own matcher keeps parameterized redirect semantics aligned.
 * Call only after the requested root introduction has failed to resolve.
 */
export async function loadRootDocumentRedirect({ i18n, locale, reader }: RootDocumentOptions): Promise<string | null> {
  const collections = await loadSidebarCollections(locale, reader)
  const redirects = getRedirectsConfig().map(rule => getPathMatch(rule.source))
  const seen = new Set<string>()
  const expectedLocale = locale ?? i18n.defaultLocale
  for (const collection of collections) for (const section of collection.sections) {
    const hrefs = section.nodes ? pageHrefs(section.nodes) : section.items.map(item => item.href)
    for (const href of hrefs) {
      // A configured navigation href is not authority to redirect off-origin.
      if (!href.startsWith('/') || href.startsWith('//') || href.includes('\\')) continue
      let segments: Array<string>
      let path: string
      try {
        const url = new URL(href, 'https://documentation.invalid')
        if (url.origin !== 'https://documentation.invalid' || url.search || url.hash) continue
        segments = url.pathname.split('/').filter(Boolean).map(decodeURIComponent)
        if (segments.some(segment => segment === '.' || segment === '..' || /[/\\\0]/.test(segment))) continue
        path = docPathFromSlug(segments)
      } catch { continue }
      if (seen.has(path)) continue
      seen.add(path)
      const route = resolveDocRoute(segments, i18n)
      if (route.locale !== expectedLocale || !route.docSlug?.length || (route.docSlug.length === 1 && route.docSlug[0] === 'introduction')) continue
      if (redirects.some(match => match(path) !== false)) continue
      const document = await getDocFromParams(route.docSlug, route.isLocaleRoute ? route.locale : undefined)
      if (!document || !isDocPublished(document.id, locale)) continue
      if (!(await canReaderViewResolvedDoc(document, reader, locale))) continue
      if (document.openapi) {
        const operation = await lookupApiOperationForFrontmatter(document.openapi)
        if (operation.node === null && operation.reason === 'withheld') continue
      }
      return path
    }
  }
  return null
}
