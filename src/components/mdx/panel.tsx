'use client'

/** Canonical sidebar Panel and explicit aliases for Thally's legacy inline panel. */

import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useEffect } from 'react'
import { usePageSlots } from '@/components/mdx/page-slots'

interface PanelProps {
  children?: ReactNode
}

/** Put supplementary MDX in the desktop detail column, replacing the TOC. */
export function Panel({ children }: PanelProps) {
  const { panelTarget, registerPanel } = usePageSlots()
  useEffect(() => registerPanel(), [registerPanel])

  return (
    <>
      <div className={`thally-panel-inline not-prose my-6 ${panelTarget ? 'xl:hidden' : ''}`}>{children}</div>
      {panelTarget ? createPortal(
        <div className="not-prose space-y-4 pb-6" data-mdx-panel>{children}</div>,
        panelTarget,
      ) : null}
    </>
  )
}

interface ContentPanelProps extends PanelProps {
  title?: string
}

/** Legacy inline neutral container. Prefer Panel for Mintlify-compatible content. */
export function ContentPanel({ title, children }: ContentPanelProps) {
  return (
    <div className="not-prose my-6 rounded-[11px] border border-border bg-muted/35 px-5 py-4">
      {title ? <p className="mb-3 text-sm font-semibold text-foreground">{title}</p> : null}
      <div className="prose prose-sm text-foreground/80 dark:prose-invert">{children}</div>
    </div>
  )
}

export const InlinePanel = ContentPanel
