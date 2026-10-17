/** Builds the locale-prefixed sidebar state shared by localized docs and API pages. */

import { SidebarCollectionsHydrator } from '@/components/layout/sidebar-hydrator'
import { loadNavigationSnapshot } from '@/lib/navigation-snapshot-server'

interface LocalizedSidebarHydratorProps {
  locale: string
}

/** Hydrate navigation whose internal links remain inside the requested locale. */
export async function LocalizedSidebarHydrator({
  locale,
}: LocalizedSidebarHydratorProps) {
  const snapshot = await loadNavigationSnapshot(`locale:${locale}`)
  const collections = snapshot.collections

  return <SidebarCollectionsHydrator collections={collections} snapshot={snapshot} scope={`locale:${locale}`} />
}
