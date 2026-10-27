'use client'

/** Visible document headings and scroll tracking share the page's anchor offsets. */

import { usePathname } from 'next/navigation'
import { startTransition, useCallback, useEffect, useState } from 'react'
import { layout } from '@/config/layout'
import { cn } from '@/lib/utils'

interface TocItem {
  id: string
  text: string
  level: number
}

// Preserve the original reading threshold when the header uses a single row.
const ACTIVE_OFFSET = 120

/** Follow the visible document outline as navigation and scroll position change. */
export function TableOfContents() {
  const pathname = usePathname()
  const [items, setItems] = useState<Array<TocItem>>([])
  const [activeId, setActiveId] = useState<string>()

  useEffect(() => {
    function refreshHeadings() {
      const headingElements = Array.from(
        document.querySelectorAll<HTMLElement>('[data-heading]'),
      ).filter((element) => element.getClientRects().length > 0).map((element) => ({
        id: element.id,
        text: element.dataset.heading ?? element.textContent ?? '',
        level: Number(element.dataset.level ?? 2),
      }))
      startTransition(() => setItems(headingElements))
    }

    refreshHeadings()
    window.addEventListener('thally:view-change', refreshHeadings)
    return () => window.removeEventListener('thally:view-change', refreshHeadings)
  }, [pathname])

  useEffect(() => {
    if (items.length === 0) return

    let frame = 0
    function computeActive() {
      const headings = items
        .map((item) => document.getElementById(item.id))
        .filter((el): el is HTMLElement => Boolean(el))
      if (headings.length === 0) return

      let current = headings[0].id
      for (const heading of headings) {
        // A stacked header raises the anchor margin above the normal threshold.
        // Read the applied margin so a completed anchor scroll stays selected,
        // including after responsive header changes or custom heading styles.
        const anchorOffset = Number.parseFloat(getComputedStyle(heading).scrollMarginTop) || 0
        const activeOffset = Math.max(ACTIVE_OFFSET, anchorOffset)
        if (heading.getBoundingClientRect().top - activeOffset <= 1) {
          current = heading.id
        } else {
          break
        }
      }
      setActiveId(current)
    }

    function onScroll() {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(computeActive)
    }

    computeActive()
    window.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('resize', onScroll, { passive: true })
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', onScroll)
    }
  }, [items])

  const handleClick = useCallback(
    (event: React.MouseEvent<HTMLAnchorElement>, id: string) => {
      const target = document.getElementById(id)
      if (!target) return
      event.preventDefault()
      setActiveId(id)
      target.scrollIntoView({ behavior: 'smooth', block: 'start' })
      window.history.replaceState(null, '', `#${id}`)
    },
    [],
  )

  if (items.length === 0) return null

  return (
    // Mintlify's id and landmark name: site scripts written for it find the
    // table of contents by either and append their own cards here.
    <aside id="table-of-contents-content" aria-label="On this page" className={cn('thally-docs-toc sticky top-[calc(var(--docs-header-height,60px)+22px)] max-h-[calc(100dvh-var(--docs-header-height,60px)-22px)] overflow-y-auto text-sm', layout.tocWidth)}>
      <p className="mb-0 text-sm font-medium leading-6 text-foreground">On this page</p>
      <ul className="border-l border-border">
        {items.map((item) => {
          const isActive = activeId === item.id
          return (
            <li key={item.id}>
              <a
                href={`#${item.id}`}
                aria-current={isActive ? 'location' : undefined}
                onClick={(event) => handleClick(event, item.id)}
                className={cn(
                  '-ml-px flex items-center border-l-2 py-1 pr-2 text-left text-sm font-medium leading-6 transition-colors duration-200 hover:text-foreground',
                  item.level > 2 ? 'pl-7' : 'pl-4',
                  isActive
                    ? 'border-foreground text-foreground'
                    : 'border-transparent text-foreground/55',
                )}
              >
                {item.text}
              </a>
            </li>
          )
        })}
      </ul>
    </aside>
  )
}
