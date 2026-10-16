/**
 * Resumable public URL migration. A bounded batch commits a JSON journal delta;
 * capture, deterministic conversion and validation share the existing adapter.
 * Checkpoints accelerate recovery but hashes and host reconciliation establish
 * which artifacts can be reused. No provider or publication authority lives here.
 */
import { createHash } from 'node:crypto'
import { load } from 'cheerio'
import remarkParse from 'remark-parse'
import { unified } from 'unified'
import { buildNavigationFromPages } from './navigation.js'
import { pageIdFromReference } from './path.js'
import { defaultMigrationFetcher, htmlPage, markdownPage, sanitizeRemoteMarkdown, validateMigrationUrl } from './url.js'
import type { MigrationBundle, MigrationFetchResponse, MigrationNavigationGroup, MigrationPage } from './types.js'
import type {
  MigrationCapture, MigrationCapturedAsset, MigrationEvidence, MigrationNavigationOccurrence,
  UrlMigrationCheckpoint, UrlMigrationIssue, UrlMigrationRecord, UrlMigrationRun,
  UrlMigrationRunOptions, UrlMigrationValidation,
} from './url-run-types.js'

const CONVERTER_VERSION = 'url-evidence-v1'
const parser = unified().use(remarkParse)
const ACCEPT = 'text/markdown,text/html,application/xhtml+xml;q=0.9'
const MAX_RESPONSE_BYTES = 8_000_000
const MAX_ASSET_BYTES = 10_000_000
const MAX_RECORDS = 100_000
const LOCALES = new Set(['ar', 'cs', 'da', 'de', 'el', 'en', 'es', 'fi', 'fr', 'he', 'hi', 'hu', 'id', 'it', 'ja', 'ko', 'ms', 'nl', 'no', 'pl', 'pt', 'pt-br', 'ro', 'ru', 'sk', 'sv', 'th', 'tr', 'uk', 'vi', 'zh', 'zh-cn', 'zh-hans', 'zh-hant'])

interface MarkdownNode {
  type: string
  url?: string
  value?: string
  children?: Array<MarkdownNode>
  position?: { start: { offset?: number }; end: { offset?: number } }
}

