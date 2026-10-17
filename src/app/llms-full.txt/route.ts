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
import { agentExportHeader, agentExportPagePrefix, AGENT_EXPORT_PAGE_SUFFIX, agentExportApiHeader, orderAgentExport } from '@/lib/agent-export/format'

import { getRequestNativeAgentExportCapability } from '@/lib/agent-export/request-capability'
import { createPreparedAgentExportPlan, isPreparedAgentExportUnavailable } from '@/lib/agent-export/prepared-plan'
import { NATIVE_AGENT_EXPORT_HANDOFF_HEADER, NATIVE_AGENT_EXPORT_HANDOFF_VALUE } from '@/lib/agent-export/native-protocol'

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
// An authorized empty handoff is invocation-local and must never be framework cached.
export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  // Under the assets ContentSource this route must render per request — the
  // corpus below reflects published content, not the build. No-op by default.
  const effectiveSite = await resolveRequestSiteConfig()
  const native = getRequestNativeAgentExportCapability(request)
  const baseUrl = native ? new URL(native.requestUrl).origin : request.nextUrl.origin

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

  const { pageIds, operations } = orderAgentExport(entries, listable, collections, apiNodes)
  const listedById = new Map(listable.map((entry) => [entry.id, entry]))

  const responseHeaders = {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Language': locale,
    'Cache-Control': contentCacheControl('public, max-age=3600, s-maxage=3600'),
  }
  if (native) {
    // This branch runs AFTER the same ordinary reader/listable/version/locale
    // projection as the legacy response. Prepared bytes never list pages.
    function* operationMarkdown(): Generator<string> {
      for (const node of operations) yield apiOperationMarkdown(describeApiOperation(node, baseUrl))
    }
    let plan
    try { plan = await createPreparedAgentExportPlan({
      origin: baseUrl, locale, engineLocale,
      siteName: effectiveSite.name, siteDescription: effectiveSite.description,
      pages: pageIds.flatMap((id) => { const entry = listedById.get(id); return entry ? [entry] : [] }),
      apiMarkdown: operationMarkdown(),
    }) } catch (error) {
      if (!isPreparedAgentExportUnavailable(error)) throw error
      return problemResponse({ status: 503, code: 'prepared_export_unavailable', title: 'Prepared export unavailable', detail: error.message,
        resolution: 'Run a full build with the current docs.json. Individual documents remain available through llms.txt.', instance: request.nextUrl.pathname })
    }
    if (plan && native.accept(plan)) {
      // A request-owned in-process plan plus this marker are BOTH required.
      // The native wrapper drains this empty response before reading ASSETS.
      return new Response(null, { headers: { ...responseHeaders, [NATIVE_AGENT_EXPORT_HANDOFF_HEADER]: NATIVE_AGENT_EXPORT_HANDOFF_VALUE } })
    }
  }

  // This framing is shared with native managed delivery. Both paths retain
  // current reader/locale metadata and consume the same document projection.
  async function* chunks(): AsyncGenerator<string> {
    yield agentExportHeader(effectiveSite, baseUrl, locale)
    for (const id of pageIds) {
      const entry = listedById.get(id)
      if (!entry) continue
      const document = await loadContentDocument(id, engineLocale)
      if (!document) continue
      yield agentExportPagePrefix(entry, baseUrl) + document.content.markdown + AGENT_EXPORT_PAGE_SUFFIX
    }
    if (operations.length) {
      yield agentExportApiHeader(baseUrl)
      for (const node of operations) yield `\n${apiOperationMarkdown(describeApiOperation(node, baseUrl))}\n`
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

  return new Response(body, { headers: responseHeaders })
}
