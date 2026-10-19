import { ChevronRight } from 'lucide-react'
import { getContextualOptions, type DocEntry } from '@/data/docs'
import { CopyPageButton } from '@/components/docs/copy-page-button'
import { InlineCodeText } from '@/components/mdx/inline-code-text'

interface DocHeaderProps {
  doc: DocEntry
  /** Eyebrow above the title: the page's nearest group, or (an array) its whole group path. */
  eyebrow?: string | Array<string> | null
  showCopyPage?: boolean
  /** Hide a metadata-only summary when another surface renders the full description. */
  showDescription?: boolean
}

export function DocHeader({ doc, eyebrow, showCopyPage = true, showDescription = true }: DocHeaderProps) {
  return (
    <header className="thally-docs-header">
      <div className="flex flex-col items-start gap-4 sm:flex-row sm:justify-between">
        <div className="min-w-0 flex-1">
          {Array.isArray(eyebrow) ? (
            eyebrow.length > 0 ? (
              <div className="thally-docs-eyebrow mb-2.5">
                <ol aria-label="Section path" className="flex flex-wrap items-center gap-1 text-sm leading-5 text-foreground/50">
                  {eyebrow.map((part, index) => (
                    <li key={index} className="flex items-center gap-1">
                      {index > 0 ? <ChevronRight aria-hidden="true" className="h-3 w-3 shrink-0" /> : null}
                      {part}
                    </li>
                  ))}
                </ol>
              </div>
            ) : null
          ) : eyebrow ? (
            <p className="thally-docs-eyebrow mb-2.5 text-sm font-semibold leading-5 text-accent">
              {eyebrow}
            </p>
          ) : null}
          <h1 className="break-words font-heading text-4xl font-semibold leading-10 tracking-[-0.025em] text-foreground">
            {doc.headingTitle ?? doc.title}
          </h1>
          {showDescription && doc.description && doc.descriptionPlacement !== 'body' ? (
            <p className="mt-2 max-w-[58ch] text-lg leading-7 text-foreground/80"><InlineCodeText>{doc.description}</InlineCodeText></p>
          ) : null}
        </div>
        {showCopyPage ? <CopyPageButton options={getContextualOptions()} /> : null}
      </div>
    </header>
  )
}
