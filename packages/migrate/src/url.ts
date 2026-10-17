/**
 * Public URL adapter for the shared migration engine. Discovery prefers
 * machine-readable Markdown and sitemaps, remains scoped to the submitted docs
 * path, then falls back to bounded navigation crawling and HTML extraction.
 */

import { load } from 'cheerio'
import remarkMdx from 'remark-mdx'
import remarkParse from 'remark-parse'
import TurndownService from 'turndown'
import { unified } from 'unified'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'

import { projectMintlifyIntegrations } from './analytics.js'
import { parseMarkdownPage } from './mdx.js'
import { addMintlifyDirectoryRedirects, buildNavigationFromPages, projectMintlifyNavigation } from './navigation.js'
import { pageIdFromReference } from './path.js'
import { migrationImageAttribute, migrationImageCandidates, migrationImageUrl, renderMigrationSrcset } from './url-images.js'
import type {
  MigrationBundle,
  MigrationFetcher,
  MigrationFetchResponse,
  MigrationNavigationGroup,
  MigrationPage,
  MigrationPlatform,
  MigrationWarning,
} from './types.js'

const DEFAULT_MAX_PAGES = 1_000
const DEFAULT_MAX_TOTAL_BYTES = 100_000_000
const MAX_DISCOVERED_URLS = 100_000
const MAX_LOCAL_RESPONSE_BYTES = 2_000_000
const MAX_SITEMAP_DOCUMENTS = 25
const PORTABLE_MDX_COMPONENTS = new Set([
  'Accordion', 'AccordionGroup', 'Badge', 'Callout', 'Card', 'CardGroup',
  'Check', 'CodeBlock', 'CodeGroup', 'Color', 'Column', 'Columns', 'ContentPanel', 'Danger', 'Error', 'Expandable',
  'Agent', 'AgentPrompt', 'Banner', 'BannerPreview', 'Embed', 'File', 'Folder', 'Frame', 'GitHub', 'Github', 'Hero', 'Human',
  'Icon', 'Info', 'InlinePanel', 'InlineRequestExample', 'InlineResponseExample',
  'Latex', 'LegacyView', 'LiteYouTubeEmbed', 'MDX', 'Mermaid', 'Note', 'Panel', 'ParamField', 'Prompt',
  'PromptAssistant', 'PromptUser',
  'RequestExample', 'ResponseExample', 'ResponseField', 'Step', 'Steps',
  'Tab', 'Tabs', 'Terminal', 'TerminalInput', 'TerminalOutput', 'Tile', 'TileGroup',
  'Tip', 'Tooltip', 'Tree', 'Update', 'Video', 'View', 'Visibility', 'Warning', 'YouTube',
  'picture', 'source',
])
const LOCALE_CODES = new Set([
  'ar', 'cs', 'da', 'de', 'el', 'es', 'fi', 'fr', 'he', 'hi', 'hu', 'id',
  'it', 'ja', 'ko', 'ms', 'nl', 'no', 'pl', 'pt', 'ro', 'ru', 'sk', 'sv',
  'th', 'tr', 'uk', 'vi', 'zh', 'pt-br', 'zh-hans', 'zh-hant',
])
const PORTABLE_URL_PROPS = 'href|src|img|primaryHref|secondaryHref'
const PORTABLE_URL_PROP_NAMES = new Set(PORTABLE_URL_PROPS.split('|'))
// Recognize observed theme controls by exact labels; unknown/local custom
// controls remain available for explicit review instead of being guessed away.
const MINTLIFY_ARTICLE_LABELS = [
  { baseUrl: 'Select base URL', permalink: 'Navigate to header' },
  { baseUrl: '选择基础URL', permalink: '导航到标题' },
]
const remoteMarkdownParser = unified().use(remarkParse).use(remarkMdx)
// Operation metadata is data inside Markdown fences, even when surrounding
// publisher prose is not portable MDX. Never compile that surrounding prose.
const embeddedOpenApiParser = unified().use(remarkParse)

interface RemoteMarkdownAttributeValue {
  type: string
  value: string
}

interface RemoteMarkdownAttribute {
  type: string
  name?: string
  value?: string | null | RemoteMarkdownAttributeValue
}

interface RemoteMarkdownNode {
  type: string
  name?: string
  alt?: string | null
  attributes?: Array<RemoteMarkdownAttribute>
  identifier?: string
  url?: string
  value?: string
  lang?: string | null
  meta?: string | null
  children?: Array<RemoteMarkdownNode>
  position?: {
    start: { offset?: number }
    end: { offset?: number }
  }
}

/** One declared operation and its complete publisher-provided schema context. */
export interface EmbeddedOpenApiFragment {
  method: string
  path: string
  document: Record<string, unknown>
}

export interface UrlMigrationOptions {
  sourceUrl: string
  /** Explicit caller selection; omitted callers retain source auto-detection. */
  platform?: MigrationPlatform
  fetcher?: MigrationFetcher
  maxPages?: number
  concurrency?: number
  maxTotalBytes?: number
}

/** Validate the transport-level shape of a docs URL; hosted callers add SSRF checks. */
export function validateMigrationUrl(value: string): URL {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('Enter a complete documentation URL, including https://.')
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('Documentation imports support only HTTP and HTTPS URLs.')
  }
  if (url.username || url.password) throw new Error('Documentation URLs cannot contain credentials.')
  url.hash = ''
  return url
}

async function readResponseBody(response: Response): Promise<string> {
  const contentLength = Number(response.headers.get('content-length') ?? 0)
  if (contentLength > MAX_LOCAL_RESPONSE_BYTES) throw new Error('A documentation response exceeded the 2 MB import limit.')
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks: Array<Uint8Array> = []
  let size = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > MAX_LOCAL_RESPONSE_BYTES) {
      await reader.cancel()
      throw new Error('A documentation response exceeded the 2 MB import limit.')
    }
    chunks.push(value)
  }
  const body = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(body)
}

