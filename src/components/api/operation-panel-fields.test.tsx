import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { OperationPanel } from '@/components/api/operation-panel'
import { operationFrom } from '@/components/api/test-fixtures'

const render = (operation: Record<string, unknown>, document: Record<string, unknown> = {}) =>
  renderToStaticMarkup(
    <OperationPanel
      operation={operationFrom({
        openapi: '3.0.1',
        info: { title: 'T', version: '1' },
        servers: [{ url: 'https://api.example.com' }],
        paths: { '/things/{email}': { post: { summary: 'Thing', responses: {}, ...operation } } },
        ...document,
      })}
    />,
  )

describe('parameter rows', () => {
  it('show the description that sits on the parameter schema', () => {
    const html = render({
      parameters: [{ name: 'email', in: 'path', required: true, schema: { type: 'string', description: 'The email of the user invited.' } }],
    })
    expect(html).toContain('The email of the user invited.')
  })

  it('prefer the parameter description over the schema one', () => {
    const html = render({
      parameters: [{ name: 'email', in: 'path', required: true, description: 'Parameter text.', schema: { type: 'string', description: 'Schema text.' } }],
    })
    expect(html).toContain('Parameter text.')
    expect(html).not.toContain('Schema text.')
  })

  it('read the description and values of a parameter schema that is a $ref', () => {
    const components = { components: { schemas: { Role: { type: 'string', description: 'The role.', enum: ['admin', 'member'] } } } }
    const html = render({ parameters: [{ name: 'role', in: 'query', schema: { $ref: '#/components/schemas/Role' } }] }, components)
    expect(html).toContain('The role.')
    expect(html).toContain('Allowed: admin, member')
    expect(html).toContain('enum&lt;string&gt;')
  })

  it('let a description next to the $ref win over the referenced one', () => {
    const components = { components: { schemas: { Role: { type: 'string', description: 'The role.', enum: ['admin'] } } } }
    const html = render({ parameters: [{ name: 'role', in: 'query', schema: { $ref: '#/components/schemas/Role', description: 'Own text.' } }] }, components)
    expect(html).toContain('Own text.')
    expect(html).not.toContain('The role.')
  })

  it('add no empty description block to a parameter that has neither description nor values', () => {
    const html = render({ parameters: [{ name: 'limit', in: 'query', schema: { type: 'integer' } }] })
    expect(html).toContain('limit')
    expect(html).not.toContain('mt-2.5')
  })

  it('list the allowed values of a query parameter', () => {
    const html = render({
      parameters: [{ name: 'type', in: 'query', schema: { type: 'string', enum: ['all', 'upcoming', 'issued'] } }],
    })
    expect(html).toContain('Allowed: all, upcoming, issued')
  })
})

describe('body field rows', () => {
  const body = (properties: Record<string, unknown>) => ({
    requestBody: { content: { 'application/json': { schema: { type: 'object', properties } } } },
  })

  it('list the allowed values of an array of enum items', () => {
    const html = render(body({ scopes: { type: 'array', items: { type: 'string', enum: ['read', 'db:create'] } } }))
    expect(html).toContain('Allowed: read, db:create')
  })

  it('list the allowed values of a union of enums in member order, once each', () => {
    const html = render(body({ role: { oneOf: [{ type: 'string', enum: ['admin'] }, { type: 'string', enum: ['member', 'admin'] }] } }))
    expect(html).toContain('Allowed: admin, member<')
  })

  it('include null in the allowed values of a nullable union', () => {
    const html = render(body({ role: { anyOf: [{ type: 'string', enum: ['a', 'b'] }, { type: 'null' }] } }))
    expect(html).toContain('Allowed: a, b, null<')
  })

  it('list no values for a union that has a member that is not an enum', () => {
    const html = render(
      body({
        extensions: {
          oneOf: [
            { type: 'string', enum: ['all'] },
            { type: 'array', items: { type: 'string', enum: ['vector', 'uuid'] } },
          ],
        },
      }),
    )
    expect(html).not.toContain('Allowed:')
  })

  it('still list the values of a plain enum once', () => {
    const html = render(body({ role: { type: 'string', enum: ['admin', 'member'] } }))
    expect(html.match(/Allowed: admin, member/g)).toHaveLength(1)
  })
})

describe('map fields (additionalProperties)', () => {
  const response = (schema: Record<string, unknown>) =>
    render({ responses: { '200': { description: 'ok', content: { 'application/json': { schema: { type: 'object', properties: { locations: schema } } } } } } })

  it('list the value schema as a {key} row under the map', () => {
    const html = response({ type: 'object', description: 'Location codes to names.', additionalProperties: { type: 'string' } })
    expect(html).toContain('locations properties')
    expect(html).toMatch(/<code[^>]*>\{key\}<\/code>.*?string/)
  })

  it('keep the fixed properties and add the {key} row after them', () => {
    const html = response({ type: 'object', properties: { total: { type: 'integer' } }, additionalProperties: { type: 'string' } })
    expect(html.indexOf('>total<')).toBeGreaterThan(-1)
    expect(html.indexOf('>total<')).toBeLessThan(html.indexOf('>{key}<'))
  })

  it('keep a real property named {key} and add no synthetic row beside it', () => {
    const html = response({ type: 'object', properties: { '{key}': { type: 'integer', description: 'A real field.' } }, additionalProperties: { type: 'string' } })
    expect(html.match(/>\{key\}</g)).toHaveLength(1)
    expect(html).toContain('A real field.')
    expect(html).toMatch(/>\{key\}<\/code><span[^>]*>integer</)
  })

  it('open a map of objects through the same nested rows', () => {
    const html = response({ type: 'object', additionalProperties: { type: 'object', properties: { name: { type: 'string' } } } })
    expect(html).toContain('>{key}<')
    expect(html).toContain('>name<')
  })

  it('show a map that is a oneOf variant', () => {
    const html = response({ oneOf: [{ type: 'object', title: 'Named', additionalProperties: { type: 'string' } }, { type: 'string' }] })
    expect(html).toContain('>{key}<')
  })

  it('add no row for an open map without a value schema', () => {
    const html = response({ type: 'object', additionalProperties: true })
    expect(html).not.toContain('>{key}<')
    expect(html).not.toContain('locations properties')
  })
})
