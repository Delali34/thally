/**
 * Accessible disclosure components for authored MDX.
 *
 * Accordions work independently or as joined items inside AccordionGroup. Item
 * ids are also URL targets: following a hash opens the matching disclosure.
 */
'use client'

import { createContext, useContext, useEffect, useId, useRef, type ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'
import { Icon } from '@/components/mdx/content-icon'
import { InlineCodeText } from '@/components/mdx/inline-code-text'
import { plainInlineText } from '@/lib/inline-code'
import { cn } from '@/lib/utils'

/**
 * Items are native <details> elements, as in Mintlify: the body is always in
 * the server HTML (collapsed, not unmounted), so search, Ctrl+F, anchors and
 * crawlers see it. Single groups share a `name`, which makes the browser close
 * the other items.
 */
interface AccordionGroupContextValue {
  name?: string
  defaultValue: string[]
}

const AccordionGroupContext = createContext<AccordionGroupContextValue | null>(null)

export interface AccordionProps {
  title: string
  description?: string
  id?: string
  icon?: string
  iconType?: 'solid' | 'outline'
  defaultOpen?: boolean
  children?: ReactNode
}

export interface AccordionGroupProps {
  children?: ReactNode
  type?: 'single' | 'multiple'
  defaultValue?: string | string[]
  className?: string
}

function normalizeId(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

/** Render one disclosure, either independently or as part of AccordionGroup. */
export function Accordion({ title, description, id, icon, iconType, defaultOpen, children }: AccordionProps) {
  const group = useContext(AccordionGroupContext)
  const generatedId = useId().replace(/:/g, '')
  const value = id || normalizeId(plainInlineText(title)) || generatedId
  const ref = useRef<HTMLDetailsElement>(null)
  const open = Boolean(defaultOpen) || Boolean(group?.defaultValue.includes(value))

  useEffect(() => {
    if (window.location.hash.slice(1) === value && ref.current) ref.current.open = true
  }, [value])

  return (
    <details
      ref={ref}
      id={value}
      name={group?.name}
      open={open}
      className={cn('group/accordion scroll-mt-24', group ? 'border-b border-border/60 last:border-b-0' : 'not-prose my-4 overflow-hidden rounded-xl border border-border/60 bg-card')}
    >
      <summary
        data-accordion-trigger
        aria-controls={`${value}-accordion-children`}
        className="group flex w-full cursor-pointer list-none items-start justify-between gap-4 px-4 py-4 text-left transition-colors hover:bg-muted/35 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent [&::-webkit-details-marker]:hidden"
      >
        <span className="flex min-w-0 gap-3">
          {icon ? (
            <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border/60 bg-muted/40">
              <Icon icon={icon} iconType={iconType} className="h-4 w-4 text-foreground/65" />
            </span>
          ) : null}
          <span className="min-w-0">
            <span className="block text-base font-semibold leading-6 text-foreground"><InlineCodeText>{title}</InlineCodeText></span>
            {description ? (
              <span className="mt-0.5 block text-sm font-normal leading-5 text-foreground/60">{description}</span>
            ) : null}
          </span>
        </span>
        <ChevronDown className="mt-1 h-4 w-4 shrink-0 text-foreground/45 transition-transform duration-200 group-open/accordion:rotate-180" aria-hidden="true" />
      </summary>
      <div id={`${value}-accordion-children`} role="region" className="thally-accordion-content prose prose-sm px-4 pb-5 pt-1 text-foreground/80 dark:prose-invert">
        {children}
      </div>
    </details>
  )
}

/** Join related accordions into one bordered group. */
export function AccordionGroup({ children, type = 'single', defaultValue, className }: AccordionGroupProps) {
  const name = useId()
  const defaults = Array.isArray(defaultValue) ? defaultValue : defaultValue ? [defaultValue] : []
  const context = { name: type === 'single' ? name : undefined, defaultValue: type === 'single' ? defaults.slice(0, 1) : defaults }

  return (
    <AccordionGroupContext.Provider value={context}>
      <div className={cn('not-prose my-4 overflow-hidden rounded-xl border border-border/60 bg-card', className)}>{children}</div>
    </AccordionGroupContext.Provider>
  )
}
