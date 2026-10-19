/** Compatibility coverage for authored and generated API-field metadata. */

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Expandable, ParamField, ResponseField } from '@/components/mdx/api-fields'

describe('API field components', () => {
  it('accepts Mintlify string location props and legacy boolean locations', () => {
    const canonical = renderToStaticMarkup(createElement(ParamField, {
      query: 'limit', type: 'integer', default: 20, placeholder: '25', deprecated: true,
    }, 'Maximum rows.'))
    const legacy = renderToStaticMarkup(createElement(ParamField, {
      path: true, name: 'petId', required: true,
    }))

    expect(canonical).toContain('limit')
    expect(canonical).toContain('placeholder')
    expect(canonical).toContain('deprecated')
    expect(legacy).toContain('petId')
    expect(legacy).toContain('required')
  })

  // Mintlify names a field's location only for a header; body, query and path fields show name, type and required.
  it('labels a header field with its location and no other field', () => {
    const field = (props: Record<string, unknown>) => renderToStaticMarkup(createElement(ParamField, { type: 'string', required: true, ...props }))
    expect(field({ header: 'Authorization' })).toContain('>header</span>')
    for (const props of [{ body: 'runCount' }, { query: 'page' }, { path: 'batchId' }, { name: 'plain' }]) {
      expect(field(props)).not.toMatch(/>(body|query|path|header)<\/span>/)
    }
    expect(field({ query: 'page' })).toContain('<code class="text-sm font-semibold text-foreground">page</code>')
  })

  it('renders response labels and accessible expandable state', () => {
    const response = renderToStaticMarkup(createElement(ResponseField, {
      name: 'status', type: 'string', pre: ['read-only'], post: ['enum'], deprecated: true,
    }))
    const expandable = renderToStaticMarkup(createElement(Expandable, {
      title: 'Child fields', defaultOpen: true,
    }, 'Nested content'))

    expect(response).toContain('read-only')
    expect(response).toContain('enum')
    expect(expandable).toContain('aria-expanded="true"')
    expect(expandable).toContain('Nested content')
  })
})
