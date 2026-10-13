import { searchDocs, searchSections } from '@/lib/search/engine'
import { loadListedDocEntries } from '@/lib/search/register-doc-source'
import { loadContentDocument } from '@/lib/content'
import { canReaderViewPage, loadDocEntries } from '@/data/docs'
import { getAllApiOperationNodes, getApiOperationBySlug } from '@/data/api-reference'
import { computePublishedAgentReadiness } from '@/lib/agent-readiness'
import { filterChangesSince, loadChangelog, parseChangelogDate } from '@/lib/changelog'
import { hasDocTranslation } from '@/lib/i18n/translation-source'
import { localizedPath } from '@/lib/i18n/config'
import { getEffectiveI18nConfig } from '@/lib/i18n/request'
import {
  apiOperationId,
  describeApiOperation,
  summarizeApiOperation,
  type ApiOperationDetail,
} from '@/lib/openapi/operation-projection'
import { toolMetadata, type McpToolMetadata } from '@/lib/mcp/tool-metadata'
import { getReaderAuthConfig } from '@/lib/reader-auth/config'
import { ANONYMOUS_READER, canReaderAccessUnmarkedContent, type ReaderContext } from '@/lib/reader-auth/access'

/**
 * The tools the remote MCP endpoint exposes to any attached agent. Unlike
 * the `packages/mcp` tools (which operate on a local project directory), these
 * run against the deployed site's own content engine — so an agent attached over
 * HTTP reads exactly what the site serves.
 *
 * Name/title/description/schemas/annotations are NOT declared here — they live
 * in the dependency-free `tool-metadata.ts` (single source of truth). This file
 * is the SERVER tool source: it attaches content-engine-backed handlers.
 *
 * Every handler returns both `structuredContent` (matching the tool's
 * `outputSchema`) and a readable text rendering for clients that predate
 * structured output. Each projection reuses the surface the rest of the site
 * uses: search and listings go through the registered search resolver (so
 * hidden/noindex rules match search exactly), pages through the structured
 * content document (the same Markdown as `.md` mirrors), operations through
 * `operation-projection`, changes through `@/lib/changelog`.
 *
 * Reader access: page listings, page reads, API operations and changes take
 * the request's reader (`McpToolContext.reader`, anonymous when absent), so a
 * signed-in agent sees exactly the pages it may open and nothing more. Search
 * stays anonymous: its corpus is shared by every caller.
 */

export interface McpToolContext {
  /** Request origin; every URL a tool returns is absolute against it. */
  origin: string
  /** The verified reader behind the request. Omitted means anonymous (fail closed). */
  reader?: ReaderContext
}

export interface McpToolResult {
  text: string
  structured: Record<string, unknown>
}

export interface McpTool extends McpToolMetadata {
  handler: (args: Record<string, unknown>, context: McpToolContext) => Promise<McpToolResult>
}

const TOOL_INPUT_ERROR = Symbol('mcp-tool-input-error')

/**
 * A problem with the caller's arguments. Surfaced verbatim as a tool
 * execution error (`isError: true`) so the model can correct itself; any other
 * thrown error is reported generically, never with its internal message.
 */
export function toolInputError(message: string): Error {
  return Object.assign(new Error(message), { [TOOL_INPUT_ERROR]: true })
}

export function isToolInputError(error: unknown): error is Error {
  return error instanceof Error && (error as unknown as Record<symbol, unknown>)[TOOL_INPUT_ERROR] === true
}

function requiredString(args: Record<string, unknown>, name: string): string {
  const value = args[name]
  if (typeof value !== 'string' || !value.trim()) throw toolInputError(`Provide a non-empty "${name}".`)
  return value.trim()
}

function optionalString(args: Record<string, unknown>, name: string): string | undefined {
  const value = args[name]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw toolInputError(`"${name}" must be a string.`)
  return value.trim() || undefined
}

function boundedLimit(args: Record<string, unknown>, fallback: number, max: number): number {
  const value = args.limit
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value)) throw toolInputError('"limit" must be a number.')
  return Math.min(Math.max(1, Math.floor(value)), max)
}

export interface ResolvedLocale {
  /** Effective locale code reported back to the caller. */
  code: string
  defaultLocale: string
  /** The locale to pass to engine calls: undefined for the default locale. */
  engineLocale?: string
}

/** Validate an optional `locale` argument against the site's enabled languages. */
export async function resolveLocaleArg(args: Record<string, unknown>): Promise<ResolvedLocale> {
  const requested = optionalString(args, 'locale')
  const i18n = await getEffectiveI18nConfig()
  if (!requested || requested === i18n.defaultLocale) return { code: i18n.defaultLocale, defaultLocale: i18n.defaultLocale }
  if (!i18n.locales.some((locale) => locale.code === requested)) {
    const enabled = i18n.locales.map((locale) => locale.code).join(', ')
    throw toolInputError(`Unsupported locale "${requested}". Enabled locales: ${enabled}.`)
  }
  return { code: requested, defaultLocale: i18n.defaultLocale, engineLocale: requested }
}

