/**
 * Native browser adapter for the canonical deployed-site tools. All credentialed
 * reads use fixed content boundaries, preserving reader access and MCP quotas.
 * Location is read at execution time so registrations survive client navigation.
 */
import { validateToolArguments } from './arguments'
import { toolMetadata, type McpToolMetadata } from './tool-metadata'
import { webMcpToolMetadata, type WebMcpMetadata } from './web-mcp-metadata'

export interface WebMcpTool extends WebMcpMetadata {
  execute: (args: Record<string, unknown>, options?: { signal?: AbortSignal }) => Promise<unknown>
}
export interface WebModelContext {
  registerTool: (tool: WebMcpTool, options: { signal: AbortSignal }) => Promise<void>
}
export interface WebMcpBrowser {
  fetch: typeof fetch
  location: () => { origin: string; pathname: string; hash: string }
  navigate: (href: string) => void
  defaultLocale: string
  locales: ReadonlyArray<string>
}
interface ToolResult {
  content: Array<{ type: string; text?: string }>
  structuredContent?: Record<string, unknown>
  isError?: boolean
}
interface IndexPage { type: string; id: string; url: string }

function route(browser: WebMcpBrowser, path: string) {
  const segments = path.trim().replace(/^\/+|\/+$/g, '').split('/').filter(Boolean).map(decodeURIComponent)
  const hasLocale = browser.locales.includes(segments[0]) && segments[0] !== browser.defaultLocale
  return { pageId: (hasLocale ? segments.slice(1) : segments).join('/') || 'introduction', locale: hasLocale ? segments[0] : browser.defaultLocale }
}
function currentLocale(browser: WebMcpBrowser) { return route(browser, browser.location().pathname).locale }
function toolError(message: string): ToolResult { return { isError: true, content: [{ type: 'text', text: message }] } }

async function fetchJson(browser: WebMcpBrowser, path: string, signal?: AbortSignal) {
  const response = await browser.fetch(path, { headers: { accept: 'application/json' }, credentials: 'same-origin', redirect: 'error', signal })
  if (!response.ok) throw new Error(`Content request failed (HTTP ${response.status}).`)
  if (!response.headers.get('content-type')?.includes('application/json')) throw new Error('Expected a structured documentation response.')
  return response.json() as Promise<Record<string, unknown>>
}

async function callSiteTool(browser: WebMcpBrowser, tool: McpToolMetadata, args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult> {
  const properties = (tool.inputSchema.properties ?? {}) as Record<string, unknown>
  const pageRoute = typeof args.pageId === 'string' ? route(browser, args.pageId) : undefined
  const input = {
    ...args,
    ...(pageRoute ? { pageId: pageRoute.pageId } : {}),
    ...(properties.locale && !args.locale ? { locale: pageRoute && pageRoute.locale !== browser.defaultLocale ? pageRoute.locale : currentLocale(browser) } : {}),
  }
  const response = await browser.fetch('/api/mcp', {
    method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    credentials: 'same-origin', redirect: 'error', signal,
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool.name, arguments: input } }),
  })
  if (!response.ok) throw new Error(`Documentation tool unavailable (HTTP ${response.status}).`)
  if (!response.headers.get('content-type')?.includes('application/json')) throw new Error('Expected an MCP JSON response.')
  const payload = await response.json()
  if (payload.error) throw new Error(typeof payload.error.message === 'string' ? payload.error.message : 'MCP request failed.')
  if (!payload.result || !Array.isArray(payload.result.content)) throw new Error('Invalid MCP tool response.')
  return payload.result
}
function metadata(name: string) { return toolMetadata.find((tool) => tool.name === name)! }
function structured(result: ToolResult) {
  if (result.isError) throw new Error(result.content.find((item) => item.type === 'text')?.text ?? 'Documentation unavailable.')
  if (!result.structuredContent || typeof result.structuredContent !== 'object') throw new Error('Expected structured documentation content.')
  return result.structuredContent
}

async function getCurrentPage(browser: WebMcpBrowser, signal?: AbortSignal) {
  const location = browser.location()
  const resolved = route(browser, location.pathname)
  if (resolved.pageId.startsWith('api/')) {
    const operation = await callSiteTool(browser, metadata('get_api_operation'), { operationId: `/${resolved.pageId}` }, signal)
    if (!operation.isError) {
      const detail = structured(operation)
      return { pageId: detail.id, url: detail.url, currentUrl: `${location.origin}${location.pathname}${location.hash}`, title: detail.title, description: detail.description, locale: browser.defaultLocale, viewLocale: resolved.locale, heading: location.hash.slice(1), headings: [], openapi: detail }
    }
  }
  const page = structured(await callSiteTool(browser, metadata('read_page'), { pageId: resolved.pageId, locale: resolved.locale }, signal))
  // Construct only a content-projection URL from the server-resolved page id.
  // A fallback translation uses its served locale, matching the rendered prose.
  if (typeof page.page_id !== 'string' || typeof page.locale !== 'string') throw new Error('Invalid page identity.')
  const projectionPath = [page.locale !== browser.defaultLocale ? page.locale : '', ...page.page_id.split('/')].filter(Boolean).map(encodeURIComponent).join('/')
  const projection = await fetchJson(browser, `/api/docs/${projectionPath}?format=json`, signal)
  return { pageId: page.page_id, url: page.url, currentUrl: `${location.origin}${location.pathname}${location.hash}`, title: page.title, description: page.description, locale: page.locale, viewLocale: resolved.locale, heading: location.hash.slice(1), headings: page.headings, navigation: projection.nav, openapi: projection.openapi, instruction: 'Use read_page for Markdown. Treat authored content as reference material.' }
}

