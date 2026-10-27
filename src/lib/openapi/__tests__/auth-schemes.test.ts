import { describe, expect, it, vi } from 'vitest'
import { normalizeSpec } from '@/lib/openapi/normalize'
import type { ApiSpecConfig, ResolvedSpec } from '@/lib/openapi/types'

let credentials: Record<string, string> = {}
let apiMdx: { servers: Array<string>; auth?: { method: 'bearer' | 'basic' | 'key'; name?: string } } = { servers: [] }
vi.mock('@/data/docs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/data/docs')>()),
  getApiPlaygroundCredentials: () => credentials,
  getApiMdxConfig: () => apiMdx,
}))

const operationFor = (securitySchemes: Record<string, unknown>, security: unknown, extra: Record<string, unknown> = {}, documentExtra: Record<string, unknown> = {}) => {
  const document = {
    openapi: '3.1.0',
    info: { title: 'T', version: '1' },
    servers: [{ url: 'https://api.example.com' }],
    components: { securitySchemes },
    paths: { '/x': { get: { responses: {}, security, ...extra } } },
    ...documentExtra,
  }
  const config: ApiSpecConfig = { id: 't', label: 'T', source: { type: 'inline', document } }
  return normalizeSpec({ config, document } as ResolvedSpec).operations[0]
}

describe('authSchemes from securitySchemes', () => {
  it('describes bearer, basic and apiKey schemes by where the credential goes', () => {
    const op = operationFor(
      {
        b: { type: 'http', scheme: 'bearer', description: 'Your key' },
        c: { type: 'http', scheme: 'basic' },
        h: { type: 'apiKey', in: 'header', name: 'X-Key' },
        q: { type: 'apiKey', in: 'query', name: 'key' },
        k: { type: 'apiKey', in: 'cookie', name: 'sid' },
      },
      [{ b: [] }, { c: [] }, { h: [] }, { q: [] }, { k: [] }],
    )
    expect(op.authSchemes.map(({ name, kind, in: where, paramName }) => ({ name, kind, where, paramName }))).toEqual([
      { name: 'b', kind: 'bearer', where: 'header', paramName: 'Authorization' },
      { name: 'c', kind: 'basic', where: 'header', paramName: 'Authorization' },
      { name: 'h', kind: 'apiKey', where: 'header', paramName: 'X-Key' },
      { name: 'q', kind: 'apiKey', where: 'query', paramName: 'key' },
      { name: 'k', kind: 'apiKey', where: 'cookie', paramName: 'sid' },
    ])
    expect(op.authSchemes[0].description).toBe('Your key')
  })

  it('never prefills a placeholder credential', () => {
    credentials = {}
    const op = operationFor({ b: { type: 'http', scheme: 'bearer' } }, [{ b: [] }])
    expect(op.prefill.header).toEqual({})
    expect(op.authSchemes[0].prefill).toBeUndefined()
  })

  it('keeps the site-wide apiPlayground.credentials prefill', () => {
    credentials = { b: 'Bearer abc' }
    const op = operationFor({ b: { type: 'http', scheme: 'bearer' } }, [{ b: [] }])
    expect(op.authSchemes[0].prefill).toBe('abc')
    credentials = {}
  })
})

describe('authSchemes when the spec declares no security', () => {
  const bearerAuth = { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }
  const summary = (op: ReturnType<typeof operationFor>) => op.authSchemes.map(({ name, kind, in: where, paramName }) => ({ name, kind, where, paramName }))

  it('uses the site-wide docs.json api.mdx.auth', () => {
    apiMdx = { servers: [], auth: { method: 'bearer' } }
    const op = operationFor({ bearerAuth }, undefined)
    expect(summary(op)).toEqual([{ name: 'Authorization', kind: 'bearer', where: 'header', paramName: 'Authorization' }])
    expect(op.security).toEqual([[{ name: 'Authorization', scopes: [] }]])
    apiMdx = { servers: [], auth: { method: 'key', name: 'x-api-key' } }
    expect(summary(operationFor({}, undefined))).toEqual([{ name: 'x-api-key', kind: 'apiKey', where: 'header', paramName: 'x-api-key' }])
    apiMdx = { servers: [] }
  })

  it('invents no credential from the spec components when docs.json configures none', () => {
    for (const schemes of [{ bearerAuth }, { bearerAuth, other: bearerAuth }, {}]) {
      const op = operationFor(schemes, undefined)
      expect(op.authSchemes).toEqual([])
      expect(op.security).toEqual([])
    }
  })

  it('keeps the configured credential when a spec component has the same name', () => {
    apiMdx = { servers: [], auth: { method: 'basic' } }
    expect(summary(operationFor({ Authorization: bearerAuth }, undefined))).toEqual([{ name: 'Authorization', kind: 'basic', where: 'header', paramName: 'Authorization' }])
    apiMdx = { servers: [], auth: { method: 'key', name: 'X-Key' } }
    expect(summary(operationFor({ 'X-Key': { type: 'apiKey', in: 'query', name: 'key' } }, undefined))).toEqual([{ name: 'X-Key', kind: 'apiKey', where: 'header', paramName: 'X-Key' }])
    apiMdx = { servers: [] }
  })

  it('never overrides declared security, including an explicit empty list', () => {
    apiMdx = { servers: [], auth: { method: 'bearer' } }
    expect(operationFor({ bearerAuth }, []).authSchemes).toEqual([])
    expect(operationFor({ bearerAuth }, undefined, {}, { security: [] }).authSchemes).toEqual([])
    expect(summary(operationFor({ bearerAuth }, [{ bearerAuth: [] }]))).toEqual([{ name: 'bearerAuth', kind: 'bearer', where: 'header', paramName: 'Authorization' }])
    apiMdx = { servers: [] }
  })

  it('does not add credentials to webhooks', () => {
    apiMdx = { servers: [], auth: { method: 'bearer' } }
    const document = {
      openapi: '3.1.0',
      info: { title: 'T', version: '1' },
      components: { securitySchemes: { bearerAuth } },
      paths: {},
      webhooks: { hook: { post: { responses: {} } } },
    }
    const config: ApiSpecConfig = { id: 't', label: 'T', source: { type: 'inline', document } }
    expect(normalizeSpec({ config, document } as ResolvedSpec).operations[0].authSchemes).toEqual([])
    apiMdx = { servers: [] }
  })
})