/**
 * Indexable pages for a locale as `reader` sees them — the listing rule search
 * ranks over (hidden, noindex and older-version pages excluded; translations
 * only where a translated page exists), applied to the pages the reader may
 * open. Anonymous by default, which is exactly the search corpus. Shared with
 * `resources/list` and `llms-full.txt`.
 */
export async function listAgentPages(locale?: string, reader: ReaderContext = ANONYMOUS_READER) {
  return loadListedDocEntries(locale, reader)
}

/** Whether `reader` may see generated API operations (content without page frontmatter). */
export function canReaderSeeApiOperations(reader: ReaderContext = ANONYMOUS_READER): boolean {
  return canReaderAccessUnmarkedContent(reader, getReaderAuthConfig())
}

/** Published API operations visible to `reader`: none when the site default hides unmarked content. */
export async function loadVisibleApiOperationNodes(reader: ReaderContext = ANONYMOUS_READER) {
  return canReaderSeeApiOperations(reader) ? getAllApiOperationNodes() : []
}

/**
 * Resolve a page id or URL path to a KNOWN published entry. Never pass the raw
 * argument to the content resolver: it path-joins under `src/content`, so a
 * "../" would escape and read arbitrary .mdx files on the public endpoint.
 * Hidden and noindex pages resolve here, as their `.md` mirrors do; pages the
 * reader may not open do not resolve at all (answered like a missing page).
 */
export async function findPublishedEntry(raw: string, reader: ReaderContext = ANONYMOUS_READER) {
  const normalized = raw.trim().replace(/^\/+|\/+$/g, '').replace(/\.md$/, '')
  // The root page has an empty slug, so "/" resolves to it.
  return (await loadDocEntries(reader)).find((entry) => entry.id === normalized || entry.slug.join('/') === normalized)
}

/**
 * The agent Markdown projection of one published page, localized when a
 * translation exists. Null when the page does not exist or `reader` may not
 * open it — including a translation that restricts its page further than the
 * primary file.
 */