/** Fetch implementation for local CLI usage. Cloud injects its pinned network boundary. */
export const defaultMigrationFetcher: MigrationFetcher = async (url, request) => {
  const response = await fetch(url, {
    headers: {
      Accept: request.accept,
      'User-Agent': 'Thally-Migrate/1.0 (+https://thally.io)',
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok) throw new Error(`Documentation server returned ${response.status}.`)
  return {
    finalUrl: new URL(response.url),
    body: await readResponseBody(response),
    contentType: response.headers.get('content-type') ?? '',
    headers: Object.fromEntries(response.headers.entries()),
  }
}

function docsScopePath(source: URL): string {
  const path = source.pathname.replace(/\/+$/, '') || '/'
  if (path === '/') return '/'
  const segments = path.split('/').filter(Boolean)
  return `/${segments.length > 1 ? segments[0] : segments.join('/')}`
}

function machineIndexScopePath(
  source: URL,
  documents: Array<MigrationFetchResponse | null>,
): string | null {
  const candidates = new Set<string>()
  for (const document of documents) {
    if (!document) continue
    const references = [...headerLinks(document)]
    if (/html/i.test(document.contentType)) {
      const $ = load(document.body)
      references.push(...$('link[href], a[href]')
        .map((_index, element) => $(element).attr('href') ?? '')
        .get()
        .filter((href) => /\/(?:llms(?:-full)?\.txt|sitemap\.xml)(?:[?#]|$)/i.test(href)))
    }
    for (const reference of references) {
      try {
        const indexUrl = new URL(reference, document.finalUrl)
        if (indexUrl.origin !== source.origin) continue
        const scope = indexUrl.pathname.replace(/\/(?:llms(?:-full)?\.txt|sitemap\.xml)$/i, '') || '/'
        if (isInScope(source, source, scope)) candidates.add(scope)
      } catch {
        // Malformed discovery hints are ignored just like malformed page links.
      }
    }
  }
  return [...candidates].sort((left, right) => right.length - left.length)[0] ?? null
}

function isInScope(url: URL, source: URL, scopePath: string): boolean {
  if (url.origin !== source.origin || !['http:', 'https:'].includes(url.protocol)) return false
  const path = url.pathname.replace(/\/+$/, '') || '/'
  if (scopePath === '/') return true
  return path === scopePath || path === `${scopePath}.md` || path.startsWith(`${scopePath}/`)
}

function normalizeCandidate(value: string, base: URL, source: URL, scopePath: string): URL | null {
  try {
    const url = new URL(value, base)
    url.hash = ''
    if (!isInScope(url, source, scopePath)) return null
    if (url.pathname.startsWith('/cdn-cgi/')) return null
    if (/\/(?:llms(?:-full)?|robots)\.txt$/i.test(url.pathname)
      || /\/sitemap\.xml$/i.test(url.pathname)) return null
    if (/\.(?:avif|bmp|gif|ico|jpe?g|mp[34]|pdf|png|svg|ya?ml|webm|webp|zip)$/i.test(url.pathname)
      || /\/(?:openapi|swagger|asyncapi)[^/]*\.json$/i.test(url.pathname)) return null
    return url
  } catch {
    return null
  }
}

function candidateIdentity(url: URL): string {
  const pathname = url.pathname.replace(/\.mdx?$/i, '').replace(/\/+$/, '') || '/'
  return `${url.origin}${pathname}${url.search}`
}

function pageIdForUrl(url: URL, scopePath: string): string | null {
  let path = url.pathname.replace(/\/+$/, '')
  if (scopePath !== '/') {
    if (path === `${scopePath}.md`) path = ''
    else if (path === scopePath) path = ''
    else if (path.startsWith(`${scopePath}/`)) path = path.slice(scopePath.length + 1)
  }
  return pageIdFromReference(path.replace(/^\/+/, '') || 'introduction', true)
}

function canonicalLocalizedPageId(id: string): string {
  const [segment, ...rest] = id.split('/')
  if (LOCALE_CODES.has(segment)) return rest.length > 0 ? id : `${segment}/introduction`
  for (const locale of LOCALE_CODES) {
    if (segment !== `${locale}-api-reference`) continue
    return [locale, 'api-reference', ...rest].join('/')
  }
  return id
}

function detectUrlPlatform(document: MigrationFetchResponse): MigrationPlatform {
  const headers = Object.entries(document.headers ?? {})
    .map(([key, value]) => `${key}:${value ?? ''}`)
    .join(' ')
  const value = `${document.body.slice(0, 200_000)} ${headers}`.toLowerCase()
  if (value.includes('__mintlify') || value.includes('/mintlify-assets/')
    || value.includes('x-mintlify-') || value.includes('/_mintlify/')) return 'mintlify'
  if (value.includes('docusaurus') || value.includes('__docusaurus')) return 'docusaurus'
  if (value.includes('gitbook')) return 'gitbook'
  if (value.includes('nextra')) return 'nextra'
  if (value.includes('vitepress')) return 'vitepress'
  if (value.includes('starlight')) return 'starlight'
  return 'generic'
}

function jsonObjectAfterKey(value: string, key: string): Record<string, unknown> | null {
  let cursor = 0
  const marker = `"${key}":`
  while (cursor < value.length) {
    const markerIndex = value.indexOf(marker, cursor)
    if (markerIndex < 0) return null
    let start = markerIndex + marker.length
    while (/\s/.test(value[start] ?? '')) start += 1
    if (value[start] !== '{') {
      cursor = start + 1
      continue
    }
    let depth = 0
    let isQuoted = false
    let isEscaped = false
    for (let index = start; index < value.length; index += 1) {
      const character = value[index]
      if (isQuoted) {
        if (isEscaped) isEscaped = false
        else if (character === '\\') isEscaped = true
        else if (character === '"') isQuoted = false
        continue
      }
      if (character === '"') {
        isQuoted = true
        continue
      }
      if (character === '{') depth += 1
      if (character === '}') {
        depth -= 1
        if (depth !== 0) continue
        try {
          const parsed = JSON.parse(value.slice(start, index + 1)) as unknown
          return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? parsed as Record<string, unknown>
            : null
        } catch {
          break
        }
      }
    }
    cursor = start + 1
  }
  return null
}

/**
 * Current Mintlify themes embed the resolved docs config and scoped navigation
 * in React Flight. Reading that data is substantially more faithful than
 * inferring information architecture from whichever responsive nav is visible.
 */
function embeddedMintlifyConfig(body: string): Record<string, unknown> | null {
  const $ = load(body)
  const flightPayloads: Array<string> = []
  $('script').each((_index, element) => {
    const script = $(element).text()
    for (const match of script.matchAll(/self\.__next_f\.push\(\[1,("(?:\\.|[^"\\])*")\]\)/g)) {
      try {
        const payload = JSON.parse(match[1])
        if (typeof payload === 'string') flightPayloads.push(payload)
      } catch {
        // Older or customized shells fall back to bounded DOM inference.
      }
    }
  })
  if (flightPayloads.length === 0) return null
  const payload = flightPayloads.join('\n')
  const docsConfig = jsonObjectAfterKey(payload, 'docsConfig')
  const scopedNavigation = jsonObjectAfterKey(payload, 'scopedNav')
  if (!docsConfig && !scopedNavigation) return null
  return {
    ...(docsConfig ?? {}),
    ...(scopedNavigation ? { navigation: scopedNavigation } : {}),
  }
}

function plainDescription(value: string): string {
  return value
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[`*_>#-]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240)
}

function withoutFencedCode(body: string): string {
  let fenceCharacter = ''
  let fenceLength = 0
  return body.split('\n').map((line) => {
    const match = line.match(/^\s{0,3}(`{3,}|~{3,})(.*)$/)
    if (match && !fenceCharacter) {
      fenceCharacter = match[1][0]
      fenceLength = match[1].length
      return ''
    }
    if (match && match[1][0] === fenceCharacter && match[1].length >= fenceLength
      && match[2].trim() === '') {
      fenceCharacter = ''
      fenceLength = 0
      return ''
    }
    return fenceCharacter ? '' : line
  }).join('\n')
}

function eventHandlerPropEnd(value: string, start: number): number | null {
  const opening = value[start]
  if (opening === '"' || opening === "'") {
    for (let index = start + 1; index < value.length; index += 1) {
      if (value[index] === opening && value[index - 1] !== '\\') return index + 1
    }
    return null
  }
  if (opening !== '{') {
    const match = value.slice(start).match(/^[^\s>]+/)
    return match ? start + match[0].length : null
  }
  let depth = 0
  let quote = ''
  for (let index = start; index < value.length; index += 1) {
    const character = value[index]
    if (quote) {
      if (character === quote && value[index - 1] !== '\\') quote = ''
      continue
    }
    if (character === '"' || character === "'" || character === '`') {
      quote = character
      continue
    }
    if (character === '{') depth += 1
    if (character === '}') {
      depth -= 1
      if (depth === 0) return index + 1
    }
  }
  return null
}

function stripEventHandlerProps(line: string): string {
  const matcher = /\s+on[A-Z][A-Za-z0-9]*\s*=\s*/g
  let cursor = 0
  let result = ''
  for (const match of line.matchAll(matcher)) {
    const start = match.index
    const valueStart = start + match[0].length
    const end = eventHandlerPropEnd(line, valueStart)
    if (end === null) continue
    result += line.slice(cursor, start)
    cursor = end
  }
  return cursor === 0 ? line : `${result}${line.slice(cursor)}`
}

function isSafePortableUrl(value: string): boolean {
  try {
    const parsed = new URL(value, 'https://relative.thally.invalid')
    return ['http:', 'https:', 'mailto:', 'tel:'].includes(parsed.protocol)
  } catch {
    return false
  }
}

function decodeHtmlAttribute(value: string): string {
  const document = load(`<i data-thally-value="${value.replace(/"/g, '&quot;')}"></i>`)
  return document('i').attr('data-thally-value') ?? ''
}

/** Escape imported copy for Markdown text and MDX's additional delimiters. */
function escapeMarkdownText(value: string, escapeTableSeparator = false): string {
  let escaped = ''
  for (const character of value) {
    if (character === '\\') escaped += '\\\\'
    else if (character === '[' || character === ']') escaped += `\\${character}`
    else if (character === '<') escaped += '&lt;'
    else if (character === '>') escaped += '&gt;'
    else if (character === '{') escaped += '&#123;'
    else if (character === '}') escaped += '&#125;'
    else if (character === '|' && escapeTableSeparator) escaped += '\\|'
    else escaped += character
  }
  return escaped
}

/** Keep Turndown's existing Markdown escapes while protecting GFM delimiters. */
function portableMarkdownTableCell(value: string): string {
  let output = ''
  let hasOddBackslashes = false
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]
    if (character === '\\') {
      output += character
      hasOddBackslashes = !hasOddBackslashes
      continue
    }
    if (character === '|' && !hasOddBackslashes) output += '\\'
    if (character === '\r' || character === '\n') {
      output += ' '
      if (character === '\r' && value[index + 1] === '\n') index += 1
    } else output += character
    hasOddBackslashes = false
  }
  return output.trim()
}

/** GFM code spans cannot preserve an odd literal backslash run before a pipe. */
function needsLiteralTableCode(value: string): boolean {
  let hasOddBackslashes = false
  for (const character of value) {
    if (character === '\\') hasOddBackslashes = !hasOddBackslashes
    else {
      if (character === '|' && hasOddBackslashes) return true
      hasOddBackslashes = false
    }
  }
  return false
}

/** Encode syntax as character references so a literal inline code leaf stays data. */
function literalMdxCodeText(value: string): string {
  let output = ''
  for (const character of value) {
    output += /[A-Za-z0-9 ]/.test(character) ? character : `&#${character.codePointAt(0)!};`
  }
  return output
}

function markdownLinkDestination(value: string): string | null {
  try {
    return encodeURI(value)
      .replace(/\(/g, '%28')
      .replace(/\)/g, '%29')
      .replace(/&/g, '&amp;')
  } catch {
    return null
  }
}

function htmlOpeningTagEnd(value: string, start: number): number | null {
  let quote = ''
  for (let index = start; index < value.length; index += 1) {
    const character = value[index]
    if (quote) {
      if (character === quote) quote = ''
      continue
    }
    if (character === '"' || character === "'") {
      quote = character
      continue
    }
    if (character === '>') return index + 1
  }
  return null
}

function replacePortableHtmlImages(value: string): string {
  const matcher = /<img\b/gi
  let cursor = 0
  let output = ''
  for (const match of value.matchAll(matcher)) {
    const start = match.index
    if (start < cursor) continue
    const end = htmlOpeningTagEnd(value, start + match[0].length)
    if (end === null) continue
    const fragment = load(value.slice(start, end))
    const image = fragment('img').first()
    const source = image.attr('src')
    const destination = source && isSafePortableUrl(source) ? markdownLinkDestination(source) : null
    const alternative = escapeMarkdownText(image.attr('alt') ?? '')
    output += value.slice(cursor, start)
    output += destination ? `![${alternative}](${destination})` : alternative
    cursor = end
  }
  return cursor === 0 ? value : `${output}${value.slice(cursor)}`
}

function replacePortableHtmlAnchors(value: string): string {
  const matcher = /<a\b/gi
  let cursor = 0
  let output = ''
  for (const match of value.matchAll(matcher)) {
    const start = match.index
    if (start < cursor) continue
    const openingEnd = htmlOpeningTagEnd(value, start + match[0].length)
    if (openingEnd === null) continue
    const closingMatch = /<\/a\s*>/gi
    closingMatch.lastIndex = openingEnd
    const closing = closingMatch.exec(value)
    if (!closing) continue
    const end = closing.index + closing[0].length
    const fragment = load(value.slice(start, end))
    const anchor = fragment('a').first()
    const href = anchor.attr('href')
    const label = escapeMarkdownText(anchor.text().replace(/\s+/g, ' ').trim())
    const destination = href && isSafePortableUrl(href) ? markdownLinkDestination(href) : null
    output += value.slice(cursor, start)
    output += destination ? `[${label}](${destination})` : label
    cursor = end
  }
  return cursor === 0 ? value : `${output}${value.slice(cursor)}`
}

function markdownNodeText(node: RemoteMarkdownNode): string {
  if (node.type === 'text' || node.type === 'inlineCode') return node.value ?? ''
  if (node.type === 'image' || node.type === 'imageReference') return node.alt ?? ''
  return (node.children ?? []).map(markdownNodeText).join('')
}

/**
 * Remove unsafe Markdown links using the actual Markdown/MDX parse tree. This
 * catches entity-encoded schemes and balanced destinations that regexes cannot
 * classify reliably, while leaving code fences and ordinary prose untouched.
 */
function sanitizeMarkdownUrls(value: string): string | null {
  let root: RemoteMarkdownNode
  try {
    root = remoteMarkdownParser.parse(value) as RemoteMarkdownNode
  } catch {
    return null
  }

  let hasUnsafeMdxSyntax = false
  const validateMdxSyntax = (node: RemoteMarkdownNode) => {
    if (node.type === 'mdxTextExpression'
      || node.type === 'mdxFlowExpression'
      || node.type === 'mdxjsEsm') {
      hasUnsafeMdxSyntax = true
      return
    }
    if (node.type === 'mdxJsxTextElement' || node.type === 'mdxJsxFlowElement') {
      // Validate actual JSX nodes, not tag-shaped prose: Markdown escapes such
      // as `enum\<string>` are inert text, while member components still need
      // rejection even when their first segment names a portable primitive.
      const isLiteralCode = node.type === 'mdxJsxTextElement' && node.name === 'code'
        && !node.attributes?.length && (node.children ?? []).every((child) => child.type === 'text')
      if (!isLiteralCode && (!node.name || !PORTABLE_MDX_COMPONENTS.has(node.name))) {
        hasUnsafeMdxSyntax = true
        return
      }
      for (const attribute of node.attributes ?? []) {
        if (attribute.type !== 'mdxJsxAttribute' || !attribute.name
          || /^on[A-Z]/.test(attribute.name)) {
          hasUnsafeMdxSyntax = true
          return
        }
        let staticValue: unknown = attribute.value
        if (attribute.value && typeof attribute.value === 'object') {
          if (attribute.value.type !== 'mdxJsxAttributeValueExpression') {
            hasUnsafeMdxSyntax = true
            return
          }
          try {
            staticValue = JSON.parse(attribute.value.value)
          } catch {
            hasUnsafeMdxSyntax = true
            return
          }
        }
        if (PORTABLE_URL_PROP_NAMES.has(attribute.name)
          && (typeof staticValue !== 'string'
            || !isSafePortableUrl(decodeHtmlAttribute(staticValue)))) {
          hasUnsafeMdxSyntax = true
          return
        }
        if (node.name === 'source' || node.name === 'picture') {
          const allowed = node.name === 'picture' ? [] : ['src', 'srcSet', 'srcset', 'sizes', 'media', 'type', 'width', 'height', 'id']
          if (!allowed.includes(attribute.name) || typeof attribute.value !== 'string') {
            hasUnsafeMdxSyntax = true
            return
          }
          try {
            if (/^srcset$/i.test(attribute.name)) migrationImageCandidates(decodeHtmlAttribute(attribute.value), new URL('https://migration.invalid'))
            if (attribute.name === 'src') migrationImageUrl(decodeHtmlAttribute(attribute.value), new URL('https://migration.invalid'))
          } catch { hasUnsafeMdxSyntax = true; return }
        }
      }
    }
    for (const child of node.children ?? []) validateMdxSyntax(child)
  }
  validateMdxSyntax(root)
  if (hasUnsafeMdxSyntax) return null

  const unsafeDefinitions = new Set<string>()
  const visitDefinitions = (node: RemoteMarkdownNode) => {
    if (node.type === 'definition' && node.identifier && node.url
      && !isSafePortableUrl(node.url)) unsafeDefinitions.add(node.identifier.toLowerCase())
    for (const child of node.children ?? []) visitDefinitions(child)
  }
  visitDefinitions(root)

  const replacements: Array<{ start: number; end: number; value: string }> = []
  const replaceNode = (node: RemoteMarkdownNode, replacement: string): boolean => {
    const start = node.position?.start.offset
    const end = node.position?.end.offset
    if (start === undefined || end === undefined) return false
    replacements.push({ start, end, value: replacement })
    return true
  }
  const visitUrls = (node: RemoteMarkdownNode) => {
    const hasUnsafeDirectUrl = (node.type === 'link' || node.type === 'image')
      && typeof node.url === 'string'
      && !isSafePortableUrl(node.url)
    const hasUnsafeReference = (node.type === 'linkReference' || node.type === 'imageReference')
      && typeof node.identifier === 'string'
      && unsafeDefinitions.has(node.identifier.toLowerCase())
    if (hasUnsafeDirectUrl || hasUnsafeReference) {
      if (replaceNode(node, escapeMarkdownText(markdownNodeText(node)))) return
    }
    if (node.type === 'definition' && node.identifier
      && unsafeDefinitions.has(node.identifier.toLowerCase())) {
      if (replaceNode(node, '')) return
    }
    for (const child of node.children ?? []) visitUrls(child)
  }
  visitUrls(root)

  return replacements
    .sort((left, right) => right.start - left.start)
    .reduce((result, replacement) => (
      `${result.slice(0, replacement.start)}${replacement.value}${result.slice(replacement.end)}`
    ), value)
}

function hasUnsafePortableUrlProp(value: string): boolean {
  const quotedProps = new RegExp(`\\b(?:${PORTABLE_URL_PROPS})\\s*=\\s*(['"])([^'"\\r\\n]*)\\1`, 'gi')
  for (const match of value.matchAll(quotedProps)) {
    if (!isSafePortableUrl(decodeHtmlAttribute(match[2]))) return true
  }
  const expressionProps = new RegExp(`\\b(?:${PORTABLE_URL_PROPS})\\s*=\\s*\\{\\s*("(?:\\\\.|[^"\\\\])*")\\s*\\}`, 'gi')
  for (const match of value.matchAll(expressionProps)) {
    try {
      if (!isSafePortableUrl(decodeHtmlAttribute(JSON.parse(match[1])))) return true
    } catch {
      return true
    }
  }
  return false
}

function portableHtmlToMarkdown(value: string): string {
  return replacePortableHtmlAnchors(replacePortableHtmlImages(value))
    .replace(/<span\b[^>]*>|<\/span>/gi, '')
    .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_original, level: string, content: string) => {
      return `\n${'#'.repeat(Number(level))} ${content.trim()}\n`
    })
    .replace(/<p\b[^>]*>([\s\S]*?)<\/p>/gi, (_original, content: string) => `\n${content.trim()}\n`)
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<\/?(?:article|div|main|section)\b[^>]*>/gi, '')
}

