/** Regression coverage for validating authored OpenAPI migration navigation. */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { runCheck } from '../check.js'
import { API_GROUPS_MAX_DEPTH } from '../openapi-publication.js'

describe('thally check OpenAPI migrations', () => {
  it('accepts authored API groups and operation-only MDX pages', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'thally-check-openapi-'))
    mkdirSync(join(projectDir, 'src/content/api-reference/status'), { recursive: true })
    mkdirSync(join(projectDir, 'public'), { recursive: true })
    writeFileSync(join(projectDir, 'docs.json'), JSON.stringify({
      tabs: [{
        tab: 'API Reference',
        href: '/api-reference/status/get-status',
        api: { source: '/openapi.yaml', navigation: false },
        groups: [{ group: 'Status', pages: ['api-reference/status/get-status'] }],
      }],
    }))
    writeFileSync(join(projectDir, 'src/content/api-reference/status/get-status.mdx'), [
      '---',
      'title: Get status',
      'description: Returns the service status.',
      'openapi: GET /status',
      '---',
      '',
    ].join('\n'))
    writeFileSync(join(projectDir, 'public/openapi.yaml'), [
      'openapi: 3.0.0',
      'info:',
      '  title: Service API',
      '  version: 1.0.0',
      'paths:',
      '  /status:',
      '    get:',
      '      responses:',
      "        '200':",
      '          description: Available',
    ].join('\n'))
    const output: Array<string> = []
    const log = vi.spyOn(console, 'log').mockImplementation((value) => output.push(String(value)))

    try {
      await expect(runCheck(projectDir, { fix: false, ci: true })).resolves.toBe(0)
    } finally {
      log.mockRestore()
    }
    expect(output.join('\n')).not.toContain('orphan')
    expect(output.join('\n')).not.toContain('Very short body')
  })

  it('validates interleaved root pages and groups as authored navigation', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'thally-check-root-pages-'))
    mkdirSync(join(projectDir, 'src/content/guides'), { recursive: true })
    writeFileSync(join(projectDir, 'docs.json'), JSON.stringify({
      tabs: [{
        tab: 'Documentation',
        pages: [
          'introduction',
          { group: 'Guides', pages: ['guides/install'] },
        ],
      }],
    }))
    writeFileSync(join(projectDir, 'src/content/introduction.mdx'), [
      '---',
      'title: Introduction',
      'description: Product documentation introduction.',
      '---',
      '',
      'Welcome to the product documentation and its complete setup guide.',
    ].join('\n'))
    writeFileSync(join(projectDir, 'src/content/guides/install.mdx'), [
      '---',
      'title: Install',
      'description: Install the product.',
      '---',
      '',
      'Install the product and verify that the generated project works.',
    ].join('\n'))
    const output: Array<string> = []
    const log = vi.spyOn(console, 'log').mockImplementation((value) => output.push(String(value)))

    try {
      await expect(runCheck(projectDir, { fix: false, ci: true })).resolves.toBe(0)
    } finally {
      log.mockRestore()
    }
    expect(output.join('\n')).not.toContain('has no groups')
    expect(output.join('\n')).not.toContain('orphan')
  })

  it('includes authored pages in API tabs while preserving real orphan warnings', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'thally-check-mixed-api-'))
    mkdirSync(join(projectDir, 'src/content/api'), { recursive: true })
    mkdirSync(join(projectDir, 'public'), { recursive: true })
    writeFileSync(join(projectDir, 'docs.json'), JSON.stringify({
      tabs: [
        { tab: 'Documentation', pages: ['introduction'] },
        {
          tab: 'API Reference',
          api: { source: '/openapi.yaml' },
          pages: ['api/introduction'],
          groups: [{
            group: 'API guides',
            pages: [
              'api/authentication',
              { group: 'Advanced', pages: ['api/tokens'] },
            ],
          }],
        },
      ],
    }))
    const page = (title: string) => [
      '---',
      `title: ${title}`,
      `description: Complete documentation for ${title}.`,
      '---',
      '',
      'This page contains enough authored documentation to satisfy body checks.',
    ].join('\n')
    writeFileSync(join(projectDir, 'src/content/introduction.mdx'), page('Introduction'))
    writeFileSync(join(projectDir, 'src/content/api/introduction.mdx'), page('API introduction'))
    writeFileSync(join(projectDir, 'src/content/api/authentication.mdx'), page('API authentication'))
    writeFileSync(join(projectDir, 'src/content/api/tokens.mdx'), page('API tokens'))
    writeFileSync(join(projectDir, 'src/content/api/unreferenced.mdx'), page('Unreferenced API guide'))
    writeFileSync(join(projectDir, 'public/openapi.yaml'), [
      'openapi: 3.0.0',
      'info:',
      '  title: Service API',
      '  version: 1.0.0',
      'paths: {}',
    ].join('\n'))
    const output: Array<string> = []
    const log = vi.spyOn(console, 'log').mockImplementation((value) => output.push(String(value)))

    try {
      await expect(runCheck(projectDir, { fix: false, ci: true })).resolves.toBe(0)
    } finally {
      log.mockRestore()
    }
    expect(output.join('\n')).not.toContain('"api/introduction" is not in docs.json nav')
    expect(output.join('\n')).not.toContain('"api/authentication" is not in docs.json nav')
    expect(output.join('\n')).not.toContain('"api/tokens" is not in docs.json nav')
    expect(output.join('\n')).toContain('"api/unreferenced" is not in docs.json nav (orphan)')
  })
})