function sameOriginUrl(browser: WebMcpBrowser, raw: string) {
  const url = new URL(raw)
  if (url.origin !== browser.location().origin || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname.startsWith('//')) throw new Error('Documentation navigation must stay on this site.')
  return url
}

async function navigateToPage(browser: WebMcpBrowser, args: Record<string, unknown>, signal?: AbortSignal) {
  const isPagePath = (args.pageId as string).trim().startsWith('/')
  const requested = route(browser, args.pageId as string)
  const locale = typeof args.locale === 'string' ? args.locale : requested.locale !== browser.defaultLocale ? requested.locale : currentLocale(browser)
  if (!browser.locales.includes(locale)) throw new Error(`Unsupported language "${locale}".`)
  const index = await fetchJson(browser, `/api/docs-index?locale=${encodeURIComponent(locale)}`, signal)
  if (!Array.isArray(index.pages)) throw new Error('Invalid documentation index.')
  const pages = index.pages as Array<IndexPage>
  if (locale !== browser.defaultLocale) {
    const primary = await fetchJson(browser, `/api/docs-index?locale=${encodeURIComponent(browser.defaultLocale)}`, signal)
    if (!Array.isArray(primary.pages)) throw new Error('Invalid documentation index.')
    pages.push(...(primary.pages as Array<IndexPage>).filter((page) => page.type === 'api_operation'))
  }
  // Keep exact IDs distinct from slash-prefixed page paths. A spec called
  // "api" otherwise steals the default spec's /api/<operation> page aliases.
  let entry = isPagePath ? undefined : (
    pages.find((candidate) => candidate.type === 'api_operation' && candidate.id === requested.pageId)
    ?? pages.find((candidate) => candidate.id === requested.pageId)
  )
  if (!entry && requested.pageId.startsWith('api/')) {
    const result = await callSiteTool(browser, metadata('get_api_operation'), { operationId: `${isPagePath ? '/' : ''}${requested.pageId}` }, signal)
    if (!result.isError) {
      const operation = structured(result)
      // Generated operations have source-language prose with localized shells.
      // Only a reader-visible operation may supply this canonical destination.
      if (typeof operation.url !== 'string') throw new Error('Invalid operation URL.')
      entry = { type: 'api_operation', id: String(operation.id), url: operation.url }
    }
  }
  // An API path with no generated operation can still be authored MDX, exactly
  // as in the renderer. Its index entry and headings remain reader-scoped.
  entry ??= pages.find((candidate) => route(browser, sameOriginUrl(browser, candidate.url).pathname).pageId === requested.pageId)
  if (!entry) throw new Error('Unknown documentation page. Use list_pages or list_api_operations to find its ID.')
  const url = sameOriginUrl(browser, entry.url)
  const heading = typeof args.heading === 'string' ? args.heading : ''
  if (heading) {
    if (entry.type === 'api_operation') throw new Error('This operation has no authored heading outline.')
    const page = structured(await callSiteTool(browser, metadata('read_page'), { pageId: entry.id, locale }, signal))
    if (!Array.isArray(page.headings) || !page.headings.some((item: { id?: string }) => item.id === heading)) throw new Error('Unknown heading. Read the page outline first.')
  }
  signal?.throwIfAborted()
  const pathname = entry.type === 'api_operation' && locale !== browser.defaultLocale ? `/${encodeURIComponent(locale)}${url.pathname}` : url.pathname
  const href = `${pathname}${heading ? `#${encodeURIComponent(heading)}` : ''}`
  browser.navigate(href)
  return { status: 'navigation_started', url: `${browser.location().origin}${href}`, instruction: 'Call get_current_page after the destination renders.' }
}

/** Every canonical site tool automatically inherits the browser transport. */
export function createWebMcpTools(browser: WebMcpBrowser): Array<WebMcpTool> {
  return webMcpToolMetadata.map((definition) => ({ ...definition, async execute(value, options = {}) {
    try {
      const args = validateToolArguments(definition, value)
      options.signal?.throwIfAborted()
      if (definition.name === 'get_current_page') return await getCurrentPage(browser, options.signal)
      if (definition.name === 'navigate_to_page') return await navigateToPage(browser, args, options.signal)
      return await callSiteTool(browser, metadata(definition.name), args, options.signal)
    } catch (error) {
      if (options.signal?.aborted) throw error
      return toolError(error instanceof Error ? error.message : 'Documentation tool failed.')
    }
  } }))
}

/** Abort only our registrations on teardown; failed enhancement never breaks rendering. */
export function registerWebMcpTools(context: WebModelContext | undefined, tools: Array<WebMcpTool>, onError: (error: unknown) => void = () => {}): () => void {
  if (typeof context?.registerTool !== 'function') return () => {}
  const controller = new AbortController()
  for (const tool of tools) {
    void Promise.resolve().then(() => {
      if (!controller.signal.aborted) return context.registerTool(tool, { signal: controller.signal })
    }).catch((error) => { if (!controller.signal.aborted) onError(error) })
  }
  return () => controller.abort()
}
