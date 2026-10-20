/** URL migration fixtures prove path scoping and Markdown-first discovery. */

import { describe, expect, it } from 'vitest'

import { migrateUrl, renderMigrationFiles, type MigrationFetcher } from '../index.js'

function response(url: string, body: string, contentType: string) {
  return { finalUrl: new URL(url), body, contentType }
}

describe('public URL migration', () => {
  async function migrateFlightFixture(integrations?: unknown) {
    const sourceUrl = 'https://product.test/docs/introduction'
    const navigation = {
      global: null,
      dropdowns: [
        {
          dropdown: 'Documentation',
          groups: [{
            group: 'Getting started',
            pages: [
              { title: 'Welcome', sidebarTitle: 'Introduction', href: '/introduction' },
              { title: 'Quick start', href: '/quick-start' },
              { group: 'Advanced', pages: [{ title: 'Manual setup', href: '/manual-setup' }] },
            ],
          }],
        },
        {
          dropdown: 'API reference',
          groups: [{ group: 'Runs API', pages: [{ title: 'Runs', href: '/management/runs' }] }],
        },
        {
          dropdown: 'Guides & examples',
          groups: [{ group: 'Guides', pages: [{ title: 'Examples', href: '/guides/examples' }] }],
        },
      ],
    }
    const docsConfig = {
      $schema: 'https://mintlify.com/docs.json',
      theme: 'maple',
      icons: { library: 'fontawesome' },
      navbar: { primary: { type: 'github', href: 'https://github.com/acme/product' } },
      footer: { links: [{ header: 'Docs', items: [{ label: 'Home', href: '/introduction' }] }] },
      navigation: { pages: [] },
      ...(integrations ? { integrations } : {}),
    }
    const flight = [
      `18:["$","$Provider",null,{"value":{"docsConfig":${JSON.stringify(docsConfig)}}}]`,
      `19:["$","$Scoped",null,{"scopedNav":${JSON.stringify(navigation)}}]`,
    ].join('\n')
    const misleadingTabs = Array.from({ length: 20 }, (_, index) => (
      `<a href="/page-${index}">Page ${index}</a>`
    )).join('')
    const html = `<html><head><link href="/docs/_mintlify/site.css"></head><body><div class="nav-tabs">${misleadingTabs}</div><script>self.__next_f.push([1,${JSON.stringify(flight)}])</script></body></html>`
    const pages = new Map([
      ['/docs/introduction', '# Welcome\n\nWelcome to the product.'],
      ['/docs/quick-start', '# Quick start\n\nInstall the product.'],
      ['/docs/manual-setup', '# Manual setup\n\nConfigure it manually.'],
      ['/docs/management/runs', '# Runs\n\nManage runs.'],
      ['/docs/guides/examples', '# Examples\n\nExplore examples.'],
    ])
    const fetcher: MigrationFetcher = async (url, request) => {
      if (url.toString() === sourceUrl && request.accept.startsWith('text/html')) {
        return response(sourceUrl, html, 'text/html')
      }
      if (url.toString() === sourceUrl) {
        return {
          ...response(sourceUrl, pages.get('/docs/introduction')!, 'text/markdown'),
          headers: { 'x-llms-txt': '/docs/llms.txt' },
        }
      }
      if (url.pathname === '/docs/llms.txt') {
        return response(url.toString(), [...pages.keys()].map((path) => `- [Page](${path})`).join('\n'), 'text/plain')
      }
      const page = pages.get(url.pathname.replace(/\.md$/, ''))
      if (page) return response(url.toString(), page, 'text/markdown')
      throw new Error(`missing fixture: ${url}`)
    }

    return migrateUrl({ sourceUrl, platform: 'mintlify', fetcher })
  }

  it('uses Mintlify React Flight config instead of promoting sidebar pages to tabs', async () => {
    const bundle = await migrateFlightFixture()

    expect(bundle.docsConfig.tabs.map((tab) => tab.tab)).toEqual([
      'Documentation',
      'API reference',
      'Guides & examples',
    ])
    expect(bundle.docsConfig.tabs[0].groups).toEqual([{
      group: 'Getting started',
      pages: ['introduction', 'quick-start', {
        group: 'Advanced',
        pages: ['manual-setup'],
      }],
    }])
    expect(bundle.docsConfig).toMatchObject({
      theme: 'maple',
      icons: { library: 'fontawesome' },
      navbar: { primary: { label: 'GitHub', href: 'https://github.com/acme/product' } },
      footer: { links: [{ heading: 'Docs', items: [{ label: 'Home', href: '/introduction' }] }] },
    })
    expect(bundle.docsConfig.tabs.some((tab) => tab.tab === 'Page 0')).toBe(false)
    expect(bundle.pages.map((page) => page.id)).toEqual([
      'introduction',
      'quick-start',
      'manual-setup',
      'management/runs',
      'guides/examples',
    ])
  })

  it('imports Mintlify analytics integrations from the embedded config', async () => {
    const key = `phc_${'a1B2'.repeat(8)}`
    const bundle = await migrateFlightFixture({
      ga4: { measurementId: 'G-TEST12345' },
      posthog: { apiKey: key, apiHost: 'https://eu.i.posthog.com' },
      amplitude: { apiKey: 'AMPSECRET' },
      segment: { key: 'SEGSECRET' },
    })
    expect(bundle.docsConfig.integrations).toEqual({
      ga4: { measurementId: 'G-TEST12345' },
      posthog: { apiKey: key, apiHost: 'https://eu.i.posthog.com' },
    })
    const unsupported = bundle.warnings.filter((warning) => warning.code === 'unsupported-config' && /amplitude/.test(warning.message))
    expect(unsupported).toHaveLength(1)
    expect(unsupported[0].message).toMatch(/segment/)
    expect(JSON.stringify(bundle.warnings)).not.toMatch(/AMPSECRET|SEGSECRET/)
  })

  it('leaves integrations unset, with no analytics warning, when the embedded config has none', async () => {
    const bundle = await migrateFlightFixture()
    expect(bundle.docsConfig.integrations).toBeUndefined()
    expect(bundle.warnings.some((warning) => /analytics|integration/i.test(warning.message))).toBe(false)
  })

  it('imports only the submitted docs path and prefers llms Markdown pages', async () => {
    const documents = new Map([
      ['https://example.com/docs', response(
        'https://example.com/docs',
        '<html><head><title>Docs</title></head><body><main><h1>Docs</h1><p>Mintlify documentation home with enough useful text to import.</p></main></body></html>',
        'text/html',
      )],
      ['https://example.com/docs.md', response(
        'https://example.com/docs.md',
        '---\ntitle: Product docs\ndescription: Product documentation.\n---\n\n# Product docs\n\nWelcome to the product documentation. [Install](/docs/guides/install.md#run)',
        'text/markdown',
      )],
      ['https://example.com/llms.txt', response(
        'https://example.com/llms.txt',
        '# Docs\n\n- [Install](https://example.com/docs/guides/install.md)\n- [Blog](https://example.com/blog/launch)',
        'text/plain',
      )],
      ['https://example.com/docs/llms.txt', response(
        'https://example.com/docs/llms.txt',
        '- [API](https://example.com/docs/api/auth.md)',
        'text/plain',
      )],
      ['https://example.com/sitemap.xml', response(
        'https://example.com/sitemap.xml',
        '<urlset><url><loc>https://example.com/docs/guides/install</loc></url><url><loc>https://example.com/pricing</loc></url></urlset>',
        'application/xml',
      )],
      ['https://example.com/docs/sitemap.xml', response(
        'https://example.com/docs/sitemap.xml',
        '<urlset><url><loc>https://example.com/docs/api/auth</loc></url></urlset>',
        'application/xml',
      )],
      ['https://example.com/docs/guides/install.md', response(
        'https://example.com/docs/guides/install.md',
        '---\ntitle: Install\n---\n\n# Install\n\nRun the installer and verify the generated project.',
        'text/markdown',
      )],
      ['https://example.com/docs/api/auth.md', response(
        'https://example.com/docs/api/auth.md',
        '---\ntitle: Authentication\n---\n\n# Authentication\n\nSend a bearer token with every API request.',
        'text/markdown',
      )],
    ])
    const fetcher: MigrationFetcher = async (url) => {
      const document = documents.get(url.toString())
      if (!document) throw new Error(`missing fixture: ${url}`)
      return document
    }

    const bundle = await migrateUrl({
      sourceUrl: 'https://example.com/docs',
      fetcher,
    })

    expect(bundle.pages.map((page) => page.id)).toEqual([
      'introduction',
      'guides/install',
      'api/auth',
    ])
    expect(bundle.pages.some((page) => page.source.includes('/blog/'))).toBe(false)
    expect(bundle.pages[0].body).toContain('[Install](/guides/install.md#run)')
    expect(bundle.docsConfig.tabs[0].groups?.map((group) => group.group)).toEqual([
      'Overview',
      'Guides',
      'API',
    ])
  })

  it('migrates a deep Mintlify URL as a complete, portable docs site', async () => {
    const sourceUrl = 'https://docs.product.test/introduction/introduction'
    const pages = new Map([
      ['/introduction/chains', '# Chain Overview\n\n> Supported networks.\n\nEvery supported chain is listed here.'],
      ['/api-reference/introduction', '# API Reference\n\n> REST API endpoints.\n\nUse the API to request quotes.'],
      ['/sdk/overview', '# SDK Overview\n\n> TypeScript SDK.\n\nInstall and configure the SDK.'],
      ['/zh-hans-api-reference/introduction', '# API 参考\n\n> REST API 端点。\n\n使用 API 请求报价。'],
      ['/zh-hans/api-reference/introduction', '# API 参考\n\n> REST API 端点。\n\n使用 API 请求报价。'],
    ])
    const fetcher: MigrationFetcher = async (url, request) => {
      if (url.toString() === sourceUrl && request.accept.startsWith('text/html')) {
        return response(
          sourceUrl,
          '<html><head><link href="/mintlify-assets/site.css"></head><body><div class="nav-tabs"><a href="/introduction/introduction">Overview</a><a href="/api-reference/introduction">API Reference</a><a href="/sdk/overview">SDK</a></div><nav><a href="/introduction/chains">Chains</a><a href="/cdn-cgi/l/email-protection">Email</a></nav></body></html>',
          'text/html',
        )
      }
      if (url.toString() === sourceUrl) {
        return {
          ...response(
            sourceUrl,
            '> ## Documentation Index\n> Fetch the complete documentation index at: https://docs.product.test/llms.txt\n> Use this file to discover all available pages before exploring further.\n\n# Product Documentation\n\n> One integration for every platform.\n\nThe authored introduction remains intact.\n\n<Steps>\n  <Step title="Install">Run the installer.</Step>\n</Steps>\n\n<CardGroup cols={2}>\n  <Card title="API" href="/api-reference/introduction" onClick={() => window.analytics?.track(\'api\')}>Read the API.</Card>\n</CardGroup>\n\n| Feature | Status |\n| --- | --- |\n| Navigation | Ready |',
            'text/markdown',
          ),
          headers: { 'x-llms-txt': '/llms.txt' },
        }
      }
      if (url.pathname === '/llms.txt') {
        return response(
          url.toString(),
          '# Product docs\n\n- [Introduction](/introduction/introduction.md)\n- [Chains](/introduction/chains)\n- [API](/api-reference/introduction)\n- [SDK](/sdk/overview)\n- [中文 API](/zh-hans-api-reference/introduction)\n- [中文 API alias](/zh-hans/api-reference/introduction)',
          'text/plain',
        )
      }
      if (url.pathname === '/sitemap.xml') {
        return response(
          url.toString(),
          '<urlset><url><loc>https://docs.product.test/introduction/introduction</loc></url><url><loc>https://docs.product.test/introduction/chains</loc></url><url><loc>https://docs.product.test/api-reference/introduction</loc></url><url><loc>https://docs.product.test/sdk/overview</loc></url><url><loc>https://docs.product.test/zh-hans-api-reference/introduction</loc></url><url><loc>https://docs.product.test/zh-hans/api-reference/introduction</loc></url></urlset>',
          'application/xml',
        )
      }
      const page = pages.get(url.pathname.replace(/\.md$/, ''))
      if (page) return response(url.toString(), page, 'text/markdown')
      throw new Error(`missing fixture: ${url}`)
    }

    const bundle = await migrateUrl({ sourceUrl, fetcher })

    expect(bundle.platform).toBe('mintlify')
    expect(bundle.pages.map((page) => page.id)).toEqual([
      'introduction',
      'api-reference/introduction',
      'sdk/overview',
      'introduction/chains',
      'zh-hans/api-reference/introduction',
    ])
    expect(bundle.pages[0]).toMatchObject({
      title: 'Product Documentation',
      description: 'One integration for every platform.',
    })
    expect(bundle.pages[0].body).not.toContain('Documentation Index')
    expect(bundle.pages[0].body).not.toContain('# Product Documentation')
    expect(bundle.pages[0].body).not.toContain('onClick')
    expect(bundle.pages[0].body).not.toContain('window.analytics')
    expect(bundle.pages[0].body).toContain('<Steps titleSize="p">')
    expect(bundle.pages[0].body).toContain('<CardGroup cols={2}>')
    expect(bundle.pages[0].body).toContain('href="/api-reference/introduction"')
    expect(bundle.pages[0].body).toContain('| Feature | Status |')
    expect(bundle.docsConfig.tabs.map((tab) => ({ tab: tab.tab, href: tab.href }))).toEqual([
      { tab: 'Overview', href: '/' },
      { tab: 'API Reference', href: '/api-reference/introduction' },
      { tab: 'SDK', href: '/sdk/overview' },
    ])
    expect(bundle.warnings).toEqual([])
    expect(bundle.docsConfig.i18n?.locales.map((locale) => locale.code)).toEqual(['en', 'zh-hans'])
  })

  it('uses the source navigation home when a different Mintlify page is submitted', async () => {
    const sourceUrl = 'https://docs.product.test/widget/compatibility'
    const pages = new Map([
      ['/introduction/introduction', '# Product home\n\nStart with the canonical documentation overview.'],
      ['/widget/overview', '# Widget overview\n\nIntegrate the widget into an application.'],
    ])
    const fetcher: MigrationFetcher = async (url, request) => {
      if (url.toString() === sourceUrl && request.accept.startsWith('text/html')) {
        return response(
          sourceUrl,
          '<html><head><link href="/mintlify-assets/site.css"></head><body><div class="nav-tabs"><a href="/introduction/introduction">Overview</a><a href="/widget/overview">Widget</a></div></body></html>',
          'text/html',
        )
      }
      if (url.toString() === sourceUrl) {
        return {
          ...response(sourceUrl, '# Compatibility\n\n[Home](/introduction/introduction) and supported environments.', 'text/markdown'),
          headers: { 'x-llms-txt': '/llms.txt' },
        }
      }
      if (url.pathname === '/llms.txt') {
        return response(
          url.toString(),
          '- [Home](/introduction/introduction)\n- [Widget](/widget/overview)\n- [Compatibility](/widget/compatibility)',
          'text/plain',
        )
      }
      const page = pages.get(url.pathname.replace(/\.md$/, ''))
      if (page) return response(url.toString(), page, 'text/markdown')
      throw new Error(`missing fixture: ${url}`)
    }

    const bundle = await migrateUrl({ sourceUrl, fetcher })

    expect(bundle.pages.find((page) => page.id === 'introduction')).toMatchObject({
      title: 'Product home',
      source: 'https://docs.product.test/introduction/introduction',
    })
    expect(bundle.pages.find((page) => page.id === 'widget/compatibility')?.body).toContain('[Home](/)')
    expect(bundle.docsConfig.tabs.map((tab) => ({ tab: tab.tab, href: tab.href }))).toEqual([
      { tab: 'Overview', href: '/' },
      { tab: 'Widget', href: '/widget/overview' },
    ])
  })

  it('preserves Mintlify tabs while containing a path-scoped docs site', async () => {
    const sourceUrl = 'https://platform.test/docs'
    const fetchedUrls: Array<string> = []
    const pages = new Map([
      ['/docs/guides', '# Guides\n\nBuild complete documentation sites.'],
      ['/docs/api/introduction', '# API reference\n\nIntegrate with the platform API.'],
      ['/docs/changelog', '# Changelog\n\nFollow product updates and improvements.'],
      ['/docs/create/text', '# Write text\n\nCreate clear documentation content.'],
    ])
    const fetcher: MigrationFetcher = async (url, request) => {
      fetchedUrls.push(url.toString())
      if (url.toString() === sourceUrl && request.accept.startsWith('text/html')) {
        return response(
          sourceUrl,
          '<html><head><link href="/docs/_mintlify/site.css"><link href="/docs/sitemap.xml"></head><body><nav><a href="/docs">Documentation</a><a href="/docs/guides">Guides</a><a href="/docs/api/introduction">API reference</a><a href="/docs/changelog">Changelog</a></nav><nav><a href="/docs/create/text">Write text</a><a href="/pricing">Pricing</a></nav></body></html>',
          'text/html',
        )
      }
      if (url.toString() === sourceUrl) {
        return {
          ...response(sourceUrl, '# Documentation\n\nBuild documentation that users love.', 'text/markdown'),
          headers: { 'x-llms-txt': '/docs/llms.txt' },
        }
      }
      if (url.pathname === '/docs/llms.txt') {
        return response(
          url.toString(),
          '# Platform docs\n\n- [Documentation](/docs)\n- [Write text](/docs/create/text)\n- [Guides](/docs/guides)\n- [API reference](/docs/api/introduction)\n- [Changelog](/docs/changelog)',
          'text/plain',
        )
      }
      if (url.pathname === '/docs/sitemap.xml') {
        return response(
          url.toString(),
          '<urlset><url><loc>https://platform.test/docs</loc></url><url><loc>https://platform.test/docs/create/text</loc></url><url><loc>https://platform.test/docs/guides</loc></url><url><loc>https://platform.test/docs/api/introduction</loc></url><url><loc>https://platform.test/docs/changelog</loc></url></urlset>',
          'application/xml',
        )
      }
      const page = pages.get(url.pathname.replace(/\.md$/, ''))
      if (page) return response(url.toString(), page, 'text/markdown')
      throw new Error(`missing fixture: ${url}`)
    }

    const bundle = await migrateUrl({ sourceUrl, fetcher })

    expect(bundle.docsConfig.tabs.map((tab) => ({ tab: tab.tab, href: tab.href }))).toEqual([
      { tab: 'Documentation', href: '/' },
      { tab: 'Guides', href: '/guides' },
      { tab: 'API reference', href: '/api/introduction' },
      { tab: 'Changelog', href: '/changelog' },
    ])
    expect(bundle.docsConfig.tabs[0].groups?.flatMap((group) => group.pages)).toContain('create/text')
    expect(fetchedUrls.some((url) => new URL(url).pathname === '/pricing')).toBe(false)
  })

  it('does not widen path scope through an HTML-only same-origin redirect', async () => {
    const sourceUrl = 'https://platform.test/docs'
    const fetchedUrls: Array<string> = []
    const fetcher: MigrationFetcher = async (url, request) => {
      fetchedUrls.push(url.toString())
      if (url.toString() === sourceUrl && request.accept.startsWith('text/html')) {
        return response(
          'https://platform.test/',
          '<html><head><link href="/_mintlify/site.css"><link href="/sitemap.xml"></head><body><nav><a href="/pricing">Pricing</a><a href="/blog">Blog</a></nav></body></html>',
          'text/html',
        )
      }
      if (url.toString() === sourceUrl) {
        return {
          ...response(sourceUrl, '# Documentation\n\nPath-scoped documentation content remains isolated.', 'text/markdown'),
          headers: { 'x-mintlify-project': 'platform-docs' },
        }
      }
      throw new Error(`missing fixture: ${url}`)
    }

    const bundle = await migrateUrl({ sourceUrl, fetcher })

    expect(bundle.platform).toBe('mintlify')
    expect(bundle.pages.map((page) => page.id)).toEqual(['introduction'])
    expect(fetchedUrls.some((url) => ['/pricing', '/blog'].includes(new URL(url).pathname))).toBe(false)
  })

  it('falls back to rendered HTML when a Markdown endpoint contains site-local code', async () => {
    const fetcher: MigrationFetcher = async (url) => {
      if (url.pathname.endsWith('.md')) {
        return response(
          url.toString(),
          '---\ntitle: Custom home\n---\n\nexport const ProductCard = () => <div>Custom</div>\n\n<ProductCard />',
          'text/markdown',
        )
      }
      if (url.toString() === 'https://custom.example.com/docs') {
        return response(
          url.toString(),
          '<html><head><title>Custom home</title></head><body><main><h1>Custom home</h1><p>The rendered documentation remains portable without repository-local React components.</p><pre><code>&lt;Columns&gt;\n```bash\nnpm install\n```\n&lt;/Columns&gt;</code></pre></main></body></html>',
          'text/html',
        )
      }
      throw new Error('not found')
    }

    const bundle = await migrateUrl({ sourceUrl: 'https://custom.example.com/docs', fetcher })

    expect(bundle.pages[0].body).toContain('The rendered documentation remains portable')
    expect(bundle.pages[0].body).not.toContain('export const ProductCard')
    expect(bundle.pages[0].body).toContain('````\n<Columns>\n```bash')
  })

  it('does not compile active content from an untrusted Markdown endpoint', async () => {
    const fetcher: MigrationFetcher = async (url, request) => {
      if (url.toString() !== 'https://unsafe.example.com/docs') throw new Error('not found')
      if (request.accept.startsWith('text/html')) {
        return response(
          url.toString(),
          '<main><h1>Safe docs</h1><p>Safe rendered documentation content for readers.</p><script>alert(1)</script><a href="javascript:alert(1)">bad</a></main>',
          'text/html',
        )
      }
      return response(
        url.toString(),
        '# Unsafe docs\n\n<script>alert(1)</script>\n\n<a href="javascript:alert(1)">bad</a>',
        'text/markdown',
      )
    }

    const bundle = await migrateUrl({ sourceUrl: 'https://unsafe.example.com/docs', fetcher })

    expect(bundle.pages[0].body).toContain('Safe rendered documentation')
    expect(bundle.pages[0].body).not.toContain('<script')
    expect(bundle.pages[0].body).not.toContain('javascript:')
  })

  it.each([
    ['an entity-encoded URL prop', '<Hero primaryHref="java&#x73;cript:alert(1)">Run code</Hero>'],
    ['a non-string URL prop expression', '<Hero primaryHref={["javascript:alert(1)"]}>Run code</Hero>'],
  ])('fails closed on %s when unsafe MDX has no rendered HTML fallback', async (_case, content) => {
    const fetcher: MigrationFetcher = async (url) => response(
      url.toString(),
      `# Unsafe docs\n\n${content}`,
      'text/markdown',
    )

    await expect(migrateUrl({
      sourceUrl: 'https://unsafe.example.com/docs',
      fetcher,
    })).rejects.toThrow('No readable documentation pages were found')
  })

  it('fails closed when mismatched code delimiters expose an MDX expression', async () => {
    const probeName = '__MIGRATION_SANITIZER_PROBE__'
    Reflect.deleteProperty(globalThis, probeName)
    const fetcher: MigrationFetcher = async (url) => response(
      url.toString(),
      '# Unsafe docs\n\n`prefix {globalThis.__MIGRATION_SANITIZER_PROBE__ = 1} suffix ``',
      'text/markdown',
    )

    try {
      await expect(migrateUrl({
        sourceUrl: 'https://unsafe.example.com/docs',
        fetcher,
      })).rejects.toThrow('No readable documentation pages were found')
      expect(Reflect.get(globalThis, probeName)).toBeUndefined()
    } finally {
      Reflect.deleteProperty(globalThis, probeName)
    }
  })

  it('sanitizes encoded schemes and Markdown delimiters from remote content', async () => {
    const fetcher: MigrationFetcher = async (url) => response(
      url.toString(),
      [
        '# Portable links',
        '',
        String.raw`<a href="java&#x73;cript:alert(1)">Unsafe \] <<script></a>`,
        '',
        String.raw`<img src="https://cdn.example.com/diagram.png" alt="Diagram \] <<script>" />`,
        '',
        '[Encoded link](javascript&#58;alert(1))',
        '',
        '[Reference link][unsafe-reference]',
        '',
        '[unsafe-reference]: data:text/html,unsafe',
      ].join('\n'),
      'text/markdown',
    )

    const bundle = await migrateUrl({ sourceUrl: 'https://portable.example.com/docs', fetcher })
    const body = bundle.pages[0].body

    expect(body).toContain('Unsafe')
    expect(body).toContain('![Diagram')
    expect(body).toContain('Encoded link')
    expect(body).toContain('Reference link')
    expect(body).not.toMatch(/(?:javascript|data):/i)
    expect(body).not.toContain('<script')
  })

  it('preserves known documentation components with static props', async () => {
    const fetcher: MigrationFetcher = async (url) => {
      if (url.toString() !== 'https://portable.example.com/docs') throw new Error('not found')
      return response(
        url.toString(),
        '---\ntitle: Portable docs\n---\n\n# Portable docs\n\n<div id="section"><Columns cols={2}><Note title="Heads up">Static component content is portable.</Note></Columns></div>\n\n<Prompt actions={["copy", "cursor"]}>Copy me.</Prompt>\n\n<img src="https://cdn.example.com/image.png" alt="Diagram" onerror="alert(1)" />\n\n[Unsafe link](javascript:alert)\n\n![Unsafe image](data:image/svg+xml,<svg onload=alert(1)>)\n\n````mdx\n<Card value={{ unsafe: true }} />\n```js\nconst value = { nested: true }\n```\n````',
        'text/markdown',
      )
    }

    const bundle = await migrateUrl({ sourceUrl: 'https://portable.example.com/docs', fetcher })

    expect(bundle.pages[0].body).toContain('<Note title="Heads up">')
    expect(bundle.pages[0].body).toContain('<Columns cols={2}>')
    expect(bundle.pages[0].body).toContain('actions={["copy", "cursor"]}')
    expect(bundle.pages[0].body).toContain('![Diagram](https://cdn.example.com/image.png)')
    expect(bundle.pages[0].body).not.toContain('<div')
    expect(bundle.pages[0].body).not.toContain('javascript:')
    expect(bundle.pages[0].body).not.toContain('data:image')
  })

  it('preserves Mintlify cards and converts embedded operation specs', async () => {
    const sourceUrl = 'https://api-docs.example.test/welcome'
    const operationMarkdown = [
      '# Get service status',
      '',
      '> Returns the current service status.',
      '',
      '## OpenAPI',
      '',
      '````yaml /openapi.yaml get /status',
      'openapi: 3.0.0',
      'info:',
      '  title: Service API',
      '  version: 1.0.0',
      'servers:',
      '  - url: https://api.example.test',
      'paths:',
      '  /status:',
      '    get:',
      '      summary: Get service status',
      '      responses:',
      "        '200':",
      '          description: Service is available',
      '````',
    ].join('\n')
    const fetcher: MigrationFetcher = async (url, request) => {
      if (url.toString() === sourceUrl && request.accept.startsWith('text/html')) {
        return response(
          sourceUrl,
          '<html><head><link href="/_mintlify/site.css"></head><body><div class="nav-tabs"><a href="/welcome">Welcome</a><a href="/api-reference/status/get-status">Prediction APIs</a></div></body></html>',
          'text/html',
        )
      }
      if (url.toString() === sourceUrl) {
        return {
          ...response(
            sourceUrl,
            '# Service documentation\n\n<div className="hero">\n<h2 className="title">\nThe APIs\n</h2>\n<p><span>Choose an API surface.</span></p>\n</div>\n\n<CardGroup cols={2}>\n<Card title="Prediction APIs" href="/api-reference">Read the API reference.</Card>\n</CardGroup>',
            'text/markdown',
          ),
          headers: { 'x-llms-txt': '/llms.txt' },
        }
      }
      if (url.pathname === '/llms.txt') {
        return response(
          url.toString(),
          '- [Welcome](/welcome)\n- [Get service status](/api-reference/status/get-status)\n- [OpenAPI spec](/openapi.yaml)',
          'text/plain',
        )
      }
      if (url.pathname.replace(/\.md$/, '') === '/api-reference/status/get-status') {
        return response(url.toString(), operationMarkdown, 'text/markdown')
      }
      throw new Error(`missing fixture: ${url}`)
    }

    const bundle = await migrateUrl({ sourceUrl, fetcher })
    const introduction = bundle.pages.find((page) => page.id === 'introduction')
    const operation = bundle.pages.find((page) => page.id === 'api-reference/status/get-status')

    expect(introduction?.body).toContain('## The APIs')
    expect(introduction?.body).toContain('<CardGroup cols={2}>')
    expect(introduction?.body).toContain('href="/api-reference/status/get-status"')
    expect(operation).toMatchObject({
      openapi: 'GET /status',
      body: '',
    })
    expect(bundle.assets).toHaveLength(1)
    expect(new TextDecoder().decode(bundle.assets[0].content)).toContain('/status:')
    expect(bundle.docsConfig.tabs.find((tab) => tab.tab === 'Prediction APIs')).toMatchObject({
      href: '/api-reference/status/get-status',
      api: { source: '/openapi.yaml', navigation: false },
    })
    const operationFile = renderMigrationFiles(bundle)
      .find((file) => file.path === 'src/content/api-reference/status/get-status.mdx')
    expect(operationFile?.content).toContain('openapi: "GET /status"')
    expect(operationFile?.content).not.toContain('openapi: 3.0.0')
  })

  it('maps localized URL roots to Thally locale content directories', async () => {
    const documents = new Map([
      ['https://locale.example.com/docs', response(
        'https://locale.example.com/docs',
        '<html><head><title>Docs</title></head><body><main><h1>Docs</h1><p>Default language documentation homepage with sufficient content.</p></main></body></html>',
        'text/html',
      )],
      ['https://locale.example.com/docs.md', response(
        'https://locale.example.com/docs.md',
        '---\ntitle: Docs\n---\n\nDefault documentation.',
        'text/markdown',
      )],
      ['https://locale.example.com/llms.txt', response(
        'https://locale.example.com/llms.txt',
        '[Español](https://locale.example.com/docs/es.md)',
        'text/plain',
      )],
      ['https://locale.example.com/docs/es.md', response(
        'https://locale.example.com/docs/es.md',
        '---\ntitle: Documentación\n---\n\nDocumentación en español.',
        'text/markdown',
      )],
    ])
    const fetcher: MigrationFetcher = async (url) => {
      const document = documents.get(url.toString())
      if (!document) throw new Error('not found')
      return document
    }

    const bundle = await migrateUrl({ sourceUrl: 'https://locale.example.com/docs', fetcher })

    expect(bundle.pages.map((page) => page.id)).toEqual(['introduction', 'es/introduction'])
    expect(bundle.docsConfig.i18n?.defaultLocale).toBe('en')
    expect(bundle.docsConfig.i18n?.locales.map((locale) => locale.code)).toEqual(['en', 'es'])
  })

  it('uses Docusaurus sidebars, current-version scope, aliases, and rendered primitives', async () => {
    const sourceUrl = 'https://docusaurus.test/'
    const sidebar = (active: string) => `
      <ul class="theme-doc-sidebar-menu menu__list">
        <li class="theme-doc-sidebar-item-link menu__list-item"><a class="menu__link" href="/docs/index">Introduction</a></li>
        <li class="theme-doc-sidebar-item-category menu__list-item">
          <div class="menu__list-item-collapsible"><a class="menu__link menu__link--sublist" href="/docs/guide/start">Guides</a></div>
          ${active === 'guide' ? '<ul class="menu__list"><li><a class="menu__link" href="/docs/guide/start">Start</a></li></ul>' : ''}
        </li>
        <li class="theme-doc-sidebar-item-category menu__list-item">
          <div class="menu__list-item-collapsible"><a class="menu__link menu__link--sublist" href="/docs/API/Type">API</a></div>
          ${active === 'api' ? '<ul class="menu__list"><li><a class="menu__link" href="/docs/API/Type">Type</a></li></ul>' : ''}
        </li>
        <li class="theme-doc-sidebar-item-link menu__list-item"><a class="menu__link" href="/docs/EmptyPage">Empty page</a></li>
      </ul>`
    const page = (url: string, title: string, active: string, content = '') => response(
      url,
      `<html><body><aside>${sidebar(active)}</aside><div class="dropdown__menu"><a href="/docs/v1/index">v1</a></div><main><article><header><h1>${title}</h1></header>${content}</article></main></body></html>`,
      'text/html',
    )
    const fetcher: MigrationFetcher = async (url) => {
      if (url.toString() === sourceUrl) {
        return response(
          sourceUrl,
          '<html><body><nav><a href="/docs/index">Docs</a><a href="/blog">Blog</a></nav><main><h1>Marketing</h1><p>This homepage must not become documentation.</p></main></body></html>',
          'text/html',
        )
      }
      if (url.pathname === '/docs/sitemap.xml') {
        return response(url.toString(), '<urlset>'
          + '<url><loc>https://docusaurus.test/docs/</loc></url>'
          + '<url><loc>https://docusaurus.test/docs/index</loc></url>'
          + '<url><loc>https://docusaurus.test/docs/guide/start</loc></url>'
          + '<url><loc>https://docusaurus.test/docs/API/Type</loc></url>'
          + '<url><loc>https://docusaurus.test/docs/EmptyPage</loc></url>'
          + '<url><loc>https://docusaurus.test/docs/search</loc></url>'
          + '<url><loc>https://docusaurus.test/docs/v1/index</loc></url>'
          + '</urlset>', 'application/xml')
      }
      if (url.pathname === '/docs/' || url.pathname === '/docs') {
        return page('https://docusaurus.test/docs/index', 'Introduction', 'intro', '<p>Canonical docs introduction.</p>')
      }
      if (url.pathname === '/docs/index') {
        return page(url.toString(), 'Introduction', 'intro', '<p>Canonical docs introduction.</p>')
      }
      if (url.pathname === '/docs/guide/start') {
        return page(url.toString(), 'Start', 'guide', `
          <div class="theme-admonition theme-admonition-warning"><div class="admonitionHeading">Caution</div><div><p>Back up first.</p></div></div>
          <div class="tabs-container"><ul class="tabs"><li>npm</li><li>pnpm</li></ul><div role="tabpanel"><pre><code class="language-bash">npm install</code></pre></div><div role="tabpanel"><pre><code class="language-bash">pnpm install</code></pre></div></div>
          <table><thead><tr><th>Option</th><th>Value</th></tr></thead><tbody><tr><td>endpoint</td><td>https://&lt;host&gt;/C:\\docs\\|{project}</td></tr></tbody></table>`)
      }
      if (url.pathname === '/docs/API/Type') {
        return page(url.toString(), 'Type', 'api', '<p>Case-sensitive reference content.</p>')
      }
      if (url.pathname === '/docs/EmptyPage') return page(url.toString(), 'Empty page', 'intro')
      throw new Error(`missing fixture: ${url}`)
    }

    const bundle = await migrateUrl({ sourceUrl, platform: 'docusaurus', fetcher })

    expect(bundle.pages.map((entry) => entry.id)).toEqual([
      'index/index',
      'guide/start',
      'API/Type',
      'EmptyPage',
    ])
    expect(bundle.pages.some((entry) => entry.title === 'Marketing')).toBe(false)
    expect(bundle.docsConfig.redirects).toContainEqual({ source: '/', destination: '/index' })
    expect(bundle.docsConfig.tabs).toHaveLength(1)
    expect(bundle.docsConfig.tabs[0].groups).toEqual([
      { group: 'Overview', pages: ['index', 'EmptyPage'] },
      { group: 'Guides', pages: ['guide/start'] },
      { group: 'API', pages: ['API/Type'] },
    ])
    const guide = bundle.pages.find((entry) => entry.navigationId === 'guide/start')
    expect(guide?.body).toContain('<Warning>')
    expect(guide?.body).toContain('<Tabs>')
    expect(guide?.body).toContain('<Tab title="npm">')
    expect(guide?.body).toContain('| Option | Value |')
    expect(guide?.body).toContain(String.raw`https://&lt;host&gt;/C:\\docs\\\|&#123;project&#125;`)
  })
})