function transformMarkdownProse(body: string, transform: (value: string) => string): string {
  const output: Array<string> = []
  let prose: Array<string> = []
  let fenceCharacter = ''
  let fenceLength = 0
  const flushProse = () => {
    if (prose.length === 0) return
    output.push(transform(prose.join('\n')))
    prose = []
  }
  for (const line of body.split('\n')) {
    const fence = line.match(/^\s{0,3}(`{3,}|~{3,})(.*)$/)
    if (fence && !fenceCharacter) {
      flushProse()
      fenceCharacter = fence[1][0]
      fenceLength = fence[1].length
      output.push(line)
      continue
    }
    if (fenceCharacter) {
      output.push(line)
      if (fence && fence[1][0] === fenceCharacter && fence[1].length >= fenceLength
        && fence[2].trim() === '') {
        fenceCharacter = ''
        fenceLength = 0
      }
      continue
    }
    prose.push(line)
  }
  flushProse()
  return output.join('\n')
}

/** Normalize inert public Markdown; return null when execution cannot be excluded. */
export function sanitizeRemoteMarkdown(body: string): string | null {
  let fenceCharacter = ''
  let fenceLength = 0
  const portableBody = transformMarkdownProse(body, portableHtmlToMarkdown)
  const sanitized = portableBody.split('\n').map((line) => {
    const fence = line.match(/^\s{0,3}(`{3,}|~{3,})(.*)$/)
    if (fence && !fenceCharacter) {
      fenceCharacter = fence[1][0]
      fenceLength = fence[1].length
      return line
    }
    if (fence && fence[1][0] === fenceCharacter && fence[1].length >= fenceLength
      && fence[2].trim() === '') {
      fenceCharacter = ''
      fenceLength = 0
      return line
    }
    if (fenceCharacter) return line
    return portableHtmlToMarkdown(stripEventHandlerProps(line
      // Remove obviously unsafe image destinations before MDX parsing. A data
      // URL can itself contain raw `<svg ...>` syntax that makes an otherwise
      // removable Markdown image fail the MDX grammar before the AST exists.
      .replace(/!\[([^\]]*)\]\(\s*([^)]+)\)/g, (original, alternative: string, destination: string) => (
        isSafePortableUrl(decodeHtmlAttribute(destination.replace(/^<|>$/g, '')))
          ? original
          : escapeMarkdownText(alternative)
      ))))
  }).join('\n')
  const urlSafeMarkdown = sanitizeMarkdownUrls(sanitized)
  if (urlSafeMarkdown === null) return null
  const executable = withoutFencedCode(urlSafeMarkdown)
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/<(?:https?:\/\/|mailto:)[^>]+>/gi, '')
    .replace(/(`+)[\s\S]*?\1/g, '')
  if (/^\s*(?:import|export)\s/m.test(executable)) return null
  // A public Markdown endpoint is still attacker-controlled MDX. Preserve
  // known documentation primitives and JSON-literal props, but never compile
  // executable expressions, raw HTML, event handlers, or local components.
  let hasUnsafeExpression = false
  const withoutStaticProps = executable.replace(/=\{([^{}\n]*)\}/g, (original, value: string) => {
    try {
      JSON.parse(value)
      return '=""'
    } catch {
      hasUnsafeExpression = true
      return original
    }
  }).replace(/\\[{}]/g, '')
  if (hasUnsafeExpression || /[{}]/.test(withoutStaticProps)
    || /\bon[A-Z][A-Za-z]*\s*=/g.test(withoutStaticProps)
    || hasUnsafePortableUrlProp(executable)) return null
  return urlSafeMarkdown
}

function migratedHref(
  href: string,
  currentUrl: URL,
  source: URL,
  scopePath: string,
  importedIds: Set<string>,
  sourceHomePageId?: string,
): string {
  if (/^(?:javascript|data|vbscript):/i.test(href)) return '#'
  if (href.startsWith('#') || /^(?:mailto|tel):/i.test(href)) return href
  try {
    const target = new URL(href, currentUrl)
    if (target.origin !== source.origin) return href
    if (scopePath === '/' && candidateIdentity(target) === candidateIdentity(source)) {
      return `/${target.search}${target.hash}`
    }
    let path = target.pathname
    if (scopePath !== '/' && (path === scopePath || path.startsWith(`${scopePath}/`))) {
      path = path.slice(scopePath.length)
    }
    const id = pageIdFromReference(path.replace(/^\/+/, '') || 'introduction')
    const localizedId = id ? canonicalLocalizedPageId(id) : id
    const destinationId = localizedId === sourceHomePageId ? 'introduction' : localizedId
    let importedDestinationId = destinationId && importedIds.has(destinationId)
      ? destinationId
      : undefined
    if (destinationId && !importedDestinationId) {
      importedDestinationId = [`${destinationId}/overview`, `${destinationId}/introduction`]
        .find((candidate) => importedIds.has(candidate))
        ?? [...importedIds].find((candidate) => candidate.startsWith(`${destinationId}/`))
    }
    if (importedDestinationId) {
      const destination = importedDestinationId === 'introduction' ? '/' : `/${importedDestinationId}`
      return `${destination}${target.search}${target.hash}`
    }
    // Same-origin marketing and intentionally missing example links remain
    // valid external URLs instead of becoming broken links in the new site.
    return target.toString()
  } catch {
    return href
  }
}

function rewriteInternalLinks(
  body: string,
  currentUrl: URL,
  source: URL,
  scopePath: string,
  importedIds: Set<string>,
  sourceHomePageId?: string,
): string {
  const markdown = body.replace(/(?<!!)\[([^\]]+)\]\(([^)\s]+)(\s+['"][^'"]*['"])?\)/g, (
    original,
    label: string,
    href: string,
    title = '',
  ) => {
    const destination = migratedHref(href, currentUrl, source, scopePath, importedIds, sourceHomePageId)
    return destination === href ? original : `[${label}](${destination}${title})`
  })
  return markdown.replace(/\bhref=(['"])([^'"]+)\1/g, (_original, quote: string, href: string) => {
    const destination = migratedHref(href, currentUrl, source, scopePath, importedIds, sourceHomePageId)
    return `href=${quote}${destination}${quote}`
  })
}

function remoteMarkdownMetadata(body: string): {
  content: string
  title?: string
  description?: string
  sidebarTitle?: string
  tag?: string
  mode?: string
  hidden?: boolean
  noindex?: boolean
} {
  if (!/^---\r?\n/.test(body)) return { content: body }
  const end = body.slice(4, 65_540).search(/\r?\n---(?:\r?\n|$)/)
  if (end < 0) return { content: body }
  const frontmatter = body.slice(4, end + 4)
  const contentStart = end + 4 + body.slice(end + 4).match(/^\r?\n---(?:\r?\n|$)/)![0].length
  function scalar(key: string): string | undefined {
    const value = frontmatter.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'))?.[1].trim()
    if (!value) return undefined
    if (/^['"].*['"]$/.test(value)) {
      try {
        const parsed = JSON.parse(value.replace(/^'/, '"').replace(/'$/, '"'))
        return typeof parsed === 'string' ? parsed : undefined
      } catch {
        return value.slice(1, -1)
      }
    }
    return value.slice(0, 500)
  }
  return {
    content: body.slice(contentStart),
    title: scalar('title'),
    description: scalar('description'),
    sidebarTitle: scalar('sidebarTitle'),
    tag: scalar('tag'),
    mode: scalar('mode'),
    hidden: scalar('hidden') === 'true' ? true : undefined,
    noindex: scalar('noindex') === 'true' ? true : undefined,
  }
}

function stripMintlifyDocumentationIndex(body: string): string {
  const lines = body.split(/\r?\n/)
  if (!/^>\s*##\s+Documentation Index\s*$/i.test(lines[0] ?? '')
    || !/^>.*\/llms(?:-full)?\.txt/i.test(lines[1] ?? '')
    || !/^>.*discover all available pages/i.test(lines[2] ?? '')) return body
  let index = 3
  while (index < lines.length && /^>/.test(lines[index])) index += 1
  while (index < lines.length && lines[index].trim() === '') index += 1
  return lines.slice(index).join('\n')
}

/**
 * Extract one unambiguous publisher-declared operation from a bounded literal
 * code fence. Optional source filenames are metadata only: callers choose local
 * asset names and never fetch or write the publisher's filename.
 */
export function extractEmbeddedOpenApi(content: string): {
  content: string
  openapi?: string
  fragment?: EmbeddedOpenApiFragment
} {
  if (Buffer.byteLength(content, 'utf8') > MAX_LOCAL_RESPONSE_BYTES) return { content }
  try {
    const root = embeddedOpenApiParser.parse(content) as RemoteMarkdownNode
    const candidates = (root.children ?? []).flatMap((node) => {
      if (node.type !== 'code' || !/^(?:yaml|yml|json)$/i.test(node.lang ?? '')) return []
      const metadata = node.meta?.match(/^(?:(\S+\.(?:yaml|yml|json))\s+)?(delete|get|head|options|patch|post|put|trace)\s+(\/\S+)\s*$/i)
      return metadata ? [{ node, method: metadata[2].toUpperCase(), path: metadata[3] }] : []
    })
    if (candidates.length !== 1) return { content }
    const { node, method, path } = candidates[0]
    const start = node.position?.start.offset
    const end = node.position?.end.offset
    if (start === undefined || end === undefined) return { content }
    const lines = content.slice(start, end).split(/\r?\n/)
    const opening = lines[0].match(/^ {0,3}(`{3,}|~{3,})/)
    const closing = lines.at(-1)?.match(/^ {0,3}(`{3,}|~{3,})[\t ]*$/)
    if (!opening || !closing || opening[1][0] !== closing[1][0]
      || closing[1].length < opening[1].length) return { content }
    const parsed = parseYaml(node.value ?? '', { maxAliasCount: 50 })
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { content }
    const document = parsed as Record<string, unknown>
    if (typeof document.openapi !== 'string' && typeof document.swagger !== 'string') return { content }
    const paths = document.paths
    if (!paths || typeof paths !== 'object' || Array.isArray(paths)) return { content }
    if (!Object.prototype.hasOwnProperty.call(paths, path)) return { content }
    const pathItem = (paths as Record<string, unknown>)[path]
    if (!pathItem || typeof pathItem !== 'object' || Array.isArray(pathItem)
      || !Object.prototype.hasOwnProperty.call(pathItem, method.toLowerCase())) return { content }
    const operation = (pathItem as Record<string, unknown>)[method.toLowerCase()]
    if (!operation || typeof operation !== 'object' || Array.isArray(operation)) return { content }
    // Recovery emits a local JSON/YAML asset. Reject cyclic alias graphs and
    // bound expansion before callers serialize a remotely supplied document.
    let values = 0
    let textLength = 0
    const serialized = JSON.stringify(document, (_key, value: unknown) => {
      values += 1
      if (typeof value === 'string') textLength += value.length
      if (values > 100_000 || textLength > MAX_LOCAL_RESPONSE_BYTES
        || (typeof value === 'number' && !Number.isFinite(value))) throw new Error('OpenAPI document exceeds portable data limits.')
      return value
    })
    if (Buffer.byteLength(serialized, 'utf8') > MAX_LOCAL_RESPONSE_BYTES) return { content }
    const before = content.slice(0, start).replace(/(?:^|\n)##\s+OpenAPI\s*\n\s*$/i, '\n')
    const after = content.slice(end)
    return {
      content: `${before}${after}`.trim(),
      openapi: `${method} ${path}`,
      fragment: {
        method,
        path,
        document,
      },
    }
  } catch {
    return { content }
  }
}

/** Convert an already sanitized Markdown response through the shared representation. */
export function markdownPage(document: MigrationFetchResponse, id: string, platform: MigrationPlatform, warn?: (message: string) => void): {
  page: MigrationPage | null
  openApiFragment?: EmbeddedOpenApiFragment
} {
  const parsed = remoteMarkdownMetadata(document.body)
  let content = stripMintlifyDocumentationIndex(parsed.content).trimStart()
  const titleMatch = content.match(/^#\s+(.+)\r?\n/)
  const title = parsed.title ?? titleMatch?.[1] ?? id.split('/').at(-1) ?? 'Introduction'
  if (titleMatch) content = content.slice(titleMatch[0].length).trimStart()
  let description = parsed.description
  if (!description) {
    const quoteMatch = content.match(/^(>[^\r\n]*(?:\r?\n>[^\r\n]*)*)\r?\n/)
    if (quoteMatch) {
      description = plainDescription(quoteMatch[1].replace(/^>\s?/gm, ''))
      content = content.slice(quoteMatch[0].length).trimStart()
    }
  }
  // Re-emit only scalar metadata we parsed ourselves. The shared YAML parser
  // handles trusted repository sources but never receives attacker-controlled
  // aliases from a public URL.
  const embeddedOpenApi = extractEmbeddedOpenApi(content)
  const raw = [
    '---',
    `title: ${JSON.stringify(title)}`,
    ...(description ? [`description: ${JSON.stringify(description)}`] : []),
    ...(parsed.sidebarTitle ? [`sidebarTitle: ${JSON.stringify(parsed.sidebarTitle)}`] : []),
    ...(parsed.tag ? [`tag: ${JSON.stringify(parsed.tag)}`] : []),
    ...(parsed.mode ? [`mode: ${JSON.stringify(parsed.mode)}`] : []),
    ...(parsed.hidden ? ['hidden: true'] : []),
    ...(parsed.noindex ? ['noindex: true'] : []),
    ...(embeddedOpenApi.openapi ? [`openapi: ${JSON.stringify(embeddedOpenApi.openapi)}`] : []),
    '---',
    '',
    embeddedOpenApi.content,
  ].join('\n')
  return {
    // The crawler knows the source platform (detected or caller-provided)
    // before it ever parses a page; an omitted platform would otherwise
    // apply every platform's textual renames to content of unknown origin.
    page: parseMarkdownPage({ id, raw, source: document.finalUrl.toString(), platform, ...(warn ? { warn } : {}) }),
    openApiFragment: embeddedOpenApi.fragment,
  }
}

function mergeRecord(target: Record<string, unknown>, source: unknown): void {
  if (!source || typeof source !== 'object' || Array.isArray(source)) return
  for (const [key, value] of Object.entries(source)) {
    if (['__proto__', 'constructor', 'prototype'].includes(key)) continue
    if (!Object.prototype.hasOwnProperty.call(target, key)) {
      target[key] = value
      continue
    }
    const current = target[key]
    if (current && value && typeof current === 'object' && typeof value === 'object'
      && !Array.isArray(current) && !Array.isArray(value)) {
      mergeRecord(current as Record<string, unknown>, value)
    }
  }
}

/** Project validated operation fragments while keeping their complete components. */
export function mergeEmbeddedOpenApi(fragments: Array<EmbeddedOpenApiFragment>): Uint8Array | null {
  const first = fragments[0]
  if (!first) return null
  const combined: Record<string, unknown> = {
    ...first.document,
    paths: {},
    components: {},
  }
  const combinedPaths = combined.paths as Record<string, unknown>
  const combinedComponents = combined.components as Record<string, unknown>
  const tags = new Map<string, unknown>()
  for (const fragment of fragments) {
    const sourcePaths = fragment.document.paths as Record<string, unknown>
    const sourcePathItem = sourcePaths?.[fragment.path]
    if (!sourcePathItem || typeof sourcePathItem !== 'object' || Array.isArray(sourcePathItem)) continue
    const sourceOperation = (sourcePathItem as Record<string, unknown>)[fragment.method.toLowerCase()]
    if (!sourceOperation || typeof sourceOperation !== 'object' || Array.isArray(sourceOperation)) continue
    const operation = { ...(sourceOperation as Record<string, unknown>) }
    if (!operation.servers && Array.isArray(fragment.document.servers)) operation.servers = fragment.document.servers
    if (!operation.security && Array.isArray(fragment.document.security)) operation.security = fragment.document.security
    const existingPath = combinedPaths[fragment.path]
    const pathItem = existingPath && typeof existingPath === 'object' && !Array.isArray(existingPath)
      ? existingPath as Record<string, unknown>
      : {}
    for (const sharedKey of ['parameters', 'servers', 'summary', 'description']) {
      const sharedValue = (sourcePathItem as Record<string, unknown>)[sharedKey]
      if (sharedValue !== undefined && pathItem[sharedKey] === undefined) pathItem[sharedKey] = sharedValue
    }
    pathItem[fragment.method.toLowerCase()] = operation
    combinedPaths[fragment.path] = pathItem
    mergeRecord(combinedComponents, fragment.document.components)
    for (const tag of Array.isArray(fragment.document.tags) ? fragment.document.tags : []) {
      if (!tag || typeof tag !== 'object' || Array.isArray(tag)) continue
      const name = (tag as Record<string, unknown>).name
      if (typeof name === 'string' && !tags.has(name)) tags.set(name, tag)
    }
  }
  if (Object.keys(combinedPaths).length === 0) return null
  if (Object.keys(combinedComponents).length === 0) delete combined.components
  if (tags.size > 0) combined.tags = [...tags.values()]
  return new TextEncoder().encode(stringifyYaml(combined))
}

/**
 * Select documentation content once for conversion and fidelity evidence.
 * Mintlify API examples can sit beside its prose column, so retain the main
 * content container and remove only known navigation/assistant chrome. Unknown
 * article controls remain visible to callers that decide whether review is
 * required; in particular, ordinary textareas are not assistant chrome.
 */
export function migrationHtmlArticle(body: string) {
  const $ = load(body)
  const root = ['main article', 'article', 'main', '[role="main"]', 'body']
    .map((selector) => $(selector).first())
    .find((candidate) => candidate.length)!
  root.find([
    'script', 'style', 'noscript', 'nav', 'footer', 'aside',
    '.theme-doc-version-badge', '.theme-doc-breadcrumbs', '.theme-doc-toc-mobile', '.table-of-contents',
    '.chat-assistant-floating-input', '.chat-assistant-sheet', '#chat-assistant-sheet', '#chat-assistant-textarea',
  ].join(',')).remove()
  const permalinkSelectors = MINTLIFY_ARTICLE_LABELS.map((labels) => `a[aria-label="${labels.permalink}"]`)
  root.find([...permalinkSelectors, 'h1 .hash-link', 'h2 .hash-link', 'h3 .hash-link', 'h4 .hash-link', 'h5 .hash-link', 'h6 .hash-link'].join(',')).each((_index, link) => {
    const parent = $(link).parent()
    $(link).remove()
    // Mintlify wraps its heading and API-parameter permalink icons in a block.
    // Leaving the empty wrapper would separate the ATX marker from its text.
    if (parent.is('div') && !parent.text().trim() && parent.children().length === 0) parent.remove()
  })
  root.find('svg.lucide-chevrons-up-down,summary[data-component-part="expandable-button"] svg[data-component-part="icon-svg"]').remove()
  root.find('li.task-list-item > input[type="checkbox"][disabled]').each((_index, element) => {
    const isChecked = $(element).attr('checked') !== undefined
    $(element).replaceWith($('<span></span>')
      .attr('data-thally-static-task-checkbox', isChecked ? 'checked' : 'unchecked')
      .text(isChecked ? '[x] ' : '[ ] '))
  })
  root.find(MINTLIFY_ARTICLE_LABELS.map((labels) => `select[aria-label="${labels.baseUrl}"]`).join(',')).each((_index, element) => {
    const select = $(element)
    const options = select.children('option').toArray()
    if (!options.length || options.length !== select.children().length) return
    const urls: Array<{ label: string; href: string; isSelected: boolean }> = []
    for (const option of options) {
      // The option's display text is the server URL; its value is often an
      // index. Only project complete literal HTTPS URLs without credentials.
      if ($(option).children().length) return
      const label = $(option).text().trim()
      if (!/^https:\/\//i.test(label) || /[\s\u0000-\u001f\u007f]/.test(label)) return
      try {
        const url = new URL(label)
        if (url.protocol !== 'https:' || url.username || url.password) return
        urls.push({ label, href: url.href, isSelected: $(option).attr('selected') !== undefined })
      } catch { return }
    }
    const projection = $('<div data-thally-static-base-urls></div>')
    const sourceId = select.attr('id')
    if (sourceId) projection.attr('id', sourceId)
    projection.append($('<p></p>').text(select.attr('aria-label')!))
    const list = $('<ul></ul>')
    for (const url of urls) {
      const item = $('<li></li>').append($('<a></a>').attr('href', url.href).text(url.label))
      if (url.isSelected) item.append(' (selected)')
      list.append(item)
    }
    projection.append(list)
    select.replaceWith(projection)
  })
  return { $, root }
}

/** Project rendered article HTML into inert content using shared conversion rules. */
export function htmlPage(
  document: MigrationFetchResponse,
  id: string,
  options: { preserveAnchors?: boolean; preserveResponsiveImages?: boolean; omitDocumentHeading?: boolean } = {},
): { page: MigrationPage | null; links: Array<string> } {
  const { $, root } = migrationHtmlArticle(document.body)
  const links = root.find('a[href]')
    .map((_index, element) => $(element).attr('href') ?? '')
    .get()
    .filter(Boolean)
  const scopedTitle = options.omitDocumentHeading
    ? root.find('h1').first().text().trim()
    : ''
  const title = scopedTitle || $('main h1, article h1, h1').first().text().trim()
    || $('meta[property="og:title"]').attr('content')?.trim()
    || $('title').text().split('|')[0].trim()
  const description = $('meta[name="description"]').attr('content')?.trim()
    || $('meta[property="og:description"]').attr('content')?.trim()
  let documentHeadingAnchor = ''
  const excludedElements = options.omitDocumentHeading
    ? 'script,style,noscript,nav,footer,aside,form,button,svg,iframe,object,embed,link,meta'
    : 'script,style,noscript,nav,header,footer,aside,form,button,svg,iframe,object,embed,link,meta'
  root.find(excludedElements).remove()
  root.find('.theme-doc-version-badge,.theme-doc-breadcrumbs,.theme-doc-toc-mobile,.table-of-contents,.hash-link').remove()
  if (options.omitDocumentHeading) {
    const heading = root.find('h1').first()
    if (heading.length && heading.text().trim() === title) {
      // Thally renders this title from frontmatter. Retain its source anchor at
      // the same boundary without generating a second article-level heading.
      const anchorId = heading.attr('id')
      if (anchorId) documentHeadingAnchor = `<a id="${migrationImageAttribute(anchorId)}" />\n\n`
      heading.remove()
    }
    // The destination renders its only document H1 from frontmatter. Some
    // authors use additional H1s for article sections; preserve their full
    // content and source IDs while giving those sections the next heading level.
    root.find('h1').each((_index, element) => { element.name = 'h2' })
  }
  root.find('a[href]').each((_index, element) => {
    const href = $(element).attr('href')
    if (!href) return
    try {
      const resolved = new URL(href, document.finalUrl)
      if (['http:', 'https:', 'mailto:', 'tel:'].includes(resolved.protocol)) {
        $(element).attr('href', resolved.toString())
      } else {
        $(element).removeAttr('href')
      }
    } catch {
      $(element).removeAttr('href')
    }
  })
  root.find('img[src]').each((_index, element) => {
    const src = $(element).attr('src')
    if (!src) return
    try {
      const resolved = new URL(src, document.finalUrl)
      if (['http:', 'https:'].includes(resolved.protocol)) {
        $(element).attr('src', resolved.toString())
      } else {
        $(element).removeAttr('src')
      }
    } catch {
      $(element).removeAttr('src')
    }
  })
  const turndown = new TurndownService({ codeBlockStyle: 'fenced', emDelimiter: '_', headingStyle: 'atx', preformattedCode: true })
  let isConvertingTableCell = false
  turndown.remove(['script', 'style', 'noscript'])
  turndown.addRule('migration-literal-table-code', {
    filter: (node) => isConvertingTableCell && node.nodeName === 'CODE' && node.parentNode?.nodeName !== 'PRE'
      && needsLiteralTableCode(node.textContent ?? ''),
    // A strict, attribute-free text leaf preserves the payload that GFM's
    // escaped-pipe code-span grammar cannot represent without changing it.
    replacement: (_content, node) => `<code>${literalMdxCodeText(node.textContent ?? '')}</code>`,
  })
  turndown.addRule('migration-static-task-checkbox', {
    filter: (node) => node.nodeName === 'SPAN'
      && ['checked', 'unchecked'].includes((node as HTMLElement).getAttribute('data-thally-static-task-checkbox') ?? ''),
    // Emit literal task-list syntax rather than escaping its brackets as copy.
    replacement: (_content, node) => (node as HTMLElement).getAttribute('data-thally-static-task-checkbox') === 'checked' ? '[x] ' : '[ ] ',
  })
  const anchor = (element: HTMLElement): string => {
    const value = element.getAttribute('id')
    return options.preserveAnchors && value
      ? `<a id="${value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/\{/g, '&#123;')}" />\n\n`
      : ''
  }
  if (options.preserveAnchors) turndown.addRule('migration-source-anchor', {
    filter: (node) => (node as HTMLElement).hasAttribute('id') && node.nodeName !== 'PRE',
    replacement: (content, node) => {
      const element = node as HTMLElement
      const heading = element.nodeName.match(/^H([1-6])$/)
      return `\n\n${anchor(element)}${heading ? `${'#'.repeat(Number(heading[1]))} ${content.trim()}` : content}\n\n`
    },
  })
  if (options.preserveResponsiveImages) {
    const image = (element: HTMLElement): string => {
      const tag = element.nodeName.toLowerCase()
      const attributes: Array<string> = []
      for (const name of ['src', 'srcset', 'sizes', 'alt', 'title', 'media', 'type', 'width', 'height', 'id']) {
        let value = element.getAttribute(name)
        if (value === null) continue
        if (name === 'src') value = migrationImageUrl(value, document.finalUrl)
        if (name === 'srcset') value = renderMigrationSrcset(migrationImageCandidates(value, document.finalUrl))
        const prop = name === 'srcset' ? 'srcSet' : name
        attributes.push(`${prop}="${migrationImageAttribute(value)}"`)
      }
      return `<${tag}${attributes.length ? ` ${attributes.join(' ')}` : ''} />`
    }
    turndown.addRule('migration-responsive-image', {
      filter: (node) => ['IMG', 'SOURCE'].includes(node.nodeName),
      replacement: (_content, node) => image(node as HTMLElement),
    })
    turndown.addRule('migration-responsive-picture', {
      filter: 'picture',
      replacement: (content) => `\n\n<picture>\n${content.trim()}\n</picture>\n\n`,
    })
  }
  turndown.addRule('docusaurus-admonition', {
    filter: (node) => node.nodeName === 'DIV'
      && (node as HTMLElement).classList.contains('theme-admonition'),
    replacement: (_content, node) => {
      const element = node as HTMLElement
      const className = element.className
      const tag = /admonition-(?:danger)/.test(className)
        ? 'Error'
        : /admonition-(?:caution|warning)/.test(className)
          ? 'Warning'
          : /admonition-info/.test(className)
            ? 'Info'
            : 'Note'
      const fragment = load(element.outerHTML)
      const clone = fragment('.theme-admonition').first()
      const title = clone.find('[class*="admonitionHeading"],.admonition-heading').first()
      const titleText = title.text().trim()
      title.remove()
      const markdown = turndown.turndown(clone.html() ?? '').trim()
      return `\n\n${anchor(element)}<${tag}>\n${titleText ? `**${escapeMarkdownText(titleText)}**\n\n` : ''}${markdown}\n</${tag}>\n\n`
    },
  })
  turndown.addRule('docusaurus-tabs', {
    filter: (node) => node.nodeName === 'DIV'
      && (node as HTMLElement).classList.contains('tabs-container'),
    replacement: (_content, node) => {
      const element = node as HTMLElement
      const fragment = load(element.outerHTML)
      const container = fragment('.tabs-container').first()
      const labels = container.children('ul.tabs').children('li').toArray()
        .map((item) => fragment(item).text().trim() || 'Tab')
      const panels = container.find('[role="tabpanel"]').toArray()
        .filter((panel) => fragment(panel).closest('.tabs-container')[0] === container[0])
      if (panels.length === 0) return _content
      const tabs = panels.map((panel, index) => {
        const panelId = fragment(panel).attr('id')
        const tab = panelId ? container.find('[role="tab"]').toArray().find((item) => fragment(item).attr('aria-controls') === panelId) : undefined
        const title = migrationImageAttribute((tab ? fragment(tab).text().trim() : labels[index]) || `Tab ${index + 1}`)
        const panelAnchor = options.preserveAnchors && panelId ? `<a id="${migrationImageAttribute(panelId)}" />\n\n` : ''
        return `<Tab title="${title}">\n${panelAnchor}${turndown.turndown(fragment(panel).html() ?? '').trim()}\n</Tab>`
      })
      return `\n\n${anchor(element)}<Tabs>\n${tabs.join('\n\n')}\n</Tabs>\n\n`
    },
  })
  turndown.addRule('gfm-table', {
    filter: 'table',
    replacement: (_content, node) => {
      const fragment = load((node as HTMLElement).outerHTML)
      const rows = fragment('tr').toArray().map((row) => (
        fragment(row).children('th,td').toArray().map((cell) => {
          const wasConvertingTableCell = isConvertingTableCell
          isConvertingTableCell = true
          try {
            // Reuse the article's safe inline rules so links, code, emphasis
            // and images survive. GFM still requires one physical line per
            // row and escaped pipes, including pipes inside inline code.
            return portableMarkdownTableCell(turndown.turndown(fragment(cell).html() ?? ''))
          } finally {
            isConvertingTableCell = wasConvertingTableCell
          }
        })
      )).filter((row) => row.length > 0)
      if (rows.length === 0) return ''
      const width = Math.max(...rows.map((row) => row.length))
      const normalized = rows.map((row) => [...row, ...Array<string>(width - row.length).fill('')])
      return `\n\n| ${normalized[0].join(' | ')} |\n| ${Array<string>(width).fill('---').join(' | ')} |\n${normalized.slice(1).map((row) => `| ${row.join(' | ')} |`).join('\n')}\n\n`
    },
  })
  turndown.addRule('migration-safe-fenced-code', {
    filter: (node) => node.nodeName === 'PRE',
    replacement: (_content, node) => {
      const element = node as HTMLElement
      const fragment = load(element.outerHTML)
      const tokenLines = fragment('.token-line').toArray()
      const code = (tokenLines.length > 0
        ? tokenLines.map((line) => fragment(line).text()).join('\n')
        : fragment('pre').text()).replace(/\n$/, '')
      const language = fragment('code').attr('class')?.match(/(?:language-|lang-)([A-Za-z0-9_+-]+)/)?.[1] ?? ''
      const longestFence = Math.max(0, ...[...code.matchAll(/`+/g)].map((match) => match[0].length))
      const fence = '`'.repeat(Math.max(3, longestFence + 1))
      return `\n\n${anchor(element)}${fence}${language}\n${code}\n${fence}\n\n`
    },
  })
  const escape = turndown.escape.bind(turndown)
  turndown.escape = (text: string) => isConvertingTableCell
    // Entity-encode only text nodes: code spans retain their literal payload,
    // and generated links keep their syntax while prose stays inert MDX.
    ? escape(text.replace(/[<>{}]/g, (character) => ({ '<': '&lt;', '>': '&gt;', '{': '&#123;', '}': '&#125;' })[character]!))
    : escape(text).replace(/[<{}]/g, (match) => `\\${match}`)
  const body = `${documentHeadingAnchor}${turndown.turndown(root.html() ?? '').trim()}`
  // Docusaurus can intentionally publish title-only reference/partial pages.
  // Keep those real article routes while still rejecting empty search/app
  // shells that happen to expose a document title.
  if (!title || (body.length < 40 && $('article').length === 0)) return { page: null, links }
  return {
    page: {
      id,
      navigationId: id,
      title,
      description: description || plainDescription(body) || `Documentation imported from ${document.finalUrl.hostname}.`,
      keywords: [],
      body,
      source: document.finalUrl.toString(),
    },
    links,
  }
}

