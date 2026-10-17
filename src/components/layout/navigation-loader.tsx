'use client'

/** One shell-owned request per active scope; stale work cannot install another reader's tree. */
import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { decodeNavigationWire, readNavigationResponse } from '@/lib/navigation-snapshot'
import { useSidebarCollectionsStore } from './sidebar-store'

/** Load only the current scoped descriptor, with explicit retry and abort ownership. */
export function NavigationLoader({ scope }: { scope: string }) {
  const entry = useSidebarCollectionsStore(state => state.navigationByScope[scope])
  const snapshot = entry?.snapshot
  const retry = entry?.retry
  useEffect(() => {
    useSidebarCollectionsStore.getState().activateScope(scope)
    if (useSidebarCollectionsStore.getState().navigationByScope[scope]?.status === 'ready' || !snapshot || snapshot.mode !== 'deferred' || !snapshot.endpoint) return
    // A descriptor is server-produced, but this additional same-origin path
    // check prevents a malformed response from turning navigation into a fetch
    // capability for arbitrary URLs.
    const store = useSidebarCollectionsStore.getState()
    const attempt = store.beginAttempt(scope, snapshot.snapshotId)
    if (attempt === null) return
    let url: URL
    try {
      url = new URL(snapshot.endpoint, window.location.origin)
      if (url.origin !== window.location.origin || url.pathname !== '/api/docs-index' || url.searchParams.get('view') !== 'navigation' || url.searchParams.get('scope') !== snapshot.dataScope) throw new Error('Invalid navigation endpoint')
    } catch { store.finishAttempt(scope, snapshot.snapshotId, attempt, null); return }
    const controller = new AbortController()
    let active = true
    void (async () => {
      try {
        const response = await fetch(url, { signal: controller.signal, credentials: 'same-origin' })
        if (!response.ok) throw new Error('Navigation is unavailable')
        const value = await readNavigationResponse(response)
        const body = value as { schemaVersion?: unknown; scope?: unknown; viewKey?: unknown; revision?: unknown; collections?: unknown }
        if (!body || body.schemaVersion !== 1 || body.scope !== snapshot.dataScope || body.viewKey !== snapshot.viewKey || body.revision !== snapshot.snapshotId) throw new Error('Navigation view changed')
        const collections = decodeNavigationWire(body.collections)
        if (active) store.finishAttempt(scope, snapshot.snapshotId, attempt, collections)
      } catch {
        if (active) store.finishAttempt(scope, snapshot.snapshotId, attempt, null)
      }
    })()
    return () => { active = false; controller.abort() }
    // Status changes within this attempt must not start/abort another request.
    // New descriptors and explicit retries are the only loading generations.
  }, [scope, snapshot, retry])
  return null
}

/** Accessible loading/error state shared by desktop and mobile navigation. */
export function NavigationStatus({ scope }: { scope: string }) {
  const router = useRouter()
  const entry = useSidebarCollectionsStore(state => state.navigationByScope[scope])
  const retry = useSidebarCollectionsStore(state => state.retry)
  if (entry?.status === 'ready') return null
  return <div className="px-3 py-4 text-sm text-muted-foreground" role="status" aria-live="polite">
    {entry?.status === 'error' ? <><p>Navigation could not load.</p><button type="button" className="mt-2 underline" onClick={() => { retry(scope); router.refresh() }}>Retry navigation</button></> : 'Loading navigation…'}
  </div>
}