describe('thally check hidden operations under public/', () => {
  const spec = (flag: string) => [
    'openapi: 3.0.0',
    'info:',
    '  title: T',
    '  version: 1.0.0',
    'paths:',
    '  /a:',
    '    get:',
    ...(flag ? [`      ${flag}`] : []),
    '      responses:',
    "        '200':",
    '          description: ok',
  ].join('\n')

  async function run(source: string, file: string, body: string, overrides?: unknown) {
    const projectDir = mkdtempSync(join(tmpdir(), 'thally-check-hidden-'))
    mkdirSync(join(projectDir, file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : '.'), { recursive: true })
    writeFileSync(join(projectDir, 'docs.json'), JSON.stringify({ tabs: [{ tab: 'API', api: { source, overrides } }] }))
    writeFileSync(join(projectDir, file), body)
    const output: Array<string> = []
    const log = vi.spyOn(console, 'log').mockImplementation((value) => output.push(String(value)))
    try {
      await runCheck(projectDir, { fix: false, ci: true })
    } finally {
      log.mockRestore()
    }
    return output.join('\n')
  }

  it('warns for a public/ spec with x-excluded, or an override-hidden op', async () => {
    expect(await run('/openapi.yaml', 'public/openapi.yaml', spec('x-excluded: true'))).toContain('lives under public/')
    expect(await run('/openapi.yaml', 'public/openapi.yaml', spec(''), { 'GET /a': { hidden: true } })).toContain('lives under public/')
  })

  it('stays quiet for a clean public/ spec or a project-root spec', async () => {
    expect(await run('/openapi.yaml', 'public/openapi.yaml', spec(''))).not.toContain('lives under public/')
    expect(await run('openapi/api.yaml', 'openapi/api.yaml', spec('x-excluded: true'))).not.toContain('lives under public/')
  })
})

describe('thally check OpenAPI root objects', () => {
  async function run(body: Record<string, unknown>) {
    const projectDir = mkdtempSync(join(tmpdir(), 'thally-check-roots-'))
    mkdirSync(join(projectDir, 'openapi'), { recursive: true })
    writeFileSync(join(projectDir, 'docs.json'), JSON.stringify({ tabs: [{ tab: 'API', api: { source: 'openapi/api.json' } }] }))
    writeFileSync(join(projectDir, 'openapi/api.json'), JSON.stringify({ info: { title: 'T', version: '1' }, ...body }))
    const output: Array<string> = []
    const log = vi.spyOn(console, 'log').mockImplementation((value) => output.push(String(value)))
    try {
      await runCheck(projectDir, { fix: false, ci: true })
    } finally {
      log.mockRestore()
    }
    return output.join('\n')
  }
  const hook = { post: { responses: { 200: { description: 'ok' } } } }

  it('accepts an OpenAPI 3.1 spec with only webhooks', async () => {
    expect(await run({ openapi: '3.1.0', webhooks: { 'crawl.page': hook } })).not.toMatch(/OpenAPI spec (is missing the "paths"|needs a "paths")/)
  })

  it('still requires paths in OpenAPI 3.0, and some root object in 3.1', async () => {
    expect(await run({ openapi: '3.0.3', webhooks: { 'crawl.page': hook } })).toContain('OpenAPI spec is missing the "paths" object')
    expect(await run({ openapi: '3.1.0' })).toContain('OpenAPI spec needs a "paths", "webhooks" or "components" object')
  })
})

