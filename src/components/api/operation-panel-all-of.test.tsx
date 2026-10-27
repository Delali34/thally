import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { OperationPanel } from '@/components/api/operation-panel'
import { operationFrom } from '@/components/api/test-fixtures'

const render = (operation: Record<string, unknown>) =>
  renderToStaticMarkup(
    <OperationPanel
      operation={operationFrom({
        openapi: '3.0.3',
        info: { title: 'T', version: '1' },
        servers: [{ url: 'https://api.example.com' }],
        paths: { '/api/v1/things': { post: { summary: 'Thing', responses: {}, ...operation } } },
      })}
    />,
  )

const body = (schema: Record<string, unknown>) => ({ requestBody: { content: { 'application/json': { schema } } } })

// A connection endpoint as a generated spec writes it: the credentials sit in a union that is one fragment of an allOf,
// the name in the other.
const named = {
  type: 'object',
  properties: { name: { type: 'string', description: 'The name of the connection. Must be slug-friendly.' } },
  required: ['name'],
}
const checkly = {
  type: 'object',
  properties: {
    method: { type: 'string', enum: ['api-key'], description: 'The method used to authenticate with Checkly.' },
    credentials: { type: 'object', properties: { apiKey: { type: 'string' } }, description: 'The credentials used to connect with Checkly.' },
  },
  required: ['method', 'credentials'],
  additionalProperties: false,
}
const awsAssumeRole = {
  type: 'object',
  properties: {
    method: { type: 'string', enum: ['assume-role'], description: 'The method used to authenticate with AWS.' },
    credentials: { type: 'object', properties: { roleArn: { type: 'string' } }, description: 'The credentials used to connect with AWS.' },
  },
  required: ['method', 'credentials'],
}
const awsAccessKey = {
  type: 'object',
  properties: {
    method: { type: 'string', enum: ['access-key'], description: 'The method used to authenticate with AWS.' },
    credentials: { type: 'object', properties: { accessKeyId: { type: 'string' } }, description: 'The credentials used to connect with AWS.' },
  },
  required: ['method', 'credentials'],
}

describe('a union inside allOf in a request body', () => {
  it('lists the fields of a union with one variant next to the fields of the rest', () => {
    const html = render(body({ allOf: [{ anyOf: [checkly] }, named] }))
    expect(html).toContain('The method used to authenticate with Checkly.')
    expect(html).toContain('The credentials used to connect with Checkly.')
    expect(html).toContain('The name of the connection.')
  })

  it('lists the shared fields and the first variant, with a tab for every variant', () => {
    const html = render(body({ allOf: [{ anyOf: [awsAssumeRole, awsAccessKey] }, named] }))
    expect(html).toContain('The method used to authenticate with AWS.')
    expect(html).toContain('The name of the connection.')
    expect(html).toContain('assume-role')
    expect(html.match(/role="tab"/g)).toHaveLength(2)
  })

  it('lists the fields of a union around a property of a response', () => {
    const html = render({
      responses: {
        '200': {
          description: 'ok',
          content: { 'application/json': { schema: { type: 'object', properties: { connection: { allOf: [{ anyOf: [checkly] }, named] } } } } },
        },
      },
    })
    expect(html).toContain('The method used to authenticate with Checkly.')
    expect(html).toContain('The name of the connection.')
  })
})
