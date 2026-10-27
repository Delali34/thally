import { describe, expect, it } from 'vitest'
import { normalizeSpec } from '@/lib/openapi/normalize'
import type { ApiSpecConfig, ResolvedSpec } from '@/lib/openapi/types'

/** `{ "$ref": ..., "description": ... }` next to a `$ref`, as Turso's spec writes `group` (openapi 3.0.1). */
const document = {
  openapi: '3.0.1',
  info: { title: 'Groups', version: '1.0.0' },
  paths: {
    '/groups': {
      post: {
        summary: 'Create group',
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: { template: { $ref: '#/components/schemas/Group', title: 'Template group', description: 'The group to copy' } },
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'ok',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    group: { $ref: '#/components/schemas/Group', description: 'The newly created group' },
                    other: { $ref: '#/components/schemas/Group' },
                    titled: { $ref: '#/components/schemas/Group', title: 'Created group' },
                    blank: { $ref: '#/components/schemas/Group', title: '', description: '' },
                    numeric: { $ref: '#/components/schemas/Group', description: 7 },
                    nullable: { $ref: '#/components/schemas/Group', nullable: true, example: { name: 'x' }, readOnly: true },
                    list: { type: 'array', items: { $ref: '#/components/schemas/Group', description: 'Each group' } },
                    alias: { $ref: '#/components/schemas/GroupAlias', description: 'The alias' },
                    child: { $ref: '#/components/schemas/Node', description: 'The child node' },
                    missing: { $ref: '#/components/schemas/Nothing', description: 'Not in the spec' },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
  components: {
    schemas: {
      Group: { type: 'object', title: 'Group', description: 'A group of databases', properties: { name: { type: 'string' } } },
      GroupAlias: { $ref: '#/components/schemas/Group', description: 'An alias of Group' },
      Node: { type: 'object', description: 'A node', properties: { child: { $ref: '#/components/schemas/Node', description: 'The next node' } } },
    },
  },
}

const config: ApiSpecConfig = { id: 'test', label: 'Test', source: { type: 'inline', document }, tagsOrder: [], defaultGroup: 'Core', webhookGroup: 'Webhooks', operationOverrides: {} }
const resolved: ResolvedSpec = { config, document }

type Props = Record<string, Record<string, unknown>>

function properties(content: 'request' | 'response'): Props {
  const operation = normalizeSpec(resolved).operations[0]
  const media = content === 'request' ? operation.requestBody?.contents[0] : operation.responses.find((response) => response.code === '200')?.contents[0]
  return (media?.schema as { properties: Props }).properties
}

describe('a description or title next to a $ref', () => {
  it('replaces the referenced schema\'s description, in a response and a request body', () => {
    expect(properties('response').group.description).toBe('The newly created group')
    expect(properties('request').template.description).toBe('The group to copy')
    expect(properties('request').template.title).toBe('Template group')
  })

  it('replaces the title the same way, and keeps the rest of the referenced schema', () => {
    expect(properties('response').titled).toMatchObject({ title: 'Created group', description: 'A group of databases', type: 'object', properties: { name: { type: 'string' } } })
    expect(properties('response').group).toMatchObject({ title: 'Group', type: 'object', properties: { name: { type: 'string' } } })
  })

  it('does not change the schema for a reference that has no sibling, or the one other fields share', () => {
    expect(properties('response').other).toMatchObject({ title: 'Group', description: 'A group of databases' })
    expect(properties('response').group.description).toBe('The newly created group')
    expect(properties('response').other.description).toBe('A group of databases')
  })

  it('applies to array items, to a reference that points at another reference, and to a circular one', () => {
    expect((properties('response').list.items as { description: string }).description).toBe('Each group')
    expect(properties('response').alias.description).toBe('The alias')
    expect(properties('response').child.description).toBe('The child node')
  })

  it('ignores an empty or non-text description and title', () => {
    expect(properties('response').blank).toMatchObject({ title: 'Group', description: 'A group of databases' })
    expect(properties('response').numeric.description).toBe('A group of databases')
  })

  it('keeps treating every other sibling of a $ref as before', () => {
    const node = properties('response').nullable
    expect(node).toEqual(properties('response').other)
    expect(node).not.toHaveProperty('nullable')
    expect(node).not.toHaveProperty('example')
    expect(node).not.toHaveProperty('readOnly')
  })

  it('keeps an unresolvable reference as written, with its own description', () => {
    expect(properties('response').missing).toEqual({ $ref: '#/components/schemas/Nothing', description: 'Not in the spec' })
  })
})
