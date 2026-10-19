/**
 * Structured API-field rows used by authored MDX and generated OpenAPI pages.
 *
 * Field metadata remains visible at a glance while nested attributes use an
 * accessible disclosure control. The same primitives intentionally serve the
 * generated API renderer and customer-authored component surface.
 */

'use client'

import { useId, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { useApiLabels } from '@/components/api/api-locale'
import { cn } from '@/lib/utils'
import type { ReactNode } from 'react'

/**
 * Typography for a field's description. Tailwind's `not-prose` opt-out reaches every descendant,
 * so no ancestor of this block may carry it, or paragraphs, inline code and fenced code lose
 * their prose styles. The trailing rules drop the first and last block's outer margin inside
 * rendered Markdown, so a one-paragraph description keeps the row height it has without prose.
 */
const descriptionClass =
  'prose prose-sm mt-2.5 max-w-none text-foreground/75 dark:prose-invert [&_div>:first-child]:mt-0 [&_div>:last-child]:mb-0'

// ---------------------------------------------------------------------------
// ResponseField
// ---------------------------------------------------------------------------

interface ResponseFieldProps {
  name: string
  type?: string
  required?: boolean
  deprecated?: boolean
  default?: ReactNode
  pre?: Array<string>
  post?: Array<string>
  children?: ReactNode
}

export function ResponseField({
  name,
  type,
  required,
  deprecated,
  default: defaultValue,
  pre = [],
  post = [],
  children,
}: ResponseFieldProps) {
  const t = useApiLabels()
  return (
    <section className="border-b border-border/70 py-5 last:border-0">
      <div className="not-prose flex flex-wrap items-baseline gap-x-2.5 gap-y-1.5">
        {pre.map((label) => <span key={`pre-${label}`} className="rounded bg-muted px-1.5 py-0.5 text-[0.68rem] font-medium text-foreground/60">{label}</span>)}
        <code className={cn('text-sm font-semibold text-foreground', deprecated && 'line-through opacity-65')}>{name}</code>
        {post.map((label) => <span key={`post-${label}`} className="rounded bg-muted px-1.5 py-0.5 text-[0.68rem] font-medium text-foreground/60">{label}</span>)}
        {type && (
          <span className="rounded border border-border/50 bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground/70">
            {type}
          </span>
        )}
        {required && (
          <span className="text-[0.7rem] font-semibold text-rose-600 dark:text-rose-400">
            {t('required')}
          </span>
        )}
        {deprecated && <span className="text-[0.7rem] font-semibold text-amber-700 dark:text-amber-300">{t('deprecated')}</span>}
        {defaultValue !== undefined && (
          <span className="text-xs text-foreground/50">
            {t('default')} <code className="font-mono text-foreground/70">{defaultValue}</code>
          </span>
        )}
      </div>
      {children && (
        <div className={descriptionClass}>{children}</div>
      )}
    </section>
  )
}

// ---------------------------------------------------------------------------
// ParamField
// ---------------------------------------------------------------------------

interface ParamFieldProps {
  body?: boolean | string
  query?: boolean | string
  path?: boolean | string
  header?: boolean | string
  name?: string
  type?: string
  required?: boolean
  deprecated?: boolean
  default?: ReactNode
  placeholder?: string
  children?: ReactNode
}

export function ParamField({ name, type, required, deprecated, body, query, path, header, default: defaultValue, placeholder, children }: ParamFieldProps) {
  const t = useApiLabels()
  // As on Mintlify, only a header names its location; body, query and path fields show name, type and required.
  const isHeader = !path && !query && Boolean(header)
  const locatedName = [path, query, header, body].find((value): value is string => typeof value === 'string' && value.length > 0)
  const fieldName = locatedName ?? name ?? 'parameter'
  return (
    <section className="border-b border-border/70 py-5 last:border-0">
      <div className="not-prose flex flex-wrap items-baseline gap-x-2.5 gap-y-1.5">
        <code className={cn('text-sm font-semibold text-foreground', deprecated && 'line-through opacity-65')}>{fieldName}</code>
        {isHeader && (
          <span className="font-mono text-[0.7rem] font-medium text-green-700 dark:text-green-300">header</span>
        )}
        {type && (
          <span className="rounded border border-border/50 bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground/70">
            {type}
          </span>
        )}
        {required && (
          <span className="text-[0.7rem] font-semibold text-rose-600 dark:text-rose-400">
            {t('required')}
          </span>
        )}
        {deprecated && <span className="text-[0.7rem] font-semibold text-amber-700 dark:text-amber-300">{t('deprecated')}</span>}
        {defaultValue !== undefined && (
          <span className="text-xs text-foreground/50">
            {t('default')}: <code className="font-mono">{defaultValue}</code>
          </span>
        )}
        {placeholder ? <span className="text-xs text-foreground/50">placeholder <code className="font-mono text-foreground/70">{placeholder}</code></span> : null}
      </div>
      {children && (
        <div className={descriptionClass}>{children}</div>
      )}
    </section>
  )
}

// ---------------------------------------------------------------------------
// Expandable
// ---------------------------------------------------------------------------

interface ExpandableProps {
  title?: string
  defaultOpen?: boolean
  children?: ReactNode
}

export function Expandable({ title, defaultOpen = false, children }: ExpandableProps) {
  const t = useApiLabels()
  const [open, setOpen] = useState(defaultOpen)
  const contentId = useId()
  return (
    <div className="my-3">
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        aria-expanded={open}
        aria-controls={contentId}
        className="group flex items-center gap-1.5 rounded-md py-1 text-xs font-medium text-accent transition-colors hover:text-accent/75 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:ring-offset-2 focus-visible:ring-offset-background"
      >
        <ChevronRight className={cn('h-3.5 w-3.5 transition-transform duration-200', open && 'rotate-90')} aria-hidden="true" />
        {title ?? t('showChildAttributes')}
      </button>
      <div
        id={contentId}
        hidden={!open}
        className="mt-3 border-l border-border pl-4"
      >
        {children}
      </div>
    </div>
  )
}
