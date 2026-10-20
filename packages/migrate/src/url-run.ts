/**
 * Resumable public URL migration. A bounded batch commits a JSON journal delta;
 * capture, deterministic conversion and validation share the existing adapter.
 * Checkpoints accelerate recovery but hashes and host reconciliation establish
 * which artifacts can be reused. No provider or publication authority lives here.
 */
import { createHash } from 'node:crypto'
import { load } from 'cheerio'
import { parse, postprocess, preprocess } from 'micromark'
import remarkParse from 'remark-parse'
import remarkMdx from 'remark-mdx'
import { unified } from 'unified'
import { buildNavigationFromPages } from './navigation.js'
import { pageIdFromReference } from './path.js'
import { isPassiveSvg } from './svg-policy.js'
import { createMigrationAssetCache } from './url-asset-cache.js'
import { cloneUrlMigrationCheckpoint } from './url-journal-clone.js'
import { extractSourceNavigation, mergeSourceNavigation } from './url-navigation.js'
import { migrationImageAttribute, migrationImageCandidates, renderMigrationSrcset } from './url-images.js'
import { projectMigrationMedia } from './url-media.js'
import { declaredMigrationArticleUrl, isMigrationUtilityUrl, migrationSectionQueryCandidate, observedMigrationArticleIdentity } from './url-identity.js'
import { inferUrlMigrationScope } from './url-scope.js'
import { apiOperationCodeControls, apiSchemaDisclosureGroups, apiSchemaTabGroups } from './url-api-schema-controls.js'
import { projectProtectedEmails } from './url-static-content.js'
import { defaultMigrationFetcher, extractEmbeddedOpenApi, htmlPage, markdownPage, migrationHtmlArticle, sanitizeRemoteMarkdown, validateMigrationUrl } from './url.js'
import type { MigrationBundle, MigrationFetchResponse, MigrationNavigationGroup, MigrationPage } from './types.js'
import type {
  MigrationCapture, MigrationCapturedAsset, MigrationEvidence, MigrationNavigationOccurrence,
  UrlMigrationCheckpoint, UrlMigrationIssue, UrlMigrationRecord, UrlMigrationRun,
  UrlMigrationRunOptions, UrlMigrationValidation,
} from './url-run-types.js'

// Conversion and navigation evidence changed together. Older journals must be
// recaptured rather than reusing page hashes produced by the previous rules.
const CONVERTER_VERSION = 'url-evidence-v7'
const parser = unified().use(remarkParse).use(remarkMdx)
// Some publishers treat any Markdown Accept token as an explicit opt-in, even
// with a lower quality value. Capture the interactive article; declared .md
// URLs remain available separately for complete machine-readable API schemas.
const ACCEPT = 'text/html,application/xhtml+xml'
const MAX_RESPONSE_BYTES = 8_000_000
const MAX_ASSET_BYTES = 10_000_000
const MAX_RECORDS = 100_000
const LOCALES = new Set(['ar', 'cs', 'da', 'de', 'el', 'en', 'es', 'fi', 'fr', 'he', 'hi', 'hu', 'id', 'it', 'ja', 'ko', 'ms', 'nl', 'no', 'pl', 'pt', 'pt-br', 'ro', 'ru', 'sk', 'sv', 'th', 'tr', 'uk', 'vi', 'zh', 'zh-cn', 'zh-hans', 'zh-hant'])

interface MarkdownNode {
  type: string
  name?: string
  url?: string
  value?: string
  children?: Array<MarkdownNode>
  attributes?: Array<{ type: string; name?: string; value?: string | { type: string; value: string }; position?: { start: { offset?: number }; end: { offset?: number } } }>
  position?: { start: { offset?: number }; end: { offset?: number } }
}

function hash(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

function canonicalJson(value: unknown): string {
  // JSONB and other durable stores reorder object keys. Identity binds field
  // values recursively, while ordered arrays (code/navigation) keep their order.
  const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
    : value !== null && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, field]) => [key, canonical(field)])) : value
  return JSON.stringify(canonical(value))
}

function pageHash(page: MigrationPage): string { return hash(canonicalJson(page)) }

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

/** A filename match is only admissible after the publisher declares an alternate. */
function sameRouteMarkdownRepresentation(alternate: string, primary: string): boolean {
  const target = new URL(alternate), source = new URL(primary)
  const directory = (path: string) => path.replace(/\.mdx?$/i, '').replace(/\/index\/?$/i, '').replace(/\/$/, '')
  return target.origin === source.origin && target.search === source.search
    && directory(target.pathname) === directory(source.pathname) && /\.mdx?$/i.test(target.pathname)
}

