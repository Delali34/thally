/** Regression coverage for navigation snapshots owned by preserved layouts. */

import { beforeEach, describe, expect, it } from 'vitest'
import type { SidebarCollection } from '@/data/docs'
import { useSidebarCollectionsStore } from './sidebar-store'
import type { NavigationSnapshot } from '@/lib/navigation-snapshot'

function collection(id: string): SidebarCollection {
  return { id, label: id, sections: [] }
}

describe('sidebar collection store', () => {
  beforeEach(() => {
    useSidebarCollectionsStore.setState({ collectionsByScope: {}, navigationByScope: {}, viewKey: null })
  })

  it('keeps root, locale, and API snapshots isolated', () => {
    const { setCollections } = useSidebarCollectionsStore.getState()

    setCollections('default', [collection('documentation')])
    setCollections('locale:fr', [collection('documentation-fr')])
    setCollections('api:management', [collection('api-management')])

    expect(useSidebarCollectionsStore.getState().collectionsByScope).toEqual({
      default: [collection('documentation')],
      'locale:fr': [collection('documentation-fr')],
      'api:management': [collection('api-management')],
    })
  })

  it('fences old reader responses and attempts across root replacement and retry', () => {
    const store = useSidebarCollectionsStore.getState()
    const snapshot = (viewKey: string, scope = 'default'): NavigationSnapshot => ({ schemaVersion: 1, scope, dataScope: 'default', viewKey, snapshotId: viewKey, mode: 'deferred', collections: [collection(viewKey)], endpoint: '/api/docs-index?view=navigation&scope=default' })
    store.installSnapshot(snapshot('a'))
    const attemptA = store.beginAttempt('default', 'a')!
    store.installSnapshot(snapshot('b'))
    store.finishAttempt('default', 'a', attemptA, [collection('STALE')])
    expect(useSidebarCollectionsStore.getState().collectionsByScope.default[0].id).toBe('b')
    store.installSnapshot(snapshot('a', 'locale:fr'))
    expect(useSidebarCollectionsStore.getState().navigationByScope['locale:fr']).toBeUndefined()
    const attemptB = store.beginAttempt('default', 'b')!
    store.retry('default')
    store.finishAttempt('default', 'b', attemptB, [collection('STALE-RETRY')])
    expect(useSidebarCollectionsStore.getState().collectionsByScope.default[0].id).toBe('b')
  })

  it('retains only root and active scoped snapshots', () => {
    const store = useSidebarCollectionsStore.getState()
    for (const scope of ['default', 'api:first', 'api:last', 'locale:fr']) {
      store.installSnapshot({ schemaVersion: 1, scope, dataScope: 'default', snapshotId: scope, viewKey: 'one', mode: 'inline', collections: [collection(scope)] })
    }
    store.activateScope('locale:fr')
    expect(Object.keys(useSidebarCollectionsStore.getState().collectionsByScope)).toEqual(['default', 'locale:fr'])
  })
})


it('reuses one canonical ready tree for API logical scopes without retaining every visited scope', () => {
  const store = useSidebarCollectionsStore.getState()
  const snapshot = (scope: string): NavigationSnapshot => ({ schemaVersion: 1, scope, dataScope: 'default', snapshotId: 'same-revision', viewKey: 'one', mode: 'deferred', collections: [collection('headers')] })
  store.installSnapshot(snapshot('default'))
  store.installSnapshot(snapshot('api:first'))
  const tree = [collection('complete')]
  store.finishAttempt('api:first', 'same-revision', store.beginAttempt('api:first', 'same-revision')!, tree)
  expect(useSidebarCollectionsStore.getState().collectionsByScope.default).toBe(tree)
  store.installSnapshot(snapshot('api:second'))
  store.activateScope('api:second')
  expect(useSidebarCollectionsStore.getState().navigationByScope['api:second'].status).toBe('ready')
  expect(useSidebarCollectionsStore.getState().collectionsByScope['api:second']).toBe(tree)
  expect(Object.keys(useSidebarCollectionsStore.getState().collectionsByScope)).toEqual(['default', 'api:second'])
})
