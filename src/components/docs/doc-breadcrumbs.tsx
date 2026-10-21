import { ChevronRight } from 'lucide-react'
import type { BreadcrumbItem } from '@/data/docs'
import { IntentPrefetchLink } from '@/components/navigation/intent-prefetch-link'

interface DocBreadcrumbsProps {
  items: Array<BreadcrumbItem>
}

export function DocBreadcrumbs({ items }: DocBreadcrumbsProps) {
  if (items.length < 2) return null

  return (
    <nav aria-label="Breadcrumb" className="thally-docs-breadcrumbs flex flex-wrap items-center gap-1 text-sm text-foreground/50">
      {items.map((item, index) => {
        const isLast = index === items.length - 1
        return (
          <span key={index} className="flex items-center gap-1 whitespace-nowrap">
            {index > 0 && <ChevronRight className="h-3 w-3 shrink-0" />}
            {item.href && !isLast ? (
              <IntentPrefetchLink
                href={item.href}
                className="transition hover:text-foreground/80"
              >
                {item.label}
              </IntentPrefetchLink>
            ) : (
              <span className={isLast ? 'text-foreground/70 font-medium' : ''}>
                {item.label}
              </span>
            )}
          </span>
        )
      })}
    </nav>
  )
}
