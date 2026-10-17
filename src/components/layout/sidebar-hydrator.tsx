'use client'

import { useLayoutEffect } from 'react'
import type { SidebarCollection } from '@/data/docs'
import { useSidebarCollectionsStore } from './sidebar-store'
import type { NavigationSnapshot } from '@/lib/navigation-snapshot'

interface SidebarCollectionsHydratorProps {
  collections: Array<SidebarCollection>
  scope?: string
  snapshot?: NavigationSnapshot
}

export function SidebarCollectionsHydrator({
  collections,
  scope = 'default',
  snapshot,
}: SidebarCollectionsHydratorProps) {
  const setCollections = useSidebarCollectionsStore((state) => state.setCollections)
  const installSnapshot = useSidebarCollectionsStore((state) => state.installSnapshot)
  const rootViewKey = useSidebarCollectionsStore((state) => state.viewKey)

  // Layouts are preserved during App Router transitions. Install the incoming
  // route snapshot before paint and key it so a parent layout can never race a
  // locale or OpenAPI child into the wrong sidebar.
  useLayoutEffect(() => {
    if (snapshot) {
      // Selective hydration may deliver a child before its matching root.
      // Revisit it when the root view changes, without granting the child
      // authority to revert that root to an earlier reader.
      if (snapshot.scope !== 'default' && rootViewKey !== snapshot.viewKey) return
      installSnapshot(snapshot)
    }
    else setCollections(scope, collections)
  }, [collections, scope, snapshot, rootViewKey, setCollections, installSnapshot])

  return null
}
