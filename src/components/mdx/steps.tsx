'use client'

import { createContext, useContext, type ReactNode } from 'react'
import { InlineCodeText } from '@/components/mdx/inline-code-text'
import { plainInlineText } from '@/lib/inline-code'
import { cn } from '@/lib/utils'

// ---------------------------------------------------------------------------
// <Steps> — wrapper that resets the CSS counter
// ---------------------------------------------------------------------------

/** Element a step title renders as. Only `h2`/`h3`/`h4` are headings; `p` is plain text (Mintlify's default). */
export type StepTitleSize = 'p' | 'h2' | 'h3' | 'h4'

interface StepsProps {
  children: ReactNode
  className?: string
  /** Default title element for every step; a step's own `titleSize` wins. */
  titleSize?: StepTitleSize
}

const StepsTitleSizeContext = createContext<StepTitleSize | undefined>(undefined)

export function Steps({ children, className, titleSize }: StepsProps) {
  return (
    <div
      className={cn('thally-steps relative', className)}
      style={{ counterReset: 'step 0' }}
    >
      <StepsTitleSizeContext.Provider value={titleSize}>{children}</StepsTitleSizeContext.Provider>
    </div>
  )
}

// ---------------------------------------------------------------------------
// <Step> — individual step with numbered circle and connector line
// ---------------------------------------------------------------------------

interface StepProps {
  title: string
  titleSize?: StepTitleSize
  /** Set by the page's heading pass for a title that is a heading, so the table of contents can list it and scroll to it. */
  id?: string
  children?: ReactNode
}

function StepTitle({ as: Title, id, children }: { as: StepTitleSize; id?: string; children: string }) {
  // A plain-text (`p`) title is never a heading, whatever id it was handed.
  const heading = id && Title !== 'p' ? { id, 'data-heading': plainInlineText(children), 'data-level': Number(Title[1]) } : undefined
  return <Title {...heading} className="font-heading text-[1.02rem] font-semibold tracking-[-0.012em] text-foreground"><InlineCodeText>{children}</InlineCodeText></Title>
}

export function Step({ title, titleSize, id, children }: StepProps) {
  const inherited = useContext(StepsTitleSizeContext)
  return (
    <div
      className="thally-step relative grid grid-cols-[30px_minmax(0,1fr)] gap-x-5 pb-[34px] last:pb-0"
      style={{ counterIncrement: 'step 1' }}
    >
      {/* Vertical connector line — hidden on last step via CSS */}
      <div className="thally-step-line absolute left-[14px] top-[34px] bottom-1 w-px bg-border" />

      {/* Numbered circle */}
      <div className="thally-step-number relative z-10 flex h-[29px] w-[29px] shrink-0 items-center justify-center rounded-full border border-border bg-background font-mono text-[0.78rem] font-medium text-foreground/70 before:content-[counter(step)]" />

      {/* Step content */}
      <div className="min-w-0 pt-1">
        <StepTitle as={titleSize ?? inherited ?? 'h3'} id={id}>{title}</StepTitle>
        {children ? (
          <div className="prose prose-sm dark:prose-invert mt-2 max-w-none text-foreground/80">
            {children}
          </div>
        ) : null}
      </div>
    </div>
  )
}
