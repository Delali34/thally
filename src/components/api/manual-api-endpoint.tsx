'use client'

import { useState } from 'react'
import { ApiLocaleProvider } from '@/components/api/api-locale'
import { EndpointBar } from '@/components/api/endpoint-bar'
import { TryItDialog } from '@/components/api/try-it-dialog'
import { useTryItController } from '@/components/api/use-try-it-controller'
import type { NormalizedOperation } from '@/lib/openapi/types'
import type { PlaygroundDisplay } from '@/lib/openapi/playground-display'

/** Endpoint header + Try It for a page authored with `api:` frontmatter. */
export function ManualApiEndpoint({ operation, playground = 'interactive', locale }: { operation: NormalizedOperation; playground?: PlaygroundDisplay; locale?: string }) {
  return <ManualApiEndpointContent key={`${operation.specId}:${operation.manualPage ?? operation.id}:${operation.key}`} operation={operation} playground={playground} locale={locale} />
}

function ManualApiEndpointContent({ operation, playground, locale }: { operation: NormalizedOperation; playground: PlaygroundDisplay; locale?: string }) {
  const controller = useTryItController(operation)
  const [open, setOpen] = useState(false)
  return (
    <ApiLocaleProvider value={locale}>
    <div className="not-prose mb-8" data-manual-api="">
      <EndpointBar operation={operation} display={playground} onTryIt={() => setOpen(true)} />
      {operation.servers.length === 0 ? (
        <p className="mt-2 text-xs text-foreground/60">
          Live requests are disabled: set <code>api.mdx.server</code> in docs.json or use a full URL in the page&apos;s <code>api</code> frontmatter.
        </p>
      ) : null}
      {playground === 'interactive' ? <TryItDialog controller={controller} open={open} onOpenChange={setOpen} /> : null}
    </div>
    </ApiLocaleProvider>
  )
}
