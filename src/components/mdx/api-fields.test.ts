/** Compatibility coverage for authored and generated API-field metadata. */

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ApiLocaleProvider } from '@/components/api/api-locale'
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

  // Mintlify gives every field an id so a link can land on it; the id sits on the head row and changes nothing else.
  it('puts the id it is handed on the field head and leaves the rest of the markup as it was', () => {
    for (const [Field, props] of [
      [ParamField, { body: 'expiresInDays', type: 'integer', required: true }],
      [ResponseField, { name: 'pagination.cursor', type: 'string' }],
    ] as const) {
      const plain = renderToStaticMarkup(createElement(Field as never, props, 'Body.'))
      const withId = renderToStaticMarkup(createElement(Field as never, { ...props, id: 'param-x' }, 'Body.'))
      expect(plain).not.toContain(' id=')
      expect(withId).toMatch(/<div [^>]*\bid="param-x"[^>]*><code /)
      expect(withId).not.toMatch(/<section [^>]*\bid=/)
      expect(withId.replace(' id="param-x"', '')).toBe(plain)
    }
  })

  it('exposes named keyboard-focusable rows for parameter and code linking', () => {
    const parameter = renderToStaticMarkup(createElement(ParamField, {
      name: 'title', type: 'string', required: true, default: 'draft',
    }, 'Page title.'))
    const response = renderToStaticMarkup(createElement(ResponseField, { name: 'title', type: 'string' }))
    for (const markup of [parameter, response]) {
      expect(markup).toContain('data-p="title"')
      expect(markup).toContain('tabindex="0"')
      expect(markup).toContain('thally-parameter-header')
    }
    expect(parameter).toContain('thally-parameter-required')
    expect(parameter).not.toContain('rounded border')
  })

  it('preserves localized metadata and description prose outside not-prose ancestors', () => {
    const markup = renderToStaticMarkup(createElement(ApiLocaleProvider, { value: 'es' }, createElement(ParamField, { name: 'title', required: true, deprecated: true, default: 'draft' }, createElement('p', null, 'Descripción'))))
    expect(markup).toContain('requerido')
    expect(markup).toContain('obsoleto')
    expect(markup).toContain('predeterminado')
    expect(markup).toContain('prose prose-sm')
    expect(markup).not.toMatch(/<section[^>]*class="[^"]*not-prose/)
    expect(markup).toContain('[&amp;_div&gt;:first-child]:mt-0')
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