describe('thally check stale specs under public/', () => {
  const doc = (paths: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    JSON.stringify({ openapi: '3.1.0', info: { title: 'T', version: '1' }, paths, ...extra })
  const ok = { get: { responses: { 200: { description: 'ok' } } } }

  async function run(files: Record<string, string>, source = 'openapi/api.json') {
    const projectDir = mkdtempSync(join(tmpdir(), 'thally-check-stale-'))
    writeFileSync(join(projectDir, 'docs.json'), JSON.stringify({ tabs: [{ tab: 'API', api: { source } }] }))
    for (const [file, body] of Object.entries(files)) {
      mkdirSync(join(projectDir, file.slice(0, file.lastIndexOf('/'))), { recursive: true })
      writeFileSync(join(projectDir, file), body)
    }
    const output: Array<string> = []
    const log = vi.spyOn(console, 'log').mockImplementation((value) => output.push(String(value)))
    try {
      await runCheck(projectDir, { fix: false, ci: true })
    } finally {
      log.mockRestore()
    }
    return output.join('\n')
  }

  it('warns about a leftover public/ spec even though docs.json points at the new file', async () => {
    const output = await run({
      'openapi/api.json': doc({ '/a': ok }),
      'public/openapi.json': doc({ '/a': { ...ok, get: { 'x-hidden': true, responses: {} } } }),
    })
    expect(output).toContain('public/openapi.json')
    expect(output).toContain('x-excluded/x-hidden')
    expect(output).toContain('does not remove old copies from public/')
  })

  it('says a leftover public/openapi.json answers /openapi.json instead of the filtered spec; other names do not', async () => {
    const flagged = doc({ '/a': { get: { 'x-hidden': true, responses: {} } } })
    const shadowed = await run({ 'openapi/api.json': doc({ '/a': ok }), 'public/openapi.json': flagged })
    expect(shadowed).toContain('in place of the filtered specification')
    const other = await run({ 'openapi/api.json': doc({ '/a': ok }), 'public/old.json': flagged })
    expect(other).toContain('public/old.json')
    expect(other).not.toContain('in place of the filtered specification')
    // Configured at /openapi.json itself: the validateOpenApi warning carries the same consequence.
    const configured = await run({ 'public/openapi.json': flagged }, '/openapi.json')
    expect(configured).toContain('in place of the filtered specification')
  })

  it('detects flags on a $ref sibling, a path item, a webhook and nested directories', async () => {
    for (const spec of [
      doc({ '/a': { $ref: '#/components/pathItems/X', 'x-hidden': true } }),
      doc({ '/a': { 'x-excluded': true, ...ok } }),
      doc({}, { webhooks: { h: { post: { 'x-excluded': 'true' } } } }),
    ]) {
      expect(await run({ 'openapi/api.json': doc({ '/a': ok }), 'public/deep/nested/spec.yaml': spec })).toContain('public/deep/nested/spec.yaml')
    }
  })

  it('warns about an unflagged leftover only when the configured spec lives elsewhere; ignores non-specs', async () => {
    const files = { 'openapi/api.json': doc({ '/a': ok }), 'public/old.json': doc({ '/a': ok }), 'public/manifest.json': '{"name":"x"}', 'public/data.yaml': 'a: 1' }
    const output = await run(files)
    expect(output).toContain('public/old.json')
    expect(output).toContain('an old copy')
    expect(output).not.toContain('manifest.json')
    expect(output).not.toContain('data.yaml')
    // No configured spec elsewhere and nothing hidden: a plain public spec is left alone.
    expect(await run({ 'public/old.json': doc({ '/a': ok }) }, 'https://example.com/spec.json')).not.toContain('public/old.json')
  })

  it('does not double-report the configured public/ spec and never errors', async () => {
    const output = await run({ 'public/openapi.json': doc({ '/a': { 'x-excluded': true, ...ok } }) }, '/openapi.json')
    expect(output.match(/public\/openapi\.json|lives under public\//g)?.length).toBe(1)
    expect(output).toContain('0 error(s)')
  })
})

describe('thally check image references', () => {
  it('warns about a local image with no file under public/, and accepts one that exists', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'thally-check-images-'))
    mkdirSync(join(projectDir, 'src/content'), { recursive: true })
    mkdirSync(join(projectDir, 'public/images'), { recursive: true })
    writeFileSync(join(projectDir, 'docs.json'), JSON.stringify({
      tabs: [{ tab: 'Guides', groups: [{ group: 'Start', pages: ['introduction'] }] }],
    }))
    writeFileSync(join(projectDir, 'public/images/present.png'), 'image')
    writeFileSync(join(projectDir, 'src/content/introduction.mdx'), [
      '---',
      'title: Introduction',
      'description: Overview page.',
      '---',
      '',
      '![Present](/images/present.png)',
      '',
      '![Missing](/images/missing.png)',
      '',
      '<img src="/images/also-missing.png" />',
    ].join('\n'))
    const output: Array<string> = []
    const log = vi.spyOn(console, 'log').mockImplementation((value) => output.push(String(value)))

    try {
      // A missing local image is a warning, not an error: next build still
      // succeeds with a broken <img>, unlike a broken internal link (404).
      await expect(runCheck(projectDir, { fix: false, ci: true })).resolves.toBe(0)
    } finally {
      log.mockRestore()
    }
    const text = output.join('\n')
    expect(text).not.toContain('/images/present.png')
    expect(text).toContain('Image not found: "/images/missing.png"')
    expect(text).toContain('Image not found: "/images/also-missing.png"')
  })
})