describe('website API and machine-readable migration', () => {
  const schema = JSON.stringify({ openapi: '3.0.0', info: { title: 'Example', version: '1' }, paths: { '/users': { get: { tags: ['Users'], summary: 'List users', responses: { 200: { description: 'OK' } } } } } })
  function sourceFetcher(linkSpec: boolean): MigrationFetcher {
    return async (url) => {
      if (url.pathname === '/openapi.json') return response(url.toString(), schema, 'application/json')
      if (url.pathname === '/docs') return response(url.toString(), `<html><head>${linkSpec ? '<link rel="service-desc" href="/openapi.json">' : ''}<title>Docs</title></head><body><main><h1>Docs</h1><p>A useful documentation overview with enough material for the importer to retain.</p><a href="/docs/api-reference/users/list-users">List users</a></main></body></html>`, 'text/html')
      if (url.pathname === '/docs.md') return response(url.toString(), '# Docs\n\n[Users](/docs/api-reference/users/list-users)\n[Markdown](/docs/guide.md)\n[Index](/llms.txt)\n[Spec](/openapi.json)\n', 'text/markdown')
      if (url.pathname === '/docs/api-reference/users/list-users') return response(url.toString(), '<html><body><main><h1>List users</h1><p>Endpoint-specific prose stays here.</p></main></body></html>', 'text/html')
      if (url.pathname === '/docs/api-reference/users/list-users.md') return response(url.toString(), '# List users\n\nEndpoint-specific prose stays here.', 'text/markdown')
      if (url.pathname === '/docs/guide.md') return response(url.toString(), '# Guide\n\nA guide for readers.', 'text/markdown')
      throw new Error('not found')
    }
  }
  it.each([true, false])('restores an interactive endpoint with publisher discovery=%s and preserves machine link formats', async (automatic) => {
    const bundle = await migrateUrl({ sourceUrl: 'https://docs.example.com/docs', platform: 'mintlify', fetcher: sourceFetcher(automatic), ...(automatic ? {} : { openapiUrl: 'https://docs.example.com/openapi.json' }) })
    const endpoint = bundle.pages.find((page) => page.navigationId === 'api-reference/users/list-users')
    expect(endpoint).toMatchObject({ openapi: expect.stringContaining('GET /users'), body: expect.stringContaining('Endpoint-specific prose') })
    expect(bundle.docsConfig.tabs.find((tab) => tab.api)?.api?.navigation).toBe(false)
    expect(bundle.pages.find((page) => page.id === 'introduction')?.body).toContain('(/guide.md)')
    expect(bundle.pages.find((page) => page.id === 'introduction')?.body).toContain('(/llms.txt)')
    expect(bundle.pages.find((page) => page.id === 'introduction')?.body).toContain('(/openapi.json)')
  })
})
