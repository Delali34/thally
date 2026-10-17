import { type NextRequest } from 'next/server'
import { AsyncLocalStorage } from 'node:async_hooks'
import { type ApiOperationNode } from '@/data/api-reference'
import { loadDocEntries, loadSidebarCollections } from '@/data/docs'
import { loadContentDocument } from '@/lib/content'
import { problemResponse } from '@/lib/http/problem'
import { getEffectiveI18nConfig } from '@/lib/i18n/request'
import { listAgentPages, loadVisibleApiOperationNodes } from '@/lib/mcp/site-tools'
import { apiOperationMarkdown, describeApiOperation } from '@/lib/openapi/operation-projection'
import { resolveRequestSiteConfig } from '@/lib/site-config'
import { getReaderContextFromRequest } from '@/lib/reader-auth/context'
import { contentCacheControl } from '@/lib/reader-auth/cache'

/**
 * `llms-full.txt` — the whole documentation corpus as one Markdown file.
 *
 * Built from the same projections every other agent surface uses, so they
 * cannot disagree:
 * - Pages: the structured content document's agent Markdown
 *   (`content.markdown`), byte-identical to MCP `read_page` and the `.md`
 *   mirrors. `<Visibility for="humans">` / `<Human>` content never appears,
 *   and every MDX component is projected to Markdown (no raw JSX).
 * - Which pages: the search listing (`listAgentPages`), so hidden, noindex
 *   and older-version pages are left out exactly as search leaves them out.
 *   Pages appear in sidebar order, then any indexable page outside the
 *   sidebar.
 * - API operations: the compact operation projection MCP resources use,
 *   after the pages (default locale only; operations are not translated).
 *
 * - Reader access: the corpus is the request reader's view (anonymous unless
 *   reader auth is active and a token/session is presented), so restricted
 *   pages and — on a private-by-default site — API operations appear only for
 *   readers allowed to open them; such responses are never shared-cached.
 *
 * `?locale=<code>` returns a translated corpus containing only translated
 * pages. The response is pulled one page at a time, so it deliberately omits
 * a whole-body token estimate: computing that header would buffer the corpus
 * or fetch/parse it twice before sending the first byte.
 */
