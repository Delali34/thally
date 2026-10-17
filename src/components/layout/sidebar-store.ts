'use client'

/** Route-scoped navigation snapshots used by preserved App Router layouts. */

import { create } from 'zustand'
import type { SidebarCollection } from '@/data/docs'
import type { NavigationSnapshot } from '@/lib/navigation-snapshot'

export interface NavigationLoadState {
  snapshot: NavigationSnapshot
  status: 'ready' | 'loading' | 'error'
  attempt: number
  retry: number
}

interface SidebarCollectionsState {
  collectionsByScope: Record<string, Array<SidebarCollection>>
  setCollections: (scope: string, collections: Array<SidebarCollection>) => void
  viewKey: string | null
  navigationByScope: Record<string, NavigationLoadState>
  installSnapshot(snapshot: NavigationSnapshot): void
  beginAttempt(scope: string, snapshotId: string): number | null
  finishAttempt(scope: string, snapshotId: string, attempt: number, collections: Array<SidebarCollection> | null): void
  retry(scope: string): void
  activateScope(scope: string): void
}

export const useSidebarCollectionsStore = create<SidebarCollectionsState>((set, get) => ({
  collectionsByScope: {},
  viewKey: null,
  navigationByScope: {},
  setCollections: (scope, collections) => set((state) => ({
    collectionsByScope: { ...state.collectionsByScope, [scope]: collections },
  })),
  installSnapshot: (snapshot) => set((state) => {
    const sameView = state.viewKey === snapshot.viewKey
    // The root descriptor owns reader transitions. A delayed locale/API
    // subtree must never switch a newer root back to its previous reader.
    if (snapshot.scope !== 'default' && state.viewKey !== null && !sameView) return state
    if (sameView && state.navigationByScope[snapshot.scope]?.snapshot.snapshotId === snapshot.snapshotId) return state
    const root = sameView ? state.navigationByScope.default : undefined
    const reusable = root?.status === 'ready' && root.snapshot.dataScope === snapshot.dataScope && root.snapshot.snapshotId === snapshot.snapshotId
    return {
      viewKey: snapshot.viewKey,
      collectionsByScope: { ...(sameView ? state.collectionsByScope : {}), [snapshot.scope]: reusable ? state.collectionsByScope.default : snapshot.collections },
      navigationByScope: { ...(sameView ? state.navigationByScope : {}), [snapshot.scope]: { snapshot, status: snapshot.mode === 'inline' || reusable ? 'ready' : 'loading', attempt: 0, retry: 0 } },
    }
  }),
  beginAttempt: (scope, snapshotId) => {
    const current = get().navigationByScope[scope]
    if (!current || current.snapshot.snapshotId !== snapshotId) return null
    const attempt = current.attempt + 1
    set(state => ({ navigationByScope: { ...state.navigationByScope, [scope]: { ...current, attempt, status: 'loading' } } }))
    return attempt
  },
  finishAttempt: (scope, snapshotId, attempt, collections) => set(state => {
    const current = state.navigationByScope[scope]
    if (!current || current.snapshot.snapshotId !== snapshotId || current.attempt !== attempt) return state
    const root = state.navigationByScope.default
    const sharesRoot = Boolean(collections && root && root.snapshot.snapshotId === snapshotId && root.snapshot.dataScope === current.snapshot.dataScope)
    return {
      collectionsByScope: { ...state.collectionsByScope, ...(sharesRoot ? { default: collections! } : {}), [scope]: collections ?? current.snapshot.collections },
      navigationByScope: { ...state.navigationByScope, ...(sharesRoot ? { default: { ...root, status: 'ready' as const } } : {}), [scope]: { ...current, status: collections ? 'ready' : 'error' } },
    }
  }),
  retry: scope => set(state => {
    const current = state.navigationByScope[scope]
    return current ? { navigationByScope: { ...state.navigationByScope, [scope]: { ...current, retry: current.retry + 1, attempt: current.attempt + 1, status: 'loading' } } } : state
  }),
  activateScope: scope => set(state => {
    // Browser HTTP caching owns public reuse. Retain at most the root and
    // current logical view rather than one full tree for every visited API page.
    const keep = (key: string) => key === 'default' || key === scope
    if (Object.keys(state.navigationByScope).every(keep) && Object.keys(state.collectionsByScope).every(keep)) return state
    return {
      navigationByScope: Object.fromEntries(Object.entries(state.navigationByScope).filter(([key]) => keep(key))),
      collectionsByScope: Object.fromEntries(Object.entries(state.collectionsByScope).filter(([key]) => keep(key))),
    }
  }),
}))
