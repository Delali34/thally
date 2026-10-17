/** Contract coverage for the universal documentation API description. */

import { describe, expect, it } from 'vitest'
import { buildDocumentationApiOpenApi } from '@/lib/openapi/documentation-api'

describe('buildDocumentationApiOpenApi', () => {
  it('describes anonymous read operations for a public site', () => {
    const document = buildDocumentationApiOpenApi(
      'https://docs.example.com/a/path?ignored=true',
      'Example Docs',
    )

    expect(document.openapi).toBe('3.1.1')
    expect(document.servers).toEqual([{ url: 'https://docs.example.com' }])
    expect(document.security).toEqual([])
    expect(document.paths).toMatchObject({
      '/api/docs-index': { get: {} },
      '/api/search': { get: {} },
      '/api/docs/{page_id}': { get: {} },
      '/api/agent-readiness': { get: {} },
    })
    expect(JSON.stringify(document.paths)).not.toContain('"security"')
    expect(
      (document.components as Record<string, unknown>).securitySchemes,
    ).toBeUndefined()
    expect(JSON.stringify(document)).not.toContain('oauth2')
    expect(JSON.stringify(document)).not.toContain('apiKey')
  })

  it('advertises the enforced cookie gate for a password-protected site', () => {
    const document = buildDocumentationApiOpenApi(
      'https://private.example.com',
      'Private Docs',
      { accessMode: 'password', accessCookieName: 'docs-access' },
    )
    const components = document.components as Record<string, unknown>
    const paths = document.paths as Record<
      string,
      { get: { responses: Record<string, unknown> } }
    >

    expect(document.security).toEqual([{ docsAccess: [] }])
    expect(document.externalDocs).toEqual({
      description: 'Interactive documentation access',
      url: 'https://private.example.com/access',
    })
    expect(components.securitySchemes).toEqual({
      docsAccess: expect.objectContaining({
        type: 'apiKey',
        in: 'cookie',
        name: 'docs-access',
      }),
    })
    for (const path of Object.values(paths)) {
      expect(path.get.responses['401']).toBeDefined()
    }
    expect(JSON.stringify(document.info)).toContain('password-protected')
  })

  it('documents both negotiated 404 representations for page reads', () => {
    const document = buildDocumentationApiOpenApi('https://docs.example.com')
    const paths = document.paths as Record<
      string,
      { get: { responses: Record<string, { content?: Record<string, unknown> }> } }
    >
    const notFound = paths['/api/docs/{page_id}'].get.responses['404']

    expect(Object.keys(notFound.content ?? {}).sort()).toEqual([
      'application/problem+json',
      'text/markdown',
    ])
  })

  it('documents requested hybrid ranking and both explicit fulltext degradation reasons', () => {
    const document = buildDocumentationApiOpenApi('https://docs.example.com')
    const schemas = (document.components as { schemas: Record<string, { properties: Record<string, unknown> }> }).schemas
    const paths = document.paths as Record<string, unknown>
    expect(schemas.SearchResults.properties.mode_requested).toEqual({ type: 'string', enum: ['hybrid'] })
    expect(schemas.SearchResults.properties.mode_degraded_reason).toEqual({ type: 'string', enum: ['rate_limited', 'runtime_capacity'] })
    expect(JSON.stringify(paths['/api/search'])).toContain('runtime_capacity')
  })
})
