// @vitest-environment happy-dom
/** Real React effects reconcile selective hydration, stale requests and explicit retries. */
import { act, createElement, Fragment } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NavigationSnapshot } from '@/lib/navigation-snapshot'
import { SidebarCollectionsHydrator } from './sidebar-hydrator'
import { NavigationLoader, NavigationStatus } from './navigation-loader'
import { useSidebarCollectionsStore } from './sidebar-store'

const mocks = vi.hoisted(() => ({ refresh: vi.fn() }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: mocks.refresh }) }))

let root: Root
let container: HTMLDivElement
let pending: Array<{ resolve(response: Response): void; signal?: AbortSignal }>
const snapshot = (viewKey: string, scope = 'default'): NavigationSnapshot => ({
  schemaVersion: 1, scope, dataScope: scope.startsWith('api:') ? 'default' : scope,
  snapshotId: `${viewKey}-${scope}`, viewKey, mode: 'deferred', collections: [{ id: 'docs', label: 'Docs', sections: [] }],
  endpoint: `/api/docs-index?view=navigation&scope=${encodeURIComponent(scope.startsWith('api:') ? 'default' : scope)}&revision=${viewKey}-${scope}`,
})
const hydrator = (source: NavigationSnapshot) => createElement(SidebarCollectionsHydrator, { collections: source.collections, snapshot: source, scope: source.scope, key: source.scope })
const response = (source: NavigationSnapshot, title: string) => Response.json({
  schemaVersion: 1, scope: source.dataScope, viewKey: source.viewKey, revision: source.snapshotId,
  collections: [{ id: 'docs', label: 'Docs', sections: [{ title: 'Pages', nodes: [{ type: 'page', item: { id: title, title, href: `/${title}` } }] }] }],
})

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  useSidebarCollectionsStore.setState({ collectionsByScope: {}, navigationByScope: {}, viewKey: null })
  mocks.refresh.mockReset()
  pending = []
  vi.stubGlobal('fetch', vi.fn((_input: unknown, options?: RequestInit) => new Promise<Response>(resolve => pending.push({ resolve, signal: options?.signal ?? undefined }))))
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals() })

describe('navigation lifecycle', () => {
  it('reconciles childB before rootB and refuses a delayed childA afterwards', async () => {
    const a = snapshot('a')
    const b = snapshot('b')
    const childB = snapshot('b', 'locale:fr')
    useSidebarCollectionsStore.getState().installSnapshot(a)
    await act(async () => root.render(createElement(Fragment, null, hydrator(childB), hydrator(b))))
    expect(useSidebarCollectionsStore.getState().navigationByScope['locale:fr'].snapshot.viewKey).toBe('b')
    await act(async () => root.render(createElement(Fragment, null, hydrator(snapshot('a', 'api:old')), hydrator(childB), hydrator(b))))
    expect(useSidebarCollectionsStore.getState().viewKey).toBe('b')
    expect(useSidebarCollectionsStore.getState().navigationByScope['api:old']).toBeUndefined()
  })

  it('aborts an old reader request and rejects its late result', async () => {
    const a = snapshot('a')
    const b = snapshot('b')
    const render = (source: NavigationSnapshot) => createElement(Fragment, null, hydrator(source), createElement(NavigationLoader, { scope: 'default' }))
    await act(async () => root.render(render(a)))
    expect(pending).toHaveLength(1)
    await act(async () => root.render(render(b)))
    expect(pending[0].signal?.aborted).toBe(true)
    expect(pending).toHaveLength(2)
    await act(async () => { pending[0].resolve(response(a, 'STALE')); pending[1].resolve(response(b, 'Allowed')) })
    expect(useSidebarCollectionsStore.getState().collectionsByScope.default[0].sections[0].items[0].title).toBe('Allowed')
    expect(useSidebarCollectionsStore.getState().navigationByScope.default.status).toBe('ready')
  })

  it('keeps failures explicit and refreshes the descriptor on manual retry', async () => {
    const source = snapshot('a')
    await act(async () => root.render(createElement(Fragment, null, hydrator(source), createElement(NavigationLoader, { scope: 'default' }), createElement(NavigationStatus, { scope: 'default' }))))
    await act(async () => pending[0].resolve(new Response('Changed', { status: 409 })))
    expect(container.textContent).toContain('Navigation could not load')
    await act(async () => container.querySelector('button')!.click())
    expect(mocks.refresh).toHaveBeenCalledOnce()
    expect(pending).toHaveLength(2)
    await act(async () => pending[1].resolve(response(source, 'Recovered')))
    expect(useSidebarCollectionsStore.getState().navigationByScope.default.status).toBe('ready')
  })

  it('uses canonical API transport while installing only its logical scope', async () => {
    const base = { ...snapshot('a'), mode: 'inline' as const }
    const api = snapshot('a', 'api:management')
    await act(async () => root.render(createElement(Fragment, null, hydrator(base), hydrator(api), createElement(NavigationLoader, { scope: api.scope }))))
    await act(async () => pending[0].resolve(response(api, 'Operation')))
    expect(useSidebarCollectionsStore.getState().navigationByScope['api:management'].status).toBe('ready')
    expect(useSidebarCollectionsStore.getState().collectionsByScope.default[0].sections).toEqual([])
  })
})


it('does not fetch a second logical API scope when its exact canonical root revision is ready', async () => {
  const parent = snapshot('public')
  const first = { ...snapshot('public', 'api:first'), snapshotId: parent.snapshotId }
  const second = { ...snapshot('public', 'api:second'), snapshotId: parent.snapshotId }
  useSidebarCollectionsStore.getState().installSnapshot(parent)
  await act(async () => root.render(createElement(Fragment, null, hydrator(first), createElement(NavigationLoader, { scope: first.scope }))))
  await act(async () => pending[0].resolve(response(first, 'Shared')))
  await act(async () => root.render(createElement(Fragment, null, hydrator(second), createElement(NavigationLoader, { scope: second.scope }))))
  expect(pending).toHaveLength(1)
  expect(useSidebarCollectionsStore.getState().navigationByScope[second.scope].status).toBe('ready')
  expect(useSidebarCollectionsStore.getState().collectionsByScope[second.scope][0].sections[0].items[0].title).toBe('Shared')
})