describe('thally check pages bound to unpublished operations', () => {
  const ok = { responses: { 200: { description: 'ok' } } }
  async function run(pages: Record<string, string>, overrides?: Record<string, unknown>, source = 'openapi/api.json') {
    const projectDir = mkdtempSync(join(tmpdir(), 'thally-check-unpublished-'))
    mkdirSync(join(projectDir, 'openapi'), { recursive: true })
    mkdirSync(join(projectDir, 'src/content'), { recursive: true })
    writeFileSync(join(projectDir, 'docs.json'), JSON.stringify({ tabs: [{ tab: 'API', groups: [{ group: 'G', pages: Object.keys(pages) }], api: { source, ...(overrides ? { overrides } : {}) } }] }))
    writeFileSync(join(projectDir, 'openapi/api.json'), JSON.stringify({
      openapi: '3.1.0', info: { title: 'T', version: '1' },
      paths: {
        '/hidden': { get: { 'x-hidden': true, ...ok } },
        '/excluded': { $ref: '#/components/pathItems/E' },
        '/visible': { get: ok },
      },
      webhooks: {
        orderUpdated: { post: { 'x-hidden': true, ...ok } },
        refunded: { $ref: '#/components/pathItems/E' },
        shipped: { post: ok },
      },
      components: { pathItems: { E: { 'x-excluded': true, get: ok } } },
    }))
    for (const [id, operation] of Object.entries(pages)) {
      writeFileSync(join(projectDir, `src/content/${id}.mdx`), `---\ntitle: ${id}\ndescription: d\nopenapi: "${operation}"\n---\n`)
    }
    const output: Array<string> = []
    const log = vi.spyOn(console, 'log').mockImplementation((value) => output.push(String(value)))
    try {
      await runCheck(projectDir, { fix: false, ci: true })
    } finally {
      log.mockRestore()
    }
    return output.join('\n')
  }

  it('warns for each page whose operation is hidden or excluded, naming the page and operation', async () => {
    const output = await run({ 'hidden-endpoint': 'GET /hidden', 'excluded-endpoint': 'GET /excluded', 'visible-endpoint': 'GET /visible', 'typo-endpoint': 'GET /typo' })
    expect(output).toContain('page src/content/hidden-endpoint.mdx points at hidden operation GET /hidden and is not published')
    expect(output).toContain('page src/content/excluded-endpoint.mdx points at excluded operation GET /excluded and is not published')
    expect(output).not.toContain('visible-endpoint.mdx points')
    expect(output).not.toContain('typo-endpoint.mdx points')
    expect(output).toContain('0 error(s)')
  })

  it('warns for pages bound to hidden or excluded webhooks, bare or spec-prefixed', async () => {
    const output = await run({
      'hook-hidden': 'webhook orderUpdated',
      'hook-prefixed': 'openapi/api.json webhook orderUpdated',
      'hook-excluded': 'webhook refunded',
      'hook-shown': 'webhook shipped',
      'hook-typo': 'webhook nope',
    })
    expect(output).toContain('page src/content/hook-hidden.mdx points at hidden operation WEBHOOK orderUpdated and is not published')
    expect(output).toContain('page src/content/hook-prefixed.mdx points at hidden operation openapi/api.json WEBHOOK orderUpdated and is not published')
    expect(output).toContain('page src/content/hook-excluded.mdx points at excluded operation WEBHOOK refunded and is not published')
    expect(output).not.toContain('hook-shown.mdx points')
    expect(output).not.toContain('hook-typo.mdx points')
  })

  it('judges a spec-prefixed page against the spec it names, like the site', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'thally-check-prefixed-'))
    mkdirSync(join(projectDir, 'openapi'), { recursive: true })
    mkdirSync(join(projectDir, 'src/content'), { recursive: true })
    const pages = { 'admin-secret': 'admin.yaml GET /secret', 'main-moved': 'openapi/api.json GET /moved', 'bare-moved': 'GET /moved', 'admin-moved': 'admin.yaml GET /moved' }
    writeFileSync(join(projectDir, 'docs.json'), JSON.stringify({ tabs: [
      { tab: 'API', groups: [{ group: 'G', pages: Object.keys(pages) }], api: { source: 'openapi/api.json' } },
      { tab: 'Admin', api: { source: 'openapi/admin.yaml' } },
    ] }))
    writeFileSync(join(projectDir, 'openapi/api.json'), JSON.stringify({ openapi: '3.1.0', info: { title: 'T', version: '1' }, paths: { '/moved': { get: { 'x-hidden': true, ...ok } } } }))
    writeFileSync(join(projectDir, 'openapi/admin.yaml'), 'openapi: 3.1.0\ninfo: { title: A, version: "1" }\npaths:\n  /secret:\n    get: { x-hidden: true, responses: { "200": { description: ok } } }\n  /moved:\n    get: { responses: { "200": { description: ok } } }\n')
    for (const [id, operation] of Object.entries(pages)) {
      writeFileSync(join(projectDir, `src/content/${id}.mdx`), `---\ntitle: ${id}\ndescription: d\nopenapi: "${operation}"\n---\n`)
    }
    const output: Array<string> = []
    const log = vi.spyOn(console, 'log').mockImplementation((value) => output.push(String(value)))
    try {
      await runCheck(projectDir, { fix: false, ci: true })
    } finally {
      log.mockRestore()
    }
    const text = output.join('\n')
    expect(text).toContain('page src/content/admin-secret.mdx points at hidden operation admin.yaml GET /secret and is not published')
    expect(text).toContain('page src/content/main-moved.mdx points at hidden operation openapi/api.json GET /moved and is not published')
    // A bare reference renders from the Admin spec, which publishes it.
    expect(text).not.toContain('bare-moved.mdx points')
    expect(text).not.toContain('admin-moved.mdx points')
  })

  it('honours docs.json overrides and does not judge a remote spec', async () => {
    expect(await run({ 'hidden-endpoint': 'GET /hidden' }, { 'GET /hidden': { hidden: false } })).not.toContain('is not published')
    expect(await run({ 'hidden-endpoint': 'GET /hidden' }, undefined, 'https://example.com/spec.json')).not.toContain('is not published')
  })
})

