/**
 * Shared, self-contained site fixture for agent-surface route tests (MCP,
 * llms-full.txt, changelog feeds). Runtime tests ship to customer sites, so
 * nothing here depends on this repository's own `src/content` or `docs.json`.
 *
 * Test files wire it in with `vi.mock(<module>, async () => (await
 * import('@/lib/mcp/__tests__/agent-surface-fixture')).<export>)`.
 *
 * The fixture deliberately contains the cases agent surfaces must get right:
 * human-only content, a hidden page, a noindex page, a Spanish translation, a
 * changelog with audience-scoped entries, and an API spec whose playground
 * credential must never be echoed.
 */

import { parseMdxContent, type ContentDocument } from '@thallylabs/core/content'
import { parseFrontmatter } from '@/lib/frontmatter'

/** A token configured for the Try It console; must never appear in any output. */
export const PLAYGROUND_SECRET = 'sk_live_FIXTURE_SECRET_123'
export const HUMAN_ONLY = 'HUMAN_ONLY_MARKER'
export const AGENT_ONLY = 'AGENT_ONLY_MARKER'

export const sources: Record<string, string> = {
  introduction: `---
title: Introduction
description: Start here.
---

Welcome to Acme. Install the Acme CLI to begin.
`,
  'guides/auth': `---
title: Authentication
description: Authenticate requests with API keys.
---

Overview of authentication.

## API keys

Create an API key in the dashboard and rotate it monthly.

<Visibility for="humans">
  ${HUMAN_ONLY} Open Settings, then click Create key.
</Visibility>

<Agent>${AGENT_ONLY} Use POST /v1/keys with the keys:write scope.</Agent>

<Steps>
<Step title="Store the key">
Keep it in an environment variable.
</Step>
</Steps>

## Webhooks

Verify the webhook signature header on every delivery.
`,
  'guides/hidden': `---
title: Hidden page
hidden: true
---

Secret-ish hidden page about zebras.
`,
  'guides/draft': `---
title: Draft page
noindex: true
---

Draft page about zebras.
`,
  changelog: `---
title: Changelog
---

<Update label="Live branding" date="2026-06-20" tags={["branding"]}>
  - Brand accent color picker, see [Branding](/guides/auth).
  <Human>${HUMAN_ONLY} teaser</Human>
</Update>

<Update label="Search" date="2026-03-01" description="Faster search.">
Section-level search for agents.
</Update>

<Update label="v0.1.0" date="Spring 2025">
Initial release.
</Update>
`,
  'es/guides/auth': `---
title: Autenticación
description: Autentica solicitudes.
---

## Claves de API

Crea una clave de API en el panel de configuración.
`,
}

interface FixtureEntry {
  id: string
  title: string
  description: string
  slug: Array<string>
  href: string
  keywords: Array<string>
  hidden?: boolean
  noindex?: boolean
}

const DEFAULT_PAGE_IDS = ['introduction', 'guides/auth', 'guides/hidden', 'guides/draft', 'changelog']

export const entries: Array<FixtureEntry> = DEFAULT_PAGE_IDS.map((id) => {
  const { data } = parseFrontmatter(sources[id])
  const slug = id === 'introduction' ? [] : id.split('/')
  return {
    id,
    title: String(data.title),
    description: typeof data.description === 'string' ? data.description : '',
    slug,
    href: slug.length ? `/${slug.join('/')}` : '/',
    keywords: [],
    ...(data.hidden === true ? { hidden: true } : {}),
    ...(data.noindex === true ? { noindex: true } : {}),
  }
})

function document(pageId: string, locale?: string): ContentDocument | null {
  const raw = (locale && sources[`${locale}/${pageId}`]) || sources[pageId]
  if (!raw) return null
  const { data, content } = parseFrontmatter(raw)
  return { pageId, frontmatter: data, rawBody: content, content: parseMdxContent(content, 'agents') }
}

/** Mock for `@/lib/content/document`: the real parser over fixture sources. */
export const contentDocumentModule = {
  getContentDocument: (pageId: string, locale?: string) => document(pageId, locale),
  loadContentDocument: async (pageId: string, locale?: string) => document(pageId, locale),
}

const apiCollection = { id: 'api', label: 'API', api: { source: 'openapi.json' }, sections: [] }