function htmlNavigationLinks(document: MigrationFetchResponse): Array<string> {
  const $ = load(document.body)
  return $('.nav-tabs a[href], nav a[href], aside a[href], [role="navigation"] a[href]')
    .map((_index, element) => $(element).attr('href') ?? '')
    .get()
    .filter(Boolean)
}

interface SourceNavigationTab {
  section: string
  label: string
  pageId: string
}

interface DocusaurusSidebarItem {
  label: string
  href?: string
  items?: Array<DocusaurusSidebarItem>
  isCategory?: boolean
}

interface DocusaurusSidebarSnapshot {
  items: Array<DocusaurusSidebarItem>
}

interface DocusaurusDiscovery {
  scopePath: string
  excludedVersionPrefixes: Array<string>
  sidebar: DocusaurusSidebarSnapshot | null
}

function normalizedLinkLabel(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function readDocusaurusSidebar(document: MigrationFetchResponse): DocusaurusSidebarSnapshot | null {
  if (!/html/i.test(document.contentType)) return null
  const $ = load(document.body)
  const sidebar = $('ul.theme-doc-sidebar-menu').first()
  if (sidebar.length === 0) return null

  type CheerioSelector = Exclude<Parameters<ReturnType<typeof load>>[0], undefined>
  function readList(list: CheerioSelector): Array<DocusaurusSidebarItem> {
    return $(list).children('li').toArray().flatMap((item) => {
      const directLink = $(item).children('a.menu__link').first()
      const collapsibleLink = $(item)
        .children('.menu__list-item-collapsible')
        .children('a.menu__link')
        .first()
      const link = directLink.length > 0 ? directLink : collapsibleLink
      const label = normalizedLinkLabel(link.text())
      const href = link.attr('href')
      const nested = $(item).children('ul.menu__list').first()
      const children = nested.length > 0 ? readList(nested.get(0)!) : []
      const isCategory = $(item).hasClass('theme-doc-sidebar-item-category')
        || link.hasClass('menu__link--sublist')
      if (!label && children.length === 0) return []
      return [{
        label: label || 'Documentation',
        ...(href ? { href: new URL(href, document.finalUrl).toString() } : {}),
        ...(children.length > 0 ? { items: children } : {}),
        ...(isCategory ? { isCategory: true } : {}),
      }]
    })
  }

  return { items: readList(sidebar.get(0)!) }
}

function docusaurusSidebarHrefs(snapshot: DocusaurusSidebarSnapshot | null): Array<string> {
  const hrefs: Array<string> = []
  const visit = (items: Array<DocusaurusSidebarItem>) => {
    for (const item of items) {
      if (item.href) hrefs.push(item.href)
      if (item.items) visit(item.items)
    }
  }
  if (snapshot) visit(snapshot.items)
  return hrefs
}

function deriveDocusaurusScope(
  source: URL,
  document: MigrationFetchResponse,
  submittedScopePath: string,
): DocusaurusDiscovery {
  const $ = load(document.body)
  const sidebar = readDocusaurusSidebar(document)
  const internalPaths = docusaurusSidebarHrefs(sidebar).flatMap((href) => {
    try {
      const url = new URL(href)
      return url.origin === source.origin ? [url.pathname.replace(/\/+$/, '') || '/'] : []
    } catch {
      return []
    }
  })
  const counts = new Map<string, number>()
  for (const path of internalPaths) {
    const segments = path.split('/').filter(Boolean)
    for (let length = 1; length < segments.length; length++) {
      const prefix = `/${segments.slice(0, length).join('/')}`
      counts.set(prefix, (counts.get(prefix) ?? 0) + 1)
    }
  }
  const threshold = Math.max(2, Math.ceil(internalPaths.length * 0.6))
  const scopePath = [...counts]
    .filter(([, count]) => count >= threshold)
    .sort((left, right) => right[0].split('/').length - left[0].split('/').length
      || right[1] - left[1])[0]?.[0]
    ?? submittedScopePath

  const excludedVersionPrefixes = $('.dropdown__menu a[href]').toArray().flatMap((element) => {
    const href = $(element).attr('href')
    if (!href) return []
    try {
      const target = new URL(href, document.finalUrl)
      if (target.origin !== source.origin || !isInScope(target, source, scopePath)) return []
      const relativePath = target.pathname.slice(scopePath.length).replace(/^\/+/, '')
      const version = relativePath.split('/', 1)[0]
      if (!/^(?:legacy|next|v\d[\w.-]*)$/i.test(version)) return []
      return [`${scopePath}/${version}`]
    } catch {
      return []
    }
  })

  return {
    scopePath,
    excludedVersionPrefixes: [...new Set(excludedVersionPrefixes)],
    sidebar,
  }
}

function docusaurusRouteIdForUrl(url: URL, scopePath: string): string | null {
  let path = url.pathname.replace(/\/+$/, '')
  if (scopePath === '/') path = path.replace(/^\/+/, '')
  else if (path === scopePath) path = ''
  else if (path.startsWith(`${scopePath}/`)) path = path.slice(scopePath.length + 1)
  else return null
  const segments = path.split('/').filter(Boolean).map((segment) => {
    let decoded = segment
    try {
      decoded = decodeURIComponent(segment)
    } catch {
      // Preserve malformed source segments as literal route input.
    }
    return decoded
      .replace(/\.(?:html?|mdx?)$/i, '')
      .replace(/[^A-Za-z0-9._-]+/g, '-')
      .replace(/(^-|-$)/g, '')
  }).filter(Boolean)
  return segments.join('/') || 'introduction'
}

function storageIdForDocusaurusRoute(routeId: string): string {
  return /(?:^|\/)(?:index|readme)$/i.test(routeId) ? `${routeId}/index` : routeId
}

function docusaurusNavigationFromSnapshots(
  snapshots: Array<DocusaurusSidebarSnapshot>,
  pages: Array<MigrationPage>,
  scopePath: string,
): ReturnType<typeof buildNavigationFromPages> {
  const imported = new Set(pages.map((page) => page.navigationId))
  const claimed = new Set<string>()
  const uniqueSnapshots = [...new Map(snapshots.map((snapshot) => [
    JSON.stringify(snapshot.items),
    snapshot,
  ])).values()]
  const mergedSnapshots: Array<DocusaurusSidebarSnapshot> = []
  function mergeItems(
    target: Array<DocusaurusSidebarItem>,
    incoming: Array<DocusaurusSidebarItem>,
  ): void {
    for (const item of incoming) {
      const existing = target.find((candidate) => candidate.label === item.label
        && (candidate.items || item.items))
        ?? target.find((candidate) => candidate.label === item.label && candidate.href === item.href)
      if (!existing) {
        target.push(structuredClone(item))
        continue
      }
      if (!existing.href && item.href) existing.href = item.href
      if (item.items) {
        existing.items ??= []
        mergeItems(existing.items, item.items)
      }
    }
  }
  for (const snapshot of uniqueSnapshots) {
    const incomingLabels = new Set(snapshot.items.map((item) => item.label))
    const cluster = mergedSnapshots.find((candidate) => {
      const candidateLabels = new Set(candidate.items.map((item) => item.label))
      const overlap = [...incomingLabels].filter((label) => candidateLabels.has(label)).length
      return overlap >= Math.max(2, Math.ceil(Math.min(incomingLabels.size, candidateLabels.size) * 0.5))
    })
    if (cluster) mergeItems(cluster.items, snapshot.items)
    else mergedSnapshots.push(structuredClone(snapshot))
  }
  const pageIdsFor = (snapshot: DocusaurusSidebarSnapshot): Array<string> => docusaurusSidebarHrefs(snapshot)
    .flatMap((href) => {
      const id = docusaurusRouteIdForUrl(new URL(href), scopePath)
      return id && imported.has(id) ? [id] : []
    })
  mergedSnapshots.sort((left, right) => pageIdsFor(right).length - pageIdsFor(left).length)

  const tabs = mergedSnapshots.flatMap((snapshot, snapshotIndex) => {
    function convert(items: Array<DocusaurusSidebarItem>): Array<string | MigrationNavigationGroup> {
      const converted: Array<string | MigrationNavigationGroup> = []
      for (const item of items) {
        const routeId = item.href
          ? docusaurusRouteIdForUrl(new URL(item.href), scopePath)
          : null
        const page = routeId && imported.has(routeId) && !claimed.has(routeId) ? routeId : null
        if (page) claimed.add(page)
        const children = item.items ? convert(item.items) : []
        if (children.length > 0 || item.isCategory) {
          converted.push({ group: item.label, pages: page ? [page, ...children] : children })
          continue
        }
        if (page) converted.push(page)
      }
      return converted
    }
    const converted = convert(snapshot.items)
    const loosePages = converted.filter((item): item is string => typeof item === 'string')
    const groups = converted.filter((item): item is Exclude<typeof item, string> => typeof item !== 'string')
    if (loosePages.length > 0) groups.unshift({ group: 'Overview', pages: loosePages })
    if (groups.length === 0) return []
    const snapshotPageIds = pageIdsFor(snapshot)
    const firstSegments = new Set(snapshotPageIds.map((id) => id.split('/', 1)[0]))
    const tab = snapshotIndex > 0 && firstSegments.size === 1
      ? normalizedLinkLabel([...firstSegments][0].replace(/[-_]/g, ' ')).replace(/\b\w/g, (letter) => letter.toUpperCase())
      : 'Documentation'
    return [{ tab, groups }]
  })

  const additional = pages
    .map((page) => page.navigationId)
    .filter((id) => !claimed.has(id))
  if (additional.length > 0) {
    if (tabs.length === 0) return buildNavigationFromPages(pages)
    tabs[0].groups?.push({ group: 'Additional', pages: additional })
  }
  return { tabs }
}

function htmlTopLevelNavigation(
  document: MigrationFetchResponse,
  source: URL,
  scopePath: string,
): Array<SourceNavigationTab> {
  const $ = load(document.body)
  interface NavigationCandidate {
    entries: Array<SourceNavigationTab>
    anchorCount: number
  }
  const collectCandidates = (selector: string): Array<NavigationCandidate> => {
    const candidates: Array<NavigationCandidate> = []
    $(selector).each((_containerIndex, container) => {
      const entries: Array<SourceNavigationTab> = []
      const seenSections = new Set<string>()
      let anchorCount = 0
      $(container).find('a[href]').each((_index, element) => {
        const label = $(element).text().replace(/\s+/g, ' ').trim()
        const href = $(element).attr('href')
        if (!label || !href) return
        try {
          const target = new URL(href, document.finalUrl)
          if (!isInScope(target, source, scopePath)) return
          anchorCount += 1
          const targetId = canonicalLocalizedPageId(pageIdForUrl(target, scopePath) ?? '')
          const pageId = targetId
          const section = targetId.split('/', 1)[0] || 'introduction'
          if (!pageId || seenSections.has(section)) return
          seenSections.add(section)
          entries.push({ section, label, pageId })
        } catch {
          // Ignore malformed navigation targets; discovery applies the same rule.
        }
      })
      if (entries.length > 1) {
        candidates.push({ entries, anchorCount })
      }
    })
    return candidates
  }
  // Mintlify marks its product-tab strip consistently. Prefer that explicit
  // platform signal; generic nav elements usually describe only the sidebar.
  const tabCandidates = collectCandidates('.nav-tabs')
  const candidates = tabCandidates.length > 0
    ? tabCandidates
    : collectCandidates('nav, [role="navigation"]')
  const entries = candidates.sort((left, right) => {
    const densityDifference = (right.entries.length / right.anchorCount)
      - (left.entries.length / left.anchorCount)
    return densityDifference || right.entries.length - left.entries.length
  })[0]?.entries ?? []
  // A product switcher with dozens of entries is invariably a sidebar or
  // responsive page strip, not authored top-level navigation. Refuse to turn
  // that ambiguity into an unusable header.
  const normalizedLabels = entries.map((entry) => entry.label.trim().toLowerCase())
  if (entries.length > 12 || new Set(normalizedLabels).size !== normalizedLabels.length) return []
  return entries
}

function remapNavigationHome(
  config: MigrationBundle['docsConfig'],
  sourceHomePageId: string | undefined,
): MigrationBundle['docsConfig'] {
  if (!sourceHomePageId || sourceHomePageId === 'introduction') return config
  const remapPages = (
    pages: Array<string | MigrationNavigationGroup>,
  ): Array<string | MigrationNavigationGroup> => pages.map((page) => typeof page === 'string'
    ? page === sourceHomePageId ? 'introduction' : page
    : { ...page, pages: remapPages(page.pages) })
  const remapGroups = (groups: Array<MigrationNavigationGroup>): Array<MigrationNavigationGroup> => groups.map((group) => ({
    ...group,
    pages: remapPages(group.pages),
  }))
  return {
    ...config,
    tabs: config.tabs.map((tab) => ({
      ...tab,
      ...(tab.href === `/${sourceHomePageId}` ? { href: '/' } : {}),
      ...(tab.pages ? { pages: remapPages(tab.pages) } : {}),
      ...(tab.groups ? { groups: remapGroups(tab.groups) } : {}),
    })),
  }
}

function markdownLinks(body: string): Array<string> {
  return [...body.matchAll(/\[[^\]]+\]\(([^)\s]+)(?:\s+['"][^'"]*['"])?\)/g)]
    .map((match) => match[1])
}