describe('thally check api.groups keys', () => {
  const ok = { responses: { 200: { description: 'ok' } } }
  // `groups` may be raw JSON text: JSON.stringify cannot serialise thousands of nested levels.
  async function run(groups: unknown, extraTabs: Array<unknown> = [], source = 'openapi/api.json', overrides?: Record<string, unknown>, docsExtra: Record<string, unknown> = {}) {
    const projectDir = mkdtempSync(join(tmpdir(), 'thally-check-groups-'))
    mkdirSync(join(projectDir, 'openapi'), { recursive: true })
    mkdirSync(join(projectDir, 'src/content'), { recursive: true })
    writeFileSync(join(projectDir, 'docs.json'), typeof groups === 'string'
      ? `{"tabs":[{"tab":"API reference","api":{"source":"${source}","groups":${groups}}}]}`
      : JSON.stringify({ ...docsExtra, tabs: [{ tab: 'API reference', api: { source, ...(groups ? { groups } : {}), ...(overrides ? { overrides } : {}) } }, ...extraTabs] }))
    writeFileSync(join(projectDir, 'openapi/api.json'), JSON.stringify({
      openapi: '3.1.0', info: { title: 'T', version: '1' },
      paths: {
        '/hidden': { get: { 'x-hidden': true, ...ok } },
        '/excluded': { get: { 'x-excluded': true, ...ok } },
        '/visible': { get: ok, post: ok },
      },
      webhooks: { orderUpdated: { post: { 'x-hidden': true, ...ok } }, shipped: { post: ok } },
    }))
    const output: Array<string> = []
    const log = vi.spyOn(console, 'log').mockImplementation((value) => output.push(String(value)))
    try {
      await runCheck(projectDir, { fix: false, ci: true })
    } finally {
      log.mockRestore()
    }
    return output.join('\n')
  }
  const warning = (key: string, state = '') =>
    `API tab "API reference": api.groups lists "${key}", which matches no published operation in openapi/api.json${state}. It is left out of the sidebar.`

  it('warns for each key that matches no published operation, naming the tab and the key', async () => {
    const output = await run([
      { group: 'A', pages: ['GET /visible', 'GET /typo', { group: 'Nested', pages: ['GET /hidden', 'GET /excluded', 'DELETE /visible'] }] },
      { group: 'B', pages: ['WEBHOOK POST orderUpdated', 'WEBHOOK POST nope', 'WEBHOOK GET shipped', 'FETCH /visible', 'visible'] },
    ])
    expect(output).toContain(warning('GET /typo'))
    expect(output).toContain(warning('GET /hidden', ' (it is hidden)'))
    expect(output).toContain(warning('GET /excluded', ' (it is excluded)'))
    expect(output).toContain(warning('DELETE /visible'))
    expect(output).toContain(warning('WEBHOOK POST orderUpdated', ' (it is hidden)'))
    expect(output).toContain(warning('WEBHOOK POST nope'))
    expect(output).toContain(warning('WEBHOOK GET shipped'))
    expect(output).toContain(warning('FETCH /visible'))
    expect(output).toContain(warning('visible'))
    expect(output).toContain('0 error(s), 9 warning(s)')
  })

  it('accepts published operations and webhooks, whatever the method case and spacing', async () => {
    const output = await run([{ group: 'A', pages: ['GET /visible', ' post   /visible ', 'WEBHOOK POST shipped', 'webhook post shipped', { group: 'Nested', pages: ['get /visible'] }] }])
    expect(output).not.toContain('api.groups')
    expect(output).toContain('0 error(s), 0 warning(s)')
  })

  it('honours overrides, and judges nothing for a remote spec, no groups or a hidden tab', async () => {
    expect(await run([{ group: 'A', pages: ['GET /hidden'] }], [], 'openapi/api.json', { 'GET /hidden': { hidden: false } })).not.toContain('api.groups')
    expect(await run([{ group: 'A', pages: ['GET /typo'] }], [], 'https://example.com/spec.json')).not.toContain('api.groups')
    expect(await run(undefined)).not.toContain('api.groups')
    const hiddenTab = { tab: 'Spec only', hidden: true, api: { source: 'openapi/api.json', groups: [{ group: 'A', pages: ['GET /typo'] }] } }
    expect(await run(undefined, [hiddenTab])).not.toContain('api.groups')
  })

  it('warns once per tab when entries are malformed and skipped, and still judges the valid ones', async () => {
    const output = await run([null, { group: 'NoPages' }, { group: 'Text', pages: 'GET /visible' }, { group: 'Mixed', pages: ['GET /visible', 7, ['GET /typo']] }, 'GET /visible'])
    expect(output).toContain('API tab "API reference": api.groups has 6 entries that are not a group with a "pages" list or an operation key. They are left out of the sidebar.')
    expect(output.split('api.groups has').length - 1).toBe(1)
    expect(output).toContain('0 error(s), 1 warning(s)')
    expect(await run([{ group: 'A', pages: ['GET /visible', 7] }])).toContain('api.groups has 1 entry that is not a group')
  })

  it('bounds the nesting: warns once per tab that deeper groups are skipped, without overflowing the stack', async () => {
    const nest = (levels: number, key: string) => '{"group":"G","pages":['.repeat(levels) + `"${key}"` + ']}'.repeat(levels)
    const deep = await run(`[${nest(3001, 'GET /visible')}]`)
    expect(deep).toContain(`API tab "API reference": api.groups nests groups deeper than ${API_GROUPS_MAX_DEPTH} levels. Groups beyond that level are left out of the sidebar`)
    expect(deep.split('deeper than').length - 1).toBe(1)
    expect(deep).toContain('0 error(s), 1 warning(s)')
    const atLimit = await run(`[${nest(API_GROUPS_MAX_DEPTH, 'GET /typo')}]`)
    expect(atLimit).toContain(warning('GET /typo'))
    expect(atLimit).not.toContain('deeper than')
    const beyond = await run(`[${nest(API_GROUPS_MAX_DEPTH + 1, 'GET /typo')}]`)
    expect(beyond).toContain('deeper than')
    expect(beyond).not.toContain(warning('GET /typo'))
  })

  it('judges a hidden tab that the site renders for a navigation.versions label, and no other hidden tab', async () => {
    const versions = { navigation: { versions: [{ label: 'v1' }, { label: 'v2' }] } }
    const hiddenTab = (version?: string) => ({ tab: 'API v1', hidden: true, ...(version ? { version } : {}), api: { source: 'openapi/api.json', groups: [{ group: 'A', pages: ['GET /typo'] }] } })
    const rendered = await run(undefined, [hiddenTab('v1')], 'openapi/api.json', undefined, versions)
    expect(rendered).toContain('API tab "API v1": api.groups lists "GET /typo", which matches no published operation')
    expect(await run(undefined, [hiddenTab('v3')], 'openapi/api.json', undefined, versions)).not.toContain('api.groups')
    expect(await run(undefined, [hiddenTab()], 'openapi/api.json', undefined, versions)).not.toContain('api.groups')
    expect(await run(undefined, [hiddenTab('v1')])).not.toContain('api.groups')
  })

  it('does not crash on malformed navigation.versions: a malformed list registers no version', async () => {
    const hiddenTab = { tab: 'API v1', hidden: true, version: 'v1', api: { source: 'openapi/api.json', groups: [{ group: 'A', pages: ['GET /typo'] }] } }
    for (const versions of [[null], {}, 'v1', [null, { label: 'v1' }]]) {
      const output = await run(undefined, [hiddenTab], 'openapi/api.json', undefined, { navigation: { versions } })
      expect(output).toContain('thally check:')
      expect(output.includes('API tab "API v1"')).toBe(Array.isArray(versions) && versions.length === 2)
    }
  })

  it('reports nothing about api.groups on a tab with navigation: false, which leaves the groups unused', async () => {
    const off = { tab: 'Off', api: { source: 'openapi/api.json', navigation: false, groups: [{ group: 'A', icon: { bad: true }, pages: ['GET /typo', null] }] } }
    expect(await run(undefined, [off])).not.toContain('API tab "Off"')
  })

  it('warns once per tab when a group icon is not text: the group stays, only the icon is dropped', async () => {
    const output = await run([{ group: 'A', icon: { bad: true }, pages: ['GET /visible', { group: 'Nested', icon: 5, pages: ['POST /visible'] }] }, { group: 'B', icon: 'paw', pages: ['WEBHOOK POST shipped'] }])
    expect(output).toContain('API tab "API reference": api.groups has 2 groups whose "icon" is not text. The icon is dropped and the group is still listed.')
    expect(output.split('whose "icon"').length - 1).toBe(1)
    expect(output).toContain('0 error(s), 1 warning(s)')
    expect(await run([{ group: 'A', icon: null, pages: ['GET /visible'] }])).toContain('api.groups has 1 group whose "icon" is not text')
    expect(await run([{ group: 'A', icon: '', pages: ['GET /visible'] }, { group: 'B', icon: 'paw', pages: ['POST /visible'] }])).not.toContain('"icon"')
  })

  it('judges the tabs of every i18n.navigation locale, naming the locale, with the same hidden-tab rule', async () => {
    const apiTab = (name: string, extra: Record<string, unknown> = {}) => ({ tab: name, ...extra, api: { source: 'openapi/api.json', groups: [{ group: 'A', pages: ['GET /typo', 7] }] } })
    const i18n = (navigation: Record<string, Array<unknown>>) => ({
      navigation: { versions: [{ label: 'v1' }] },
      i18n: { defaultLocale: 'en', locales: [{ code: 'en', label: 'English' }, { code: 'fr', label: 'French' }, { code: 'de', label: 'German' }], navigation },
    })
    const output = await run(undefined, [], 'openapi/api.json', undefined, i18n({
      fr: [apiTab('API fr', { hidden: true, version: 'v1' }), apiTab('Spec only', { hidden: true })],
      de: [apiTab('API de')],
    }))
    expect(output).toContain('API tab "API fr" (locale fr): api.groups lists "GET /typo", which matches no published operation in openapi/api.json. It is left out of the sidebar.')
    expect(output).toContain('API tab "API fr" (locale fr): api.groups has 1 entry that is not a group')
    expect(output).toContain('API tab "API de" (locale de): api.groups lists "GET /typo"')
    expect(output).not.toContain('Spec only')
    expect(output).not.toContain('API tab "API reference"')
    expect(await run(undefined, [], 'openapi/api.json', undefined, i18n({ fr: [{ tab: 'Docs', href: 'https://example.com' }] }))).not.toContain('api.groups')
  })

  it('does not repeat a warning for the same tab shared by two locales', async () => {
    const { checkApiGroupKeys } = await import('../check.js')
    const shared = { tab: 'API', api: { source: 'openapi/api.json', groups: [{ group: 'A', pages: ['GET /typo'] }] } }
    const projectDir = mkdtempSync(join(tmpdir(), 'thally-check-shared-'))
    mkdirSync(join(projectDir, 'openapi'), { recursive: true })
    writeFileSync(join(projectDir, 'openapi/api.json'), JSON.stringify({ openapi: '3.1.0', info: { title: 'T', version: '1' }, paths: { '/visible': { get: ok } } }))
    const issues: Array<unknown> = []
    checkApiGroupKeys(projectDir, { tabs: [shared], i18n: { defaultLocale: 'en', locales: [], navigation: { fr: [shared], de: [shared] } } }, issues as never)
    expect(issues).toHaveLength(1)
  })

  it('warns when api.groups is not a list: the renderer then shows the generated navigation', async () => {
    const message = 'API tab "API reference": api.groups must be a list of groups, so the tab shows the generated navigation.'
    expect(await run({ group: 'A', pages: ['GET /visible'] })).toContain(message)
    for (const raw of ['null', '5', '"GET /visible"', 'true', '{}']) expect(await run(raw)).toContain(message)
    expect(await run([])).not.toContain('api.groups')
    expect(await run(undefined)).not.toContain('api.groups')
    const off = { tab: 'Off', api: { source: 'openapi/api.json', navigation: false, groups: { group: 'A', pages: [] } } }
    expect(await run(undefined, [off])).not.toContain('must be a list')
  })
})

