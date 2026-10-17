'use client'

/** Mobile documentation navigation with contained brand artwork and labels. */

import * as Dialog from '@radix-ui/react-dialog'
import { Menu, X } from 'lucide-react'
import { usePathname } from 'next/navigation'
import { useState } from 'react'
import type { ReactNode } from 'react'
import type { NavigationSection, SidebarCollection } from '@/data/docs'
import { Logo } from '@/components/layout/logo'
import { displaySiteName, useSiteName } from '@/components/layout/use-site-name'
import { CollectionSelector } from '@/components/navigation/collection-selector'
import { NavigationSections } from '@/components/navigation/navigation-tree'

interface MobileNavProps {
  sections: Array<NavigationSection>
  collections: Array<SidebarCollection>
  activeCollectionId: string
  onCollectionChange: (id: string) => void
  showGroupIcons?: boolean
  status?: ReactNode
}

export function MobileNav({
  sections,
  collections,
  activeCollectionId,
  onCollectionChange,
  showGroupIcons = true,
  status,
}: MobileNavProps) {
  const siteName = useSiteName()
  const [open, setOpen] = useState(false)
  const pathname = usePathname()

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <button className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-border text-foreground transition hover:bg-muted/50 lg:hidden">
          <span className="sr-only">Open navigation</span>
          <Menu className="h-4 w-4" />
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/40 backdrop-blur-sm" />
        <Dialog.Content className="fixed inset-y-0 left-0 z-50 flex w-full max-w-[min(85vw,320px)] flex-col border-r border-border bg-background shadow-2xl">
          <Dialog.Title className="sr-only">Primary navigation</Dialog.Title>
          <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border/50 px-4 py-4">
            <div className="flex min-w-0 items-center gap-2">
              <Logo showText={false} />
              <span className="truncate text-base font-semibold">{displaySiteName(siteName)}</span>
            </div>
            <Dialog.Close className="shrink-0 rounded-full border border-border p-1.5 transition hover:bg-muted/50">
              <span className="sr-only">Close</span>
              <X className="h-4 w-4" />
            </Dialog.Close>
          </div>
          <nav className="flex flex-1 flex-col gap-6 overflow-y-auto px-4 py-6">
            <CollectionSelector
              collections={collections}
              activeCollectionId={activeCollectionId}
              onCollectionChange={(id) => {
                onCollectionChange(id)
                setOpen(false)
              }}
              compact
            />
            {status ?? <NavigationSections sections={sections} pathname={pathname} onNavigate={() => setOpen(false)} mobile showGroupIcons={showGroupIcons} />}
          </nav>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