function sitemapLinks(body: string): Array<string> {
  const $ = load(body, { xmlMode: true })
  return $('url > loc, sitemap > loc').map((_index, element) => $(element).text().trim()).get().filter(Boolean)
}

function robotsSitemaps(body: string): Array<string> {
  return body.split('\n')
    .map((line) => line.match(/^\s*Sitemap:\s*(\S+)/i)?.[1])
    .filter((value): value is string => Boolean(value))
}

function headerLinks(document: MigrationFetchResponse): Array<string> {
  const links: Array<string> = []
  const llms = document.headers?.['x-llms-txt']
  if (llms) links.push(llms)
  const linkHeader = document.headers?.link ?? ''
  for (const match of linkHeader.matchAll(/<([^>]+)>\s*;[^,]*(?:rel=["']?(?:alternate|llms-txt)["']?|type=["']text\/(?:markdown|plain)["'])/gi)) {
    links.push(match[1])
  }
  return links
}

async function safeFetch(
  fetcher: MigrationFetcher,
  url: URL,
  accept: string,
): Promise<MigrationFetchResponse | null> {
  try {
    return await fetcher(url, { accept })
  } catch {
    return null
  }
}

/** Crawl one public docs origin into a canonical, caller-independent bundle. */
export async function migrateUrl(options: UrlMigrationOptions): Promise<MigrationBundle> {
  const source = validateMigrationUrl(options.sourceUrl)
  const fetcher = options.fetcher ?? defaultMigrationFetcher
  const maxPages = Math.max(1, Math.min(options.maxPages ?? DEFAULT_MAX_PAGES, 10_000))
  const concurrency = Math.max(1, Math.min(options.concurrency ?? 5, 10))
  const maxTotalBytes = Math.max(1_000_000, Math.min(options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES, 500_000_000))
  const submittedScopePath = docsScopePath(source)
  const initial = await fetcher(source, { accept: 'text/markdown,text/html,application/xhtml+xml;q=0.9' })
  if (!isInScope(initial.finalUrl, source, submittedScopePath)) {
    throw new Error('The documentation URL redirected outside the submitted docs origin or path.')
  }
  const htmlProbe = /html/i.test(initial.contentType)
    ? initial
    : await safeFetch(fetcher, source, 'text/html,application/xhtml+xml')
  // Content negotiation must not let an HTML-only redirect escape the path
  // boundary already validated for the submitted documentation response.
  const scopedHtmlProbe = htmlProbe && isInScope(htmlProbe.finalUrl, source, submittedScopePath)
    ? htmlProbe
    : null
  const platform = options.platform ?? detectUrlPlatform(scopedHtmlProbe ?? initial)
  let docusaurusHtmlProbe = platform === 'docusaurus' ? scopedHtmlProbe : null
  if (docusaurusHtmlProbe && !readDocusaurusSidebar(docusaurusHtmlProbe)) {
    const $ = load(docusaurusHtmlProbe.body)
    const docsHref = $('nav a[href]').toArray().map((element) => ({
      href: $(element).attr('href'),
      label: normalizedLinkLabel($(element).text()),
    })).find((link) => /^docs(?:umentation)?$/i.test(link.label))?.href
    if (docsHref) {
      try {
        const docsUrl = new URL(docsHref, docusaurusHtmlProbe.finalUrl)
        if (docsUrl.origin === source.origin && isInScope(docsUrl, source, submittedScopePath)) {
          const probe = await safeFetch(fetcher, docsUrl, 'text/html,application/xhtml+xml')
          if (probe && probe.finalUrl.origin === source.origin && /html/i.test(probe.contentType)) {
            docusaurusHtmlProbe = probe
          }
        }
      } catch {
        // A malformed navbar link falls back to the submitted path boundary.
      }
    }
  }
  const docusaurusDiscovery = platform === 'docusaurus' && docusaurusHtmlProbe
    ? deriveDocusaurusScope(source, docusaurusHtmlProbe, submittedScopePath)
    : null
  // A Mintlify site may own an entire docs origin or a path below a marketing
  // site. Its llms/sitemap location is the authoritative crawl boundary.
  const scopePath = platform === 'mintlify'
    ? machineIndexScopePath(source, [initial, scopedHtmlProbe]) ?? submittedScopePath
    : docusaurusDiscovery?.scopePath ?? submittedScopePath
  const sourceMintlifyConfig = platform === 'mintlify' && scopedHtmlProbe && /html/i.test(scopedHtmlProbe.contentType)
    ? embeddedMintlifyConfig(scopedHtmlProbe.body)
    : null
  const sourceMintlifyProjection = sourceMintlifyConfig
    ? projectMintlifyNavigation(sourceMintlifyConfig, { pathPrefix: scopePath })
    : null
  const hasStructuredMintlifyNavigation = Boolean(
    sourceMintlifyProjection?.docsConfig.tabs.length
      && sourceMintlifyProjection.pageReferences.length,
  )
  const sourceTopLevelNavigation = platform === 'mintlify' && !hasStructuredMintlifyNavigation
    && scopedHtmlProbe && /html/i.test(scopedHtmlProbe.contentType)
    ? htmlTopLevelNavigation(scopedHtmlProbe, source, scopePath)
    : undefined
  // The submitted URL can be any page. Mintlify's first authored product tab,
  // rather than the submitted page, defines which source page becomes `/`.
  // Older single-section themes do not expose a tab strip, so they retain the
  // legacy dedicated-origin fallback when no authored home can be recovered.
  const sourceHomePageId = sourceMintlifyProjection?.pageReferences[0]?.navigationId
    ?? sourceTopLevelNavigation?.[0]?.pageId
    ?? (platform === 'mintlify' && scopePath === '/'
      ? canonicalLocalizedPageId(pageIdForUrl(source, scopePath) ?? '') || undefined
      : undefined)
  const cache = new Map([[source.toString(), initial]])
  if (docusaurusHtmlProbe) cache.set(docusaurusHtmlProbe.finalUrl.toString(), docusaurusHtmlProbe)
  const queue: Array<URL> = [source]
  const queued = new Set([candidateIdentity(source)])
  const warnings: Array<MigrationWarning> = []
  const fetchedSitemaps = new Set<string>()
  const docusaurusSidebars: Array<DocusaurusSidebarSnapshot> = docusaurusDiscovery?.sidebar
    ? [docusaurusDiscovery.sidebar]
    : []
  const docusaurusRedirects: Array<{ source: string; destination: string }> = []

  function enqueue(value: string, base: URL): void {
    if (queued.size >= MAX_DISCOVERED_URLS) return
    const url = normalizeCandidate(value, base, source, scopePath)
    if (!url || queued.has(candidateIdentity(url))) return
    if (platform === 'docusaurus' && url.pathname.replace(/\/+$/, '') === `${scopePath}/search`) return
    if (docusaurusDiscovery?.excludedVersionPrefixes.some((prefix) => {
      const path = url.pathname.replace(/\/+$/, '')
      return path === prefix || path.startsWith(`${prefix}/`)
    })) return
    queued.add(candidateIdentity(url))
    queue.push(url)
  }

  for (const reference of sourceMintlifyProjection?.pageReferences ?? []) {
    let href = reference.ref
    if (scopePath !== '/' && href.startsWith('/')
      && href !== scopePath && !href.startsWith(`${scopePath}/`)) {
      href = `${scopePath}${href}`
    }
    enqueue(href, source)
  }

  // Mintlify renders the authored navigation into the HTML shell. Seed the
  // queue from that order before machine indexes add completeness fallbacks.
  const navigationProbe = docusaurusHtmlProbe ?? scopedHtmlProbe
  if (navigationProbe && /html/i.test(navigationProbe.contentType)) {
    for (const link of htmlNavigationLinks(navigationProbe)) enqueue(link, navigationProbe.finalUrl)
  }

  async function discoverDocumentLinks(document: MigrationFetchResponse, depth = 0): Promise<void> {
    const links = sitemapLinks(document.body)
    for (const link of links) {
      let url: URL
      try {
        url = new URL(link, document.finalUrl)
      } catch {
        continue
      }
      if (depth < 2 && /\.xml(?:$|\?)/i.test(url.pathname)) {
        if (url.origin !== source.origin || fetchedSitemaps.size >= MAX_SITEMAP_DOCUMENTS
          || fetchedSitemaps.has(url.toString())) continue
        fetchedSitemaps.add(url.toString())
        const nested = await safeFetch(fetcher, url, 'application/xml,text/xml')
        if (nested && nested.finalUrl.origin === source.origin) await discoverDocumentLinks(nested, depth + 1)
      } else {
        enqueue(link, document.finalUrl)
      }
    }
  }

  for (const link of headerLinks(initial)) {
    let url: URL
    try {
      url = new URL(link, initial.finalUrl)
    } catch {
      continue
    }
    if (url.origin !== source.origin) continue
    const document = await safeFetch(fetcher, url, 'text/plain,text/markdown')
    if (!document || document.finalUrl.origin !== source.origin) continue
    for (const candidate of markdownLinks(document.body)) enqueue(candidate, document.finalUrl)
  }

  const pathRoot = scopePath === '/' ? source.origin : `${source.origin}${scopePath}`
  const discoveryUrls = [
    new URL('/llms.txt', source.origin),
    new URL(`${pathRoot.replace(source.origin, '')}/llms.txt`, source.origin),
    new URL('/robots.txt', source.origin),
    new URL('/sitemap.xml', source.origin),
    new URL(`${pathRoot.replace(source.origin, '')}/sitemap.xml`, source.origin),
  ]
  const uniqueDiscovery = [...new Map(discoveryUrls.map((url) => [url.toString(), url])).values()]
  for (const url of uniqueDiscovery) {
    const document = await safeFetch(fetcher, url, 'text/plain,application/xml,text/xml;q=0.9')
    if (!document || document.finalUrl.origin !== source.origin) continue
    const isRobots = url.pathname.endsWith('robots.txt')
    const isSitemap = url.pathname.endsWith('sitemap.xml') || document.contentType.includes('xml')
    if (isRobots) {
      for (const link of robotsSitemaps(document.body)) {
        let sitemapUrl: URL
        try {
          sitemapUrl = new URL(link, document.finalUrl)
        } catch {
          continue
        }
        if (sitemapUrl.origin !== source.origin || fetchedSitemaps.size >= MAX_SITEMAP_DOCUMENTS
          || fetchedSitemaps.has(sitemapUrl.toString())) continue
        fetchedSitemaps.add(sitemapUrl.toString())
        const sitemap = await safeFetch(fetcher, sitemapUrl, 'application/xml,text/xml')
        if (sitemap && sitemap.finalUrl.origin === source.origin) await discoverDocumentLinks(sitemap)
      }
    } else if (isSitemap) {
      await discoverDocumentLinks(document)
    } else {
      for (const link of markdownLinks(document.body)) enqueue(link, document.finalUrl)
    }
  }

  const pages: Array<MigrationPage> = []
  const openApiFragments: Array<EmbeddedOpenApiFragment> = []
  const seenIds = new Set<string>()
  const seenSources = new Set<string>()
  const visited = new Set<string>()
  let importedBytes = 0
  let isByteBudgetExhausted = false
  while (queue.length > 0 && pages.length < maxPages && !isByteBudgetExhausted) {
    const batch: Array<URL> = []
    while (queue.length > 0 && batch.length < Math.min(concurrency, maxPages - pages.length)) {
      const candidate = queue.shift()
      if (!candidate || visited.has(candidate.toString())) continue
      visited.add(candidate.toString())
      batch.push(candidate)
    }
    if (batch.length === 0) continue
    const results = await Promise.all(batch.map(async (candidate) => {
      let document = cache.get(candidate.toString())
        ?? await safeFetch(fetcher, candidate, 'text/markdown,text/html,application/xhtml+xml;q=0.9')
      if (!document) {
        return { candidate, page: null, links: [] as Array<string>, failure: true }
      }
      if (!isInScope(document.finalUrl, source, scopePath)) {
        return { candidate, page: null, links: [] as Array<string>, failure: false }
      }
      // A .md mirror can redirect to an index. Classify the final response,
      // rather than trusting the requested extension or content negotiation.
      if (/\/(?:llms(?:-full)?|robots)\.txt$|\/sitemap[^/]*\.xml$/i.test(document.finalUrl.pathname)
        || /(?:xml|json)/i.test(document.contentType)) {
        return { candidate, page: null, links: markdownLinks(document.body), base: document.finalUrl, failure: false }
      }
      const isMarkdown = /(?:markdown|text\/plain)/i.test(document.contentType)
        || /\.mdx?$/i.test(document.finalUrl.pathname)
      if (!isMarkdown && !/\.mdx?$/i.test(candidate.pathname)) {
        const markdownUrl = new URL(candidate)
        markdownUrl.pathname = `${markdownUrl.pathname.replace(/\/$/, '')}.md`
        const markdownDocument = await safeFetch(fetcher, markdownUrl, 'text/markdown,text/plain')
        if (markdownDocument && isInScope(markdownDocument.finalUrl, source, scopePath)
          && !/\/(?:llms(?:-full)?|robots)\.txt$|\/sitemap[^/]*\.xml$/i.test(markdownDocument.finalUrl.pathname)
          && /(?:markdown|text\/plain)/i.test(markdownDocument.contentType)) {
          document = markdownDocument
        }
      }
      const isResolvedMarkdown = /(?:markdown|text\/plain)/i.test(document.contentType)
        || /\.mdx?$/i.test(document.finalUrl.pathname)
      const sanitizedMarkdown = isResolvedMarkdown ? sanitizeRemoteMarkdown(document.body) : null
      if (isResolvedMarkdown && sanitizedMarkdown === null) {
        const htmlUrl = new URL(candidate)
        htmlUrl.pathname = htmlUrl.pathname.replace(/\.mdx?$/i, '') || '/'
        const htmlDocument = await safeFetch(fetcher, htmlUrl, 'text/html,application/xhtml+xml')
        if (htmlDocument && isInScope(htmlDocument.finalUrl, source, scopePath)
          && /html/i.test(htmlDocument.contentType)) {
          document = htmlDocument
        } else {
          // Never recover by compiling the rejected MDX. A source that does
          // not expose a safe rendered representation is skipped instead.
          return { candidate, page: null, links: [] as Array<string>, failure: false }
        }
      } else if (sanitizedMarkdown !== null) {
        document = { ...document, body: sanitizedMarkdown }
      }
      const responseBytes = Buffer.byteLength(document.body, 'utf8')
      if (importedBytes + responseBytes > maxTotalBytes) {
        isByteBudgetExhausted = true
        return { candidate, page: null, links: [] as Array<string>, failure: false, budgetExceeded: true }
      }
      importedBytes += responseBytes
      const discoveredNavigationId = platform === 'docusaurus'
        ? docusaurusRouteIdForUrl(document.finalUrl, scopePath)
          ?? docusaurusRouteIdForUrl(candidate, scopePath)
        : pageIdForUrl(document.finalUrl, scopePath)
          ?? pageIdForUrl(candidate, scopePath)
      const navigationId = discoveredNavigationId
        && canonicalLocalizedPageId(discoveredNavigationId) === sourceHomePageId
        ? 'introduction'
        : discoveredNavigationId
      if (!navigationId) return { candidate, page: null, links: [] as Array<string>, failure: false }
      const id = platform === 'docusaurus'
        ? storageIdForDocusaurusRoute(navigationId)
        : navigationId
      if (/(?:markdown|text\/plain)/i.test(document.contentType) || /\.mdx?$/i.test(document.finalUrl.pathname)) {
        const pageWarnings: Array<string> = []
        const markdown = markdownPage(document, id, platform, (message) => pageWarnings.push(message))
        if (markdown.page) markdown.page.navigationId = navigationId
        return {
          candidate,
          page: markdown.page,
          pageWarnings,
          openApiFragment: markdown.openApiFragment,
          links: markdownLinks(document.body),
          base: document.finalUrl,
          failure: false,
        }
      }
      const extracted = htmlPage(document, id)
      if (extracted.page) extracted.page.navigationId = navigationId
      const sidebar = platform === 'docusaurus' ? readDocusaurusSidebar(document) : null
      return { candidate, page: extracted.page, links: extracted.links, base: document.finalUrl, sidebar, failure: false }
    }))
    for (const result of results) {
      if (result.failure) {
        warnings.push({ code: 'fetch-failed', message: 'A discovered documentation page could not be fetched.', source: result.candidate.toString() })
        continue
      }
      if (result.budgetExceeded) continue
      if (result.page && platform !== 'docusaurus') {
        result.page.id = canonicalLocalizedPageId(result.page.id)
        result.page.navigationId = canonicalLocalizedPageId(result.page.navigationId)
      }
      const sourceIdentity = result.page
        ? candidateIdentity(new URL(result.page.source))
        : null
      if (result.page && sourceIdentity && !seenSources.has(sourceIdentity)
        && !seenIds.has(result.page.id) && pages.length < maxPages) {
        pages.push(result.page)
        if ('pageWarnings' in result && result.pageWarnings) {
          for (const message of result.pageWarnings) warnings.push({ code: 'unsupported-config', message, source: result.page.source })
        }
        if ('openApiFragment' in result && result.openApiFragment) {
          openApiFragments.push(result.openApiFragment)
        }
        seenIds.add(result.page.id)
        seenSources.add(sourceIdentity)
      }
      if (platform === 'docusaurus' && result.page) {
        const candidateRoute = docusaurusRouteIdForUrl(result.candidate, scopePath)
        if (candidateRoute && candidateRoute !== result.page.navigationId) {
          docusaurusRedirects.push({
            source: candidateRoute === 'introduction' ? '/' : `/${candidateRoute}`,
            destination: result.page.navigationId === 'introduction' ? '/' : `/${result.page.navigationId}`,
          })
        }
      }
      if ('sidebar' in result && result.sidebar) docusaurusSidebars.push(result.sidebar)
      for (const link of result.links) enqueue(link, result.base ?? result.candidate)
    }
  }

  if (pages.length === 0) throw new Error('No readable documentation pages were found at that URL.')
  for (const page of pages) {
    const [locale, ...navigationSegments] = page.id.split('/')
    if (LOCALE_CODES.has(locale)) {
      if (navigationSegments.length === 0) page.id = `${locale}/introduction`
      page.locale = locale
      page.navigationId = navigationSegments.join('/') || 'introduction'
    }
  }
  const importedIds = new Set(pages.map((page) => page.navigationId))
  for (const page of pages) {
    page.body = rewriteInternalLinks(
      page.body,
      new URL(page.source),
      source,
      scopePath,
      importedIds,
      sourceHomePageId,
    )
  }
  if (isByteBudgetExhausted) {
    warnings.push({ code: 'limit-reached', message: `Import stopped after reaching the ${Math.round(maxTotalBytes / 1_000_000)} MB content budget.` })
  } else if (queue.length > 0 || queued.size >= MAX_DISCOVERED_URLS) {
    warnings.push({ code: 'limit-reached', message: `Import stopped after ${pages.length} pages; narrow the URL or raise the caller limit to import more.` })
  }
  const topLevelNavigation = sourceTopLevelNavigation?.map((entry) => ({
    ...entry,
    pageId: entry.pageId === sourceHomePageId ? 'introduction' : entry.pageId,
  }))
  let docsConfig = platform === 'docusaurus'
    ? docusaurusNavigationFromSnapshots(docusaurusSidebars, pages, scopePath)
    : hasStructuredMintlifyNavigation && sourceMintlifyProjection
      ? remapNavigationHome(sourceMintlifyProjection.docsConfig, sourceHomePageId)
      : buildNavigationFromPages(pages, {
          topLevelTabs: platform === 'mintlify',
          topLevelNavigation,
        })
  if (sourceMintlifyProjection) warnings.push(...sourceMintlifyProjection.warnings)
  if (sourceMintlifyConfig) {
    const analytics = projectMintlifyIntegrations(sourceMintlifyConfig)
    warnings.push(...analytics.warnings)
    if (analytics.integrations) docsConfig.integrations = analytics.integrations
  }
  if (docusaurusRedirects.length > 0) {
    docsConfig.redirects = [...new Map(docusaurusRedirects.map((redirect) => [
      `${redirect.source}:${redirect.destination}`,
      redirect,
    ])).values()]
  }
  const openApiAsset = mergeEmbeddedOpenApi(openApiFragments)
  if (openApiAsset) {
    const operationPageIds = new Set(pages.filter((page) => page.openapi).map((page) => page.navigationId))
    const containsOperation = (
      navigationPages: Array<string | MigrationNavigationGroup> = [],
    ): boolean => navigationPages.some((page) => typeof page === 'string'
      ? operationPageIds.has(page)
      : containsOperation(page.pages))
    const apiTab = docsConfig.tabs.find((tab) => (
      containsOperation(tab.pages) || containsOperation(tab.groups)
    )) ?? docsConfig.tabs[0]
    if (apiTab) {
      // Migrated operation pages preserve the source URLs and sidebar order.
      // The spec is still configured for operation rendering, but its derived
      // `/api/*` navigation would duplicate every imported endpoint.
      apiTab.api = { source: '/openapi.yaml', navigation: false }
    }
  }
  const locales = [...new Set(pages.map((page) => page.locale).filter((value): value is string => Boolean(value)))]
  if (locales.length > 0) {
    docsConfig.i18n = {
      defaultLocale: 'en',
      locales: [
        { code: 'en', label: 'English' },
        ...locales.filter((locale) => locale !== 'en').map((locale) => ({ code: locale, label: locale.toUpperCase() })),
      ],
    }
  }
  if (platform === 'mintlify') docsConfig = addMintlifyDirectoryRedirects(docsConfig, pages)
  return {
    sourceUrl: source.toString(),
    sourceKind: 'url',
    platform,
    pages,
    assets: openApiAsset ? [{ path: 'openapi.yaml', content: openApiAsset }] : [],
    docsConfig,
    ...(sourceMintlifyConfig ? {
      site: {
        ...(typeof sourceMintlifyConfig.name === 'string' ? { name: sourceMintlifyConfig.name } : {}),
        ...(typeof sourceMintlifyConfig.description === 'string' ? { description: sourceMintlifyConfig.description } : {}),
      },
    } : {}),
    warnings,
    stats: {
      discovered: visited.size,
      imported: pages.length,
      skipped: Math.max(0, visited.size - pages.length),
    },
  }
}