describe('thally check manual api pages', () => {
  async function run(frontmatter: string, body = '', docsExtra: Record<string, unknown> = {}) {
    const projectDir = mkdtempSync(join(tmpdir(), 'thally-check-manual-'))
    mkdirSync(join(projectDir, 'src/content'), { recursive: true })
    writeFileSync(join(projectDir, 'docs.json'), JSON.stringify({ tabs: [{ tab: 'Docs', groups: [{ group: 'G', pages: ['page'] }] }], ...docsExtra }))
    writeFileSync(join(projectDir, 'src/content/page.mdx'), `---\ntitle: T\ndescription: d\n${frontmatter}\n---\n${body}\nSome body text that is long enough to not be flagged as empty.\n`)
    const output: Array<string> = []
    const log = vi.spyOn(console, 'log').mockImplementation((value) => output.push(String(value)))
    try {
      await runCheck(projectDir, { fix: false, ci: true })
    } finally {
      log.mockRestore()
    }
    return output.join('\n')
  }
  const server = { api: { mdx: { server: 'https://api.example.com' } } }

  it('warns for an unparseable api value', async () => {
    expect(await run('api: "FETCH"', '', server)).toContain('page src/content/page.mdx: "api" frontmatter is not "METHOD https://host/path" or "METHOD /path"')
    expect(await run('api: 42', '', server)).toContain('"api" frontmatter is not')
  })

  it('warns for a path-only api without docs.json api.mdx.server', async () => {
    expect(await run('api: "GET /status"')).toContain('has no server: set docs.json "api.mdx.server" or use a full URL')
    expect(await run('api: "GET /status"', '', { api: { mdx: { server: 'not a url' } } })).toContain('has no server')
    expect(await run('api: "GET /status"', '', server)).not.toContain('has no server')
    expect(await run('api: "GET https://api.example.com/status"')).not.toContain('has no server')
  })

  it('warns for a ParamField path parameter missing from the URL template', async () => {
    expect(await run('api: "GET /users"', '<ParamField path="id" type="string" />', server)).toContain('<ParamField path="id"> has no matching {id}')
    expect(await run('api: "GET /users/{id}"', '<ParamField path="id" type="string" />', server)).not.toContain('has no matching')
  })

  it('warns when openapi and api are both set', async () => {
    expect(await run('openapi: "GET /a"\napi: "GET /b"', '', server)).toContain('both "openapi" and "api" are set; "api" is ignored')
  })

  it('stays quiet for a sound manual page', async () => {
    const output = await run('api: "POST /users/{id}"', '<ParamField path="id" type="string" />\n<ParamField body="name" type="string" />', server)
    expect(output).not.toMatch(/"api"|ParamField|has no server/)
  })
})

