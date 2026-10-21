'use client'

/** Mintlify-compatible request/response examples plus legacy inline aliases. */

import { Children, cloneElement, isValidElement, type ReactNode } from 'react'
import { CodeGroup, Pre, getPanelTitle } from '@/components/mdx/code-blocks'
import { useApiLabels } from '@/components/api/api-locale'
import { normalizeDocsLanguage } from '@/lib/openapi/code-snippets'

interface ExampleProps {
  children?: ReactNode
  dropdown?: boolean
}

function titledChildren(children: ReactNode) {
  return Children.toArray(children).filter((child) => {
    if (typeof child === 'string') return child.trim().length > 0
    return isValidElement(child)
  })
}

function exampleTitle(node: ReactNode, index: number): string {
  if (!isValidElement(node)) return `Example ${index + 1}`
  const props = node.props as { title?: unknown; label?: unknown; filename?: unknown; language?: unknown; className?: unknown; children?: ReactNode }
  if (typeof props.title === 'string') return props.title
  if (typeof props.label === 'string') return props.label
  if (typeof props.filename === 'string') return props.filename
  const language = typeof props.language === 'string' ? props.language : typeof props.className === 'string' ? /\blanguage-([\w.-]+)/.exec(props.className)?.[1] : undefined
  if (language) return normalizeDocsLanguage(getPanelTitle({ language }))
  const nested = Children.toArray(props.children).find(isValidElement)
  return nested ? exampleTitle(nested, index) : `Example ${index + 1}`
}

function SidebarExample({ children, label }: ExampleProps & { label: string }) {
  const t = useApiLabels()
  const title = label === 'Response' ? t('response') : t('request')
  const items = titledChildren(children).map((child, index) => {
    if (!isValidElement(child)) return child
    const title = exampleTitle(child, index)
    // Legacy JSX can contain a native pre. Unwrap it instead of nesting pre
    // elements, which browsers repair before React hydrates the sample.
    if (child.type === 'pre') {
      const props = child.props as { children?: ReactNode; code?: string; language?: string }
      const codeChild = Children.toArray(props.children).find(isValidElement)
      const codeProps = codeChild?.props as { code?: string; children?: ReactNode; language?: string; className?: string } | undefined
      const source = props.code ?? codeProps?.code ?? (typeof props.children === 'string' ? props.children : codeChild?.type === 'code' && typeof codeProps?.children === 'string' ? codeProps.children : undefined)
      const language = props.language ?? codeProps?.language ?? /\blanguage-([\w.-]+)/.exec(codeProps?.className ?? '')?.[1]
      return <Pre key={index} title={title} code={source} language={language}>{props.children}</Pre>
    }
    return cloneElement(child as React.ReactElement<{ title?: string }>, { title })
  })
  return <section className="not-prose thally-api-example" data-example={label.toLowerCase()}>
    <CodeGroup title={title} menuLabel={`${title} ${t('example').toLowerCase()}`} lines selection={label === 'Response' ? 'status' : 'language'}>{items}</CodeGroup>
  </section>
}

/** Request samples share the endpoint and Try it language preference. */
export function RequestExample(props: ExampleProps) {
  return <SidebarExample {...props} label="Request" />
}

/** Responses retain every authored status variant with keyboard navigation. */
export function ResponseExample(props: ExampleProps) {
  return <SidebarExample {...props} label="Response" />
}

/** Legacy aliases use the same code surfaces as their sidebar counterparts. */
export function InlineRequestExample(props: ExampleProps) {
  return <RequestExample {...props} />
}

/** Legacy response alias, kept compatible with migrated MDX content. */
export function InlineResponseExample(props: ExampleProps) {
  return <ResponseExample {...props} />
}