/** Classify using the final response; an index must never become article text. */
export function classifyMigrationResponse(document: MigrationFetchResponse): 'page' | 'index' | 'asset' | 'unsupported' {
  if (document.status && document.status >= 400) return 'unsupported'
  if (/\/(?:llms(?:-full)?|robots)\.txt$|\/sitemap[^/]*\.xml$|\/search(?:\.html)?$/i.test(document.finalUrl.pathname)
    || /\.(?:json|ya?ml)$/i.test(document.finalUrl.pathname)
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
  // Schemas and machine manifests are attachments, never authored Markdown.
  if (/json|ya?ml/i.test(document.contentType) || /\.(?:json|ya?ml)$/i.test(document.finalUrl.pathname)) return []
  if (/html/i.test(document.contentType)) {
    const { $, root } = migrationHtmlArticle(document.body)
    root.find('nav,footer,aside').remove()
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
  const { $, root } = migrationHtmlArticle(document.body)
  const article = root.length ? root : $('body')
  article.find('nav,footer,aside,form,script,style').remove()
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
    ...technical, links: linksOf(capture), articleIdentity: observedMigrationArticleIdentity(capture),
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

function sourceNavigation(capture: MigrationCapture, selectedScope: string): Array<MigrationNavigationOccurrence> {
  return extractSourceNavigation(capture, selectedScope)
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
    const page = htmlPage(document, id, { preserveAnchors: true, preserveResponsiveImages: true, omitDocumentHeading: true }).page
    if (!page) return null
    // HTML already contains the source's visible article copy. Keep its SEO
    // description without inserting a second generated excerpt above the body.
    page.descriptionPlacement = 'body'
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
        // AST code spans start at the fence, after list/blockquote indentation.
        // Carry that container prefix onto every restored line, preserving the
        // decoded payload without turning its braces into executable MDX prose.
        const lineStart = page.body.lastIndexOf('\n', start - 1) + 1
        const prefix = page.body.slice(lineStart, start)
        // A prefix contains only indentation and blockquote markers. Scan once:
        // overlapping whitespace repetitions in a regex can backtrack on a
        // hostile document containing a long near-match before its code fence.
        let hasContainerPrefix = true
        for (const character of prefix) {
          if (character !== ' ' && character !== '\t' && character !== '>') {
            hasContainerPrefix = false
            break
          }
        }
        const indent = hasContainerPrefix ? prefix : ''
        const payload = code.split('\n').map((line) => `${indent}${line}`).join('\n')
        page.body = `${page.body.slice(0, start)}${fence}${info}\n${payload}\n${indent}${fence}${page.body.slice(end)}`
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
  const { $, root } = migrationHtmlArticle(capture.body)
  return [
    ...root.find('img[src],video[poster],a[download][href]').toArray().map((node) => $(node).is('video') ? $(node).attr('poster')! : $(node).is('a') ? $(node).attr('href')! : $(node).attr('src')!),
    ...root.find('[srcset]').toArray().flatMap((node) => migrationImageCandidates($(node).attr('srcset') ?? '', capture.finalUrl).map((candidate) => candidate.url)),
  ].filter(Boolean)
}

function unresolvedStaticControls(body: string, coveredSchemaGroups: number[] = [], coveredSchemaDisclosures: number[] = [], coveredCodeControls: number[] = []): boolean {
  const { $, root } = migrationHtmlArticle(body)
  root.find('[aria-expanded]').each((index, node) => { if (coveredCodeControls.includes(index)) $(node).removeAttr('aria-expanded') })
  // Coverage belongs to an exact operation and source group. Merely recovering
  // some API schema must never excuse unrelated, deferred article tabs.
  root.find('[role="tablist"],[data-component-part="tabs-list"]').each((index, node) => {
    if (coveredSchemaGroups.includes(index)) $(node).remove()
  })
  root.find('details').each((index, node) => { if (coveredSchemaDisclosures.includes(index)) $(node).remove() })
  const tabs = root.find('[role="tab"]').toArray()
  const idCounts = new Map<string, number>()
  root.find('[id]').each((_index, node) => {
    const id = $(node).attr('id')!
    idCounts.set(id, (idCounts.get(id) ?? 0) + 1)
  })
  for (const tab of tabs) {
    const controlId = $(tab).attr('id')
    if (controlId && idCounts.get(controlId) !== 1) return true
    const controls = $(tab).attr('aria-controls')
    const group = $(tab).closest('[role="tablist"],ul.tabs')
    const container = group.closest('.code-group,.tabs-container,.tabs.tab-container')
    // Positional panels belong to their own control group. A global index can
    // mistake a deferred schema panel for a fully captured code example.
    const peers = group.find('[role="tab"]').toArray().filter(node => $(node).closest('[role="tablist"],ul.tabs')[0] === group[0])
    const localPanels = container.find('[role="tabpanel"]').toArray().filter(node => $(node).closest('.code-group,.tabs-container,.tabs.tab-container')[0] === container[0])
    const owners = container.find('[role="tablist"],ul.tabs').toArray().filter(node => $(node).closest('.code-group,.tabs-container,.tabs.tab-container')[0] === container[0])
    const panels = controls ? root.find('[id]').filter((_index, node) => $(node).attr('id') === controls)
      : owners.length === 1 && peers.length === localPanels.length ? $(localPanels).eq(peers.indexOf(tab)) : $([])
    if (panels.length !== 1 || (!panels.text().trim() && !panels.find('pre,img,table,svg').length)
      || panels.is('[aria-busy="true"],[role="progressbar"]') || panels.find('[aria-busy="true"],[role="progressbar"]').length) return true
    const labels = panels.attr('aria-labelledby')?.trim().split(/\s+/)
    if (labels && (!controlId || !labels.includes(controlId))) return true
    if (controls && !labels && (container.length
      ? panels.closest('.code-group,.tabs-container,.tabs.tab-container')[0] !== container[0]
      : panels.parent()[0] !== group.parent()[0])) return true
  }
  const isCapturedImageZoom = (node: Parameters<typeof $>[0], depth = 0): boolean => {
    if (depth > 8) return false
    const control = $(node), image = control.prev('span.zoom-image-trigger[data-ramka-trigger]')
    return control.is('button[data-ramka-trigger][aria-haspopup="dialog"][aria-label]')
      && Boolean(control.attr('aria-label')?.trim()) && !control.attr('aria-controls') && !control.text().trim()
      && image.find('img[src]').length === 1 && !image.text().trim()
      && !image.find('form,iframe,object,embed,canvas').length
      && image.find('button').toArray().every(button => isCapturedImageZoom(button, depth + 1))
  }
  // Complete captured disclosures lose their live ARIA attributes only after
  // the shared projector proves content and ownership. A surviving control is
  // unsupported, even when an unrelated populated region could satisfy a
  // weaker second interpretation of the capture.
  if (root.find('[aria-expanded]').toArray().some(node => {
    const control = $(node)
    if (control.attr('role') === 'tab') return false
    // Publisher page actions are icon-only chrome beside the existing copy
    // action in the page header. Their menu does not own article alternatives.
    const actions = control.parent('[id="page-context-menu"]')
    if (control.is('button[aria-haspopup="menu"]') && !control.attr('aria-controls') && !control.text().trim()
      && actions.closest('header').length && actions.children('button#page-context-menu-button').length === 1) return false
    if (isCapturedImageZoom(node)) return false
    return true
  })) return true
  return root.find('details:not([open])').toArray().some((node) => {
    const clone = $(node).clone(); clone.children('summary').remove()
    return !clone.text().trim() && !clone.find('pre,img,table,svg').length
  })
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
  if (mime === 'image/svg+xml') return isPassiveSvg(asset.content) ? 'svg' : null
  const signature = Buffer.from(asset.content.slice(0, 16))
  const extensions: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'application/pdf': 'pdf', 'image/avif': 'avif' }
  const extension = extensions[mime]
  if (!extension) return null // HTML and executable downloads are never copied into public assets.
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
    && (!record.apiSpecification || (hasCompleteLocalApiSchema(record.apiSpecification.document)
      && record.apiSpecification.path === `openapi/migration-${record.apiSpecification.sha256}.json`
      && hash(canonicalJson(record.apiSpecification.document)) === record.apiSpecification.sha256))
    && record.assets?.every((asset) => /^migration-assets\/[a-f0-9]{64}\.[a-z0-9]+$/.test(asset.path)
      && (!asset.derivedFromSha256 || /^[a-f0-9]{64}$/.test(asset.derivedFromSha256))
      && hash(Buffer.from(asset.base64, 'base64')) === asset.sha256))
}

/** A local spec can replace lazy schema UI only when every reference is available inertly. */
function hasCompleteLocalApiSchema(document: Record<string, unknown>): boolean {
  let visited = 0
  const visit = (value: unknown, depth = 0): boolean => {
    if (++visited > 100_000 || depth > 96) return false
    if (typeof value === 'number' && !Number.isFinite(value)) return false
    if (!value || typeof value !== 'object') return true
    if (Array.isArray(value)) return value.every(child => visit(child, depth + 1))
    const object = value as Record<string, unknown>
    if (Object.prototype.hasOwnProperty.call(object, '$ref')) {
      if (typeof object.$ref !== 'string' || !object.$ref.startsWith('#/')) return false
      let target: unknown = document
      try {
        for (const encoded of object.$ref.slice(2).split('/')) {
          const key = decodeURIComponent(encoded).replace(/~1/g, '/').replace(/~0/g, '~')
          if (!target || typeof target !== 'object' || !Object.prototype.hasOwnProperty.call(target, key)) return false
          target = (target as Record<string, unknown>)[key]
        }
      } catch { return false }
    }
    return Object.values(object).every(child => visit(child, depth + 1))
  }
  return visit(document)
}

/** Resolve bounded format/redirect chains without accepting cycles as pages. */
function resolveMigrationRecord(records: Map<string, UrlMigrationRecord>, record?: UrlMigrationRecord): UrlMigrationRecord | undefined {
  const seen = new Set<string>()
  while (record?.outcome === 'alias') {
    if (seen.has(record.url) || seen.size >= 32) return undefined
    seen.add(record.url)
    record = records.get(record.aliasOf ?? '')
  }
  return record
}

function navigationConfig(checkpoint: UrlMigrationCheckpoint, records: Map<string, UrlMigrationRecord>, occurrencePages: ReadonlyMap<MigrationNavigationOccurrence, MigrationPage> = new Map()): MigrationBundle['docsConfig'] | null {
  const navigation = checkpoint.navigation
  // External source entries remain real links. They never authorize capturing
  // another origin; portable sidebar shortcuts retain every label/destination.
  const shortcuts: Array<{ label: string; href: string }> = []
  const collectShortcuts = (nodes: Array<MigrationNavigationOccurrence>): void => {
    for (const node of nodes) {
      if (node.url) {
        const record = records.get(canonical(node.url, checkpoint.sourceUrl) ?? '')
        const href = record?.redirectTo ?? node.url
        const identity = canonical(href, checkpoint.sourceUrl)
        const target = identity ? new URL(href, checkpoint.sourceUrl).href : null
        if (target && !inScope(new URL(target), new URL(checkpoint.sourceUrl), checkpoint.scopePath)
          && !shortcuts.some(link => link.label === node.label && link.href === target)) shortcuts.push({ label: node.label, href: target })
      }
      collectShortcuts(node.children ?? [])
    }
  }
  collectShortcuts(navigation)
  const hasDropdown = navigation.some(node => node.presentation === 'dropdown')
  const externalNavigation = shortcuts.length || hasDropdown ? { navigation: {
    ...(shortcuts.length ? { shortcuts } : {}), ...(hasDropdown ? { display: 'dropdown' as const } : {}),
  } } : {}
  const projection = localeProjection(checkpoint)
  const project = (nodes: Array<MigrationNavigationOccurrence>): Array<string | MigrationNavigationGroup> => nodes.flatMap<string | MigrationNavigationGroup>((node) => {
    const record = node.url ? records.get(canonical(node.url, node.url) ?? '') : undefined
    const target = resolveMigrationRecord(records, record)
    const page = occurrencePages.get(node) ?? target?.page
    const children = project(node.children ?? [])
    if (children.length) {
      const contains = (entries: Array<string | MigrationNavigationGroup>): boolean => entries.some((entry) => typeof entry === 'string' ? entry === (page && projection.navigationId(page)) : contains(entry.pages))
      return [{ group: node.label || 'Documentation', pages: [...(page && !contains(children) ? [projection.navigationId(page)] : []), ...children] }]
    }
    return page ? [projection.navigationId(page)] : []
  })
  const tabs = navigation.filter(node => node.kind === 'tab')
  if (tabs.length) {
    const locales = [...new Set(tabs.map(tab => tab.locale ?? projection.defaultLocale))]
    const localizedTabs = (locale: string): MigrationBundle['docsConfig']['tabs'] => tabs
      .filter(tab => (tab.locale ?? projection.defaultLocale) === locale)
      .flatMap(tab => {
        const pages = project(tab.children ?? [])
        return pages.length || tab.url ? [{ tab: tab.label, ...(pages.length ? { pages } : {}), ...(tab.url ? { href: tab.url } : {}) }] : []
      })
    const primary = localizedTabs(projection.defaultLocale)
    return { ...externalNavigation, tabs: primary.length ? primary : localizedTabs(locales[0]), ...(locales.length > 1 ? {
      i18n: { defaultLocale: projection.defaultLocale, locales: locales.map(code => ({ code, label: code === 'en' ? 'English' : code })),
        navigation: Object.fromEntries(locales.map(locale => [locale, localizedTabs(locale)])) },
    } : {}) }
  }
  const pages = project(navigation)
  return pages.length || shortcuts.length ? { ...externalNavigation, tabs: [{ tab: 'Documentation', pages }] } : null
}

function canonicalLanguage(value: string): string | undefined {
  if (!/^[a-z]{2,3}(?:-[a-z0-9]{2,8}){0,4}$/i.test(value)) return undefined
  try { return Intl.getCanonicalLocales(value)[0] } catch { return undefined }
}

/** Bind language to observed capture metadata, scoped URL identity and native HTML evidence. */
function observedLocale(document: MigrationCapture, id: string, scopePath: string): { locale?: string; issues: Array<UrlMigrationIssue> } {
  const issues: Array<UrlMigrationIssue> = []
  const candidates: Array<{ source: string; value: string }> = []
  if (document.locale) {
    const locale = canonicalLanguage(document.locale)
    if (!locale) throw new Error('Capture locale is not a portable language code.')
    candidates.push({ source: 'capture', value: locale })
  }
  const urlLocale = [id.split('/', 1)[0], ...scopePath.split('/'), document.finalUrl.pathname.split('/').filter(Boolean)[0]]
    .find((segment) => segment && LOCALES.has(segment.toLowerCase()))
  if (urlLocale) candidates.push({ source: 'URL', value: canonicalLanguage(urlLocale)! })
  const declared = /html/i.test(document.contentType) ? load(document.body)('html').attr('lang')?.trim() : undefined
  if (declared) {
    const locale = canonicalLanguage(declared)
    if (locale) candidates.push({ source: 'html lang', value: locale })
    else issues.push({ code: 'unsupported-component', source: document.finalUrl.href, message: 'The source declares an unsupported HTML language; review its locale configuration.' })
  }
  if (new Set(candidates.map((candidate) => candidate.value)).size > 1) {
    issues.push({ code: 'unsupported-component', source: document.finalUrl.href, message: `Observed locale metadata disagrees (${candidates.map((candidate) => `${candidate.source}: ${candidate.value}`).join(', ')}); review the source language.` })
  }
  return { locale: candidates[0]?.value, issues }
}

/** Match the runtime: primary files are unprefixed; translations require a primary slug. */
function localeProjection(checkpoint: UrlMigrationCheckpoint) {
  const pages = checkpoint.records.flatMap((record) => record.page ? [record.page] : [])
  const declaredLocale = (page: MigrationPage): string | undefined => {
    try { return page.locale ? Intl.getCanonicalLocales(page.locale)[0] : undefined } catch { return undefined }
  }
  const declaredLocales = [...new Set(pages.map(declaredLocale).filter((locale): locale is string => Boolean(locale)))]
  // A single-language French site must not become an orphan translation of
  // invented English content. Mixed/unprefixed sources retain English primary.
  const defaultLocale = pages.some((page) => !page.locale) || declaredLocales.includes('en') ? 'en' : declaredLocales[0] ?? 'en'
  const records = new Map(checkpoint.records.map(record => [record.url, record]))
  const memberships = new Map<MigrationPage, Set<string>>()
  const observe = (nodes: Array<MigrationNavigationOccurrence>, parentLocale?: string): void => {
    for (const node of nodes) {
      const locale = node.locale ? canonicalLanguage(node.locale) : parentLocale
      const entry = node.url ? records.get(canonical(node.url, checkpoint.sourceUrl) ?? '') : undefined
      const page = resolveMigrationRecord(records, entry)?.page
      if (page && locale) {
        const languages = memberships.get(page) ?? new Set<string>()
        languages.add(locale)
        memberships.set(page, languages)
      }
      observe(node.children ?? [], locale)
    }
  }
  observe(checkpoint.navigation)
  const primaryIds = new Set(pages.filter(page => !declaredLocale(page) || declaredLocale(page) === defaultLocale)
    .filter(page => memberships.get(page)?.has(defaultLocale)).map(page => page.navigationId))
  const remapped = new Map<MigrationPage, { locale: string; navigationId: string }>()
  for (const page of pages) {
    const languages = memberships.get(page)
    if (languages?.size !== 1) continue
    const locale = [...languages][0]
    const prefix = `${locale.toLowerCase()}-`
    // Some publishers put translated pages in legacy namespaces such as
    // fr-api/ while declaring HTML lang=en. Normalize only with three agreeing
    // facts: explicit language navigation, its exact namespace prefix, and an
    // existing primary-language counterpart. Content is never guessed/copied.
    if (locale === defaultLocale || !page.navigationId.toLowerCase().startsWith(prefix)) continue
    const navigationId = page.navigationId.slice(prefix.length)
    if (primaryIds.has(navigationId)) remapped.set(page, { locale, navigationId })
  }
  const canonicalLocale = (page: MigrationPage): string | undefined => remapped.get(page)?.locale ?? declaredLocale(page)
  const navigationId = (page: MigrationPage): string => remapped.get(page)?.navigationId ?? page.navigationId
  const locales = [...new Set(pages.map(canonicalLocale).filter((locale): locale is string => Boolean(locale)))]
  const pageId = (page: MigrationPage): string => {
    const locale = canonicalLocale(page)
    return locale ? `${locale === defaultLocale ? '' : `${locale}/`}${navigationId(page)}` : page.id
  }
  const route = (page: MigrationPage): string => {
    const locale = canonicalLocale(page)
    const prefix = locale && locale !== defaultLocale ? `/${locale}` : ''
    return `${prefix}${navigationId(page) === 'introduction' ? '/' : `/${navigationId(page)}`}`
  }
  const redirects = checkpoint.records.flatMap(record => {
    if (!record.page || !remapped.has(record.page)) return []
    const source = new URL(record.url)
    // Redirect routes use pattern syntax. Only emit literal portable paths;
    // source-controlled wildcard/parameter syntax must never widen a rule.
    return source.search || !/^\/[A-Za-z0-9/_~.%+-]*$/.test(source.pathname) ? []
      : [{ source: source.pathname, destination: route(record.page), permanent: true }]
  })
  return { canonicalLocale, navigationId, locales, defaultLocale, pageId, route, redirects }
}

/** Validate every selected outcome, source payload, internal destination and anchor. */
export function validateUrlMigration(checkpoint: UrlMigrationCheckpoint, cancelled = false): UrlMigrationValidation {
  const issues: Array<UrlMigrationIssue> = []
  const warnings: Array<UrlMigrationIssue> = []
  const counts: UrlMigrationValidation['counts'] = { pending: 0, imported: 0, excluded: 0, failed: 0, alias: 0 }
  const records = new Map(checkpoint.records.map((record) => [record.url, record]))
  const source = new URL(checkpoint.sourceUrl)
  const projection = localeProjection(checkpoint)
  const primaryIds = new Set(checkpoint.records.flatMap((record) => record.page
    && (!projection.canonicalLocale(record.page) || projection.canonicalLocale(record.page) === projection.defaultLocale) ? [projection.navigationId(record.page)] : []))
  const outputIds = new Set<string>()
  const resolve = (url: string): UrlMigrationRecord | undefined => {
    const record = records.get(canonical(url, checkpoint.sourceUrl) ?? '')
    return resolveMigrationRecord(records, record)
  }
  for (const record of checkpoint.records) {
    counts[record.outcome]++
    issues.push(...record.issues ?? [])
    warnings.push(...record.warnings ?? [])
    if (record.outcome === 'alias' && !resolveMigrationRecord(records, record)?.page) issues.push({ code: 'missing-page', source: record.url, message: 'An alias does not resolve to an imported source page.' })
    if (record.outcome === 'pending' || record.outcome === 'failed') issues.push({ code: 'missing-page', source: record.url, message: record.reason ?? `Inventory entry is ${record.outcome}.` })
    if (!record.page || !record.evidence) continue
    const outputId = projection.pageId(record.page)
    if (outputIds.has(outputId)) issues.push({ code: 'collision', source: record.url, message: `Multiple source pages map to runtime path ${outputId}.` })
    outputIds.add(outputId)
    if (projection.canonicalLocale(record.page) && projection.canonicalLocale(record.page) !== projection.defaultLocale && !primaryIds.has(projection.navigationId(record.page))) {
      issues.push({ code: 'missing-page', source: record.url, message: `Secondary locale ${projection.canonicalLocale(record.page)} requires a primary ${projection.defaultLocale} page at ${projection.navigationId(record.page)}; the runtime cannot serve an orphan translation.` })
    }
    const actual = markdownCode(record.page.body)
    if (JSON.stringify(actual) !== JSON.stringify(record.evidence.code)) issues.push({ code: 'code-mismatch', source: record.url, message: 'Source code payloads differ from converted code payloads.' })
    for (const value of record.evidence.links) {
      let link: URL
      try { link = new URL(value, record.evidence.finalUrl) } catch { continue }
      if (!inScope(link, source, checkpoint.scopePath)) continue
      if (isDiscoveryIndex(link, source) || isMigrationUtilityUrl(link)) continue
      if (/\.(?:png|jpe?g|gif|svg|webp|avif|pdf|zip|mp4|webm|css|js|json|ya?ml)$/i.test(link.pathname)) continue
      const destination = resolve(link.toString())
      if (!destination || !['imported', 'excluded'].includes(destination.outcome)) {
        issues.push({ code: 'missing-page', source: record.url, message: `Unresolved internal destination: ${link}` })
      } else if ((link.hash || records.get(canonical(link.href, checkpoint.sourceUrl) ?? '')?.aliasAnchor) && destination.outcome === 'imported') {
        let anchor = link.hash.slice(1) || records.get(canonical(link.href, checkpoint.sourceUrl) ?? '')!.aliasAnchor!
        if (link.hash) try { anchor = decodeURIComponent(anchor) } catch { /* Invalid encoding remains a literal anchor. */ }
        if (!destination.evidence?.anchors.includes(anchor)) {
          // This exact href was already broken in the captured source. Do not
          // invent anchors or mislabel it as lost conversion content.
          warnings.push({ code: 'source-link-warning', source: record.url, message: `The original source link refers to an absent source anchor; the imported link opens the page instead: ${link}` })
        } else if (destination.page) {
          const nodes = markdownNodes(destination.page.body)
          const explicit = nodes.flatMap(node => node.name === 'a' ? (node.attributes ?? []).flatMap(attribute => attribute.name === 'id' && typeof attribute.value === 'string' ? [attribute.value] : []) : [])
          if (!explicit.includes(anchor) && !markdownHeadingAnchors(destination.page.body).includes(anchor)) {
            issues.push({ code: 'missing-anchor', source: record.url, message: `Conversion lost a source anchor: ${link}` })
          }
        }
      }
    }
  }
  const visit = (nodes: Array<MigrationNavigationOccurrence>, parentLocale?: string): void => {
    for (const node of nodes) {
      const locale = node.locale ? canonicalLanguage(node.locale) : parentLocale
      if (node.url) {
        const url = new URL(node.url, source)
        if (inScope(url, source, checkpoint.scopePath) && !isMigrationUtilityUrl(url)) {
          const destination = resolve(url.toString())
          if (destination?.outcome === 'excluded' && destination.redirectTo) continue
          const page = destination?.page
          if (!page) issues.push({ code: 'navigation-missing', source: node.url, message: `Source navigation target ${node.label} was not imported.` })
          else if (locale && locale !== projection.defaultLocale && !outputIds.has(`${locale}/${projection.navigationId(page)}`)) {
            issues.push({ code: 'navigation-missing', source: node.url, message: `The ${locale} sidebar target ${node.label} has no authored localized runtime page.` })
          }
        }
      }
      visit(node.children ?? [], locale)
    }
  }
  visit(checkpoint.navigation)
  if (!counts.imported) issues.push({ code: 'missing-page', source: checkpoint.sourceUrl, message: 'No readable article pages were imported.' })
  return { status: cancelled ? 'cancelled' : issues.length ? 'partial' : 'passed', issues, counts, ...(warnings.length ? { warnings } : {}) }
}

/** Run capture/conversion in bounded batches and resume only reconciled artifacts. */
export async function runUrlMigration(options: UrlMigrationRunOptions): Promise<UrlMigrationRun> {
  const source = validateMigrationUrl(options.sourceUrl)
  const sourceUrl = canonical(source.toString(), source.toString())!
  const maxPages = options.maxPages ?? 1_000
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 10_000) throw new Error('maxPages must be between 1 and 10000.')
  const concurrency = Math.max(1, Math.min(32, Math.floor(options.concurrency ?? 5)))
  const batchSize = Math.max(1, Math.min(500, Math.floor(options.batchSize ?? 50)))
  if (!Number.isFinite(concurrency) || !Number.isFinite(batchSize)
    || (options.maxCaptures !== undefined && (!Number.isInteger(options.maxCaptures) || options.maxCaptures < 1))
    || (options.maxTotalBytes !== undefined && (!Number.isFinite(options.maxTotalBytes) || options.maxTotalBytes < 1))) throw new Error('Migration batch, concurrency and byte limits must be positive finite numbers.')
  const fetcher = options.fetcher ?? defaultMigrationFetcher
  const acquire = options.captureProvider?.capture.bind(options.captureProvider)
    ?? (async ({ url }: { url: URL }): Promise<MigrationCapture> => fetcher(url, { accept: ACCEPT }))
  let initial: Promise<MigrationCapture> | undefined
  let inferredScope: string | undefined
  if (options.scopePath === undefined && !options.checkpoint && !options.signal?.aborted) {
    // Inspect through the caller's existing capture authority and reuse that
    // exact observation for conversion. Resumes never rediscover their scope.
    initial = Promise.resolve().then(() => acquire({ url: source, signal: options.signal }))
    try {
      const document = await initial
      if (document.finalUrl.origin === source.origin) {
        const inferred = inferUrlMigrationScope(document).scopePath
        if (inScope(source, source, inferred)) inferredScope = inferred
      }
    } catch { /* The normal source record retains capture errors and retry policy. */ }
  }
  const capture = (request: { url: URL; signal?: AbortSignal }): Promise<MigrationCapture> =>
    initial && canonical(request.url.href, sourceUrl) === sourceUrl ? initial : acquire(request)
  const requestedScope = options.scopePath ?? options.checkpoint?.scopePath ?? inferredScope
    ?? (source.pathname.endsWith('/') ? source.pathname : source.pathname.slice(0, source.pathname.lastIndexOf('/')) || '/')
  // A regex anchored only at the end retries every slash-run start when a
  // hostile suffix prevents a match. Scan the tail once before validation.
  let scopeEnd = requestedScope.length
  while (scopeEnd > 0 && requestedScope.charCodeAt(scopeEnd - 1) === 47) scopeEnd--
  const scopePath = requestedScope.slice(0, scopeEnd) || '/'
  if (!scopePath.startsWith('/') || scopePath.includes('?') || scopePath.includes('#') || !inScope(source, source, scopePath)) throw new Error('The selected documentation scope must contain the source URL.')
  const captureVersion = options.captureVersion ?? 'fetch-v1'
  if (options.checkpoint && options.checkpoint.records.length > MAX_RECORDS) throw new Error('Checkpoint inventory exceeds its bound.')
  const checkpoint: UrlMigrationCheckpoint = options.checkpoint
    ? cloneUrlMigrationCheckpoint(options.checkpoint)
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
      delete record.apiSpecification; delete record.version; delete record.issues; delete record.warnings; delete record.redirectTo; delete record.reason; delete record.aliasOf; delete record.aliasAnchor
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
    // Machine indexes also advertise schemas/package files. They are linked
    // resources, not article inventory; API schemas have a separate proven path.
    const isUtility = isMigrationUtilityUrl(new URL(url))
    const isAttachment = isUtility || (discoveredBy !== 'submitted' && /\.(?:json|ya?ml)$/i.test(new URL(url).pathname))
    const existing = records.get(url)
    if (existing) {
      if (!existing.discoveredBy.includes(discoveredBy)) { existing.discoveredBy.push(discoveredBy); changed.push(existing) }
      return
    }
    if (records.size >= MAX_RECORDS) throw new Error('Discovered URL inventory exceeded the 100000 URL safety bound.')
    const record: UrlMigrationRecord = { url, discoveredBy: [discoveredBy], outcome: isAttachment ? 'excluded' : 'pending',
      ...(isAttachment ? { reason: isUtility ? 'Recognized provider utility endpoint, not an authored article.' : 'Machine-readable attachment, not an authored article.' } : {}) }
    records.set(url, record); checkpoint.records.push(record); if (!isAttachment) pending.push(record); changed.push(record)
  }
  enqueue(sourceUrl, sourceUrl, 'submitted')
  for (const path of ['llms.txt', 'sitemap.xml', 'robots.txt']) enqueue(`${scopePath === '/' ? '' : scopePath}/${path}`, sourceUrl, 'discovery-index')
  if (scopePath !== '/') for (const path of ['llms.txt', 'sitemap.xml', 'robots.txt']) enqueue(`/${path}`, sourceUrl, 'discovery-index')
  const enqueueArticleLinks = (links: Array<string>, base: string, discoveredBy: string): void => {
    for (const link of links) {
      try {
        const url = new URL(link, base)
        if (!/\.(?:png|jpe?g|gif|svg|webp|avif|pdf|zip|mp4|webm|css|js)$/i.test(url.pathname)) enqueue(link, base, discoveredBy)
      } catch { /* Malformed links remain visible in source evidence. */ }
    }
  }
  const enqueueNavigation = (nodes: Array<MigrationNavigationOccurrence>, base: string): void => {
    for (const node of nodes) {
      if (node.url) enqueue(node.url, base, 'source-navigation')
      enqueueNavigation(node.children ?? [], base)
    }
  }
  // A source record/header can commit before later pending-inventory chunks.
  // Rebuild those missing edges from durable evidence before skipping already
  // captured sources. Use the same scope, media and provenance rules as capture;
  // complete journals remain byte-identical and replay never fetches a source.
  for (const record of [...records.values()]) {
    if (!record.evidence) continue
    const final = canonical(record.evidence.finalUrl, sourceUrl)
    if (!final) continue
    if (record.outcome === 'imported') {
      enqueueArticleLinks(record.evidence.links, final, record.url)
      // The primary delta can commit before the newly discovered sibling's
      // chunk. Keep the explicit declaration as evidence on both sides.
      for (const reference of record.evidence.markdownRepresentations ?? []) {
        const alternate = canonical(reference, final)
        if (!alternate || !sameRouteMarkdownRepresentation(alternate, final)) continue
        enqueue(alternate, final, 'declared-markdown-representation')
        const sibling = records.get(alternate)
        if (sibling && sibling.representationOf !== record.url) {
          sibling.representationOf = record.url; changed.push(sibling)
        }
      }
    } else if (record.outcome === 'excluded') {
      if (classifyMigrationResponse({ finalUrl: new URL(final), contentType: record.evidence.contentType, body: '' }) === 'index') {
        for (const link of record.evidence.links) enqueue(link, final, record.url)
      }
    }
  }
  enqueueNavigation(checkpoint.navigation, sourceUrl)
  const assetFetcher = options.assetFetcher ?? (!options.fetcher && !options.captureProvider ? defaultAssetFetcher : undefined)
  const usedIds = new Map([...records.values()].filter((record) => record.page).map((record) => [record.page!.id, record.url]))
  const finalUrls = new Map([...records.values()].filter((record) => record.evidence && record.page).map((record) => [canonical(record.evidence!.finalUrl, sourceUrl)!, record.url]))
  let imported = usedIds.size
  const assetPayloads = new Map(checkpoint.records.flatMap((record) => (record.assets ?? []).map((asset) => [asset.sha256, asset] as const)))
  // URL aliases retain their own provenance, but never their own copy of an
  // identical binary payload. Normalize before a cached promise fulfills:
  // replacing only the local awaited value leaves the original Buffer alive.
  const assetBytes = new Map<string, Uint8Array>()
  const rasterizedSvgs = new Map<string, Promise<MigrationCapturedAsset>>()
  const retainAsset = async (original: MigrationCapturedAsset): Promise<MigrationCapturedAsset> => {
    let asset = { ...original }
    delete asset.derivedFromSha256
    if (asset.unavailable) {
      if ([404, 410].includes(asset.unavailable.status) && asset.content.byteLength === 0) return asset
      throw new Error('Invalid source asset availability evidence.')
    }
    if (!acceptedAsset(asset)) {
      if (asset.content.byteLength > MAX_ASSET_BYTES || asset.contentType.split(';', 1)[0].trim().toLowerCase() !== 'image/svg+xml'
        || !options.rasterizeSvg) throw new Error('Asset MIME/signature is unsupported or unsafe to serve.')
      const sourceSha256 = hash(asset.content)
      let rendering = rasterizedSvgs.get(sourceSha256)
      if (!rendering) {
        // The host owns the offline execution boundary. This engine accepts
        // only bounded PNG bytes back, never a relaxed SVG safety policy.
        rendering = options.rasterizeSvg({ ...asset, content: Buffer.from(asset.content) }, options.signal).then(rendered => {
          if (rendered.unavailable || rendered.contentType.split(';', 1)[0].trim().toLowerCase() !== 'image/png'
            || acceptedAsset(rendered) !== 'png') throw new Error('Trusted SVG renderer did not return a bounded PNG image.')
          return { ...rendered, derivedFromSha256: sourceSha256 }
        })
        rasterizedSvgs.set(sourceSha256, rendering)
      }
      asset = { ...await rendering, url: original.url }
    }
    const sha256 = hash(asset.content)
    // Own the retained bytes: adapters may recycle their capture buffers after
    // returning them, while checkpoint hashes must stay bound to this snapshot.
    const content = assetBytes.get(sha256) ?? Buffer.from(asset.content)
    assetBytes.set(sha256, content)
    return { ...asset, content }
  }
  const assetRequests = createMigrationAssetCache()
  for (const record of checkpoint.records) for (const asset of record.assets ?? []) {
    if (!assetRequests.has(asset.url)) {
      const content = assetBytes.get(asset.sha256) ?? Buffer.from(asset.base64, 'base64')
      assetBytes.set(asset.sha256, content)
      assetRequests.remember(asset.url, { url: asset.url, contentType: asset.contentType, content })
    }
  }
  let totalBytes = checkpoint.records.reduce((sum, record) => sum + (record.evidence?.byteLength ?? 0), 0)
    + [...assetPayloads.values()].reduce((sum, asset) => sum + Buffer.byteLength(asset.base64, 'base64'), 0)
  let budgetExhausted = false
  // An exact capture match avoids reparsing large identical query permalinks. The
  // signature covers complete bytes and host-supplied article state/metadata;
  // URL identity still requires the separately proven exact section candidate.
  const exactCaptures = new Map<string, string>()
  const exactCaptureKey = (document: MigrationCapture): string => {
    let body = document.body
    if (body.includes('data-cfemail')) {
      // This provider encodes the same literal with a fresh XOR key per read.
      // Normalize only after the shared, bounded decoder proves the actual
      // email. Every other DOM attribute, text byte and inert script remains.
      const $ = load(body)
      projectProtectedEmails($, $.root())
      body = $.html()
    }
    return hash(canonicalJson([
    hash(body), document.contentType, document.status, document.locale, document.version,
    document.headers?.['content-language'], document.navigation,
    (document.states ?? []).map(state => [state.id, state.label, state.response.finalUrl.href, state.response.contentType, state.response.status, hash(state.response.body)]),
    (document.assets ?? []).map(asset => [asset.url, asset.contentType, asset.unavailable, hash(asset.content)]),
    ]))
  }
  let cursor = 0
  const flush = async (): Promise<void> => {
    const distinct = [...new Map(changed.map((record) => [record.url, record])).values()]
    if (options.onCheckpoint) for (let index = 0; index < distinct.length || (index === 0 && navigationChanged); index += batchSize) {
      await options.onCheckpoint({ schemaVersion: 1, converterVersion: CONVERTER_VERSION, scopePath, captureVersion, sourceUrl, records: distinct.slice(index, index + batchSize), ...(navigationChanged && index === 0 ? { navigation: checkpoint.navigation } : {}) })
    }
    changed = []; navigationChanged = false
  }
  const process = async (record: UrlMigrationRecord): Promise<void> => {
    if (options.signal?.aborted || record.outcome !== 'pending') return
    let claimedId: string | undefined
    let claimedFinal: string | undefined
    let markdownRepresentation: string | undefined
    const markdownRepresentations: Array<string> = []
    let exactKey: string | undefined
    try {
      delete record.reason
      if (/\/llms-full\.txt$/i.test(new URL(record.url).pathname)) {
        record.outcome = 'excluded'; record.reason = 'Aggregate documentation corpus; individual articles are inventoried separately.'; return
      }
      // Pending records cannot carry a schema recovered by a previous capture.
      delete record.apiSpecification
      const represented = resolveMigrationRecord(records, record.representationOf ? records.get(record.representationOf) : undefined)
      if (represented?.outcome === 'imported') {
        record.outcome = 'alias'; record.aliasOf = represented.url
        return
      }
      const document = await capture({ url: new URL(record.url), signal: options.signal })
      if (options.signal?.aborted) return
      if (document.status && document.status >= 300 && document.status < 400 && document.headers?.location) {
        const destination = canonical(document.headers.location, document.finalUrl.href)
        if (destination && new URL(destination).origin !== source.origin) {
          record.outcome = 'excluded'; record.redirectTo = new URL(document.headers.location, document.finalUrl).href
          record.reason = 'The source entry is a redirect to an external public resource, retained as a link.'; return
        }
        throw new Error('Capture returned an unresolved redirect.')
      }
      if (Buffer.byteLength(document.body) > MAX_RESPONSE_BYTES) throw new Error('Captured response exceeds the 8 MB safety bound.')
      if ((document.states?.length ?? 0) > 64 || (document.assets?.length ?? 0) > 256) throw new Error('Capture contains too many alternative states or assets.')
      for (const state of document.states ?? []) if (Buffer.byteLength(state.response.body) > MAX_RESPONSE_BYTES) throw new Error('Alternative state exceeds the 8 MB safety bound.')
      if (/html/i.test(document.contentType) && (!document.status || document.status < 300) && inScope(document.finalUrl, source, scopePath)) {
        exactKey = exactCaptureKey(document)
        const peer = resolveMigrationRecord(records, records.get(exactCaptures.get(exactKey) ?? ''))
        const peerIdentity = peer?.evidence?.articleIdentity
        if (peer?.outcome === 'imported' && peer.evidence && peerIdentity) {
          const candidate = migrationSectionQueryCandidate(document.finalUrl, peer.evidence.anchors)
          if (candidate.sectionAnchor && candidate.canonicalUrl === peerIdentity.canonicalUrl) {
            const byteLength = Buffer.byteLength(document.body) + (document.states ?? []).reduce((sum, state) => sum + Buffer.byteLength(state.response.body), 0)
            totalBytes += byteLength
            if (totalBytes > (options.maxTotalBytes ?? 500_000_000)) { budgetExhausted = true; throw new Error('Migration exceeded its content byte budget.') }
            record.outcome = 'alias'; record.aliasOf = peer.url; record.aliasAnchor = candidate.sectionAnchor
            if (peerIdentity.sectionAnchor && peer.aliasAnchor !== peerIdentity.sectionAnchor) {
              peer.aliasAnchor = peerIdentity.sectionAnchor; changed.push(peer)
            }
            record.evidence = { ...peer.evidence, sha256: hash(document.body), byteLength, finalUrl: document.finalUrl.href,
              ...(document.artifactRef ? { artifactRef: document.artifactRef } : {}),
              articleIdentity: { ...peerIdentity, sectionAnchor: candidate.sectionAnchor } }
            if (!document.artifactRef) delete record.evidence.artifactRef
            enqueueArticleLinks(record.evidence.links, document.finalUrl.href, record.url)
            return
          }
        }
      }
      const identity = declaredMigrationArticleUrl(document)
      const final = canonical(identity.toString(), sourceUrl)!
      const role = classifyMigrationResponse(document)
      if (!inScope(document.finalUrl, source, scopePath) && !(role === 'index' && isDiscoveryIndex(document.finalUrl, source))) {
        record.outcome = 'excluded'; record.reason = 'Redirected outside the selected origin/path.'
        // Preserve a successful, observed same-origin redirect as navigation,
        // without admitting its marketing/contact destination into the crawl.
        if (document.finalUrl.origin === source.origin && (!document.status || (document.status >= 200 && document.status < 300))) record.redirectTo = document.finalUrl.href
        return
      }
      if (document.status && document.status >= 400) throw new Error(`Source page returned HTTP ${document.status}.`)
      if (role !== 'page') {
        totalBytes += Buffer.byteLength(document.body)
        if (totalBytes > (options.maxTotalBytes ?? 500_000_000)) { budgetExhausted = true; throw new Error('Migration exceeded its content byte budget.') }
        record.outcome = 'excluded'; record.reason = `Final response role: ${role}.`
        const links = role === 'index' ? linksOf(document) : []
        record.evidence = { sha256: hash(document.body), byteLength: Buffer.byteLength(document.body), finalUrl: final, contentType: document.contentType, ...(document.artifactRef ? { artifactRef: document.artifactRef } : {}), states: [], code: [], anchors: [], links }
        for (const link of links) enqueue(link, final, record.url)
        return
      }
      // A publisher may offer a Markdown representation of its exact article.
      // Require an explicit same-origin, same-route declaration; similarly named
      // independent sources must still produce visible destination collisions.
      if (/html/i.test(document.contentType)) {
        const $ = load(document.body)
        $('link[rel="alternate"][type="text/markdown"][href]').each((_index, node) => {
          const alternate = canonical($(node).attr('href')!, final)
          if (!alternate) return
          if (!sameRouteMarkdownRepresentation(alternate, final)) return
          enqueue(alternate, final, 'declared-markdown-representation')
          const sibling = records.get(alternate)
          if (!sibling) return
          sibling.representationOf = record.url
          markdownRepresentation ??= alternate
          markdownRepresentations.push(alternate)
          changed.push(sibling)
        })
      }
      const observedNavigation = sourceNavigation(document, scopePath)
      if (observedNavigation.length && !(checkpoint.navigation.some(node => node.kind === 'tab') && !observedNavigation.some(node => node.kind === 'tab'))) {
        const merged = mergeSourceNavigation(checkpoint.navigation, observedNavigation)
        if (JSON.stringify(merged) !== JSON.stringify(checkpoint.navigation)) {
          checkpoint.navigation = merged; navigationChanged = true
        }
        enqueueNavigation(observedNavigation, final)
      }
      const replacesRepresentation = imported >= maxPages && markdownRepresentations.some(url => records.get(url)?.page)
      if (imported >= maxPages && !replacesRepresentation) { record.outcome = 'excluded'; record.reason = 'A discovery endpoint resolved to an article after the selected page limit.'; return }
      const already = finalUrls.get(final)
      if (already && already !== record.url) { record.outcome = 'alias'; record.aliasOf = already; return }
      // Claim final identity before conversion can yield to asset acquisition.
      finalUrls.set(final, record.url)
      claimedFinal = final
      const id = idForUrl(identity, scopePath)
      if (!id) throw new Error('Source URL has no safe destination path.')
      const language = observedLocale(document, id, scopePath)
      const locale = language.locale
      const navigationId = locale ? id.split('/').filter(segment => segment.toLowerCase() !== locale.toLowerCase()).join('/') || 'introduction' : id
      const identityId = locale ? `${locale}/${navigationId}` : id
      const owner = records.get(usedIds.get(identityId) ?? '')
      const sharesDeclaredRepresentation = owner && (owner.representationOf === record.url || record.representationOf === owner.url)
      if (owner && owner !== record && !sharesDeclaredRepresentation) { record.outcome = 'failed'; record.reason = `Destination collision for ${identityId}.`; return }
      // A declared Markdown sibling may already be imported or awaiting assets.
      // Let both conversions finish so genuine HTML failures retain the inert
      // fallback, but reserve the shared route for the richer primary article.
      if (!owner || owner === record || owner.representationOf === record.url) usedIds.set(identityId, record.url)
      claimedId = identityId
      const evidence = evidenceOf(document)
      if (markdownRepresentations.length) evidence.markdownRepresentations = markdownRepresentations
      const page = convert(document, id)
      if (!page) { record.outcome = 'failed'; record.reason = 'Content could not be represented as safe inert MDX.'; return }
      let coveredSchemaGroups: number[] = []
      let coveredSchemaDisclosures: number[] = []
      let coveredCodeControls: number[] = []
      let schemaOperation: { method: string; path: string } | undefined
      const hasSchemaChoice = /html/i.test(document.contentType) && migrationHtmlArticle(document.body).root.find('select[aria-label="Select schema type"],select[aria-label="选择架构类型"]').length > 0
      if (/html/i.test(document.contentType) && markdownRepresentation && (unresolvedStaticControls(document.body) || hasSchemaChoice)) {
        // Lazy API fields cannot be proven from the collapsed DOM. A declared
        // machine-readable view may carry the entire OpenAPI operation instead.
        // Fetch through the same host boundary; no browser/API action is invoked.
        const schemaCapture = await capture({ url: new URL(markdownRepresentation), signal: options.signal })
        if (options.signal?.aborted) return
        if ((schemaCapture.status && schemaCapture.status >= 400) || !/text\/(?:markdown|plain)/i.test(schemaCapture.contentType)) throw new Error('API schema representation is not a successful Markdown response.')
        totalBytes += Buffer.byteLength(schemaCapture.body)
        if (Buffer.byteLength(schemaCapture.body) > MAX_RESPONSE_BYTES || totalBytes > (options.maxTotalBytes ?? 500_000_000)) throw new Error('API schema capture exceeds its content byte budget.')
        const expected = new URL(markdownRepresentation)
        if (schemaCapture.finalUrl.origin !== expected.origin || schemaCapture.finalUrl.pathname !== expected.pathname || schemaCapture.finalUrl.search !== expected.search) throw new Error('API schema representation escaped its declared identity.')
        const fragment = extractEmbeddedOpenApi(schemaCapture.body).fragment
        if (fragment && hasCompleteLocalApiSchema(fragment.document)) {
          const sha256 = hash(canonicalJson(fragment.document))
          const path = `openapi/migration-${sha256}.json`
          record.apiSpecification = { path, sha256, document: fragment.document }
          page.openapi = `${path} ${fragment.method} ${fragment.path}`
          schemaOperation = fragment
          coveredSchemaGroups = apiSchemaTabGroups(document.body, fragment.document, fragment)
          coveredSchemaDisclosures = apiSchemaDisclosureGroups(document.body, fragment.document, fragment)
          coveredCodeControls = apiOperationCodeControls(document.body, fragment.document, fragment)
        }
      }
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
      record.warnings = []
      for (const captured of [document, ...states.map(state => state.response)]) {
        if (!/html/i.test(captured.contentType)) continue
        const { $, root } = migrationHtmlArticle(captured.body)
        root.find('nav,footer,aside,.theme-doc-breadcrumbs,.theme-doc-toc-mobile,.table-of-contents,.hash-link').remove()
        root.find('button svg,a.hash-link svg,[aria-hidden="true"] svg,svg[aria-hidden="true"],svg[data-lucide],svg[data-icon]').remove()
        root.find('video,iframe').each((_index, node) => {
          // Only the exact media projection used by conversion proves support.
          // Unknown embeds and custom controls must still block silent loss.
          if (projectMigrationMedia($.html(node), captured.finalUrl) !== null) {
            record.warnings!.push({ code: 'source-asset-warning', source: record.url, message: 'Embedded video is preserved at its original public media URL; playback depends on the original host.' })
            $(node).remove()
          }
        })
        if (record.apiSpecification) {
          // These specific choices and deferred child fields are represented by
          // the complete registered OpenAPI operation, not discarded as chrome.
          root.find('select[aria-label="Select schema type"],select[aria-label="选择架构类型"]').remove()
          root.find('.option-dropdown svg[data-component-part="icon-svg"]').remove()
        }
        const unsupported = [...new Set(root.find('iframe,object,embed,canvas,svg,form,input,textarea,select,math,video,audio').toArray().map((node) => node.tagName))]
        if (unsupported.length) record.issues.push({ code: 'unsupported-component', source: record.url, message: `Rendered content requires explicit review for: ${unsupported.join(', ')}.` })
        const groups = captured === document ? coveredSchemaGroups : record.apiSpecification && schemaOperation ? apiSchemaTabGroups(captured.body, record.apiSpecification.document, schemaOperation) : []
        const disclosures = captured === document ? coveredSchemaDisclosures : record.apiSpecification && schemaOperation ? apiSchemaDisclosureGroups(captured.body, record.apiSpecification.document, schemaOperation) : []
        const codeControls = captured === document ? coveredCodeControls : record.apiSpecification && schemaOperation ? apiOperationCodeControls(captured.body, record.apiSpecification.document, schemaOperation) : []
        if (unresolvedStaticControls(captured.body, groups, disclosures, codeControls)) record.issues.push({ code: 'unsupported-component', source: record.url, message: 'An interactive alternative has no complete captured panel or disclosure content.' })
      }
      // Passive inline vectors are projected by the shared article extractor,
      // so evidence and conversion reference these exact local binary bytes.
      const inlineAssets = [document, ...states.map(state => state.response)].flatMap(captured => /html/i.test(captured.contentType)
        ? migrationHtmlArticle(captured.body).assets.map(asset => ({
          url: new URL(`/${asset.path}`, captured.finalUrl).href, contentType: 'image/svg+xml',
          content: typeof asset.content === 'string' ? Buffer.from(asset.content) : asset.content,
        })) : [])
      const suppliedAssets = new Map([...(document.assets ?? []), ...inlineAssets].map((asset) => [canonical(asset.url, final), asset]))
      const assetUrls = [...new Set([...assetReferences(document), ...states.flatMap((state) => assetReferences(state.response))].map((url) => canonical(url, final)).filter((url): url is string => Boolean(url)))]
      if (assetUrls.length > 256 || (document.assets?.length ?? 0) > 256) throw new Error('Capture exceeds the 256 assets per page safety bound.')
      for (const url of assetUrls) {
        try {
          let assetRequest = assetRequests.get(url)
          if (!suppliedAssets.has(url) && !assetRequest && assetFetcher) {
            assetRequest = assetRequests.load(url, () => assetFetcher(new URL(url), options.signal).then(retainAsset))
          }
          const supplied = suppliedAssets.get(url)
          const asset = supplied ? await retainAsset(supplied) : (assetRequest ? await assetRequest : null)
          if (!asset) throw new Error('Capture host did not supply asset bytes or a binary fetch boundary.')
          if (asset.unavailable && [404, 410].includes(asset.unavailable.status) && asset.content.byteLength === 0) {
            record.warnings.push({ code: 'asset-failed', source: record.url, message: `The original source asset is unavailable (HTTP ${asset.unavailable.status}); its original URL was retained: ${url}` })
            page.body = rewriteMarkdownDestinations(page.body, destination => canonical(destination, final) === url ? url : destination)
            continue
          }
          const extension = acceptedAsset(asset)
          if (!extension) throw new Error('Asset MIME/signature is unsupported or unsafe to serve.')
          const sha256 = hash(asset.content)
          const existing = assetPayloads.get(sha256)
          if (!existing) {
            totalBytes += asset.content.byteLength
            if (totalBytes > (options.maxTotalBytes ?? 500_000_000)) { budgetExhausted = true; throw new Error('Migration exceeded its content and asset byte budget.') }
          }
          const path = `migration-assets/${sha256}.${extension}`
          const receipt = { url, path, sha256, contentType: asset.contentType, base64: existing?.base64 ?? Buffer.from(asset.content).toString('base64'), ...(asset.derivedFromSha256 ? { derivedFromSha256: asset.derivedFromSha256 } : {}) }
          record.assets.push(receipt)
          if (!existing) assetPayloads.set(sha256, receipt)
          if (!assetRequests.has(url)) assetRequests.remember(url, asset)
          // Only prose destinations are rewritten; example code is immutable.
          page.body = rewriteMarkdownDestinations(page.body, (destination) => canonical(destination, final) === url ? `/${path}${new URL(destination, final).hash}` : destination)
        } catch (error) {
          assetRequests.delete(url)
          record.issues.push({ code: 'asset-failed', source: record.url, message: `${url}: ${error instanceof Error ? error.message : String(error)}` })
        }
      }
      if (options.signal?.aborted) return
      if (sanitizeRemoteMarkdown(page.body.replace(/^<a id="[^"<]*" \/>$/gm, '')) === null) throw new Error('Converted content did not pass inert MDX validation.')
      record.evidence = evidence
      record.page = page
      record.issues.push(...language.issues)
      const canonicalLocale = language.locale
      if (canonicalLocale) {
        page.locale = canonicalLocale
        page.navigationId = navigationId
        page.id = `${canonicalLocale}/${page.navigationId}`
      }
      record.version = document.version ?? [...page.id.split('/'), ...document.finalUrl.pathname.split('/')].find((segment) => /^v\d+(?:\.\d+)*$/i.test(segment))
      record.pageSha256 = pageHash(page)
      record.outcome = 'imported'
      imported++
      if (exactKey) exactCaptures.set(exactKey, record.url)
      enqueueArticleLinks(evidence.links, final, record.url)
    } catch (error) {
      if (options.signal?.aborted) return
      const wasImported = record.outcome === 'imported'
      record.outcome = isDiscoveryIndex(new URL(record.url), source) || record.discoveredBy.every((origin) => origin === 'discovery-index') ? 'excluded' : 'failed'
      record.reason = error instanceof Error ? error.message : String(error)
      if (record.page) {
        if (wasImported) imported--
        usedIds.delete(record.page.id)
      }
      delete record.page; delete record.pageSha256; delete record.assets; delete record.apiSpecification
    } finally {
      // Failed conversions must release both reservations, including failures
      // before record.page exists. Never release another concurrent owner.
      if (record.outcome !== 'imported') {
        if (claimedId && usedIds.get(claimedId) === record.url) usedIds.delete(claimedId)
        if (claimedFinal && finalUrls.get(claimedFinal) === record.url) finalUrls.delete(claimedFinal)
      }
      if (record.outcome !== 'pending') {
        if (options.onRecord) await options.onRecord(record)
        changed.push(record)
      }
    }
  }
  const settleArticleIdentities = (): void => {
    const groups = new Map<string, Array<UrlMigrationRecord>>()
    for (const record of records.values()) {
      const identity = record.evidence?.articleIdentity
      if (record.outcome !== 'imported' || !identity) continue
      const key = JSON.stringify([identity.canonicalUrl, identity.articleSha256])
      const group = groups.get(key) ?? []
      group.push(record); groups.set(key, group)
    }
    for (const group of groups.values()) {
      if (group.length < 2) continue
      const canonicalUrl = group[0].evidence!.articleIdentity!.canonicalUrl
      const winner = group.find(record => record.url === canonicalUrl) ?? group[0]
      const winnerAnchor = winner.evidence!.articleIdentity!.sectionAnchor
      if (winnerAnchor && winner.aliasAnchor !== winnerAnchor) {
        winner.aliasAnchor = winnerAnchor; changed.push(winner)
      }
      for (const alternate of group) {
        if (alternate === winner) continue
        imported--
        if (alternate.page && usedIds.get(alternate.page.id) === alternate.url) usedIds.delete(alternate.page.id)
        alternate.outcome = 'alias'; alternate.aliasOf = winner.url
        alternate.aliasAnchor = alternate.evidence!.articleIdentity!.sectionAnchor
        delete alternate.page; delete alternate.pageSha256; delete alternate.assets; delete alternate.apiSpecification
        delete alternate.issues; delete alternate.warnings; delete alternate.reason
        changed.push(alternate)
      }
    }
  }
  const settleRepresentations = (): void => {
    for (const record of records.values()) {
      if (!record.representationOf) continue
      const primary = resolveMigrationRecord(records, records.get(record.representationOf))
      if (!primary || primary === record) continue
      const winner = primary.outcome === 'imported' ? primary : record.outcome === 'imported' && primary.outcome === 'failed' ? record : undefined
      if (!winner) continue
      if (winner.page) usedIds.set(winner.page.id, winner.url)
      const alternate = winner === primary ? record : primary
      if (alternate.outcome === 'alias' && alternate.aliasOf === winner.url) continue
      if (alternate.outcome === 'imported') {
        imported--
        if (alternate.page && usedIds.get(alternate.page.id) === alternate.url) usedIds.delete(alternate.page.id)
      }
      alternate.outcome = 'alias'; alternate.aliasOf = winner.url
      delete alternate.reason; delete alternate.page; delete alternate.pageSha256; delete alternate.assets; delete alternate.issues; delete alternate.apiSpecification
      changed.push(alternate)
    }
  }
  settleRepresentations()
  settleArticleIdentities()
  while (cursor < pending.length && !options.signal?.aborted && !budgetExhausted && cursor < (options.maxCaptures ?? Infinity)) {
    if (imported >= maxPages) {
      const index = pending.findIndex((record, position) => {
        if (position < cursor || record.outcome !== 'pending') return false
        const url = new URL(record.url)
        if (isDiscoveryIndex(url, source)) return true
        if (/\.mdx?$/i.test(url.pathname)) return false
        // A full page budget must still permit upgrading an already counted
        // Markdown page. This only schedules a capture: the HTML must prove its
        // explicit alternate before it may share that destination reservation.
        return ['.md', '.mdx', '/index.md', '/index.mdx'].some(extension => {
          const alternate = new URL(url)
          alternate.pathname = alternate.pathname.replace(/\/index$/i, '') + extension
          return records.get(alternate.href)?.outcome === 'imported'
        })
      })
      if (index < 0) break
      pending.splice(cursor, 0, pending.splice(index, 1)[0])
    }
    const batch = pending.slice(cursor, cursor + Math.min(concurrency, imported >= maxPages ? 1 : maxPages - imported, (options.maxCaptures ?? Infinity) - cursor))
    cursor += batch.length
    await Promise.all(batch.map(process))
    settleRepresentations()
    settleArticleIdentities()
    if (changed.length >= batchSize) await flush()
  }
  await flush()
  // Link maps are derived from every committed route, including redirect aliases.
  const projection = localeProjection(checkpoint)
  const routeMap = new Map<string, string>()
  for (const record of checkpoint.records) {
    const target = resolveMigrationRecord(records, record)
    if (target?.page) {
      const route = projection.route(target.page)
      routeMap.set(record.url, route)
      if (target.evidence) routeMap.set(canonical(target.evidence.finalUrl, sourceUrl)!, route)
    }
  }
  const navigationLabels = new Map<string, string>()
  const navigationIssues: Array<UrlMigrationIssue> = []
  const navigationOccurrences = new Map<UrlMigrationRecord, Array<{ node: MigrationNavigationOccurrence; entry: UrlMigrationRecord }>>()
  const labelPages = (nodes: Array<MigrationNavigationOccurrence>): void => {
    for (const node of nodes) {
      const entry = node.url ? records.get(canonical(node.url, sourceUrl) ?? '') : undefined
      const target = resolveMigrationRecord(records, entry)
      if (entry && target?.page && node.label && !node.children?.length && !entry.aliasAnchor) {
        const occurrences = navigationOccurrences.get(target) ?? []
        occurrences.push({ node, entry }); navigationOccurrences.set(target, occurrences)
      }
      labelPages(node.children ?? [])
    }
  }
  labelPages(checkpoint.navigation)
  const occurrencePages = new Map<MigrationNavigationOccurrence, MigrationPage>()
  const navigationAliases = new Map<string, { page: MigrationPage; target: UrlMigrationRecord }>()
  const occupiedPageIds = new Set(checkpoint.records.flatMap(record => record.page ? [projection.pageId(record.page)] : []))
  const navigationRedirects: NonNullable<MigrationBundle['docsConfig']['redirects']> = []
  for (const [target, occurrences] of navigationOccurrences) {
    // Capture order may make a redirecting URL own the article record. Prefer
    // the final article's actual navigation label independently of that owner.
    const final = target.evidence && canonical(target.evidence.finalUrl, sourceUrl)
    const primary = occurrences.find(({ entry }) => entry.url === final)
      ?? occurrences.find(({ entry }) => entry === target) ?? occurrences[0]
    navigationLabels.set(target.url, primary.node.label)
    for (const { node, entry } of occurrences) {
      if (node.label === primary.node.label) continue
      const existing = navigationAliases.get(entry.url)
      if (existing?.page.navTitle === node.label && existing.target === target) {
        occurrencePages.set(node, existing.page); continue
      }
      const sourceRoute = new URL(entry.url)
      const id = inScope(sourceRoute, source, scopePath) ? idForUrl(sourceRoute, scopePath) : null
      const locale = projection.canonicalLocale(target.page!)
      let navigationId = id && (locale ? id.split('/').filter(segment => segment.toLowerCase() !== locale.toLowerCase()).join('/') || 'introduction' : id)
      // A legacy locale namespace already proven by the article retains the
      // same normalization on its redirect's portable navigation identity.
      const legacyPrefix = locale && `${locale.toLowerCase()}-`
      if (navigationId && legacyPrefix && projection.navigationId(target.page!) !== target.page!.navigationId
        && navigationId.toLowerCase().startsWith(legacyPrefix)) navigationId = navigationId.slice(legacyPrefix.length)
      const page = navigationId ? { ...target.page!, id: locale ? `${locale}/${navigationId}` : navigationId, navigationId,
        ...(locale ? { locale } : {}), navTitle: node.label, source: entry.url, noindex: true } : undefined
      if (!page || existing || occupiedPageIds.has(projection.pageId(page))) {
        navigationIssues.push({ code: 'unsupported-component', source: target.url, message: `This page has multiple source navigation labels (${primary.node.label}, ${node.label}); their source routes cannot retain distinct sidebar titles safely.` })
        continue
      }
      // Sidebar leaves read navTitle from a page file. Retain the observed
      // alias's own leaf metadata and an internal redirect, rather than losing
      // its label or duplicating the article in search. Journal capture counts
      // still describe the one imported article and its observed aliases.
      occupiedPageIds.add(projection.pageId(page))
      navigationAliases.set(entry.url, { page, target }); occurrencePages.set(node, page)
      navigationRedirects.push({ source: projection.route(page), destination: projection.route(target.page!), permanent: true })
    }
  }
  const pages = checkpoint.records.flatMap((record) => record.page ? [{ ...record.page, id: projection.pageId(record.page), navigationId: projection.navigationId(record.page), ...(projection.canonicalLocale(record.page) ? { locale: projection.canonicalLocale(record.page) } : {}), ...(navigationLabels.has(record.url) ? { navTitle: navigationLabels.get(record.url) } : {}), body: rewriteMarkdownDestinations(record.page.body, (value) => {
    let url: URL
    try { url = new URL(value, record.evidence!.finalUrl) } catch { return value }
    const identity = canonical(url.toString(), sourceUrl)!
    const route = routeMap.get(identity)
    if (!route) return value
    const destination = resolveMigrationRecord(records, records.get(identity))
    let anchor = url.hash.slice(1)
    try { anchor = decodeURIComponent(anchor) } catch { /* Match validation's literal invalid-encoding policy. */ }
    // A captured absent anchor is a source defect, not a conversion failure.
    // Keep its original href in the report, but make the imported link usable
    // by opening the proven page. Valid source anchors must survive unchanged;
    // validation still blocks any anchor that conversion itself lost.
    const effectiveHash = url.hash || (records.get(identity)?.aliasAnchor ? `#${encodeURIComponent(records.get(identity)!.aliasAnchor!)}` : '')
    const hasBrokenSourceAnchor = Boolean(url.hash && destination?.outcome === 'imported'
      && destination.evidence && !destination.evidence.anchors.includes(anchor))
    return `${route}${hasBrokenSourceAnchor ? '' : effectiveHash}`
  }) }] : [])
  const projectedPages = new Map(pages.map(page => [page.id, page]))
  for (const { page, target } of navigationAliases.values()) {
    pages.push({ ...page, id: projection.pageId(page), body: projectedPages.get(projection.pageId(target.page!))!.body })
  }
  const validation = validateUrlMigration(checkpoint, Boolean(options.signal?.aborted))
  validation.issues.push(...navigationIssues)
  if (navigationIssues.length && validation.status === 'passed') validation.status = 'partial'
  const assets = new Map<string, MigrationBundle['assets'][number]>()
  for (const record of checkpoint.records) for (const asset of record.assets ?? []) {
    if (!assets.has(asset.path)) {
      const content = assetBytes.get(asset.sha256) ?? Buffer.from(asset.base64, 'base64')
      // Keep the public bundle's historical Buffer JSON shape, including when
      // an adapter supplied a plain Uint8Array or a view into a larger buffer.
      assets.set(asset.path, { path: asset.path, content: Buffer.from(content.buffer, content.byteOffset, content.byteLength) })
    }
  }
  for (const record of checkpoint.records) if (record.page && record.apiSpecification) {
    const spec = record.apiSpecification
    assets.set(spec.path, { path: spec.path, projectRelative: true, content: Buffer.from(canonicalJson(spec.document)) })
  }
  const bundle: MigrationBundle = {
    sourceUrl, sourceKind: 'url', platform: options.platform ?? 'generic', pages, assets: [...assets.values()],
    docsConfig: navigationConfig(checkpoint, records, occurrencePages) ?? buildNavigationFromPages(pages),
    warnings: [...validation.issues, ...validation.warnings ?? []].map((issue) => ({ code: issue.code === 'missing-page' ? 'missing-page' : 'unsupported-config', message: issue.message, source: issue.source })),
    urlMigrationValidation: validation,
    stats: { discovered: records.size, imported: pages.length, skipped: records.size - pages.length },
  }
  if (projection.redirects.length || navigationRedirects.length) bundle.docsConfig.redirects = [...projection.redirects, ...navigationRedirects]
  if (projection.locales.length) {
    const locales = [...new Set([projection.defaultLocale, ...projection.locales])]
    bundle.docsConfig.i18n = { ...bundle.docsConfig.i18n, defaultLocale: projection.defaultLocale, locales: locales.map((code) => ({ code, label: code === 'en' ? 'English' : code })) }
  }
  for (const spec of assets.values()) if (spec.projectRelative && spec.path.startsWith('openapi/')) {
    bundle.docsConfig.tabs.push({ tab: `Migration API ${spec.path.slice(-69, -5)}`, hidden: true, api: { source: spec.path, navigation: false } })
  }
  const stopReason = options.signal?.aborted ? 'cancelled'
    : budgetExhausted ? 'byte-limit'
      : cursor < pending.length && cursor >= (options.maxCaptures ?? Infinity) ? 'capture-limit'
        : imported >= maxPages && cursor < pending.length ? 'page-limit'
        : cursor < pending.length ? 'capture-limit' : 'complete'
  return { bundle, checkpoint, validation, stopReason }
}

function rewriteMarkdownDestinations(body: string, rewrite: (value: string) => string): string {
  const edits = markdownNodes(body).filter((node) => node.url && node.position).map((node) => {
    const start = node.position!.start.offset!
    const end = node.position!.end.offset!
    const original = body.slice(start, end)
    const replacement = rewrite(node.url!)
    if (replacement === node.url) return null
    // mdast decodes backslash escapes and character references in node.url.
    // Locate the concrete destination with the same CommonMark tokenizer;
    // substring matching either misses escaped URLs or edits a matching title.
    // The outer link's destination follows any nested image in its label.
    const destinations = postprocess(parse().document().write(preprocess()(original, undefined, true)))
      .filter(([event, token]) => event === 'enter' && ['resourceDestinationString', 'definitionDestinationString', 'autolinkProtocol', 'autolinkEmail'].includes(token.type))
    const destination = destinations.at(-1)?.[1]
    if (!destination) return null
    // Local paths can retain source fragments containing Markdown punctuation.
    // Keep those decoded URL bytes inside the destination, including ampersands
    // that would otherwise become a different character-reference value.
    const escaped = replacement.replace(/[\\&()<>]/g, '\\$&').replace(/[\t\n\r ]/g, character => encodeURIComponent(character))
    return { start: start + destination.start.offset, end: start + destination.end.offset, replacement: escaped }
  }).filter((edit): edit is { start: number; end: number; replacement: string } => edit !== null).sort((a, b) => b.start - a.start)
  for (const node of markdownNodes(body)) for (const attribute of node.attributes ?? []) {
    if (!attribute.name || !['src', 'poster', 'href', 'srcSet', 'srcset', 'img', 'primaryHref', 'secondaryHref'].includes(attribute.name) || !attribute.position) continue
    let value = attribute.value
    if (typeof value !== 'string') {
      try { value = JSON.parse(value?.value ?? '') as string } catch { continue }
    }
    if (typeof value !== 'string') continue
    let replacement: string
    if (/^srcset$/i.test(attribute.name)) {
      const candidates = migrationImageCandidates(value, new URL('https://migration.invalid'), false)
      replacement = renderMigrationSrcset(candidates.map((candidate) => ({ ...candidate, url: rewrite(candidate.url) })))
      if (replacement === renderMigrationSrcset(candidates)) continue
    } else { replacement = rewrite(value); if (replacement === value) continue }
    const start = attribute.position.start.offset, end = attribute.position.end.offset
    if (start === undefined || end === undefined) continue
    edits.push({ start, end, replacement: `${attribute.name}="${migrationImageAttribute(replacement)}"` })
  }
  edits.sort((a, b) => b.start - a.start)
  for (const edit of edits) body = body.slice(0, edit.start) + edit.replacement + body.slice(edit.end)
  return body
}
