/** Evidence-based URL import scope. Remote hints are data and never grant origin authority. */
import { load } from 'cheerio'
import type { MigrationCapture } from './url-run-types.js'

export interface UrlMigrationScope {
  scopePath: string
  evidence: 'discovery-index' | 'navigation' | 'source-parent'
}

/** Choose a bounded documentation ancestor from explicit indexes, then sidebar links. */
export function inferUrlMigrationScope(capture: Pick<MigrationCapture, 'body' | 'contentType' | 'finalUrl'>): UrlMigrationScope {
  const source = capture.finalUrl
  const parent = source.pathname.endsWith('/') ? source.pathname.replace(/\/+$/, '') || '/' : source.pathname.slice(0, source.pathname.lastIndexOf('/')) || '/'
  if (!/html/i.test(capture.contentType) || Buffer.byteLength(capture.body) > 8_000_000) return { scopePath: parent, evidence: 'source-parent' }
  const $ = load(capture.body)
  const ancestor = (path: string): boolean => path === '/' || source.pathname === path || source.pathname.startsWith(`${path}/`)
  const observed = (reference: string | undefined): URL | undefined => {
    if (!reference || reference.length > 8192) return undefined
    try {
      const url = new URL(reference, source)
      if (url.origin !== source.origin || url.username || url.password || url.search || url.hash || /%2f|%5c/i.test(url.pathname)) return undefined
      return url
    } catch { return undefined }
  }
  const indexes: string[] = []
  $('link[href],a[href]').slice(0, 10000).each((_, node) => {
    const url = observed($(node).attr('href'))
    if (!url || !/\/(?:llms(?:-full)?\.txt|sitemap(?:[-_][^/]*)?\.xml)$/i.test(url.pathname)) return
    const path = url.pathname.slice(0, url.pathname.lastIndexOf('/')) || '/'
    if (ancestor(path)) indexes.push(path)
  })
  if (indexes.length) return { scopePath: indexes.sort((a, b) => b.length - a.length)[0], evidence: 'discovery-index' }
  const paths: string[] = []
  $('nav a[href],aside a[href],[role="navigation"] a[href]').slice(0, 10000).each((_, node) => {
    if ($(node).closest('header,footer').length) return
    const url = observed($(node).attr('href'))
    if (url && !/\.[a-z0-9]+$/i.test(url.pathname)) paths.push(url.pathname)
  })
  if (new Set(paths).size >= 2 && paths.some((path) => path === source.pathname)) {
    const segments = paths.map((path) => path.split('/').filter(Boolean))
    let count = 0
    while (segments.every((parts) => parts[count] !== undefined && parts[count] === segments[0][count])) count++
    const common = '/' + segments[0].slice(0, count).join('/')
    if (ancestor(common)) return { scopePath: common, evidence: 'navigation' }
  }
  return { scopePath: parent, evidence: 'source-parent' }
}
