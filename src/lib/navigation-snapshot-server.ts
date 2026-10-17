/** Server-owned reader/locale projection shared by article shells and the lazy data response. */
import 'server-only'
import { cache } from 'react'
import { createHash } from 'node:crypto'
import type { NextRequest } from 'next/server'
import { loadSidebarCollections } from '@/data/docs'
import type { SidebarCollection } from '@/data/docs'
import { withApiNavigation } from '@/data/api-reference'
import { getEffectiveI18nConfig } from '@/lib/i18n/request'
import { getReaderContext, getReaderContextFromRequest } from '@/lib/reader-auth/context'
import { canReaderSeeUnmarkedContent } from '@/lib/reader-auth/page-gate'
import type { ReaderContext } from '@/lib/reader-auth/access'
import { contentCacheControl } from '@/lib/reader-auth/cache'
import { canInlineNavigation, isNavigationScope, navigationDataScope, navigationHeaders, navigationJson, navigationWire, type NavigationSnapshot } from '@/lib/navigation-snapshot'

// Canonical collection arrays are release-immutable. Cache only their digest,
// with weak ownership; never retain reader payloads or request promises here.
const wireDigests = new WeakMap<Array<SidebarCollection>, string>()

/** Content-addressed URL identity without a whole JSON/string/buffer intermediate. */
export function navigationRevision(collections: Array<SidebarCollection>, scope: string, viewKey: string): string {
  let digest = wireDigests.get(collections)
  if (!digest) {
    const hash = createHash('sha256')
    for (const fragment of navigationWire(collections)) hash.update(fragment)
    digest = hash.digest('hex')
    wireDigests.set(collections, digest)
  }
  return createHash('sha256').update('navigation-v1\0').update(scope).update('\0').update(viewKey).update('\0').update(digest).digest('hex')
}

/** Opaque view identity fences late responses across reader changes; it grants no authority. */
export async function navigationViewKey(reader: ReaderContext): Promise<string> {
  if (!reader.isAuthenticated) return 'anonymous'
  const bytes = new TextEncoder().encode(JSON.stringify([reader.subject ?? '', [...reader.groups].sort(), reader.source]))
  const hash = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('')
}

/** Preserve current default/API/locale navigation semantics using their existing loaders. */
export async function loadNavigationCollections(scope: string, reader: ReaderContext) {
  if (!isNavigationScope(scope)) throw new Error('Invalid navigation scope')
  const locale = scope.startsWith('locale:') ? scope.slice('locale:'.length) : undefined
  if (locale) {
    const i18n = await getEffectiveI18nConfig()
    if (locale === i18n.defaultLocale || !i18n.locales.some(item => item.code === locale)) throw new Error('Invalid navigation locale')
  }
  const source = await loadSidebarCollections(locale, reader)
  const collections = canReaderSeeUnmarkedContent(reader) && source.some(collection => collection.api && collection.api.navigation !== false)
    ? await withApiNavigation(source, locale ? `/${locale}` : '') : source
  if (!locale) return collections
  return collections.map(collection => {
    if (collection.api && collection.api.navigation !== false) return collection
    return collection.href && !/^https?:\/\//i.test(collection.href)
      ? { ...collection, href: `/${locale}${collection.href}` } : collection
  })
}

/** Request-only deduplication also makes duplicate locale hydrators share one generation. */
export const loadNavigationSnapshot = cache(async (scope: string): Promise<NavigationSnapshot> => {
  if (!isNavigationScope(scope)) throw new Error('Invalid navigation scope')
  const reader = await getReaderContext()
  const dataScope = navigationDataScope(scope)
  const collections = await loadNavigationCollections(dataScope, reader)
  const viewKey = await navigationViewKey(reader)
  const identity = { schemaVersion: 1 as const, scope, dataScope, viewKey, snapshotId: navigationRevision(collections, dataScope, viewKey) }
  if (canInlineNavigation(collections)) return { ...identity, mode: 'inline', collections }
  return {
    ...identity, mode: 'deferred', collections: navigationHeaders(collections),
    endpoint: `/api/docs-index?view=navigation&scope=${encodeURIComponent(dataScope)}&revision=${identity.snapshotId}`,
  }
})

/** Stream the canonical tree once, with no complete JSON string/buffer or shared reader promise. */
export async function navigationResponse(request: NextRequest): Promise<Response> {
  const requestedScope = request.nextUrl.searchParams.get('scope') ?? 'default'
  if (!isNavigationScope(requestedScope)) return Response.json({ error: 'Invalid navigation scope' }, { status: 400, headers: { 'Cache-Control': 'private, no-store' } })
  const scope = navigationDataScope(requestedScope)
  const reader = await getReaderContextFromRequest(request)
  let collections: Array<SidebarCollection>
  try { collections = await loadNavigationCollections(scope, reader) }
  catch (error) {
    if (scope.startsWith('locale:')) {
      const locale = scope.slice('locale:'.length)
      const i18n = await getEffectiveI18nConfig()
      if (locale === i18n.defaultLocale || !i18n.locales.some(item => item.code === locale)) return Response.json({ error: 'Invalid navigation locale' }, { status: 400, headers: { 'Cache-Control': 'private, no-store' } })
    }
    throw error
  }
  const viewKey = await navigationViewKey(reader)
  const revision = navigationRevision(collections, scope, viewKey)
  const requestedRevision = request.nextUrl.searchParams.get('revision')
  if (requestedRevision && requestedRevision !== revision) return Response.json({ error: 'Navigation changed; refresh this page.' }, { status: 409, headers: { 'Cache-Control': 'private, no-store' } })
  function* fragments() {
    yield '{"schemaVersion":1,"scope":'; yield* navigationJson(scope)
    yield ',"viewKey":'; yield* navigationJson(viewKey)
    yield ',"revision":'; yield* navigationJson(revision)
    yield ',"collections":'; yield* navigationWire(collections); yield '}'
  }
  const iterator = fragments()
  const encoder = new TextEncoder()
  let pending = ''
  let stopped = false
  let onAbort: (() => void) | undefined
  const stop = () => { stopped = true; iterator.return(undefined); if (onAbort) request.signal.removeEventListener('abort', onAbort) }
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      onAbort = () => { if (!stopped) { stop(); controller.close() } }
      if (request.signal.aborted) onAbort()
      else request.signal.addEventListener('abort', onAbort, { once: true })
    },
    pull(controller) {
      if (stopped) return
      try {
        let chunk = pending
        pending = ''
        while (chunk.length < 8192) {
          const next = iterator.next()
          if (next.done) { stop(); break }
          if (chunk.length + next.value.length > 8192) { pending = next.value; break }
          chunk += next.value
        }
        if (chunk) controller.enqueue(encoder.encode(chunk))
        if (stopped) controller.close()
      } catch (error) { stop(); controller.error(error) }
    },
    cancel: stop,
  }, { highWaterMark: 0 })
  return new Response(body, { headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': contentCacheControl(requestedRevision ? 'public, max-age=300' : 'public, max-age=0, must-revalidate'), Vary: 'Cookie, Authorization' } })
}
