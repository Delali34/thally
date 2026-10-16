/**
 * llms-full.txt is built from the same agent Markdown projection as MCP
 * read_page and the .md mirrors: audience rules, no raw JSX, the search
 * listing's hidden/noindex rules, and compact API operations.
 */

import { describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/data/docs', async () => (await import('@/lib/mcp/__tests__/agent-surface-fixture')).docsModule)
vi.mock('@/lib/content/document', async () => (await import('@/lib/mcp/__tests__/agent-surface-fixture')).contentDocumentModule)
vi.mock('@/lib/i18n/request', async () => (await import('@/lib/mcp/__tests__/agent-surface-fixture')).i18nRequestModule)
vi.mock('@/lib/i18n/translation-source', async () => (await import('@/lib/mcp/__tests__/agent-surface-fixture')).translationSourceModule)
vi.mock('@/config/api-reference', async () => (await import('@/lib/mcp/__tests__/agent-surface-fixture')).apiReferenceConfigModule)
vi.mock('@/lib/openapi/fetch', async () => (await import('@/lib/mcp/__tests__/agent-surface-fixture')).openApiFetchModule)
vi.mock('@/lib/site-config', async () => (await import('@/lib/mcp/__tests__/agent-surface-fixture')).siteConfigModule)
vi.mock('@/lib/agent-readiness', () => ({ computePublishedAgentReadiness: vi.fn() }))

import { GET } from './route'
import { AGENT_ONLY, HUMAN_ONLY, PLAYGROUND_SECRET } from '@/lib/mcp/__tests__/agent-surface-fixture'
import { readAgentPage } from '@/lib/mcp/site-tools'

async function corpus(query = '') {
  const response = await GET(new NextRequest(`https://docs.acme.test/llms-full.txt${query}`))
  return { response, body: await response.text() }
}

describe('GET /llms-full.txt', () => {
  it('embeds exactly the MCP read_page projection of each page', async () => {
    const { body } = await corpus()
    const page = await readAgentPage('guides/auth', { code: 'en', defaultLocale: 'en' }, 'https://docs.acme.test')
    expect(body).toContain(page!.markdown)
    expect(body).toContain(AGENT_ONLY)
    expect(body).not.toContain(HUMAN_ONLY)
    expect(body).not.toMatch(/<\/?(Visibility|Agent|Human|Steps|Step|Update)\b/)
  })

  it('lists pages in sidebar order, then the rest, without hidden or noindex pages', async () => {
    const { body } = await corpus()
    const titles = [...body.matchAll(/^# (.+)$/gm)].map((match) => match[1])
    expect(titles).toEqual(['Acme Docs — Complete Documentation', 'Authentication', 'Introduction', 'Changelog', 'API reference'])
    expect(body).not.toContain('zebras')
  })

  it('appends compact API operations without credentials', async () => {
    const { body } = await corpus()
    expect(body).toContain('## POST /users — Create user')
    expect(body).toContain('URL: https://docs.acme.test/api/default/users/post')
    expect(body).toContain('Request body (application/json, required): `email` (string, required), `name` (string)')
    expect(body).not.toContain('Internal op')
    expect(body).not.toContain(PLAYGROUND_SECRET)
  })

  it('serves a per-locale corpus of translated pages only', async () => {
    const { response, body } = await corpus('?locale=es')
    expect(response.headers.get('content-language')).toBe('es')
    expect(body).toContain('# Autenticación')
    expect(body).toContain('URL: https://docs.acme.test/es/guides/auth')
    expect(body).not.toContain('# Introduction')
    expect(body).not.toContain('# API reference')
  })

  it('rejects a locale the site does not enable', async () => {
    expect((await corpus('?locale=xx')).response.status).toBe(400)
  })

  it('omits an unknown whole-body estimate from the streamed response', async () => {
    const { response } = await corpus()
    expect(response.headers.has('x-thally-approx-tokens')).toBe(false)
  })
})
