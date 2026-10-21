'use client'

import { CopyButton } from '@/components/api/copy-button'
import { useApiLabels } from '@/components/api/api-locale'
import { getMethodToken } from '@/components/api/tokens'
import type { NormalizedOperation } from '@/lib/openapi/types'
import type { PlaygroundDisplay } from '@/lib/openapi/playground-display'
import { cn } from '@/lib/utils'

/**
 * Method badge, path, and the Try it button shared by every API page.
 * `simple` shows a copyable endpoint with no playground; `none` shows nothing.
 */
export function EndpointBar({
  operation,
  onTryIt,
  display = 'interactive',
}: {
  operation: NormalizedOperation
  onTryIt: () => void
  display?: PlaygroundDisplay
}) {
  const t = useApiLabels()
  if (display === 'none') return null
  const methodToken = getMethodToken(operation.method)
  return (
    <div className="thally-endpoint-bar">
      <span className={cn('font-mono text-xs font-medium', methodToken.text)}>{operation.isWebhook ? t('webhook') : operation.method}</span>
      <code className="thally-endpoint-path">
        {operation.path.split(/(\{[^}]+\})/g).map((part, index) => part.startsWith('{') ? <i key={index}>{part}</i> : part)}
      </code>
      {operation.isWebhook ? null : <CopyButton value={`${operation.servers[0]?.url?.replace(/\/$/, '') ?? ''}${operation.path}`} label="Copy URL" />}
      {!operation.isWebhook && display === 'interactive' ? (
        <button type="button" onClick={onTryIt} className="thally-endpoint-try">{t('tryIt')}</button>
      ) : null}
    </div>
  )
}