/** Mock for `@/data/docs`. */
export const docsModule = {
  getDocEntries: () => entries,
  loadDocEntries: async () => entries,
  getCurrentVersionPageIds: () => null,
  getSidebarCollections: () => [apiCollection],
  loadSidebarCollections: async () => [
    {
      id: 'docs',
      label: 'Docs',
      sections: [{ title: 'Guides', items: [
        { id: 'guides/auth', title: 'Authentication', href: '/guides/auth' },
        { id: 'introduction', title: 'Introduction', href: '/' },
        { id: 'guides/draft', title: 'Draft page', href: '/guides/draft' },
      ] }],
    },
    { ...apiCollection, sections: [{ title: 'Users', items: [{ id: 'op', title: 'Create user', href: '/api/default/users/post' }] }] },
  ],
  getApiPlaygroundCredentials: () => ({ bearerAuth: PLAYGROUND_SECRET }),
  getApiMdxConfig: () => ({ servers: [] }),
  // No reader auth in this fixture: every page is open to every reader.
  canReaderViewPage: async () => true,
  isDocEntryVisibleTo: () => true,
  isDocPublished: () => true,
  ensureDocPublication: async () => {},
  getI18nConfig: () => ({ defaultLocale: 'en', locales: [{ code: 'en', label: 'English' }, { code: 'es', label: 'Español' }] }),
  tabCollectionId: (tab: string) => tab.toLowerCase(),
}

/** Mock for `@/lib/i18n/request`. */
export const i18nRequestModule = {
  getEffectiveI18nConfig: async () => docsModule.getI18nConfig(),
}

/** Mock for `@/lib/i18n/translation-source`. */
export const translationSourceModule = {
  hasDocTranslation: async (slug: Array<string> | undefined, locale: string) => Boolean(sources[`${locale}/${(slug ?? []).join('/')}`]),
  getIndexableDocTranslation: async (slug: Array<string> | undefined, locale: string) => {
    const raw = sources[`${locale}/${(slug ?? []).join('/')}`]
    if (!raw) return null
    const { data } = parseFrontmatter(raw)
    return { title: data.title as string, description: data.description as string }
  },
}

export const openApiDocument = {
  openapi: '3.1.0',
  info: { title: 'Acme API', version: '1' },
  servers: [{ url: 'https://api.acme.test/v1' }],
  components: {
    securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', description: 'Account API key.' } },
    schemas: {
      User: {
        type: 'object',
        required: ['email'],
        properties: { email: { type: 'string', format: 'email', description: 'Login email.' }, name: { type: 'string' } },
      },
    },
  },
  security: [{ bearerAuth: [] }],
  paths: {
    '/users': {
      post: {
        summary: 'Create user',
        description: 'Creates a user account.',
        tags: ['Users'],
        parameters: [{ name: 'dry_run', in: 'query', required: false, schema: { type: 'boolean' }, description: 'Validate only.' }],
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/User' } } } },
        responses: {
          201: { description: 'Created', content: { 'application/json': { schema: { $ref: '#/components/schemas/User' } } } },
          400: { description: 'Invalid input' },
        },
      },
    },
    '/internal': { get: { summary: 'Internal op', 'x-hidden': true, responses: { 200: { description: 'ok' } } } },
  },
}

/** Mock for `@/config/api-reference`. */
export const apiReferenceConfigModule = {
  apiReferenceConfig: {
    defaultSpecId: 'default',
    specs: [{ id: 'default', label: 'API', source: { type: 'inline', document: openApiDocument } }],
  },
}

/** Mock for `@/lib/openapi/fetch`. */
export const openApiFetchModule = {
  getSpecConfig: (config: { specs: Array<{ id: string }> }, id: string) => config.specs.find((spec) => spec.id === id),
  loadSpec: async (config: { id: string }) => ({ config, document: openApiDocument }),
  loadAuthoredSpecDocument: async () => openApiDocument,
}

/** Mock for `@/lib/site-config`. */
export const siteConfigModule = {
  resolveSiteConfig: async () => ({ name: 'Acme Docs', description: 'Acme product documentation.' }),
  resolveRequestSiteConfig: async () => ({ name: 'Acme Docs', description: 'Acme product documentation.' }),
}

/** In-memory `kvIncrement` storage, resettable between tests. */
export function createMemoryStorage() {
  const counters = new Map<string, number>()
  return {
    counters,
    storage: {
      kvIncrement: async (namespace: string, key: string, options?: { amount?: number }) => {
        const id = `${namespace}:${key}`
        const count = (counters.get(id) ?? 0) + (options?.amount ?? 1)
        counters.set(id, count)
        return { count }
      },
    },
  }
}
