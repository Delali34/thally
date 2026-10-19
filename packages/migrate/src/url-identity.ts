/**
 * Article aliases require a same-route canonical or observed section candidate
 * and exact captured article equality. Query names alone never establish identity.
 */
import { createHash } from 'node:crypto'
import { load } from 'cheerio'
import { migrationHtmlArticle } from './url.js'
import type { MigrationCapture } from './url-run-types.js'

export interface MigrationArticleIdentity {
  canonicalUrl: string
  articleSha256: string
  sectionAnchor?: string
}

const directory = (path: string): string => path.replace(/\/index\/?$/i, '').replace(/\/$/, '') || '/'

/** Propose one query section only when its exact value names an observed source anchor. */
export function migrationSectionQueryCandidate(source: URL, anchors: Array<string | undefined>): { canonicalUrl: string; sectionAnchor?: string } {
  const target = new URL(source)
  const sections = [...source.searchParams].filter(([, value]) => anchors.includes(value))
  const section = sections.length === 1 && source.searchParams.getAll(sections[0][0]).length === 1 ? sections[0] : undefined
  if (section) target.searchParams.delete(section[0])
  target.hash = ''
  target.pathname = target.pathname.replace(/\/+$/, '') || '/'
  return { canonicalUrl: target.href, ...(section ? { sectionAnchor: section[1] } : {}) }
}

/** Recognize exact provider utility routes; similarly named authored pages remain inventory. */
export function isMigrationUtilityUrl(url: URL): boolean {
  return /^\/cdn-cgi\/l\/email-protection\/?$/i.test(url.pathname)
}

/** Preserve the established same-query directory-index identity rule. */
export function declaredMigrationArticleUrl(document: MigrationCapture): URL {
  const target = declaredCanonical(document)
  return target && target.search === document.finalUrl.search ? target : document.finalUrl
}

function declaredCanonical(document: MigrationCapture): URL | undefined {
  if (!/html/i.test(document.contentType)) return undefined
  const reference = load(document.body)('link[rel="canonical"][href]').first().attr('href')
  if (!reference) return undefined
  try {
    const target = new URL(reference, document.finalUrl)
    if (target.origin !== document.finalUrl.origin || target.username || target.password
      || directory(target.pathname) !== directory(document.finalUrl.pathname)) return undefined
    target.hash = ''
    target.pathname = target.pathname.replace(/\/+$/, '') || '/'
    return target
  } catch { return undefined }
}

/** Bind a canonical claim to exact inert article, metadata and alternative-state bytes. */
export function observedMigrationArticleIdentity(document: MigrationCapture): MigrationArticleIdentity | undefined {
  if (!/html/i.test(document.contentType)) return undefined
  const { $, root } = migrationHtmlArticle(document.body)
  // Do not fingerprint a whole-site fallback: identical empty shells are not
  // evidence of identical articles, and navigation state is not article copy.
  if (!root.length || !root.text().trim()) return undefined
  const anchors = root.find('[id]').toArray().map(node => $(node).attr('id'))
  root.find('nav,aside,footer,script,style').remove()
  const metadata = load(document.body)
  const payload = JSON.stringify([
    $.html(root), metadata('title').text(), metadata('meta[name="description"]').attr('content'),
    metadata('html').attr('lang'), document.locale, document.version,
    // Deferred content can exist only in inert hydration data. Never erase its
    // differences merely because two collapsed DOM panels appear identical.
    metadata('script').toArray().map(node => [metadata(node).attr('src'), metadata(node).text()]),
    (document.states ?? []).map(state => [state.id, state.label, state.response.body]),
  ])
  const source = document.finalUrl
  // Some publishers express section permalinks as queries without a canonical
  // declaration. Propose only one exact observed anchor-valued parameter; the
  // runner still requires a separately captured matching full article payload.
  const canonical = declaredCanonical(document) ?? new URL(source)
  if (canonical.href === source.href) {
    canonical.href = migrationSectionQueryCandidate(source, anchors).canonicalUrl
  }
  canonical.hash = ''
  canonical.pathname = canonical.pathname.replace(/\/+$/, '') || '/'
  const removed = [...source.searchParams].filter(([key, value]) => !canonical.searchParams.getAll(key).includes(value))
  const sectionAnchor = removed.length === 1 && anchors.includes(removed[0][1]) ? removed[0][1] : undefined
  return { canonicalUrl: canonical.href, articleSha256: createHash('sha256').update(payload).digest('hex'), ...(sectionAnchor ? { sectionAnchor } : {}) }
}
