'use client'

/** Recursive navigation renderer shared by desktop and mobile sidebars. */

import { ChevronRight } from 'lucide-react'
import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { NavigationNode, NavigationSection } from '@/data/docs'
import { Badge } from '@/components/ui/badge'
import { Icon } from '@/components/mdx/rich-content'
import { IntentPrefetchLink } from '@/components/navigation/intent-prefetch-link'
import { cn } from '@/lib/utils'
import { matchesNavigationPath, NAVIGATION_WINDOW_SIZE, projectNavigationWindow, visibleNavigationRows, type NavigationDisclosure, type NavigationWindowRow } from './navigation-window'

interface NavigationTreeProps {
  nodes: Array<NavigationNode>
  pathname: string
  onNavigate?: () => void
  mobile?: boolean
  showGroupIcons?: boolean
}

function NavigationPage({ node, pathname, onNavigate, mobile, showGroupIcons }: NavigationTreeProps & { node: NavigationNode }) {
  if (node.type !== 'page') return null
  const active = matchesNavigationPath(node.item.href, pathname)
    return (
      <IntentPrefetchLink
        href={node.item.href}
        data-method={node.item.method?.toLowerCase()}
        aria-current={active ? 'page' : undefined}
        onClick={onNavigate}
        className={cn(
          'thally-navigation-item group relative block rounded-lg px-2.5 text-left transition-colors duration-150 focus:outline-none',
          mobile ? 'py-1.5 text-sm' : 'py-1.5 text-sm leading-6',
          active
            ? 'bg-accent/10 font-normal text-accent'
            : 'font-normal text-muted-foreground hover:bg-muted hover:text-foreground',
        )}
      >
        <span className="thally-navigation-label flex min-h-5 items-center gap-2">
          {node.item.method ? <span className="thally-method-tag">{node.item.method.toUpperCase()}</span> : null}
          <span className="thally-navigation-title line-clamp-2 break-words">
            {showGroupIcons && node.item.icon ? (
              <Icon
                {...(/^(\/(?!\/)|https:\/\/)/i.test(node.item.icon) ? { src: node.item.icon } : { icon: node.item.icon })}
                iconType={node.item.iconType}
                className="mr-2 inline-block h-3.5 w-3.5 shrink-0 text-foreground/50"
              />
            ) : null}
            {node.item.title}
          </span>
          {node.item.badge ? <Badge className="shrink-0 text-[10px] uppercase">{node.item.badge}</Badge> : null}
        </span>
        {mobile && node.item.description ? (
          <span className="mt-0.5 block text-xs font-normal text-foreground/55">
            {node.item.description}
          </span>
        ) : null}
      </IntentPrefetchLink>
    )
}

interface NavigationSectionsProps extends Omit<NavigationTreeProps, 'nodes'> {
  sections: Array<NavigationSection>
  title?: string
  /** Keep the heading of an authored group that is named after the collection; the collection's own root section never has one. */
  keepCollectionNamedGroups?: boolean
}

/**
 * One window covers the whole collection, including sections and expanded
 * groups. Paging replaces rows instead of accumulating DOM, while disclosure
 * state survives a group's removal from the currently rendered window.
 */