function hash(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

function pageHash(page: MigrationPage): string {
  return hash(JSON.stringify(page))
}

function inScope(url: URL, source: URL, scope: string): boolean {
  return url.origin === source.origin && !url.username && !url.password
    && (scope === '/' || url.pathname === scope || url.pathname.startsWith(`${scope}/`))
}

function isDiscoveryIndex(url: URL, source: URL): boolean {
  return url.origin === source.origin && /\/(?:llms(?:-full)?|robots)\.txt$|\/sitemap[^/]*\.xml$/i.test(url.pathname)
}

function canonical(value: string, base: string): string | null {
  try {
    const url = validateMigrationUrl(new URL(value, base).toString())
    // Query parameters can distinguish source versions/locales; never erase them.
    url.pathname = url.pathname.replace(/\/+$/, '') || '/'
    return url.toString()
  } catch { return null }
}

/** Classify using the final response; an index must never become article text. */
export function classifyMigrationResponse(document: MigrationFetchResponse): 'page' | 'index' | 'asset' | 'unsupported' {
  if (document.status && document.status >= 400) return 'unsupported'
  if (/\/(?:llms(?:-full)?|robots)\.txt$|\/sitemap[^/]*\.xml$|\/search(?:\.html)?$/i.test(document.finalUrl.pathname)
    || /(?:xml|json)/i.test(document.contentType)) return 'index'
  if (/^(?:image|audio|video)\//i.test(document.contentType)
    || /\.(?:pdf|zip|png|jpe?g|webp|gif|svg|ico|mp4|webm)$/i.test(document.finalUrl.pathname)) return 'asset'
  return /(?:html|markdown|text\/plain)/i.test(document.contentType)
    || /\.mdx?$/i.test(document.finalUrl.pathname) ? 'page' : 'unsupported'
}

function markdownNodes(body: string): Array<MarkdownNode> {
  const nodes: Array<MarkdownNode> = []
  const visit = (node: MarkdownNode): void => {
    nodes.push(node)
    for (const child of node.children ?? []) visit(child)
  }
  visit(parser.parse(body) as MarkdownNode)
  return nodes
}

function markdownCode(body: string): Array<string> {
  return markdownNodes(body).filter((node) => node.type === 'code').map((node) => node.value ?? '')
}

function alternativeBlocks(body: string, baseline: string): string {
  const blocks = (value: string): Array<string> => ((parser.parse(value) as MarkdownNode).children ?? [])
    .map((node) => value.slice(node.position!.start.offset!, node.position!.end.offset!))
  const originals = new Set(blocks(baseline))
  return blocks(body).filter((block) => !originals.has(block)).join('\n\n')
}

function linksOf(document: MigrationFetchResponse): Array<string> {
  if (/html/i.test(document.contentType)) {
    const $ = load(document.body)
    const root = $('main article,article,main,[role="main"]').first()
    root.find('nav,header,footer,aside').remove()
    return [...root.find('a[href]').toArray(), ...$('link[rel="sitemap"][href],link[rel="alternate"][href]').toArray()]
      .map((node) => $(node).attr('href')!).filter(Boolean)
  }
  if (/xml/i.test(document.contentType) || /<urlset|<sitemapindex/i.test(document.body)) {
    const $ = load(document.body, { xmlMode: true })
    return $('loc').toArray().map((node) => $(node).text().trim())
  }
  return [
    ...markdownNodes(document.body).flatMap((node) => node.url ? [node.url] : []),
    ...[...document.body.matchAll(/^Sitemap:\s*(\S+)/gmi)].map((match) => match[1]),
  ]
}

function htmlEvidence(document: MigrationFetchResponse): Pick<MigrationEvidence, 'anchors' | 'code'> {
  const $ = load(document.body)
  const root = $('main article,article,main,[role="main"]').first()
  const article = root.length ? root : $('body')
  article.find('nav,header,footer,aside,form,script,style').remove()
  return {
    anchors: article.find('[id]').toArray().map((node) => $(node).attr('id')!).filter(Boolean),
    code: article.find('pre').toArray().map((node) => {
      const lines = $(node).find('.token-line')
      return lines.length ? lines.toArray().map((line) => $(line).text()).join('\n') : $(node).text()
    }),
  }
}

function evidenceOf(capture: MigrationCapture): MigrationEvidence {
  const technical = /html/i.test(capture.contentType)
    ? htmlEvidence(capture)
    : { code: markdownCode(capture.body), anchors: markdownHeadingAnchors(capture.body) }
  return {
    sha256: hash(capture.body), byteLength: Buffer.byteLength(capture.body), finalUrl: capture.finalUrl.toString(), contentType: capture.contentType,
    ...(capture.artifactRef ? { artifactRef: capture.artifactRef } : {}),
    states: (capture.states ?? []).map((state) => ({ id: state.id, label: state.label, sha256: hash(state.response.body) })),
    ...technical, links: linksOf(capture),
  }
}

function markdownHeadingAnchors(body: string): Array<string> {
  const seen = new Map<string, number>()
  return markdownNodes(body).filter((node) => node.type === 'heading').map((node) => {
    const text = (value: MarkdownNode): string => value.value ?? (value.children ?? []).map(text).join('')
    const base = text(node).toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-')
    const occurrence = seen.get(base) ?? 0
    seen.set(base, occurrence + 1)
    return occurrence ? `${base}-${occurrence}` : base
  })
}

function sourceNavigation(capture: MigrationCapture): Array<MigrationNavigationOccurrence> {
  if (capture.navigation) {
    const resolve = (nodes: Array<MigrationNavigationOccurrence>, depth = 0): Array<MigrationNavigationOccurrence> => {
      if (depth > 32 || nodes.length > 10_000) throw new Error('Source navigation exceeds its depth or width safety bound.')
      return nodes.map((node) => ({ label: node.label, ...(node.url ? { url: new URL(node.url, capture.finalUrl).toString() } : {}), ...(node.children ? { children: resolve(node.children, depth + 1) } : {}) }))
    }
    return resolve(capture.navigation)
  }
  if (!/html/i.test(capture.contentType)) return []
  const $ = load(capture.body)
  const candidates = ['.theme-doc-sidebar-menu,[aria-label*="sidebar" i]', 'aside', '[role="navigation"],nav']
  const root = candidates.map((selector) => $(selector).filter((_index, node) => $(node).find('a[href]').length > 0 && $(node).closest('header').length === 0).first()).find((candidate) => candidate.length) ?? $('aside').first()
  if (!root.length) return []
  const walk = (element: Parameters<typeof $>[0]): Array<MigrationNavigationOccurrence> => {
    const result: Array<MigrationNavigationOccurrence> = []
    $(element).children().each((_index, node) => {
      const item = $(node)
      if (item.is('a[href]')) {
        result.push({ label: item.text().replace(/\s+/g, ' ').trim(), url: new URL(item.attr('href')!, capture.finalUrl).toString() })
      } else if (item.is('li,details') || item.attr('data-migration-group') !== undefined || item.children('h2,h3,h4,h5,h6').length > 0) {
        const direct = item.children('a[href]').first()
        const label = direct.text().trim() || item.children('summary,button,span,h2,h3,h4,h5,h6').first().text().trim()
        const children = walk(node).filter((entry) => !direct.length || entry.url !== new URL(direct.attr('href')!, capture.finalUrl).toString())
        if (label) result.push({ label, ...(direct.length ? { url: new URL(direct.attr('href')!, capture.finalUrl).toString() } : {}), ...(children.length ? { children } : {}) })
        else result.push(...children)
      } else result.push(...walk(node))
    })
    return result
  }
  try { return walk(root) } catch { return [] }
}

function idForUrl(url: URL, scope: string): string | null {
  const relative = scope === '/' ? url.pathname.slice(1) : url.pathname.slice(scope.length).replace(/^\//, '')
  const id = pageIdFromReference(relative || 'introduction', true)
  // Query-selected pages get a deterministic identity, never overwrite a variant.
  return id && `${id}${url.search ? `--${hash(url.search).slice(0, 12)}` : ''}`
}

function convert(document: MigrationFetchResponse, id: string): MigrationPage | null {
  if (/html/i.test(document.contentType)) {
    const technical = htmlEvidence(document)
    const page = htmlPage(document, id, { preserveAnchors: true }).page
    if (!page) return null
    // Restore exact payloads after the shared HTML converter. Replacements use
    // AST offsets, so code containing Markdown or JSX is never treated as prose.
    const nodes = markdownNodes(page.body).filter((node) => node.type === 'code')
    if (nodes.length === technical.code.length) {
      for (let index = nodes.length - 1; index >= 0; index--) {
        const node = nodes[index]
        const start = node.position?.start.offset
        const end = node.position?.end.offset
        if (start === undefined || end === undefined) continue
        const original = page.body.slice(start, end)
        const info = original.split('\n', 1)[0].replace(/^`+|^~+/, '')
        const code = technical.code[index]
        const fence = '`'.repeat(Math.max(3, ...[...code.matchAll(/`+/g)].map((match) => match[0].length + 1)))
        // The final newline belongs to the fence separator; an existing source
        // newline therefore needs a second newline before the closing fence.
        page.body = `${page.body.slice(0, start)}${fence}${info}\n${code}\n${fence}${page.body.slice(end)}`
      }
    }
    return page
  }
  const safe = sanitizeRemoteMarkdown(document.body)
  return safe === null ? null : markdownPage({ ...document, body: safe }, id, 'generic').page
}

function assetReferences(capture: MigrationCapture): Array<string> {
  if (!/html/i.test(capture.contentType)) {
    return markdownNodes(capture.body).filter((node) => node.type === 'image').flatMap((node) => node.url ? [node.url] : [])
  }
  const $ = load(capture.body)
  const root = $('main article,article,main,[role="main"]').first()
  return [
    ...root.find('img[src],video[poster],a[download][href]').toArray().map((node) => $(node).attr('src') ?? $(node).attr('poster') ?? $(node).attr('href')!),
    ...root.find('[srcset]').toArray().flatMap((node) => ($(node).attr('srcset') ?? '').split(',').map((part) => part.trim().split(/\s+/)[0])),
  ].filter(Boolean)
}

async function defaultAssetFetcher(url: URL, signal?: AbortSignal): Promise<MigrationCapturedAsset> {
  const response = await fetch(url, { signal: signal ?? AbortSignal.timeout(15_000) })
  if (!response.ok) throw new Error(`Asset returned ${response.status}.`)
  if (Number(response.headers.get('content-length')) > MAX_ASSET_BYTES) throw new Error('Asset exceeds size limit.')
  const reader = response.body?.getReader()
  const chunks: Array<Uint8Array> = []
  let size = 0
  if (reader) while (true) {
    const next = await reader.read()
    if (next.done) break
    size += next.value.length
    if (size > MAX_ASSET_BYTES) { await reader.cancel(); throw new Error('Asset exceeds size limit.') }
    chunks.push(next.value)
  }
  return { url: response.url || url.toString(), contentType: response.headers.get('content-type') ?? '', content: Buffer.concat(chunks) }
}

function acceptedAsset(asset: MigrationCapturedAsset): string | null {
  if (asset.content.byteLength > MAX_ASSET_BYTES) return null
  const mime = asset.contentType.split(';', 1)[0].toLowerCase().trim()
  const signature = Buffer.from(asset.content.slice(0, 16))
  const extensions: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'application/pdf': 'pdf', 'image/avif': 'avif' }
  const extension = extensions[mime]
  if (!extension) return null // SVG/HTML and executable downloads need a separate serving policy.
  const isSignatureValid = extension === 'png' ? signature.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    : extension === 'jpg' ? signature[0] === 255 && signature[1] === 216
      : extension === 'gif' ? /^GIF8[79]a/.test(signature.toString())
        : extension === 'webp' ? signature.toString('ascii', 0, 4) === 'RIFF' && signature.toString('ascii', 8, 12) === 'WEBP'
          : extension === 'pdf' ? signature.toString('ascii', 0, 5) === '%PDF-'
            : signature.toString('ascii', 4, 8) === 'ftyp' && /avif|avis/.test(signature.toString('ascii', 8))
  return isSignatureValid ? extension : null
}

function validRecord(record: UrlMigrationRecord): boolean {
  if (record.outcome !== 'imported') return true
  return Boolean(record.page && record.pageSha256 === pageHash(record.page) && record.evidence
    && pageIdFromReference(record.page.id, true) === record.page.id
    && pageIdFromReference(record.page.navigationId, true) === record.page.navigationId
    && sanitizeRemoteMarkdown(record.page.body.replace(/^<a id="[^"<]*" \/>$/gm, '')) !== null
    && /^[a-f0-9]{64}$/.test(record.evidence.sha256)
    && record.assets?.every((asset) => /^migration-assets\/[a-f0-9]{64}\.[a-z0-9]+$/.test(asset.path)
      && hash(Buffer.from(asset.base64, 'base64')) === asset.sha256))
}

function navigationConfig(navigation: Array<MigrationNavigationOccurrence>, records: Map<string, UrlMigrationRecord>): MigrationBundle['docsConfig'] | null {
  const project = (nodes: Array<MigrationNavigationOccurrence>): Array<string | MigrationNavigationGroup> => nodes.flatMap<string | MigrationNavigationGroup>((node) => {
    const record = node.url ? records.get(canonical(node.url, node.url) ?? '') : undefined
    const target = record?.outcome === 'alias' ? records.get(record.aliasOf ?? '') : record
    const page = target?.page
    const children = project(node.children ?? [])
    if (children.length) return [{ group: node.label || 'Documentation', pages: [...(page ? [page.navigationId] : []), ...children] }]
    return page ? [page.navigationId] : []
  })
  const pages = project(navigation)
  return pages.length ? { tabs: [{ tab: 'Documentation', pages }] } : null
}

/** Validate every selected outcome, source payload, internal destination and anchor. */
export function validateUrlMigration(checkpoint: UrlMigrationCheckpoint, cancelled = false): UrlMigrationValidation {
  const issues: Array<UrlMigrationIssue> = []
  const counts: UrlMigrationValidation['counts'] = { pending: 0, imported: 0, excluded: 0, failed: 0, alias: 0 }
  const records = new Map(checkpoint.records.map((record) => [record.url, record]))
  const source = new URL(checkpoint.sourceUrl)
  const resolve = (url: string): UrlMigrationRecord | undefined => {
    const record = records.get(canonical(url, checkpoint.sourceUrl) ?? '')
    return record?.outcome === 'alias' ? records.get(record.aliasOf ?? '') : record
  }
  for (const record of checkpoint.records) {
    counts[record.outcome]++
    issues.push(...record.issues ?? [])
    if (record.outcome === 'pending' || record.outcome === 'failed') issues.push({ code: 'missing-page', source: record.url, message: record.reason ?? `Inventory entry is ${record.outcome}.` })
    if (!record.page || !record.evidence) continue
    const actual = markdownCode(record.page.body)
    if (JSON.stringify(actual) !== JSON.stringify(record.evidence.code)) issues.push({ code: 'code-mismatch', source: record.url, message: 'Source code payloads differ from converted code payloads.' })
    for (const value of record.evidence.links) {
      let link: URL
      try { link = new URL(value, record.evidence.finalUrl) } catch { continue }
      if (!inScope(link, source, checkpoint.scopePath)) continue
      if (/\.(?:png|jpe?g|gif|svg|webp|avif|pdf|zip|mp4|webm|css|js|json|ya?ml)$/i.test(link.pathname)) continue
      const destination = resolve(link.toString())
      if (!destination || !['imported', 'excluded'].includes(destination.outcome)) {
        issues.push({ code: 'missing-page', source: record.url, message: `Unresolved internal destination: ${link}` })
      } else if (link.hash && destination.outcome === 'imported') {
        let anchor = link.hash.slice(1)
        try { anchor = decodeURIComponent(anchor) } catch { /* Invalid encoding remains a literal anchor. */ }
        if (!destination.evidence?.anchors.includes(anchor)) issues.push({ code: 'missing-anchor', source: record.url, message: `Missing source anchor: ${link}` })
      }
    }
  }
  const visit = (nodes: Array<MigrationNavigationOccurrence>): void => {
    for (const node of nodes) {
      if (node.url) {
        const url = new URL(node.url, source)
        if (inScope(url, source, checkpoint.scopePath) && !resolve(url.toString())?.page) issues.push({ code: 'navigation-missing', source: node.url, message: `Source navigation target ${node.label} was not imported.` })
      }
      visit(node.children ?? [])
    }
  }
  visit(checkpoint.navigation)
  if (!counts.imported) issues.push({ code: 'missing-page', source: checkpoint.sourceUrl, message: 'No readable article pages were imported.' })
  return { status: cancelled ? 'cancelled' : issues.length ? 'partial' : 'passed', issues, counts }
}

/** Run capture/conversion in bounded batches and resume only reconciled artifacts. */
export async function runUrlMigration(options: UrlMigrationRunOptions): Promise<UrlMigrationRun> {
  const source = validateMigrationUrl(options.sourceUrl)
  const sourceUrl = canonical(source.toString(), source.toString())!
  const scopePath = (options.scopePath ?? (source.pathname.endsWith('/') ? source.pathname : source.pathname.slice(0, source.pathname.lastIndexOf('/')) || '/')).replace(/\/+$/, '') || '/'
  if (!scopePath.startsWith('/') || scopePath.includes('?') || scopePath.includes('#') || !inScope(source, source, scopePath)) throw new Error('The selected documentation scope must contain the source URL.')
  const maxPages = options.maxPages ?? 1_000
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 10_000) throw new Error('maxPages must be between 1 and 10000.')
  const concurrency = Math.max(1, Math.min(32, Math.floor(options.concurrency ?? 5)))
  const batchSize = Math.max(1, Math.min(500, Math.floor(options.batchSize ?? 50)))
  if (!Number.isFinite(concurrency) || !Number.isFinite(batchSize)
    || (options.maxCaptures !== undefined && (!Number.isInteger(options.maxCaptures) || options.maxCaptures < 1))
    || (options.maxTotalBytes !== undefined && (!Number.isFinite(options.maxTotalBytes) || options.maxTotalBytes < 1))) throw new Error('Migration batch, concurrency and byte limits must be positive finite numbers.')
  const captureVersion = options.captureVersion ?? 'fetch-v1'
  const checkpoint: UrlMigrationCheckpoint = options.checkpoint
    ? JSON.parse(JSON.stringify(options.checkpoint)) as UrlMigrationCheckpoint
    : { schemaVersion: 1, converterVersion: CONVERTER_VERSION, sourceUrl, scopePath, captureVersion, records: [], navigation: [] }
  if (checkpoint.schemaVersion !== 1 || checkpoint.converterVersion !== CONVERTER_VERSION || checkpoint.sourceUrl !== sourceUrl || checkpoint.scopePath !== scopePath || checkpoint.captureVersion !== captureVersion) throw new Error('Checkpoint does not match this source, scope or capture/converter version.')
  if (checkpoint.records.length > MAX_RECORDS) throw new Error('Checkpoint inventory exceeds its bound.')
  const records = new Map<string, UrlMigrationRecord>()
  for (const record of checkpoint.records) {
    if (canonical(record.url, sourceUrl) !== record.url || (!inScope(new URL(record.url), source, scopePath) && !isDiscoveryIndex(new URL(record.url), source))) throw new Error('Checkpoint contains an unsafe inventory URL.')
    if (records.has(record.url)) throw new Error('Checkpoint contains a duplicate inventory URL.')
    if (!validRecord(record) || (record.outcome === 'failed' && options.retryFailed !== false)
      || (record.outcome !== 'pending' && options.reconcile && !await options.reconcile(record))) {
      record.outcome = 'pending'; delete record.page; delete record.pageSha256; delete record.evidence; delete record.assets
    }
    if (record.page && pageIdFromReference(record.page.id, true) !== record.page.id) throw new Error('Checkpoint contains an unsafe page path.')
    records.set(record.url, record)
  }
  const pending: Array<UrlMigrationRecord> = [...records.values()].filter((record) => record.outcome === 'pending')
  let changed: Array<UrlMigrationRecord> = []
  let navigationChanged = false
  const enqueue = (value: string, base: string, discoveredBy: string): void => {
    const url = canonical(value, base)
    if (!url || (!inScope(new URL(url), source, scopePath) && !isDiscoveryIndex(new URL(url), source))) return
    const existing = records.get(url)
    if (existing) {
      if (!existing.discoveredBy.includes(discoveredBy)) { existing.discoveredBy.push(discoveredBy); changed.push(existing) }
      return
    }
    if (records.size >= MAX_RECORDS) throw new Error('Discovered URL inventory exceeded the 100000 URL safety bound.')
    const record: UrlMigrationRecord = { url, discoveredBy: [discoveredBy], outcome: 'pending' }
    records.set(url, record); checkpoint.records.push(record); pending.push(record); changed.push(record)
  }
  enqueue(sourceUrl, sourceUrl, 'submitted')
  for (const path of ['llms.txt', 'sitemap.xml', 'robots.txt']) enqueue(`${scopePath === '/' ? '' : scopePath}/${path}`, sourceUrl, 'discovery-index')
  if (scopePath !== '/') for (const path of ['llms.txt', 'sitemap.xml', 'robots.txt']) enqueue(`/${path}`, sourceUrl, 'discovery-index')
  const fetcher = options.fetcher ?? defaultMigrationFetcher
  const capture = options.captureProvider?.capture.bind(options.captureProvider)
    ?? (async ({ url }: { url: URL }): Promise<MigrationCapture> => fetcher(url, { accept: ACCEPT }))
  const assetFetcher = options.assetFetcher ?? (!options.fetcher && !options.captureProvider ? defaultAssetFetcher : undefined)
  const usedIds = new Map([...records.values()].filter((record) => record.page).map((record) => [record.page!.id, record.url]))
  const finalUrls = new Map([...records.values()].filter((record) => record.evidence && record.page).map((record) => [canonical(record.evidence!.finalUrl, sourceUrl)!, record.url]))
  let imported = usedIds.size
  let totalBytes = checkpoint.records.reduce((sum, record) => sum + (record.evidence?.byteLength ?? 0) + (record.assets ?? []).reduce((bytes, asset) => bytes + Buffer.byteLength(asset.base64, 'base64'), 0), 0)
  let budgetExhausted = false
  let cursor = 0
  const flush = async (): Promise<void> => {
    const distinct = [...new Map(changed.map((record) => [record.url, record])).values()]
    if (options.onCheckpoint) for (let index = 0; index < distinct.length || (index === 0 && navigationChanged); index += batchSize) {
      await options.onCheckpoint({ schemaVersion: 1, converterVersion: CONVERTER_VERSION, scopePath, captureVersion, sourceUrl, records: distinct.slice(index, index + batchSize), ...(navigationChanged && index === 0 ? { navigation: checkpoint.navigation } : {}) })
    }
    changed = []; navigationChanged = false
  }
  const process = async (record: UrlMigrationRecord): Promise<void> => {
    if (options.signal?.aborted) return
    try {
      delete record.reason
      const document = await capture({ url: new URL(record.url), signal: options.signal })
      if (options.signal?.aborted) return
      if (Buffer.byteLength(document.body) > MAX_RESPONSE_BYTES) throw new Error('Captured response exceeds the 8 MB safety bound.')
      const final = canonical(document.finalUrl.toString(), sourceUrl)!
      const role = classifyMigrationResponse(document)
      if (!inScope(document.finalUrl, source, scopePath) && !(role === 'index' && isDiscoveryIndex(document.finalUrl, source))) { record.outcome = 'excluded'; record.reason = 'Redirected outside the selected origin/path.'; return }
      if (document.status && document.status >= 400) throw new Error(`Source page returned HTTP ${document.status}.`)
      if (role !== 'page') {
        record.outcome = 'excluded'; record.reason = `Final response role: ${role}.`
        if (role === 'index') for (const link of linksOf(document)) enqueue(link, final, record.url)
        return
      }
      const already = finalUrls.get(final)
      if (already && already !== record.url) { record.outcome = 'alias'; record.aliasOf = already; return }
      // Claim final identity before conversion can yield to asset acquisition.
      finalUrls.set(final, record.url)
      const id = idForUrl(document.finalUrl, scopePath)
      if (!id) throw new Error('Source URL has no safe destination path.')
      if (usedIds.has(id) && usedIds.get(id) !== record.url) { record.outcome = 'failed'; record.reason = `Destination collision for ${id}.`; return }
      usedIds.set(id, record.url)
      const evidence = evidenceOf(document)
      const page = convert(document, id)
      if (!page) { record.outcome = 'failed'; record.reason = 'Content could not be represented as safe inert MDX.'; return }
      const states = document.states ?? []
      if (states.length > 64) throw new Error('Capture contains too many alternative states.')
      for (const state of states) {
        if (Buffer.byteLength(state.response.body) > MAX_RESPONSE_BYTES) throw new Error('Alternative state exceeds the 8 MB safety bound.')
        if (!inScope(state.response.finalUrl, source, scopePath) || classifyMigrationResponse(state.response) !== 'page') throw new Error('Capture state escaped its selected scope or article role.')
        const alternative = convert(state.response, id)
        if (!alternative) throw new Error(`Alternative state ${state.id} is not inert content.`)
        const stateCode = /html/i.test(state.response.contentType) ? htmlEvidence(state.response).code : markdownCode(state.response.body)
        evidence.states.find((entry) => entry.id === state.id)!.code = stateCode
        const difference = alternativeBlocks(alternative.body, page.body)
        evidence.code.push(...markdownCode(difference))
        evidence.links.push(...linksOf(state.response))
        evidence.anchors.push(...(/html/i.test(state.response.contentType) ? htmlEvidence(state.response).anchors : markdownHeadingAnchors(state.response.body)))
        if (difference) page.body += `\n\n### ${state.label.replace(/[<>{}#\n\r]/g, '')}\n\n${difference}`
      }
      totalBytes += Buffer.byteLength(document.body) + states.reduce((sum, state) => sum + Buffer.byteLength(state.response.body), 0)
      evidence.byteLength = Buffer.byteLength(document.body) + states.reduce((sum, state) => sum + Buffer.byteLength(state.response.body), 0)
      if (totalBytes > (options.maxTotalBytes ?? 500_000_000)) { budgetExhausted = true; throw new Error('Migration exceeded its content byte budget.') }
      record.assets = []
      record.issues = []
      if (/html/i.test(document.contentType)) {
        const $ = load(document.body)
        const root = $('main article,article,main,[role="main"]').first()
        const unsupported = [...new Set(root.find('iframe,object,embed,canvas,svg,form,input,textarea,select,math,video,audio').toArray().map((node) => node.tagName))]
        if (unsupported.length) record.issues.push({ code: 'unsupported-component', source: record.url, message: `Rendered content requires explicit review for: ${unsupported.join(', ')}.` })
        if (!states.length && root.find('[role="tab"],[role="tabpanel"][hidden],details:not([open])').length) record.issues.push({ code: 'unsupported-component', source: record.url, message: 'Interactive alternatives were visible but no captured alternatives were supplied.' })
      }
      const suppliedAssets = new Map((document.assets ?? []).map((asset) => [canonical(asset.url, final), asset]))
      const assetUrls = [...new Set([...assetReferences(document), ...states.flatMap((state) => assetReferences(state.response))].map((url) => canonical(url, final)).filter((url): url is string => Boolean(url)))]
      if (assetUrls.length > 256 || (document.assets?.length ?? 0) > 256) throw new Error('Capture exceeds the 256 assets per page safety bound.')
      for (const url of assetUrls) {
        try {
          const asset = suppliedAssets.get(url) ?? (assetFetcher ? await assetFetcher(new URL(url), options.signal) : null)
          if (!asset) throw new Error('Capture host did not supply asset bytes or a binary fetch boundary.')
          const extension = acceptedAsset(asset)
          if (!extension) throw new Error('Asset MIME/signature is unsupported or unsafe to serve.')
          totalBytes += asset.content.byteLength
          if (totalBytes > (options.maxTotalBytes ?? 500_000_000)) { budgetExhausted = true; throw new Error('Migration exceeded its content and asset byte budget.') }
          const sha256 = hash(asset.content)
          const path = `migration-assets/${sha256}.${extension}`
          record.assets.push({ url, path, sha256, contentType: asset.contentType, base64: Buffer.from(asset.content).toString('base64') })
          // Only prose destinations are rewritten; example code is immutable.
          page.body = rewriteMarkdownDestinations(page.body, (destination) => canonical(destination, final) === url ? `/${path}` : destination)
        } catch (error) {
          record.issues.push({ code: 'asset-failed', source: record.url, message: `${url}: ${error instanceof Error ? error.message : String(error)}` })
        }
      }
      if (options.signal?.aborted) return
      if (sanitizeRemoteMarkdown(page.body.replace(/^<a id="[^"<]*" \/>$/gm, '')) === null) throw new Error('Converted content did not pass inert MDX validation.')
      record.evidence = evidence
      record.page = page
      const firstSegment = page.id.split('/', 1)[0]
      const locale = document.locale ?? (LOCALES.has(firstSegment.toLowerCase()) ? firstSegment.toLowerCase() : undefined)
      if (locale) {
        if (!/^[a-z]{2}(?:-[a-z0-9]{2,8}){0,2}$/i.test(locale)) throw new Error('Capture locale is not a portable language code.')
        page.locale = locale
        const segments = page.id.split('/')
        const localeIndex = segments.findIndex((segment) => segment.toLowerCase() === locale.toLowerCase())
        page.navigationId = segments.filter((_segment, index) => index !== localeIndex).join('/') || 'introduction'
        page.id = `${locale}/${page.navigationId}`
        if (usedIds.has(page.id) && usedIds.get(page.id) !== record.url) throw new Error(`Destination collision for locale page ${page.id}.`)
        usedIds.delete(id); usedIds.set(page.id, record.url)
      }
      record.version = document.version ?? page.id.split('/').find((segment) => /^v\d+(?:\.\d+)*$/i.test(segment))
      record.pageSha256 = pageHash(page)
      record.outcome = 'imported'
      imported++
      const navigation = checkpoint.navigation.length ? [] : sourceNavigation(document)
      if (!checkpoint.navigation.length && navigation.length) { checkpoint.navigation = navigation; navigationChanged = true }
      for (const link of evidence.links) {
        try {
          const url = new URL(link, final)
          if (!/\.(?:png|jpe?g|gif|svg|webp|avif|pdf|zip|mp4|webm|css|js)$/i.test(url.pathname)) enqueue(link, final, record.url)
        } catch { /* Malformed links remain visible in source evidence. */ }
      }
      const visit = (nodes: Array<MigrationNavigationOccurrence>): void => {
        for (const node of nodes) { if (node.url) enqueue(node.url, final, 'source-navigation'); visit(node.children ?? []) }
      }
      visit(navigation)
    } catch (error) {
      if (options.signal?.aborted) return
      const wasImported = record.outcome === 'imported'
      record.outcome = record.discoveredBy.every((origin) => origin === 'discovery-index') ? 'excluded' : 'failed'
      record.reason = error instanceof Error ? error.message : String(error)
      if (record.page) {
        if (wasImported) imported--
        usedIds.delete(record.page.id)
      }
      delete record.page; delete record.pageSha256; delete record.assets
    } finally {
      if (record.outcome !== 'pending') {
        if (options.onRecord) await options.onRecord(record)
        changed.push(record)
      }
    }
  }
  while (cursor < pending.length && !options.signal?.aborted && !budgetExhausted && cursor < (options.maxCaptures ?? Infinity)) {
    if (imported >= maxPages) break
    const batch = pending.slice(cursor, cursor + Math.min(concurrency, maxPages - imported, (options.maxCaptures ?? Infinity) - cursor))
    cursor += batch.length
    await Promise.all(batch.map(process))
    if (changed.length >= batchSize) await flush()
  }
  await flush()
  // Link maps are derived from every committed route, including redirect aliases.
  const routeMap = new Map<string, string>()
  for (const record of checkpoint.records) {
    const target = record.outcome === 'alias' ? records.get(record.aliasOf ?? '') : record
    if (target?.page) {
      const localePrefix = target.page.locale && target.page.locale !== 'en' ? `/${target.page.locale}` : ''
      const route = `${localePrefix}${target.page.navigationId === 'introduction' ? '/' : `/${target.page.navigationId}`}`
      routeMap.set(record.url, route)
      if (target.evidence) routeMap.set(canonical(target.evidence.finalUrl, sourceUrl)!, route)
    }
  }
  const navigationLabels = new Map<string, string>()
  const navigationIssues: Array<UrlMigrationIssue> = []
  const labelPages = (nodes: Array<MigrationNavigationOccurrence>): void => {
    for (const node of nodes) {
      const entry = node.url ? records.get(canonical(node.url, sourceUrl) ?? '') : undefined
      const target = entry?.outcome === 'alias' ? records.get(entry.aliasOf ?? '') : entry
      if (target?.page && node.label) {
        const previous = navigationLabels.get(target.url)
        if (previous && previous !== node.label) navigationIssues.push({ code: 'unsupported-component', source: target.url, message: `This page has multiple source navigation labels (${previous}, ${node.label}); review the shared sidebar title.` })
        else navigationLabels.set(target.url, node.label)
      }
      labelPages(node.children ?? [])
    }
  }
  labelPages(checkpoint.navigation)
  const pages = checkpoint.records.flatMap((record) => record.page ? [{ ...record.page, ...(navigationLabels.has(record.url) ? { navTitle: navigationLabels.get(record.url) } : {}), body: rewriteMarkdownDestinations(record.page.body, (value) => {
    let url: URL
    try { url = new URL(value, record.evidence!.finalUrl) } catch { return value }
    const route = routeMap.get(canonical(url.toString(), sourceUrl)!)
    return route ? `${route}${url.hash}` : value
  }) }] : [])
  const validation = validateUrlMigration(checkpoint, Boolean(options.signal?.aborted))
  validation.issues.push(...navigationIssues)
  if (navigationIssues.length && validation.status === 'passed') validation.status = 'partial'
  const assets = new Map(checkpoint.records.flatMap((record) => (record.assets ?? []).map((asset) => [asset.path, { path: asset.path, content: Buffer.from(asset.base64, 'base64') }] as const)))
  const bundle: MigrationBundle = {
    sourceUrl, sourceKind: 'url', platform: options.platform ?? 'generic', pages, assets: [...assets.values()],
    docsConfig: navigationConfig(checkpoint.navigation, records) ?? buildNavigationFromPages(pages),
    warnings: validation.issues.map((issue) => ({ code: issue.code === 'missing-page' ? 'missing-page' : 'unsupported-config', message: issue.message, source: issue.source })),
    urlMigrationValidation: validation,
    stats: { discovered: records.size, imported: pages.length, skipped: records.size - pages.length },
  }
  const locales = [...new Set(pages.map((page) => page.locale).filter((locale): locale is string => Boolean(locale)))]
  if (locales.length) bundle.docsConfig.i18n = { defaultLocale: 'en', locales: [{ code: 'en', label: 'English' }, ...locales.filter((locale) => locale !== 'en').map((code) => ({ code, label: code }))] }
  return { bundle, checkpoint, validation }
}

function rewriteMarkdownDestinations(body: string, rewrite: (value: string) => string): string {
  const edits = markdownNodes(body).filter((node) => node.url && node.position).map((node) => {
    const start = node.position!.start.offset!
    const end = node.position!.end.offset!
    const original = body.slice(start, end)
    const replacement = rewrite(node.url!)
    if (replacement === node.url) return null
    const index = original.lastIndexOf(node.url!)
    if (index < 0) return null
    return { start: start + index, end: start + index + node.url!.length, replacement }
  }).filter((edit): edit is { start: number; end: number; replacement: string } => edit !== null).sort((a, b) => b.start - a.start)
  for (const edit of edits) body = body.slice(0, edit.start) + edit.replacement + body.slice(edit.end)
  return body
}