export async function GET(request: NextRequest) {
  // Under the assets ContentSource this route must render per request — the
  // corpus below reflects published content, not the build. No-op by default.
  const effectiveSite = await resolveRequestSiteConfig()
  const baseUrl = request.nextUrl.origin

  const i18n = await getEffectiveI18nConfig()
  const requestedLocale = request.nextUrl.searchParams.get('locale')
  if (requestedLocale && !i18n.locales.some((locale) => locale.code === requestedLocale)) {
    return problemResponse({
      status: 400,
      code: 'invalid_locale',
      title: 'Unsupported language',
      detail: 'The requested locale is not enabled for this site.',
      resolution: 'Use a language code enabled in the site configuration.',
      instance: request.nextUrl.pathname,
    })
  }
  const locale = requestedLocale ?? i18n.defaultLocale
  const engineLocale = locale === i18n.defaultLocale ? undefined : locale

  const reader = await getReaderContextFromRequest(request)
  const [entries, listable, collections, apiNodes] = await Promise.all([
    loadDocEntries(reader),
    listAgentPages(engineLocale, reader),
    loadSidebarCollections(undefined, reader),
    // An unreachable remote spec must not take the page corpus down with it.
    engineLocale
      ? Promise.resolve([] as Array<ApiOperationNode>)
      : loadVisibleApiOperationNodes(reader).catch(() => [] as Array<ApiOperationNode>),
  ])

  // Sidebar items carry default-locale hrefs; map them back to page ids, then
  // keep only pages the search listing includes for this locale.
  const idByHref = new Map(entries.map((entry) => [entry.href, entry.id]))
  const listableById = new Map(listable.map((entry) => [entry.id, entry]))
  const apiNodeByHref = new Map(apiNodes.map((node) => [node.href, node]))

  const pageOrder: Array<string> = []
  const operationOrder: Array<ApiOperationNode> = []
  const seenPages = new Set<string>()
  const seenOperations = new Set<ApiOperationNode>()
  for (const collection of collections) {
    const hrefs = [
      ...(collection.sections.length === 0 && collection.href ? [collection.href] : []),
      ...collection.sections.flatMap((section) => section.items.map((item) => item.href)),
    ]
    for (const href of hrefs) {
      const node = apiNodeByHref.get(href)
      if (node && !seenOperations.has(node)) {
        seenOperations.add(node)
        operationOrder.push(node)
        continue
      }
      const id = idByHref.get(href)
      if (id && listableById.has(id) && !seenPages.has(id)) {
        seenPages.add(id)
        pageOrder.push(id)
      }
    }
  }
  for (const entry of listable) if (!seenPages.has(entry.id)) pageOrder.push(entry.id)
  for (const node of apiNodes) if (!seenOperations.has(node)) operationOrder.push(node)

  const lines: Array<string> = []
  lines.push(`# ${effectiveSite.name} — Complete Documentation`)
  lines.push('')
  lines.push(`> ${effectiveSite.description}`)
  lines.push('')
  lines.push(`Source: ${baseUrl}`)
  lines.push(`Language: ${locale}`)
  lines.push('')
  lines.push('## Instructions for agents')
  lines.push('')
  lines.push(`- Use ${baseUrl}/llms.txt to inspect the page index before scanning this full corpus.`)
  lines.push(`- Use ${baseUrl}/skill.md for retrieval rules and ${baseUrl}/AGENTS.md before editing.`)
  lines.push(`- Use ${baseUrl}/api/mcp for read-only search, section retrieval, page, API and changelog tools.`)
  lines.push('- Cite canonical page URLs, distinguish documented facts from inference, and state when the documentation does not support a claim.')
  lines.push('')
  lines.push('---')
  lines.push('')

  // Join the same line sequence as the original buffered response, including
  // its final newline. Only metadata/order remain corpus-wide; each canonical
  // document graph and encoded chunk can be released before the next page.
  async function* chunks(): AsyncGenerator<string> {
    yield lines.join('\n')
    for (const id of pageOrder) {
      const entry = listableById.get(id)
      if (!entry) continue
      const document = await loadContentDocument(id, engineLocale)
      if (!document) continue
      const page = [`# ${entry.title}`, '']
      if (entry.description) page.push(`> ${entry.description}`, '')
      page.push(`URL: ${baseUrl}${entry.href}`, '', document.content.markdown, '', '---', '')
      yield `\n${page.join('\n')}`
    }
    if (operationOrder.length) {
      yield `\n${['# API reference', '', `Full schemas: MCP \`get_api_operation\` at ${baseUrl}/api/mcp, or the human reference pages below.`, ''].join('\n')}`
      for (const node of operationOrder) yield `\n${apiOperationMarkdown(describeApiOperation(node, baseUrl))}\n`
    }
  }

  const encoder = new TextEncoder()
  const iterator = chunks()
  let isStopped = false
  let onAbort: (() => void) | undefined
  const stop = AsyncLocalStorage.bind(() => {
    if (isStopped) return
    isStopped = true
    if (onAbort) request.signal.removeEventListener('abort', onAbort)
    // Cancellation must return immediately even if an authoritative read is
    // already in flight. It may finish, but it cannot enqueue or start another.
    void iterator.return(undefined).catch(() => undefined)
  })
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      onAbort = AsyncLocalStorage.bind(() => { stop(); controller.close() })
      if (request.signal.aborted) onAbort()
      else request.signal.addEventListener('abort', onAbort, { once: true })
    },
    // The adapter's binding/reader context must outlive GET's stack, while
    // every lazy page read still belongs to this response's own invocation.
    pull: AsyncLocalStorage.bind(async (controller: ReadableStreamDefaultController<Uint8Array>) => {
      if (isStopped) return
      try {
        const chunk = await iterator.next()
        if (isStopped) return
        if (chunk.done) { stop(); controller.close() }
        else controller.enqueue(encoder.encode(chunk.value))
      } catch (error) {
        if (!isStopped) { stop(); controller.error(error) }
      }
    }),
    cancel: stop,
  }, { highWaterMark: 0 })

  return new Response(body, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Language': locale,
      'Cache-Control': contentCacheControl('public, max-age=3600, s-maxage=3600'),
    },
  })
}