export function NavigationSections({ sections, title, keepCollectionNamedGroups = false, pathname, onNavigate, mobile = false, showGroupIcons = true }: NavigationSectionsProps) {
  const [disclosures, setDisclosures] = useState<{ sections: Array<NavigationSection>; values: Record<string, NavigationDisclosure> }>({ sections, values: {} })
  const [cursor, setCursor] = useState<{ pathname: string; sections: Array<NavigationSection>; start: number } | null>(null)
  const content = useRef<HTMLDivElement>(null)
  const pendingFocus = useRef<'first' | 'last' | null>(null)
  const visible = useMemo(() => visibleNavigationRows(sections, pathname, disclosures.sections === sections ? disclosures.values : {}), [sections, pathname, disclosures])
  const requestedStart = cursor?.pathname === pathname && cursor.sections === sections
    ? cursor.start
    : Math.max(0, visible.activeIndex - Math.floor(NAVIGATION_WINDOW_SIZE / 2))
  const projection = projectNavigationWindow(visible.rows, requestedStart)
  const selectedRows = new Set(visible.rows.slice(projection.start, projection.end).map(row => row.key))
  useLayoutEffect(() => {
    if (!pendingFocus.current) return
    const targets = content.current?.querySelectorAll<HTMLElement>('[data-navigation-selected] > a[href], [data-navigation-selected] > button:not([disabled])')
    const target = pendingFocus.current === 'first' ? targets?.[0] : targets?.[targets.length - 1]
    target?.focus()
    pendingFocus.current = null
  }, [projection.start, projection.end])

  function renderRows(rows: Array<NavigationWindowRow>) {
    return rows.map(({ row, children }) => {
      if (row.section) return (
        <div key={row.key} className="thally-docs-sidebar-group space-y-2.5" data-navigation-row="section">
          {row.section.defaultOpen === undefined && (mobile || row.section.title !== title || (keepCollectionNamedGroups && !row.section.id?.startsWith('nav-root-'))) ? (
            <p className="flex items-center gap-2 px-2 text-sm font-semibold leading-6 text-foreground">
              {showGroupIcons && row.section.icon ? <Icon icon={row.section.icon} className="h-3.5 w-3.5 shrink-0 text-muted-foreground" /> : null}
              <span>{row.section.title}</span>
            </p>
          ) : null}
          <div className="space-y-px">{renderRows(children)}</div>
        </div>
      )
      const node = row.node!
      if (node.type === 'page') return <div key={row.key} data-navigation-row="page" data-navigation-selected={selectedRows.has(row.key) ? 'true' : undefined}><NavigationPage nodes={[]} node={node} pathname={pathname} onNavigate={onNavigate} mobile={mobile} showGroupIcons={showGroupIcons} /></div>
      const group = node.group
      return (
        <div key={row.key} className="thally-sidebar-group" data-navigation-row="group" data-navigation-selected={selectedRows.has(row.key) ? 'true' : undefined}>
          <button type="button" aria-expanded={row.isOpen} onClick={() => {
            // A retained ancestor can precede the visible range by thousands of
            // rows. Keep its disclosure in view when collapsing that range.
            setCursor({ pathname, sections, start: Math.min(projection.start, visible.rows.indexOf(row)) })
            setDisclosures(current => ({ sections, values: { ...(current.sections === sections ? current.values : {}), [row.key]: { isOpen: !row.isOpen, closedPath: row.isOpen && row.hasActivePath ? pathname : undefined } } }))
          }} className={cn('flex w-full items-center gap-1.5 rounded-lg px-2 py-1.5 text-left text-sm text-muted-foreground transition hover:bg-muted hover:text-foreground', mobile ? 'font-semibold' : 'font-medium leading-6')}>
            <ChevronRight className={cn('h-3.5 w-3.5 shrink-0 transition-transform', row.isOpen && 'rotate-90')} aria-hidden="true" />
            {showGroupIcons && group.icon ? <Icon icon={group.icon} className="h-3.5 w-3.5 shrink-0 text-foreground/50" /> : null}
            <span className="min-w-0 truncate">{group.title}</span>
          </button>
          {row.isOpen && children.length > 0 ? <div className="ml-3 space-y-px pl-2">{renderRows(children)}</div> : null}
        </div>
      )
    })
  }
  function page(direction: 'earlier' | 'later', keyboard: boolean) {
    if (keyboard) pendingFocus.current = direction === 'later' ? 'first' : 'last'
    setCursor({ pathname, sections, start: projection.start + (direction === 'later' ? NAVIGATION_WINDOW_SIZE : -NAVIGATION_WINDOW_SIZE) })
  }
  const hasWindow = projection.total > NAVIGATION_WINDOW_SIZE
  return (
    <div className="space-y-3" data-navigation-window="true">
      {hasWindow ? <div className="flex items-center justify-between gap-2">
        <button type="button" disabled={projection.start === 0} onClick={event => page('earlier', event.detail === 0)} className="rounded px-2 py-1 text-xs text-muted-foreground hover:bg-muted disabled:opacity-40">Show earlier entries</button>
        <button type="button" disabled={projection.end === projection.total} onClick={event => page('later', event.detail === 0)} className="rounded px-2 py-1 text-xs text-muted-foreground hover:bg-muted disabled:opacity-40">Show later entries</button>
      </div> : null}
      {hasWindow ? <p role="status" aria-live="polite" className="px-2 text-xs text-muted-foreground">Navigation entries {projection.start + 1}–{projection.end} of {projection.total}</p> : null}
      <div ref={content} className="space-y-6">{renderRows(projection.roots)}</div>
    </div>
  )
}

/** Render a standalone tree through the same collection-wide window contract. */
export function NavigationTree(props: NavigationTreeProps) {
  const sections = useMemo(() => [{ title: '', items: [], nodes: props.nodes }], [props.nodes])
  return <NavigationSections {...props} sections={sections} title="" />
}
