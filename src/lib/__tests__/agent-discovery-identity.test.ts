/** Tenant-isolation coverage for public agent discovery documents. */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const accessMocks = vi.hoisted(() => ({
  resolveDocumentationAccessMode: vi.fn(),
}))

vi.mock('@/lib/openapi/documentation-access', () => ({
  resolveDocumentationAccessMode: accessMocks.resolveDocumentationAccessMode,
}))

import * as discoveryRoute from '@/app/api/well-known/[...document]/route'
import { GET } from '@/app/api/well-known/[...document]/route'
import { mcpServerCard, oauthProtectedResource } from '@/lib/agent-discovery-responses'
import { buildAiTxtBody } from '@/lib/agent-discovery'
import { agentServerName } from '@/lib/agent-identity'
import { buildAgentsManifest, buildSkillManifest } from '@/lib/agent-manifest'
import type { SiteIdentity } from '@/lib/site-config'

const identity: SiteIdentity = {
  name: 'Launch Sentinel',
  description: 'Sentinel documentation',
  repoUrl: 'https://github.com/acme/launch-sentinel',
  links: [],
}

describe('agent discovery identity', () => {
  beforeEach(() => {
    accessMocks.resolveDocumentationAccessMode.mockReset().mockResolvedValue('public')
  })

  it('exports only supported Next.js route entrypoints', () => {
    expect(Object.keys(discoveryRoute)).toEqual(['GET'])
  })

  it('uses a customer-specific MCP identifier', () => {
    expect(agentServerName(identity.name)).toBe('launch-sentinel-docs')
  })

  it('does not advertise an A2A Agent Card without an A2A transport', async () => {
    const response = await GET(
      new NextRequest('https://sentinel.example.com/.well-known/agent-card.json'),
      { params: Promise.resolve({ document: ['agent-card'] }) },
    )

    expect(response.status).toBe(404)
  })

  it('keeps every discovery card free of baseline identity', async () => {
    const responses = [
      mcpServerCard('https://sentinel.example.com', identity),
      oauthProtectedResource('https://sentinel.example.com', identity),
    ]
    const documents = await Promise.all(
      responses.map(async (response) => JSON.stringify(await response.json())),
    )

    for (const document of documents) {
      expect(document).toContain('Launch Sentinel')
      expect(document).not.toContain('Bench Three')
      expect(document).not.toContain('Thally documentation')
      expect(document).not.toContain('thally-docs')
    }
  })

  it('omits empty OAuth server and scope arrays as RFC 9728 requires', async () => {
    const metadata = await oauthProtectedResource(
      'https://sentinel.example.com',
      identity,
    ).json()

    expect(metadata.authorization_servers).toBeUndefined()
    expect(metadata.scopes_supported).toBeUndefined()
    expect(metadata.bearer_methods_supported).toEqual([])
    expect(metadata.x_thally_access).toBeUndefined()
  })

  it('publishes the password and cookie flow without claiming OAuth support', async () => {
    accessMocks.resolveDocumentationAccessMode.mockResolvedValue('password')
    const route = (document: Array<string>) => GET(
      new NextRequest(`https://sentinel.example.com/.well-known/${document.join('/')}`),
      { params: Promise.resolve({ document }) },
    )

    const [resourceResponse, serverResponse, authResponse, mcpResponse, skillResponse] =
      await Promise.all([
        route(['oauth-protected-resource']),
        route(['oauth-authorization-server']),
        route(['auth-md']),
        route(['mcp-server-card']),
        route(['agent-skills-file', 'search-docs.md']),
      ])
    const resource = await resourceResponse.json()
    const serverProblem = await serverResponse.json()
    const authGuide = await authResponse.text()
    const mcpCard = await mcpResponse.json()
    const skill = await skillResponse.text()

    expect(resource).toMatchObject({
      bearer_methods_supported: [],
      x_thally_access: {
        mode: 'password',
        credential: 'cookie',
        cookie_name: 'thally_docs_access',
        authentication_endpoint: 'https://sentinel.example.com/api/access/auth',
        interactive_login: 'https://sentinel.example.com/access',
      },
    })
    expect(resource.authorization_servers).toBeUndefined()
    expect(resource.scopes_supported).toBeUndefined()
    expect(serverProblem.detail).toContain('password-protected')
    expect(serverProblem.detail).toContain('not an OAuth authorization server')
    expect(serverProblem.resolution).toContain('POST /api/access/auth')
    expect(serverProblem.resolution).not.toContain('without credentials')
    expect(authGuide).toContain('signed docs-access session cookie')
    expect(authGuide).toContain('OAuth is **not supported**')
    expect(authGuide).toContain('Cookie: thally_docs_access=<session-value>')
    expect(authGuide).not.toContain('access is anonymous')
    expect(mcpCard.authentication).toMatchObject({
      type: 'cookie',
      in: 'cookie',
      name: 'thally_docs_access',
    })
    expect(skill).toContain('Authenticate first')
    expect(skill).toContain('thally_docs_access')
    expect(skill).not.toContain('No authentication required')
  })

  it('answers authorization-server discovery honestly with Problem Details', async () => {
    const response = await GET(
      new NextRequest(
        'https://sentinel.example.com/.well-known/oauth-authorization-server',
      ),
      { params: Promise.resolve({ document: ['oauth-authorization-server'] }) },
    )

    expect(response.status).toBe(404)
    expect(response.headers.get('content-type')).toContain(
      'application/problem+json',
    )
    await expect(response.json()).resolves.toMatchObject({
      code: 'oauth_not_supported',
      status: 404,
    })
  })

  it('publishes a consistent evidence-first workflow across agent surfaces', () => {
    const base = 'https://sentinel.example.com'
    const aiTxt = buildAiTxtBody(identity, base)
    const skill = buildSkillManifest(identity, base)
    const agents = buildAgentsManifest(identity, base)

    expect(aiTxt).toContain(`${base}/api/search?q={query}`)
    expect(aiTxt).toContain(`${base}/AGENTS.md`)
    expect(skill).toContain('Start with the index or search')
    expect(skill).toContain('Cite the canonical page URLs')
    expect(skill).toContain(`${base}/openapi.yaml`)
    expect(agents).toContain('Read this file, `docs.json`')
    expect(agents).toContain('Do not invent product behavior')
    expect(agents).toContain('checked-in workflow/tooling lock')
    expect(agents).not.toContain('npx thally check')
  })
})