export async function readAgentPage(pageId: string, locale: ResolvedLocale, origin: string, reader: ReaderContext = ANONYMOUS_READER) {
  const entry = await findPublishedEntry(pageId, reader)
  if (!entry) return null
  const isTranslated = Boolean(locale.engineLocale && await hasDocTranslation(entry.slug, locale.engineLocale))
  if (isTranslated && !(await canReaderViewPage(entry.id, reader, locale.engineLocale))) return null
  const document = await loadContentDocument(entry.id, isTranslated ? locale.engineLocale : undefined)
  if (!document) return null
  const servedLocale = isTranslated ? locale.code : locale.defaultLocale
  const title = typeof document.frontmatter.title === 'string' ? document.frontmatter.title : entry.title
  const description = typeof document.frontmatter.description === 'string' ? document.frontmatter.description : entry.description
  return {
    page_id: entry.id,
    title,
    description,
    url: `${origin}${localizedPath(entry.href, servedLocale, locale.defaultLocale)}`,
    locale: servedLocale,
    markdown: document.content.markdown,
    headings: document.content.headings.map(({ depth, text, id }) => ({ depth, text, id })),
  }
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

async function findOperation(args: Record<string, unknown>, reader: ReaderContext) {
  const requestedOperationId = optionalString(args, 'operationId')
  const operationId = requestedOperationId?.replace(/^\/+|\/+$/g, '')
  const method = optionalString(args, 'method')?.toUpperCase()
  const path = optionalString(args, 'path')
  if (!operationId && !(method && path)) throw toolInputError('Provide "operationId", or both "method" and "path".')
  const nodes = await loadVisibleApiOperationNodes(reader)
  if (nodes.length === 0) return undefined
  if (operationId) {
    // A leading slash explicitly selects the rendered page, not an operation
    // id: /api/users/post may render the default spec while api/users/post is
    // the exact id of an operation in a different spec named "api".
    if (requestedOperationId?.startsWith('/api/')) {
      const page = await getApiOperationBySlug(operationId.slice(4).split('/'))
      return page ? nodes.find((node) => apiOperationId(node) === apiOperationId(page)) : undefined
    }
    // Also accept the page path ("api/default/users/post"); an exact id wins,
    // since a spec may itself be named "api".
    const exact = nodes.find((node) => apiOperationId(node) === operationId)
      ?? nodes.find((node) => `api/${apiOperationId(node)}` === operationId)
    if (exact) return exact
    // Browser context may use the default-spec alias the renderer accepts.
    // Resolve through the renderer's helper, then enforce the visible registry.
    const alias = operationId.startsWith('api/')
      ? await getApiOperationBySlug(operationId.slice(4).split('/'))
      : null
    return alias ? nodes.find((node) => apiOperationId(node) === apiOperationId(alias)) : undefined
  }
  return nodes.find((node) => node.operation.method.toUpperCase() === method && node.operation.path === path)
}

function operationText(detail: ApiOperationDetail): string {
  const lines = [`${detail.method} ${detail.path} — ${detail.title}`, detail.url, '', detail.description, '']
  if (detail.auth.schemes.length) {
    lines.push(`Auth${detail.auth.required ? '' : ' (optional)'}: ${detail.auth.schemes.map((scheme) => `${scheme.kind} via ${scheme.in} "${scheme.param_name}"`).join(' or ')}`, '')
  }
  if (detail.parameters.length) {
    lines.push('Parameters:')
    for (const param of detail.parameters) lines.push(`- ${param.name} (${param.in}${param.required ? ', required' : ''})${param.description ? `: ${param.description}` : ''}`)
    lines.push('')
  }
  if (detail.request_body) lines.push(`Request body (${detail.request_body.content_type}):`, JSON.stringify(detail.request_body.schema ?? {}, null, 2), '')
  if (detail.responses.length) lines.push(`Responses: ${detail.responses.map((response) => `${response.status}${response.description ? ` ${response.description}` : ''}`).join('; ')}`, '')
  if (detail.example.curl) lines.push('Example:', detail.example.curl, '')
  return lines.join('\n').trim()
}

/** Server-side handlers, keyed by tool name. Joined to the shared metadata below. */
const handlers: Record<string, McpTool['handler']> = {
  search_docs: async (args, { origin }) => {
    const query = requiredString(args, 'query')
    const limit = boundedLimit(args, 8, 25)
    const locale = await resolveLocaleArg(args)
    // Full-text only: hybrid mode embeds the query per call — too costly for a
    // public, anonymous endpoint. Rate-limited on top of this.
    const hits = await searchDocs(query, { limit, mode: 'fulltext', locale: locale.engineLocale })
    const results = hits.map((hit) => ({
      type: hit.type,
      id: hit.pageId,
      title: hit.title,
      description: hit.description,
      url: `${origin}${hit.href}`,
      ...(hit.anchor ? { section_url: `${origin}${hit.href}#${hit.anchor}`, heading: hit.heading ?? '' } : {}),
      snippet: hit.snippet,
      score: hit.score,
      ...(hit.method ? { method: hit.method } : {}),
      ...(hit.path ? { path: hit.path } : {}),
    }))
    const text = results.length === 0
      ? `No results for "${query}".`
      : results
          .map((hit, i) => `${i + 1}. ${hit.type === 'api_operation' ? `[API ${hit.method} ${hit.path}] ` : ''}${hit.title} — ${hit.section_url ?? hit.url}\n   id: ${hit.id}\n   ${hit.snippet}`)
          .join('\n\n')
    return { text, structured: { query, locale: locale.code, results } }
  },
  search_sections: async (args, { origin }) => {
    const query = requiredString(args, 'query')
    const limit = boundedLimit(args, 5, 20)
    const locale = await resolveLocaleArg(args)
    const hits = await searchSections(query, { limit, locale: locale.engineLocale })
    const results = hits.map((hit) => ({
      page_id: hit.pageId,
      title: hit.title,
      heading: hit.heading,
      heading_path: hit.headingPath,
      url: `${origin}${hit.href}`,
      section_url: `${origin}${hit.href}${hit.anchor ? `#${hit.anchor}` : ''}`,
      content: hit.content,
      score: hit.score,
    }))
    const text = results.length === 0
      ? `No sections match "${query}".`
      : results
          .map((hit, i) => `${i + 1}. ${hit.title} › ${hit.heading_path.join(' › ')} — ${hit.section_url}\n\n${hit.content}`)
          .join('\n\n---\n\n')
    return { text, structured: { query, locale: locale.code, results } }
  },
  read_page: async (args, { origin, reader }) => {
    const pageId = requiredString(args, 'pageId')
    const locale = await resolveLocaleArg(args)
    const page = await readAgentPage(pageId, locale, origin, reader)
    if (!page) throw toolInputError(`No page found for "${pageId}". Call list_pages to see valid page IDs.`)
    return { text: page.markdown, structured: page }
  },
  list_pages: async (args, { origin, reader }) => {
    const locale = await resolveLocaleArg(args)
    const pages = (await listAgentPages(locale.engineLocale, reader)).map((entry) => ({
      page_id: entry.id,
      title: entry.title,
      description: entry.description,
      url: `${origin}${entry.href}`,
    }))
    const text = pages.length === 0
      ? 'This site has no documentation pages yet.'
      : pages.map((page) => `- ${page.page_id} — ${page.title} (${page.url})`).join('\n')
    return { text, structured: { locale: locale.code, total: pages.length, pages } }
  },
  list_api_operations: async (args, { origin, reader }) => {
    const query = optionalString(args, 'query')?.toLowerCase()
    const tag = optionalString(args, 'tag')?.toLowerCase()
    const limit = boundedLimit(args, 50, 200)
    const matching = (await loadVisibleApiOperationNodes(reader))
      .map((node) => summarizeApiOperation(node, origin))
      .filter((operation) => !tag || operation.tags.some((candidate) => candidate.toLowerCase() === tag))
      .filter((operation) => !query || [operation.method, operation.path, operation.title, operation.description, operation.group]
        .some((field) => field.toLowerCase().includes(query)))
    const operations = matching.slice(0, limit)
    const text = operations.length === 0
      ? 'No API operations match.'
      : [
          `${plural(matching.length, 'operation')}${matching.length > operations.length ? ` (showing ${operations.length})` : ''}:`,
          ...operations.map((operation) => `- ${operation.method} ${operation.path} — ${operation.title} (id: ${operation.id})`),
        ].join('\n')
    return { text, structured: { total: matching.length, operations } }
  },
  get_api_operation: async (args, { origin, reader }) => {
    const node = await findOperation(args, reader ?? ANONYMOUS_READER)
    if (!node) throw toolInputError('No published API operation matches. Call list_api_operations to see valid ids.')
    const detail = describeApiOperation(node, origin)
    return { text: operationText(detail), structured: detail as unknown as Record<string, unknown> }
  },
  list_changes: async (args, { origin, reader }) => {
    const since = optionalString(args, 'since')
    if (since && !parseChangelogDate(since)) throw toolInputError(`"since" must be an ISO date such as "2026-01-31"; got "${since}".`)
    const limit = boundedLimit(args, 20, 100)
    const locale = await resolveLocaleArg(args)
    const changelog = await loadChangelog({ origin, locale: locale.engineLocale, defaultLocale: locale.defaultLocale, reader })
    const matching = filterChangesSince(changelog.entries, since)
    const entries = matching.slice(0, limit).map((entry) => ({
      id: entry.id,
      title: entry.title,
      label: entry.label,
      ...(entry.date ? { date: entry.date } : {}),
      ...(entry.published ? { published: entry.published } : {}),
      ...(entry.description ? { description: entry.description } : {}),
      tags: entry.tags,
      url: entry.url,
      markdown: entry.markdown,
    }))
    const text = !changelog.pageUrl
      ? 'This site has no changelog page.'
      : entries.length === 0
        ? `No changelog entries${since ? ` since ${since}` : ''}.`
        : entries.map((entry) => `## ${entry.title}${entry.date ? ` (${entry.date})` : ''}\n${entry.url}\n\n${entry.markdown}`).join('\n\n')
    return { text, structured: { changelog_url: changelog.pageUrl, total: matching.length, entries } }
  },
  agent_readiness: async () => {
    const report = await computePublishedAgentReadiness()
    const lines = [
      `Agent Readiness: ${report.score}/100 (grade ${report.grade}) across ${plural(report.totalPages, 'page')}.`,
      '',
    ]
    // Newer reports mark checks that do not apply with `status: 'skip'` (score
    // 1); show those as n/a rather than a misleading 100%. Older reports have
    // no status field and render as before.
    const isSkipped = (sub: object) => (sub as { status?: unknown }).status === 'skip'
    for (const sub of report.subscores) {
      const value = isSkipped(sub) ? 'n/a' : `${Math.round(sub.score * 100)}%`
      lines.push(`- ${sub.label}: ${value} (weight ${Math.round(sub.weight * 100)}%) — ${sub.detail}`)
    }
    return {
      text: lines.join('\n'),
      structured: {
        score: report.score,
        grade: report.grade,
        total_pages: report.totalPages,
        subscores: report.subscores.map((sub) => ({
          label: sub.label,
          score: sub.score,
          weight: sub.weight,
          detail: sub.detail,
          ...(isSkipped(sub) ? { status: 'skip' } : {}),
        })),
      },
    }
  },
}

// Join the shared metadata to its server handlers. Order is preserved from
// `toolMetadata`, so `tools/list` output order is stable.
export const siteTools: Array<McpTool> = toolMetadata.map((meta) => ({
  ...meta,
  handler: handlers[meta.name],
}))

export function getSiteTool(name: string): McpTool | undefined {
  return siteTools.find((tool) => tool.name === name)
}