describe('thally check integrations', () => {
  const run = async (integrations: unknown) => {
    const projectDir = mkdtempSync(join(tmpdir(), 'thally-check-integrations-'))
    mkdirSync(join(projectDir, 'src/content'), { recursive: true })
    writeFileSync(join(projectDir, 'docs.json'), JSON.stringify({
      tabs: [{ tab: 'Documentation', pages: ['introduction'] }],
      ...(integrations === undefined ? {} : { integrations }),
    }))
    writeFileSync(join(projectDir, 'src/content/introduction.mdx'), [
      '---', 'title: Introduction', 'description: Product documentation introduction.', '---', '',
      'Welcome to the product documentation and its complete setup guide.',
    ].join('\n'))
    let issues: Array<{ severity: string; message: string }> = []
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      await runCheck(projectDir, { fix: false, ci: true, onIssues: (found) => { issues = found } })
    } finally {
      log.mockRestore()
    }
    return issues.filter((issue) => /integration/i.test(issue.message))
  }

  it('warns, without echoing values, on invalid integrations', async () => {
    const found = await run({
      ga4: { measurementId: 'UA-SECRETVALUE-1' },
      posthog: { apiKey: `phc_${'a'.repeat(30)}`, sessionRecording: 'false' },
      plausible: { domain: 'docs.example.com', server: '127.0.0.1' },
      amplitude: {},
    })
    expect(found.length).toBeGreaterThanOrEqual(4)
    expect(found.every((issue) => issue.severity === 'warning')).toBe(true)
    expect(found.map((issue) => issue.message).join('\n')).not.toContain('SECRETVALUE')
    expect(found.map((issue) => issue.message)).toContain(
      'docs.json integrations: Thally does not support these providers, so they will not be rendered: amplitude. Supported: ga4, gtm, posthog, plausible.',
    )
    expect((await run('nope')).length).toBe(1)
  })

  it('stays quiet for valid or absent integrations', async () => {
    expect(await run(undefined)).toEqual([])
    expect(await run({ ga4: { measurementId: 'G-TEST12345' }, gtm: { tagId: 'GTM-TEST123' } })).toHaveLength(1) // GTM + GA4 double count only
    expect(await run({ ga4: { measurementId: 'G-TEST12345' } })).toEqual([])
  })
})
