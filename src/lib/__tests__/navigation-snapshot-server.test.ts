/** Reader-scoped lazy navigation uses the real projection and pull-driven serializer. */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import type { SidebarCollection } from '@/data/docs'
import type { ReaderContext } from '@/lib/reader-auth/access'

const state = vi.hoisted(() => ({
  collections: [] as Array<SidebarCollection>,
  reader: { isAuthenticated: false, groups: [], source: 'anonymous' } as ReaderContext,
  isProtected: false,
}))
vi.mock('@/data/docs', () => ({ loadSidebarCollections: async () => state.collections }))
vi.mock('@/data/api-reference', () => ({ withApiNavigation: async (collections: unknown) => collections }))
vi.mock('@/lib/i18n/request', () => ({ getEffectiveI18nConfig: async () => ({ defaultLocale: 'en', locales: [{ code: 'en' }, { code: 'fr' }] }) }))
vi.mock('@/lib/reader-auth/context', () => ({ getReaderContext: async () => state.reader, getReaderContextFromRequest: async () => state.reader }))
vi.mock('@/lib/reader-auth/page-gate', () => ({ canReaderSeeUnmarkedContent: () => !state.isProtected || state.reader.isAuthenticated }))
vi.mock('@/lib/reader-auth/cache', () => ({ contentCacheControl: (value: string) => state.isProtected ? 'private, no-store' : value }))

import { loadNavigationSnapshot, navigationResponse, navigationRevision, navigationViewKey } from '@/lib/navigation-snapshot-server'
import { decodeNavigationWire } from '@/lib/navigation-snapshot'

beforeEach(() => {
  state.reader = { isAuthenticated: false, groups: [], source: 'anonymous' }
  state.isProtected = false
  state.collections = [{ id: 'docs', label: 'Docs', sections: [{ title: 'Pages', items: [{ id: 'a', title: 'A', href: '/a' }] }] }]
})

describe('lazy navigation server boundary', () => {
  it('keeps small snapshots inline and defers all 10,000 pages without losing headers', async () => {
    expect((await loadNavigationSnapshot('default')).mode).toBe('inline')
    state.collections = [{ ...state.collections[0], sections: [{ title: 'Pages', items: Array.from({ length: 10_000 }, (_, index) => ({ id: `${index}`, title: `Page ${index}`, href: `/page-${index}` })) }] }]
    const snapshot = await loadNavigationSnapshot('default')
    expect(snapshot.mode).toBe('deferred')
    expect(snapshot.collections[0].sections).toEqual([])
    expect(snapshot.endpoint).toBe(`/api/docs-index?view=navigation&scope=default&revision=${snapshot.snapshotId}`)
    const response = await navigationResponse(new NextRequest('https://docs.test/api/docs-index?view=navigation'))
    const body = await response.json()
    expect(decodeNavigationWire(body.collections)[0].sections[0].items).toEqual(state.collections[0].sections[0].items)
  })

  it('scopes locale/API snapshots and preserves authored collection destinations', async () => {
    state.collections[0].href = '/guide'
    expect((await loadNavigationSnapshot('locale:fr')).collections[0].href).toBe('/fr/guide')
    expect((await loadNavigationSnapshot('api:management')).scope).toBe('api:management')
    expect((await navigationResponse(new NextRequest('https://docs.test/api/docs-index?view=navigation&scope=locale:nope'))).status).toBe(400)
    expect((await navigationResponse(new NextRequest('https://docs.test/api/docs-index?view=navigation&scope=../../secret'))).status).toBe(400)
  })

  it('fences different reader identities and uses private/no-store for protected views', async () => {
    state.isProtected = true
    state.reader = { isAuthenticated: true, groups: ['beta'], subject: 'one', source: 'session' }
    const first = await navigationViewKey(state.reader)
    const response = await navigationResponse(new NextRequest('https://docs.test/api/docs-index?view=navigation'))
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    expect(response.headers.has('Access-Control-Allow-Origin')).toBe(false)
    expect((await response.json()).viewKey).toBe(first)
    state.reader = { ...state.reader, subject: 'two' }
    expect(await navigationViewKey(state.reader)).not.toBe(first)
  })

  it('has no serializer read-ahead and cancels an active response', async () => {
    // Hashing observes the immutable graph once; the response serializer must
    // still remain pull-driven rather than encode an entire second copy.
    const before = state.collections[0].sections[0].items[0]
    before.description = 'payload'.repeat(100_000)
    navigationRevision(state.collections, 'default', 'anonymous')
    let reads = 0
    Object.defineProperty(state.collections[0].sections[0].items[0], 'description', { enumerable: true, get: () => { reads += 1; return 'payload'.repeat(100_000) } })
    const response = await navigationResponse(new NextRequest('https://docs.test/api/docs-index?view=navigation'))
    expect(reads).toBe(0)
    const reader = response.body!.getReader()
    const first = await reader.read()
    expect(first.value!.byteLength).toBeLessThanOrEqual(32768)
    expect(reads).toBe(1)
    await reader.cancel()
    const previous = reads
    await Promise.resolve()
    expect(reads).toBe(previous)
    expect((await reader.read()).done).toBe(true)
  })

  it('content-addresses public cache URLs and rejects stale revisions without public caching', async () => {
    const first = await loadNavigationSnapshot('default')
    expect((await loadNavigationSnapshot('default')).snapshotId).toBe(first.snapshotId)
    state.collections = [{ ...state.collections[0], label: 'New release' }]
    expect((await loadNavigationSnapshot('default')).snapshotId).not.toBe(first.snapshotId)
    const stale = await navigationResponse(new NextRequest(`https://docs.test/api/docs-index?view=navigation&revision=${first.snapshotId}`))
    expect(stale.status).toBe(409)
    expect(stale.headers.get('Cache-Control')).toBe('private, no-store')
    const fresh = await loadNavigationSnapshot('default')
    const response = await navigationResponse(new NextRequest(`https://docs.test/api/docs-index?view=navigation&revision=${fresh.snapshotId}`))
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=300')
    await response.body!.cancel()
  })

  it('shares transport revisions across default/API views while keeping their logical scopes', async () => {
    state.collections = [{ ...state.collections[0], sections: [{ title: 'Pages', items: Array.from({ length: 300 }, (_, index) => ({ id: `${index}`, title: `${index}`, href: `/api/${index}` })) }] }]
    const [base, first, second] = await Promise.all(['default', 'api:first', 'api:second'].map(loadNavigationSnapshot))
    expect(first.scope).toBe('api:first')
    expect(second.scope).toBe('api:second')
    expect(first.dataScope).toBe('default')
    expect(first.endpoint).toBe(base.endpoint)
    expect(second.endpoint).toBe(base.endpoint)
    expect(first.snapshotId).toBe(second.snapshotId)
  })
})
