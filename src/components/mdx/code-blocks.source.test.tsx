/** Reader actions receive authored source across both direct and opaque client wrappers. */
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
vi.mock('@/components/api/copy-button', () => ({ CopyButton: ({ value }: { value: string }) => <button data-copy-value={value} aria-label="Copy code" /> }))
vi.mock('@/components/docs/code-actions-provider', () => ({ useDocsCodeActions: () => ({ hasAssistantEntryPoint: false }) }))
import { Code, CodeBlock, CodeGroup, findCodePayload } from './code-blocks'
import { RequestExample, ResponseExample } from './examples'

function OpaqueClientBlock({ language, children }: { language?: string; children: string }) {
  return <CodeBlock language={language}>{children}</CodeBlock>
}

function OpaqueCompiledCode({ children, className }: { children: ReactNode; className: string }) {
  return <code className={className}>{children}</code>
}

describe('code action source', () => {
  it('copies raw CodeBlock children in authored request, response, and generic groups', () => {
    const source = 'body = {\n  "title": "Hello"\n}'
    const request = renderToStaticMarkup(<RequestExample><CodeBlock language="python">{source}</CodeBlock></RequestExample>)
    const response = renderToStaticMarkup(<ResponseExample><CodeBlock filename="201">{source}</CodeBlock></ResponseExample>)
    const group = renderToStaticMarkup(<CodeGroup><CodeBlock language="python">{source}</CodeBlock></CodeGroup>)
    for (const markup of [request, response, group]) {
      expect(markup).toContain('data-copy-value="body = {\n  &quot;title&quot;: &quot;Hello&quot;\n}"')
      expect(markup).not.toContain('data-copy-value=""')
    }
  })
  it('preserves raw source when the client wrapper has a different function identity', () => {
    const source = 'body = {"title": "Hello"}'
    expect(findCodePayload(<OpaqueClientBlock language="python">{source}</OpaqueClientBlock>)).toBe(source)
    expect(findCodePayload(<OpaqueClientBlock>{source}</OpaqueClientBlock>)).toBe(source)
    const request = renderToStaticMarkup(<RequestExample><OpaqueClientBlock language="python">{source}</OpaqueClientBlock></RequestExample>)
    expect(request).toContain('data-copy-value="body = {&quot;title&quot;: &quot;Hello&quot;}"')
  })
  it('never treats compiler Code HTML as the plain source payload', () => {
    const highlighted = '<span style="color:red">const answer = 42</span>'
    expect(findCodePayload(<Code className="language-ts">{highlighted}</Code>)).toBeUndefined()
    expect(findCodePayload(<OpaqueCompiledCode className="language-ts">{highlighted}</OpaqueCompiledCode>)).toBeUndefined()
  })
  it('preserves current compiler React nodes and escapes literal HTML code', () => {
    expect(renderToStaticMarkup(<Code><span className="token">const answer = 42</span></Code>)).toContain('<span class="token">const answer = 42</span>')
    expect(renderToStaticMarkup(<Code>{'<img src=x onerror=alert(1)>'}</Code>)).not.toContain('<img')
  })
  it('separates status descriptions so mobile can hide text while retaining the code', () => {
    const response = renderToStaticMarkup(<ResponseExample><CodeBlock filename="201 Created">{'{}'}</CodeBlock><CodeBlock filename="400 Invalid request">{'{}'}</CodeBlock></ResponseExample>)
    expect(response).toContain('201<span class="tc-status-description">Created</span>')
    expect(response).toContain('400<span class="tc-status-description">Invalid request</span>')
  })
})
