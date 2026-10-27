/** Adversarial inputs for the Fern and Docusaurus migrators. */

import { closeSync, ftruncateSync, mkdtempSync, mkdirSync, openSync, rmSync, symlinkSync, writeFileSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'
import { stringify as stringifyYaml } from 'yaml'
import * as mdx from '../mdx.js'
import { compileSync } from '@mdx-js/mdx'

import { projectDocusaurusNavigation, readDocusaurusRedirects, readDocusaurusSidebars, readDocusaurusSiteSettings, readDocusaurusThemeColor } from '../docusaurus.js'
import { migrateRepository, projectFernNavigation, renderMigrationFiles } from '../index.js'
import { normalizeDocusaurusAdmonitionTags, normalizeDocusaurusLinkTags, normalizeMdx } from '../mdx.js'
import { pageIdFromReference } from '../path.js'
import { fernIfRolesReason } from '../repository.js'
import { parseFrontmatter } from '../frontmatter.js'

describe('overlapping parser limits and page isolation', () => {
  it.each(['mintlify', 'fern', 'docusaurus'] as const)('bounds complex input and isolates repeated %s migrations', (platform) => {
    const root = mkdtempSync(join(tmpdir(), 'thally-overlap-'))
    const outside = mkdtempSync(join(tmpdir(), 'thally-overlap-outside-'))
    try {
      const contentRoot = platform === 'fern' ? join(root, 'fern') : platform === 'docusaurus' ? join(root, 'docs') : root
      mkdirSync(contentRoot, { recursive: true })
      if (platform === 'fern') writeFileSync(join(contentRoot, 'fern.config.json'), '{}')
      const configure = (name: string) => {
        if (platform === 'mintlify') writeFileSync(join(root, 'docs.json'), JSON.stringify({ name, navigation: { groups: [{ group: name, pages: ['a', 'b', 'bad', 'large', 'oversized'] }] } }))
        if (platform === 'docusaurus') writeFileSync(join(root, 'docusaurus.config.js'), `module.exports = { title: '${name}', presets: [['classic', { docs: {} }]] }`)
        if (platform === 'fern') writeFileSync(join(contentRoot, 'docs.yml'), `title: ${name}\nnavigation:\n${['a', 'b', 'bad', 'large', 'oversized'].map((id) => `  - page: ${id}\n    path: ${id}.mdx\n`).join('')}`)
      }
      configure('First')
      writeFileSync(join(outside, 'secret.md'), '# OUTSIDE-CONTENT')
      symlinkSync(outside, join(contentRoot, 'external'))
      symlinkSync(contentRoot, join(contentRoot, 'cycle'))
      symlinkSync(join(contentRoot, 'missing'), join(contentRoot, 'broken'))
      mkdirSync(join(contentRoot, '_partials'))
      writeSite(join(contentRoot, '_partials', 'huge.mdx'), { head: 'HUGE-INCLUDE', size: 2_000_001 })
      for (const id of ['a', 'b']) {
        writeFileSync(join(contentRoot, `${id}.mdx`), `---\ntitle: ${id}\nicon: book\niconType: {toString: null}\nkeywords: [safe, 42, null, {nested: true}]\n---\n\nexport const value = '${id}-ONLY';\n\nexport const Widget = () => { const [count] = useState(0); return <span>{value}{count}</span>; };\n\n<Widget />\n\n{value}\n\n![${id}](/${id}.svg)\n`)
        writeFileSync(join(root, `${id}.svg`), `<svg><title>${id}-ASSET</title></svg>`)
      }
      // One page combines nesting, malformed JSX, an oversized include and
      // escaping symlinks; malformed content must never abort sibling pages.
      writeFileSync(join(contentRoot, 'bad.mdx'), `import Huge from './_partials/huge.mdx'\nimport Outside from './external/secret.md'\n\n${'<Note>\n'.repeat(64)}<Huge />\n<Outside />\n${'<Link to={"unterminated"\n'.repeat(200)}${'</Note>\n'.repeat(64)}`)
      writeFileSync(join(contentRoot, 'large.mdx'), `# Large\n\n${'<Note>\n'.repeat(64)}\n\`\`\`txt\n${'x'.repeat(1_800_000)}\n\`\`\`\n\n${'</Note>\n'.repeat(64)}`)
      writeSite(join(contentRoot, 'oversized.mdx'), { head: '# Oversized', size: 50_000_001 })
      const start = Date.now()
      const first = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/docs', platform })
      expect(Date.now() - start).toBeLessThan(15_000)
      expect(first.pages.some((page) => page.title === 'Large')).toBe(true)
      expect(first.pages.some((page) => page.title === 'Oversized')).toBe(false)
      expect(JSON.stringify(first)).not.toContain('OUTSIDE-CONTENT')
      for (const id of ['a', 'b']) {
        const page = first.pages.find((page) => page.title === id)!
        expect(page).toBeDefined()
        expect(page.iconType).toBeUndefined()
        expect(page.keywords).toEqual(['safe'])
        expect(page.body).toContain(`/${id}.svg`)
        const componentFile = first.componentFiles?.find((file) => String(file.content).includes(`${id}-ONLY`))
        expect(componentFile).toBeDefined()
        expect(String(componentFile!.content)).not.toContain(`${id === 'a' ? 'b' : 'a'}-ONLY`)
      }
      for (const file of renderMigrationFiles(first).filter((file) => file.path.startsWith('src/content/') && file.path.endsWith('.mdx'))) {
        expect(typeof file.content).toBe('string')
        expect(() => compileSync(parseFrontmatter(file.content as string).content)).not.toThrow()
      }
      configure('Second')
      const second = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/docs', platform })
      expect(second.site?.name).toBe('Second')
      expect(first.site?.name).toBe('First')
      expect(second.componentFiles).toEqual(first.componentFiles)
      expect(second.assets).toEqual(first.assets)
    } finally {
      rmSync(root, { recursive: true, force: true })
      rmSync(outside, { recursive: true, force: true })
    }
  }, 60_000)
})

describe('Fern navigation recursion', () => {
  it('retains a public page without serializing cyclic source metadata', () => {
    const bundle = fernSite('theme-data: &loop\n  contents: [*loop]\n  image: /assets/open.png\nprivate-theme:\n  viewers: [admin]\n  image: /assets/secret.png\nnavigation:\n  - page: Safe\n    path: safe.mdx\n  - page: Secret\n    viewers: [admin]\n    path: secret.mdx\n', {
      'safe.mdx': '# Safe\n',
      'secret.mdx': '# Secret\n',
      'assets/open.png': 'PUBLIC-ASSET',
      'assets/secret.png': 'PRIVATE-ASSET',
    })
    expect(bundle.pages.map((page) => page.title)).toEqual(['Safe'])
    expect(bundle.assets.map((asset) => asset.path)).toEqual(['assets/open.png'])
  })

  it.each(['secret.mdx', 'safe.mdx'])('refuses incomplete navigation with a restricted appearance of %s beyond the limit', (restrictedPath) => {
    let nested: Record<string, unknown> = { section: 'Leaf', contents: [{ api: 'Secret API' }, { page: 'Secret', path: restrictedPath }] }
    for (let index = 0; index < 65; index++) nested = { section: 'Nested', contents: [nested] }
    nested.viewers = ['admin']
    expect(() => fernSite(stringifyYaml({ navigation: [{ page: 'Safe', path: 'safe.mdx' }, nested] }), {
      'safe.mdx': '# Safe\n\n<Markdown src="/secret.mdx" />\n',
      'secret.mdx': '# Secret\n\nPRIVATE-PAGE\n',
      'generators.yml': 'api: openapi.yml\n',
      'openapi.yml': 'openapi: 3.0.0\ninfo: {title: Secret, version: "1"}\npaths:\n  /secret:\n    get:\n      responses: {"200": {description: ok}}\n',
      'assets/secret.png': 'PRIVATE-ASSET',
    })).toThrow(/could not be fully classified.*no pages, assets or API specs were migrated/)
  })

  it('refuses cyclic navigation without a circular-serialization exception', () => {
    expect(() => fernSite('navigation:\n  - &loop\n    section: Loop\n    contents: [*loop]\n  - page: Safe\n    path: safe.mdx\n', { 'safe.mdx': '# Safe\n' }))
      .toThrow(/could not be fully classified/)
  })

  it('skips cyclic sections and retains public siblings', () => {
    const loop: Record<string, unknown> = { section: 'Loop' }
    loop.contents = [loop]
    const result = projectFernNavigation({
      fernRoot: tmpdir(),
      config: { navigation: [loop, { page: 'Safe', path: 'safe.md' }] },
    })
    expect(result.descriptors.map((page) => page.sourcePath)).toContain('safe.md')
    expect(result.warnings.some((warning) => warning.message.includes('cyclic'))).toBe(true)
  })

  it('bounds deep sections and repeated alias expansion', () => {
    let deep: Record<string, unknown> = { page: 'Leaf', path: 'leaf.md' }
    for (let index = 0; index < 1_000; index++) deep = { section: 'Deep', contents: [deep] }
    const result = projectFernNavigation({ fernRoot: tmpdir(), config: { navigation: [deep] } })
    expect(result.warnings.some((warning) => warning.message.includes('depth'))).toBe(true)
    let repeated: Record<string, unknown> = { section: 'Empty', contents: [] }
    for (let index = 0; index < 20; index++) repeated = { section: 'Repeated', contents: [repeated, repeated] }
    const expanded = projectFernNavigation({ fernRoot: tmpdir(), config: { navigation: [repeated] } })
    expect(expanded.warnings.some((warning) => warning.message.includes('budget'))).toBe(true)
  })

  it('allows an acyclic node shared by separate sections', () => {
    const shared = { page: 'Leaf', path: 'leaf.md' }
    const result = projectFernNavigation({ fernRoot: tmpdir(), config: { navigation: [
      { section: 'First', contents: [shared] }, { section: 'Second', contents: [shared] },
    ] } })
    expect(result.descriptors.map((page) => page.navigationId)).toEqual(['first/leaf', 'second/leaf'])
    expect(result.warnings.some((warning) => /cyclic|depth|budget/.test(warning.message))).toBe(false)
  })
})

describe('Fern file-backed code examples', () => {
  it('does not treat src text inside a quoted title as a file attribute', () => {
    const bundle = fernSite('navigation:\n  - page: Guide\n    path: guide.mdx\n', {
      'guide.mdx': '# Guide\n\nVisible introduction.\n\n<Code title=\'example src="secret.py"\' />\n',
      'secret.py': 'SHOULD-NOT-BE-INLINED\n',
    })
    expect(bundle.pages[0].body).not.toContain('SHOULD-NOT-BE-INLINED')
    const quotedTag = '<Code title="<Code example" />'
    expect(mdx.scanJsxOpeningTag(quotedTag, 0, 'Code').end).toBe(quotedTag.length - 1)
  })

  it('recovers at the next independent opening after a malformed Code tag', () => {
    const scan = vi.spyOn(mdx, 'scanJsxOpeningTag')
    try {
      fernSite('navigation:\n  - page: Guide\n    path: guide.mdx\n  - page: Safe\n    path: safe.mdx\n', {
        'safe.mdx': '# Safe\n\nBody.', 'guide.mdx': '# Guide\n\n<Code broken\n<Code src="missing" />',
      })
      expect(scan.mock.calls.filter((call) => call[2] === 'Code')).toHaveLength(2)
    } finally { scan.mockRestore() }
  })

  it('scans an unterminated suffix only once rather than rescanning every Code marker', () => {
    const scan = vi.spyOn(mdx, 'scanJsxOpeningTag')
    try {
      fernSite('navigation:\n  - page: Guide\n    path: guide.mdx\n  - page: Safe\n    path: safe.mdx\n', { 'safe.mdx': '# Safe\n\nBody.', 'guide.mdx': '# Guide\n\n<Code title="' + '<Code '.repeat(20) })
      expect(scan.mock.calls.filter((call) => call[2] === 'Code')).toHaveLength(1)
    } finally { scan.mockRestore() }
  })

  it('preserves language, title, line selections and list indentation', () => {
    const bundle = fernSite('navigation:\n  - page: Guide\n    path: guide.mdx\n', {
      'guide.mdx': '# Guide\n\n1. Example.\n\n    <Code src = "examples/demo.py" language = "python" title = "demo.py" lines = "2-3" />\n\n```mdx\n<Code src="missing" />\n```\n',
      'examples/demo.py': 'omit = 0\nfirst = 1\nsecond = 2\nomit = 3\n',
    })
    const body = bundle.pages[0].body
    expect(body).toContain('```python demo.py')
    expect(body).toContain('first = 1\n    second = 2')
    expect(body).not.toContain('omit =')
    expect(body).toContain('<Code src="missing" />')
    expect(() => compileSync(body)).not.toThrow()
  })

  it('bounds reads, confines symlinks, and safely fences code containing backticks', () => {
    const root = mkdtempSync(join(tmpdir(), 'thally-code-'))
    const outside = mkdtempSync(join(tmpdir(), 'thally-code-outside-'))
    try {
      mkdirSync(join(root, 'fern'))
      writeFileSync(join(root, 'fern', 'fern.config.json'), '{}')
      writeFileSync(join(root, 'fern', 'docs.yml'), 'navigation:\n  - page: Guide\n    path: guide.mdx\n')
      writeFileSync(join(root, 'fern', 'guide.mdx'), '# Guide\n\n<Code src="safe.txt" language="text" />\n\n<Code src="large.txt" />\n\n<Code src="escape.txt" />\n\n<Code src="missing.txt" />\n')
      writeFileSync(join(root, 'fern', 'safe.txt'), '```\n<Widget />\n```\n')
      writeSite(join(root, 'fern', 'large.txt'), { head: 'TOO-LARGE', size: 2_000_001 })
      writeFileSync(join(outside, 'escape.txt'), 'OUTSIDE-SECRET')
      symlinkSync(join(outside, 'escape.txt'), join(root, 'fern', 'escape.txt'))
      const bundle = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/docs', platform: 'fern' })
      expect(bundle.pages[0].body).toContain('````text')
      expect(bundle.pages[0].body).toContain('<Widget />')
      expect(bundle.pages[0].body).not.toContain('OUTSIDE-SECRET')
      expect(bundle.pages[0].body).not.toContain('TOO-LARGE')
      expect(bundle.warnings.filter((warning) => /large.txt|escape.txt|missing.txt/.test(warning.message))).toHaveLength(3)
      expect(() => compileSync(bundle.pages[0].body)).not.toThrow()
    } finally {
      rmSync(root, { recursive: true, force: true })
      rmSync(outside, { recursive: true, force: true })
    }
  })
})

describe('Docusaurus global MDX registry', () => {
  it('extracts display headings after unsupported leading widgets are removed', () => {
    const bundle = migrateDocusaurus({ 'docs/a.mdx': '---\ntitle: SEO title\n---\n\n<Missing />\n\n# Display title\n\nBody.' })
    expect(bundle.pages[0].headingTitle).toBe('Display title')
    expect(bundle.pages[0].body).not.toContain('# Display title')
  })

  it('keeps native widgets available when global overrides require unsupported dependencies', () => {
    const bundle = migrateDocusaurus({
      'src/theme/MDXComponents.js': "import Icon from '@site/src/Icon'\nexport default { Icon }",
      'src/Icon.jsx': "import External from 'unavailable-icon-package'\nexport default External",
      'docs/a.mdx': 'export const label = <Icon name="book" />;\n\n# A\n\n{label}',
    })
    expect(bundle.pages.map((page) => page.title)).toContain('A')
    expect(bundle.warnings.some((warning) => warning.message.includes('native widget'))).toBe(true)
  })

  it('binds invocation props inside computed expressions without sharing them across pages', () => {
    const bundle = migrateDocusaurus({
      'src/theme/MDXComponents.js': "import Shared from '@site/docs/_shared.mdx'\nexport default { Shared }",
      'docs/_shared.mdx': 'export const copy = { first: {name: "FIRST"}, second: {name: "SECOND"} };\n\nexport const literal = "props.product";\n\nexport const own = (props) => props.product;\n\n<span title={props.product}>Title</span>\n\n{copy[props.product].name}\n\n{props.product === "first" ? <p>First</p> : <p>Second</p>}\n\n```js\nprops.product\n```\n',
      'docs/a.mdx': '# A\n\n<Shared product="first" />',
      'docs/b.mdx': '# B\n\n<Shared product="second" />',
    })
    const a = bundle.pages.find((page) => page.title === 'A')!.body
    const b = bundle.pages.find((page) => page.title === 'B')!.body
    expect(a).toContain('copy["first"].name')
    expect(b).toContain('copy["second"].name')
    expect(a).toContain('title={"first"}')
    expect(a).toContain('literal = "props.product"')
    expect(a).toContain('(props) => props.product')
    expect(a).toContain('```js\nprops.product\n```')
    expect(() => compileSync(a)).not.toThrow()
  })

  it('resolves used static bindings through the existing component and partial pipeline', () => {
    const bundle = migrateDocusaurus({
      'src/theme/MDXComponents.js': "import Picture from '../picture'\nimport Note from '@site/docs/_note.mdx'\nexport default { DocsImage: Picture, GlobalNote: Note }\n",
      'src/picture.jsx': 'export default function Picture({src}) { return <img src={src} alt="global image" /> }\n',
      'docs/_note.mdx': 'GLOBAL-PARTIAL-CONTENT\n',
      'docs/a.mdx': '# A\n\n<DocsImage src="/a.svg" />\n\n<GlobalNote />\n',
      'docs/b.mdx': 'export const GlobalNote = () => <span>LOCAL-ONLY</span>;\n\n# B\n\n<GlobalNote />\n',
      'docs/c.mdx': '# C\n\n```mdx\n<GlobalNote />\n```\n',
      'static/a.svg': '<svg />',
    })
    expect(bundle.pages.find((page) => page.title === 'A')?.body).toContain('GLOBAL-PARTIAL-CONTENT')
    expect(bundle.pages.find((page) => page.title === 'B')?.body).not.toContain('GLOBAL-PARTIAL-CONTENT')
    expect(bundle.pages.find((page) => page.title === 'C')?.body).not.toContain('GLOBAL-PARTIAL-CONTENT')
    expect(bundle.warnings.filter((warning) => /picture|DocsImage/.test(warning.message))).toEqual([])
    expect(bundle.componentFiles?.some((file) => String(file.content).includes('global image'))).toBe(true)
    expect(bundle.warnings.some((warning) => /Unresolved.*DocsImage|Unresolved.*GlobalNote/.test(warning.message))).toBe(false)
  })
})

/** A file that starts with `head` and is `size` bytes long, without writing the rest (a sparse file). */
interface SparseFile { head: string; size: number }

function writeSite(path: string, content: string | SparseFile): void {
  if (typeof content === 'string') {
    writeFileSync(path, content)
    return
  }
  const descriptor = openSync(path, 'w')
  try {
    writeSync(descriptor, content.head)
    ftruncateSync(descriptor, content.size)
  } finally {
    closeSync(descriptor)
  }
}

function docusaurusSite(files: Record<string, string | SparseFile>): string {
  const root = mkdtempSync(join(tmpdir(), 'thally-harden-docusaurus-'))
  writeFileSync(join(root, 'docusaurus.config.ts'), "export default { presets: [['classic', { docs: { sidebarPath: './sidebars.ts' } }]] }")
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true })
    writeSite(join(root, path), content)
  }
  return root
}

function migrateDocusaurus(files: Record<string, string | SparseFile>) {
  return migrateRepository({ repositoryDir: docusaurusSite(files), sourceUrl: 'https://github.com/acme/docs', platform: 'docusaurus' })
}

describe('Docusaurus route identity', () => {
  it.each(['/../../escape', '/%2e%2e/%2e%2e/escape', '/a/./b/../../../escape'])('never lets slug %s leave the content directory', (slug) => {
    const bundle = migrateDocusaurus({ 'docs/a.md': `---\nslug: ${slug}\n---\n# A\n`, 'docs/b.md': '# B\n' })
    for (const page of bundle.pages) expect(page.navigationId.split('/')).not.toContain('..')
    for (const file of renderMigrationFiles(bundle)) expect(file.path.split('/')).not.toContain('..')
  })
})

describe('shared page identity', () => {
  it.each(['mintlify', 'fern', undefined] as const)('preserves Docusaurus colon fences for %s sources', (platform) => {
    const source = ':::note\nLiteral source text.\n:::'
    expect(normalizeMdx(source, platform)).toBe(source)
    expect(normalizeMdx(source, 'docusaurus')).toBe('<Note>\nLiteral source text.\n</Note>')
  })

  it('drops percent-encoded dot segments from a page reference', () => {
    expect(pageIdFromReference('%2e%2e/%2e%2e/x.md')).toBe('x')
    expect(pageIdFromReference('docs/%2E/x.md')).toBe('docs/x')
  })
})

describe('Docusaurus config parsing', () => {
  it('reads a config padded with 50k blank lines in linear time', () => {
    const root = docusaurusSite({ 'docusaurus.config.js': `${'\n'.repeat(50_000)}module.exports = {\n  title: 'Acme',\n}\n` })
    const started = Date.now()
    expect(readDocusaurusSiteSettings(root).name).toBe('Acme')
    expect(Date.now() - started).toBeLessThan(2_000)
  })
})

describe('Docusaurus redirects', () => {
  const configWith = (redirects: string): string => `module.exports = { plugins: [['@docusaurus/plugin-client-redirects', { redirects: [${redirects}] }]] }`

  it('drops a wildcard Next.js cannot express instead of emitting a redirect that fails the build', () => {
    const root = docusaurusSite({ 'docusaurus.config.js': configWith("{ from: '/old/*/deep', to: '/new' }, { from: '/ok', to: '/fine' }") })
    const warnings: Array<{ message: string }> = []
    expect(readDocusaurusRedirects(root, warnings as never)).toEqual([{ source: '/ok', destination: '/fine' }])
    expect(warnings.map((warning) => warning.message).join(' ')).toContain('/old/*/deep')
  })

  it('translates a trailing wildcard to the Next.js form', () => {
    const root = docusaurusSite({ 'docusaurus.config.js': configWith("{ from: '/old/*', to: '/new/*' }") })
    expect(readDocusaurusRedirects(root, [])).toEqual([{ source: '/old/:path*', destination: '/new/:path*' }])
  })

  it.each(['//evil.example', '/%2f%2fevil.example', '/\\\\evil.example'])('rejects the destination %s', (to) => {
    const root = docusaurusSite({ 'docusaurus.config.js': configWith(`{ from: '/a', to: '${to}' }`) })
    expect(readDocusaurusRedirects(root, [])).toEqual([])
  })

  it('names every rejected redirect in one warning, including each path of a list', () => {
    const root = docusaurusSite({ 'docusaurus.config.js': configWith("{ from: ['/a', '/b'], to: '//evil.example' }, { from: '/c', to: 'javascript:alert(1)' }, { from: '/ok', to: '/fine' }") })
    const warnings: Array<{ message: string }> = []
    expect(readDocusaurusRedirects(root, warnings as never)).toEqual([{ source: '/ok', destination: '/fine' }])
    expect(warnings.map((warning) => warning.message)).toEqual([
      'Skipped 3 redirects from /a, /b, /c: a redirect must start at a path on this site (one beginning with a single /) and lead to a path on this site or to an http:// or https:// address. Check these redirects in the source docs and add any that are still needed to docs.json.',
    ])
  })

  it('keeps a destination that is an absolute http(s) address, and says nothing', () => {
    const root = docusaurusSite({ 'docusaurus.config.js': configWith("{ from: '/a', to: 'https://example.com/b' }") })
    const warnings: Array<{ message: string }> = []
    expect(readDocusaurusRedirects(root, warnings as never)).toEqual([{ source: '/a', destination: 'https://example.com/b' }])
    expect(warnings).toEqual([])
  })
})

describe('Docusaurus and Fern redirects with a colon outside the path, or inside a path segment', () => {
  it('keeps a Docusaurus redirect whose destination query holds a colon, and names the real reason for one it drops', () => {
    const root = docusaurusSite({ 'docusaurus.config.js': "module.exports = { plugins: [['@docusaurus/plugin-client-redirects', { redirects: [{ from: '/a', to: 'https://example.com/?next=https://other.com' }, { from: '/wiki/Category:Foo', to: '/x' }] }]] }" })
    const warnings: Array<{ message: string }> = []
    expect(readDocusaurusRedirects(root, warnings as never)).toEqual([{ source: '/a', destination: 'https://example.com/?next=https://other.com' }])
    expect(warnings.map((warning) => warning.message)).toEqual([expect.stringMatching(/^Redirect from \/wiki\/Category:Foo has a path segment, "Category:Foo", with a ":" in it/)])
  })

  it('does the same for Fern', () => {
    const result = projectFernNavigation({
      fernRoot: tmpdir(),
      config: { navigation: [], redirects: [
        { source: '/a', destination: 'https://example.com/?next=https://other.com' },
        { source: '/wiki/Category:Foo', destination: '/x' },
      ] },
    })
    expect(result.docsConfig.redirects).toEqual([{ source: '/a', destination: 'https://example.com/?next=https://other.com', permanent: true }])
    expect(result.warnings.map((warning) => warning.message).filter((message) => message.startsWith('Redirect from'))).toEqual([expect.stringMatching(/^Redirect from \/wiki\/Category:Foo has a path segment, "Category:Foo", with a ":" in it/)])
  })
})

describe('inlined partial size cap', () => {
  const huge: SparseFile = { head: 'Lorem ipsum dolor sit amet.\n', size: 2_000_001 }

  it('does not inline a Docusaurus partial over 2 MB', () => {
    const bundle = migrateDocusaurus({
      'docs/a.mdx': "import Big from './_big.mdx'\n\n# A\n\n<Big />\n",
      'docs/_big.mdx': huge,
    })
    const page = bundle.pages.find((entry) => entry.navigationId === 'a')
    expect(page?.body.length).toBeLessThan(100_000)
    expect(bundle.warnings.map((warning) => warning.message).join(' ')).toContain('too large to inline')
  })

  it('does not inline a Docusaurus markdown document import over 2 MB', () => {
    const bundle = migrateDocusaurus({
      'docs/a.mdx': "import Big from './big.md'\n\n# A\n\n<Big />\n",
      'docs/big.md': huge,
    })
    const page = bundle.pages.find((entry) => entry.navigationId === 'a')
    expect(page?.body.length).toBeLessThan(100_000)
  })
})

function quarantinedPaths(bundle: ReturnType<typeof migrateRepository>): Array<string> {
  return (bundle.quarantinedFiles ?? []).map((file) => file.path).sort()
}

describe('Docusaurus draft pages', () => {
  it.each(['true', '"true"', 'yes', '1'])('quarantines a page with draft: %s and keeps draft: false public', (value) => {
    const bundle = migrateDocusaurus({
      'docs/live.md': '---\ndraft: false\n---\n# Live\n',
      'docs/unreleased.md': `---\ndraft: ${value}\n---\n# Unreleased\n`,
      'docs/plain.md': '# Plain\n',
    })
    expect(bundle.pages.map((page) => page.navigationId).sort()).toEqual(['live', 'plain'])
    expect(JSON.stringify(bundle.docsConfig.tabs)).not.toContain('unreleased')
    expect(quarantinedPaths(bundle)).toEqual(['migration-quarantine/unreleased.md'])
    expect(bundle.warnings.some((warning) => warning.code === 'gated-page' && warning.source === 'unreleased.md')).toBe(true)
  })

  it('quarantines a draft whose frontmatter is invalid YAML', () => {
    const bundle = migrateDocusaurus({
      'docs/unreleased.md': '---\ntitle: "unterminated\ndraft: true\n---\n# Unreleased\n',
      'docs/plain.md': '# Plain\n',
    })
    expect(bundle.pages.map((page) => page.navigationId)).toEqual(['plain'])
    expect(quarantinedPaths(bundle)).toEqual(['migration-quarantine/unreleased.md'])
  })

  it('does not inline a draft page that a published page imports', () => {
    const bundle = migrateDocusaurus({
      'docs/live.mdx': "import Secret from './unreleased.md'\n\n# Live\n\n<Secret />\n",
      'docs/unreleased.md': '---\ndraft: true\n---\nTOP-SECRET-LAUNCH-DATE\n',
    })
    expect(bundle.pages.map((page) => page.body).join('\n')).not.toContain('TOP-SECRET-LAUNCH-DATE')
  })
})

function fernSite(docsYml: string, pages: Record<string, string | SparseFile>) {
  const root = mkdtempSync(join(tmpdir(), 'thally-harden-fern-'))
  mkdirSync(join(root, 'fern'))
  writeFileSync(join(root, 'fern', 'fern.config.json'), '{}')
  writeFileSync(join(root, 'fern', 'docs.yml'), docsYml)
  for (const [path, content] of Object.entries(pages)) {
    mkdirSync(join(root, 'fern', path, '..'), { recursive: true })
    writeSite(join(root, 'fern', path), content)
  }
  return migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/docs', platform: 'fern' })
}

describe('Fern role-restricted pages', () => {
  const nav = (extra = ''): string => `navigation:\n  - section: Guides\n${extra}    contents:\n      - page: Open\n        path: open.mdx\n      - page: Internal\n        path: internal.mdx\n`

  it('quarantines a page whose frontmatter sets viewers', () => {
    const bundle = fernSite(nav(), { 'open.mdx': '# Open\n', 'internal.mdx': '---\nviewers: [admin]\n---\n# Internal\n' })
    expect(bundle.pages.map((page) => page.title)).toEqual(['Open'])
    expect(quarantinedPaths(bundle)).toEqual(['migration-quarantine/internal.mdx'])
    expect(JSON.stringify(bundle.docsConfig.tabs)).not.toContain('internal')
  })

  it('quarantines every page under a docs.yml section that sets viewers', () => {
    const bundle = fernSite(
      'navigation:\n  - section: Open\n    contents:\n      - page: Open\n        path: open.mdx\n  - section: Staff\n    viewers: [staff]\n    contents:\n      - page: Internal\n        path: internal.mdx\n',
      { 'open.mdx': '# Open\n', 'internal.mdx': '# Internal\n' },
    )
    expect(bundle.pages.map((page) => page.title)).toEqual(['Open'])
    expect(quarantinedPaths(bundle)).toEqual(['migration-quarantine/internal.mdx'])
    expect(JSON.stringify(bundle.docsConfig.tabs)).not.toContain('Staff')
  })

  it('quarantines a docs.yml page that sets viewers', () => {
    const bundle = fernSite(
      'navigation:\n  - page: Open\n    path: open.mdx\n  - page: Internal\n    path: internal.mdx\n    viewers: [staff]\n',
      { 'open.mdx': '# Open\n', 'internal.mdx': '# Internal\n' },
    )
    expect(bundle.pages.map((page) => page.title)).toEqual(['Open'])
    expect(quarantinedPaths(bundle)).toEqual(['migration-quarantine/internal.mdx'])
  })
})

describe('Docusaurus excluded documents', () => {
  it('does not publish files under an underscore directory', () => {
    const bundle = migrateDocusaurus({
      'docs/guide.mdx': "import Note from './_partials/note.mdx'\n\n# Guide\n\n<Note />\n",
      'docs/_partials/note.mdx': 'Shared note.\n',
      'docs/sub/_shared/deep.md': '# Deep partial\n',
      'docs/__tests__/spec.md': '# Spec\n',
    })
    expect(bundle.pages.map((page) => page.navigationId)).toEqual(['guide'])
    expect(bundle.pages[0].body).toContain('Shared note.')
  })
})

describe('Docusaurus Link component', () => {
  it('keeps expression comments opaque when converting opening tags', () => {
    const expression = '{"/a" /* } > */}'
    expect(normalizeDocusaurusLinkTags(`<Link to=${expression}>Text</Link>`)).toBe(`<a href=${expression}>Text</a>`)
    expect(normalizeDocusaurusAdmonitionTags(`<Admonition test=${expression} type="warning">Text</Admonition>`)).toBe('<Warning>\nText\n</Warning>')
  })

  it('turns Link tags with an expression or href into matching anchors', () => {
    const bundle = migrateDocusaurus({
      'docs/a.mdx': "export const base = '/docs/y'\n\nSee <Link to={base}>one</Link>, <Link href=\"/z\">two</Link> and <Link to=\"/w\">three</Link>.\n",
    })
    const body = bundle.pages[0].body
    expect(body).toContain('<a href={base}>one</a>')
    expect(body).toContain('<a href="/z">two</a>')
    expect(body).toContain('<a href="/w">three</a>')
    expect(body).not.toMatch(/&lt;|<Link/)
  })
})

describe('Docusaurus autogenerated sidebar', () => {
  it('keeps a number-prefixed directory as a category with its metadata', () => {
    const bundle = migrateDocusaurus({
      'docs/01-intro.md': '# Intro\n',
      'docs/02-guide/01-setup.md': '# Setup\n',
      'docs/02-guide/02-deep/01-leaf.md': '# Leaf\n',
      'docs/02-guide/_category_.json': '{"label":"The Guide"}',
      'sidebars.ts': "export default { docs: [{ type: 'autogenerated', dirName: '.' }] }",
    })
    expect(bundle.docsConfig.tabs[0].pages).toEqual([
      'intro',
      { group: 'The Guide', pages: ['guide/setup', { group: 'Deep', pages: ['guide/deep/leaf'] }] },
    ])
  })

  it('resolves an explicit dirName that names the on-disk prefixed directory', () => {
    const bundle = migrateDocusaurus({
      'docs/02-guide/01-setup.md': '# Setup\n',
      'sidebars.ts': "export default { docs: [{ type: 'autogenerated', dirName: '02-guide' }] }",
    })
    expect(bundle.docsConfig.tabs[0].pages).toEqual(['guide/setup'])
  })
})

describe('Fern files reached through a symlink', () => {
  it('keeps navigation restrictions when a page is reached through an internal alias', () => {
    const root = mkdtempSync(join(tmpdir(), 'thally-harden-alias-'))
    mkdirSync(join(root, 'fern/pages'), { recursive: true })
    writeFileSync(join(root, 'fern/fern.config.json'), '{}')
    writeFileSync(join(root, 'fern/docs.yml'), 'navigation:\n  - page: Live\n    path: live.mdx\n  - page: Secret\n    viewers: [admin]\n    path: alias/secret.mdx\n')
    writeFileSync(join(root, 'fern/live.mdx'), '# Live\n\nPublic content.\n')
    writeFileSync(join(root, 'fern/pages/secret.mdx'), '# Secret\n\nALIAS-PRIVATE-CONTENT\n')
    symlinkSync(join(root, 'fern/pages'), join(root, 'fern/alias'))
    const bundle = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/docs', platform: 'fern' })
    expect(bundle.pages.map((page) => page.body).join('')).not.toContain('ALIAS-PRIVATE-CONTENT')
    expect(bundle.pages.map((page) => page.title)).toEqual(['Live'])
  })

  it('does not read external version pages through an escaped ancestor symlink', () => {
    const root = mkdtempSync(join(tmpdir(), 'thally-harden-version-'))
    const outside = mkdtempSync(join(tmpdir(), 'thally-harden-outside-'))
    mkdirSync(join(root, 'fern'))
    mkdirSync(join(root, 'docs'))
    writeFileSync(join(root, 'fern/fern.config.json'), '{}')
    writeFileSync(join(root, 'fern/docs.yml'), 'versions:\n  - display-name: v1\n    path: ../docs/v1.yml\n    slug: v1\n')
    writeFileSync(join(root, 'docs/v1.yml'), 'navigation:\n  - page: Public\n    path: public.mdx\n  - page: Escaped\n    path: pages/private.mdx\n')
    writeFileSync(join(root, 'docs/public.mdx'), '# Public\n\nPublic content.\n')
    writeFileSync(join(outside, 'private.mdx'), '# Escaped\n\nOUTSIDE-HOST-CONTENT\n')
    symlinkSync(outside, join(root, 'docs/pages'))
    const bundle = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/docs', platform: 'fern' })
    expect(bundle.pages.map((page) => page.body).join('')).not.toContain('OUTSIDE-HOST-CONTENT')
    expect(bundle.pages.map((page) => page.title)).toEqual(['Public'])
  })

  it('does not copy a generators.yml spec that a symlinked directory points outside the repository', () => {
    const outside = mkdtempSync(join(tmpdir(), 'thally-harden-outside-'))
    writeFileSync(join(outside, 'openapi.yaml'), 'openapi: 3.0.0\ninfo:\n  title: OUTSIDE-SPEC\n  version: "1"\npaths: {}\n')
    const root = mkdtempSync(join(tmpdir(), 'thally-harden-fern-'))
    mkdirSync(join(root, 'fern'))
    writeFileSync(join(root, 'fern', 'fern.config.json'), '{}')
    writeFileSync(join(root, 'fern', 'docs.yml'), 'navigation:\n  - page: In\n    path: in.mdx\n  - api: API Reference\n')
    writeFileSync(join(root, 'fern', 'in.mdx'), '# In\n')
    writeFileSync(join(root, 'fern', 'generators.yml'), 'api:\n  specs:\n    - openapi: ext/openapi.yaml\n')
    symlinkSync(outside, join(root, 'fern', 'ext'))
    const bundle = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/docs', platform: 'fern' })
    expect(bundle.assets.some((asset) => Buffer.from(asset.content).toString().includes('OUTSIDE-SPEC'))).toBe(false)
    expect(bundle.warnings.some((warning) => warning.message.includes('ext/openapi.yaml'))).toBe(true)
  })
})

describe('Fern Markdown snippets', () => {
  it('resolves an absolute include from fern rather than a same-named snippets file', () => {
    const bundle = fernSite('navigation:\n  - page: In\n    path: in.mdx\n', {
      'in.mdx': '# In\n\n<Markdown src="/note.mdx" />\n',
      'note.mdx': 'ROOT-INCLUDE\n',
      'snippets/note.mdx': 'WRONG-INCLUDE\n',
    })
    expect(bundle.pages[0].body).toContain('ROOT-INCLUDE')
    expect(bundle.pages[0].body).not.toContain('WRONG-INCLUDE')
  })

  it('inlines <Markdown src> and applies the size cap', () => {
    const nav = 'navigation:\n  - page: In\n    path: in.mdx\n'
    const bundle = fernSite(nav, {
      'in.mdx': '# In\n\n<Markdown src="/snippets/note.mdx" />\n\n<Markdown src="/snippets/huge.mdx" />\n',
      'snippets/note.mdx': 'SNIPPET-BODY\n',
      'snippets/huge.mdx': { head: 'Lorem ipsum dolor sit amet.\n', size: 2_000_001 },
    })
    expect(bundle.pages).toHaveLength(1)
    expect(bundle.pages[0].body).toContain('SNIPPET-BODY')
    expect(bundle.pages[0].body.length).toBeLessThan(100_000)
    expect(bundle.warnings.map((warning) => warning.message).join(' ')).toContain('too large to inline')
  })
})

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64')

function bundlePaths(bundle: ReturnType<typeof migrateRepository>): { assets: Array<string>; quarantined: Array<string> } {
  return {
    assets: bundle.assets.map((asset) => asset.path),
    quarantined: (bundle.quarantinedFiles ?? []).map((file) => file.path),
  }
}

type RefStyle = 'markdown' | 'img' | 'import' | 'require' | 'partial'

/** The body of a page (and a partial, when needed) that references `/img/<name>.png` in one style. */
function referencing(style: RefStyle, name: string, platform: 'docusaurus' | 'fern'): { body: string; partial?: string } {
  const url = platform === 'docusaurus' ? `/img/${name}.png` : `/assets/${name}.png`
  const site = platform === 'docusaurus' ? `@site/static/img/${name}.png` : `../assets/${name}.png`
  switch (style) {
    case 'markdown': return { body: `![alt](${url})\n` }
    case 'img': return { body: `<img src="${url}" alt="alt" />\n` }
    case 'import': return { body: `import pic from '${site}'\n\n<img src={pic} alt="alt" />\n` }
    case 'require': return { body: `<img src={require('${site}').default} alt="alt" />\n` }
    case 'partial': return { body: "import Part from './_part.mdx'\n\n<Part />\n", partial: `![alt](${url})\n` }
  }
}

const STYLES: Array<RefStyle> = ['markdown', 'img', 'import', 'require', 'partial']
const SHARING = ['gated-only', 'shared'] as const

describe('assets used by quarantined pages', () => {
  it('withholds private assets when an oversized Fern page cannot be classified', () => {
    const bundle = fernSite('navigation:\n  - page: Live\n    path: live.mdx\n  - page: Huge\n    path: huge.mdx\n', {
      'live.mdx': '# Live\n\n![s](/assets/shared.png)\n',
      'huge.mdx': { head: '# Huge\n\n<If roles={["admin"]}>![s](/assets/secret.png)</If>\n', size: 2_000_001 },
      'assets/secret.png': 'private asset',
      'assets/shared.png': 'public asset',
    })
    expect(bundle.assets.some((asset) => asset.path.endsWith('secret.png'))).toBe(false)
    expect(bundle.assets.some((asset) => asset.path.endsWith('shared.png'))).toBe(true)
  })

  it('copies a public Fern logo once even with unrelated restricted pages', () => {
    const bundle = fernSite('logo: assets/logo.png\nnavigation:\n  - page: Live\n    path: live.mdx\n  - page: Secret\n    viewers: [admin]\n    path: secret.mdx\n', {
      'live.mdx': '# Live\n\nPublic content.\n',
      'secret.mdx': '# Secret\n',
      'assets/logo.png': 'public logo',
    })
    expect(bundle.assets.filter((asset) => asset.path === 'assets/logo.png')).toHaveLength(1)
    expect(bundle.docsConfig.navbar?.logo).toMatchObject({ light: '/assets/logo.png' })
  })

  it('uses a dark-only imported Fern logo for both modes', () => {
    const bundle = fernSite('logo:\n  light: assets/light.png\n  dark: assets/dark.png\nnavigation:\n  - page: Live\n    path: live.mdx\n', {
      'live.mdx': '# Live\n\nPublic content.\n',
      'assets/dark.png': 'dark logo',
    })
    expect(bundle.docsConfig.navbar?.logo).toMatchObject({ light: '/assets/dark.png', dark: '/assets/dark.png' })
  })

  it.each([false, true])('ignores restricted Fern config asset references (public sharing: %s)', (shared) => {
    const bundle = fernSite(`logo: assets/open.png\nnavigation:\n  - page: Public\n    path: public.mdx\n  - section: Private\n    viewers: [admin]\n    icon: /assets/secret.png\n    contents:\n      - page: Secret\n        path: secret.mdx\n`, {
      'public.mdx': `# Public\n${shared ? '![s](/assets/secret.png)' : ''}\n`,
      'secret.mdx': '# Secret\n\n![s](/assets/secret.png)\n',
      'assets/secret.png': 'private asset',
      'assets/open.png': 'public logo',
    })
    expect(bundle.assets.some((asset) => asset.path.endsWith('secret.png'))).toBe(shared)
    expect(bundle.assets.some((asset) => asset.path.endsWith('open.png'))).toBe(true)
  })

  const docusaurusKinds: Array<[string, string]> = [['draft', 'draft: true'], ['draft-string', 'draft: "yes"']]
  for (const [kind, frontmatter] of docusaurusKinds) {
    for (const style of STYLES) {
      for (const sharing of SHARING) {
        it(`docusaurus ${kind} / ${style} / ${sharing}`, () => {
          const gated = referencing(style, 'secret', 'docusaurus')
          const publicPage = sharing === 'shared' ? referencing('markdown', 'secret', 'docusaurus') : referencing('markdown', 'open', 'docusaurus')
          const files: Record<string, string> = {
            'docs/gated.mdx': `---\n${frontmatter}\n---\n${gated.body}`,
            'docs/public.mdx': `# Public\n\n${publicPage.body}`,
          }
          if (gated.partial) files['docs/_part.mdx'] = gated.partial
          const root = docusaurusSite(files)
          mkdirSync(join(root, 'static', 'img'), { recursive: true })
          for (const name of ['secret', 'open', 'unused']) writeFileSync(join(root, 'static', 'img', `${name}.png`), PNG)
          const bundle = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/docs', platform: 'docusaurus' })
          const { assets, quarantined } = bundlePaths(bundle)
          expect(bundle.pages.map((page) => page.navigationId)).toEqual(['public'])
          expect(assets.includes('img/secret.png')).toBe(sharing === 'shared')
          if (sharing === 'gated-only') {
            expect(assets).toContain('img/open.png')
            expect(quarantined).toContain('migration-quarantine/assets/img/secret.png')
          }
          // Ambiguity quarantines: an asset no published page names is not public on a site with withheld pages.
          expect(assets).not.toContain('img/unused.png')
        })
      }
    }
  }

  const fernKinds: Array<[string, string]> = [['viewers', 'viewers: [admin]'], ['authed', 'authed: true']]
  for (const [kind, frontmatter] of fernKinds) {
    for (const style of STYLES) {
      for (const sharing of SHARING) {
        it(`fern ${kind} / ${style} / ${sharing}`, () => {
          const gated = referencing(style, 'secret', 'fern')
          const publicPage = sharing === 'shared' ? referencing('markdown', 'secret', 'fern') : referencing('markdown', 'open', 'fern')
          const nav = 'navigation:\n  - page: Gated\n    path: gated.mdx\n  - page: Public\n    path: public.mdx\n'
          const pages: Record<string, string> = {
            'gated.mdx': `---\n${frontmatter}\n---\n${gated.body}`,
            'public.mdx': `# Public\n\n${publicPage.body}`,
          }
          if (gated.partial) pages['_part.mdx'] = gated.partial
          const root = mkdtempSync(join(tmpdir(), 'thally-harden-fern-assets-'))
          mkdirSync(join(root, 'fern', 'assets'), { recursive: true })
          writeFileSync(join(root, 'fern', 'fern.config.json'), '{}')
          writeFileSync(join(root, 'fern', 'docs.yml'), nav)
          for (const [path, content] of Object.entries(pages)) writeFileSync(join(root, 'fern', path), content)
          for (const name of ['secret', 'open', 'unused']) writeFileSync(join(root, 'fern', 'assets', `${name}.png`), PNG)
          const bundle = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/docs', platform: 'fern' })
          const { assets, quarantined } = bundlePaths(bundle)
          expect(bundle.pages.map((page) => page.title)).toEqual(['Public'])
          expect(assets.some((path) => path.endsWith('secret.png'))).toBe(sharing === 'shared')
          if (sharing === 'gated-only') {
            expect(assets.some((path) => path.endsWith('open.png'))).toBe(true)
            expect(quarantined.some((path) => path.endsWith('assets/secret.png'))).toBe(true)
          }
        })
      }
    }
  }
})

describe('assets: exact path matching and unclassifiable pages', () => {
  function site(publicBody: string, gatedFrontmatter = 'draft: true', gatedBody = '![a](/img/secret.png)\n') {
    const root = docusaurusSite({
      'docs/gated.md': `---\n${gatedFrontmatter}\n---\n${gatedBody}`,
      'docs/public.md': `# Public\n\n${publicBody}`,
    })
    mkdirSync(join(root, 'static', 'img', 'other'), { recursive: true })
    writeFileSync(join(root, 'static', 'img', 'secret.png'), PNG)
    writeFileSync(join(root, 'static', 'img', 'other', 'secret.png'), PNG)
    return migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/docs', platform: 'docusaurus' })
  }

  it('keeps a shared asset public only on an exact path match', () => {
    const bundle = site('![b](/img/other/secret.png)\n')
    expect(bundle.assets.map((asset) => asset.path)).toEqual(['img/other/secret.png'])
    expect(bundlePaths(bundle).quarantined).toContain('migration-quarantine/assets/img/secret.png')
  })

  it('does not treat a bare file name in public text as a reference', () => {
    const bundle = site('The file secret.png is mentioned here.\n')
    expect(bundle.assets.map((asset) => asset.path)).not.toContain('img/secret.png')
  })

  it('quarantines the assets of a page whose frontmatter cannot be read', () => {
    const bundle = site('![b](/img/other/secret.png)\n', 'draft: true', '')
    expect(bundle.assets.map((asset) => asset.path)).not.toContain('img/secret.png')
    const root = docusaurusSite({ 'docs/gated.md': { head: '---\ndraft: true\n', size: 2_000_001 }, 'docs/public.md': '# Public\n' })
    mkdirSync(join(root, 'static', 'img'), { recursive: true })
    writeFileSync(join(root, 'static', 'img', 'secret.png'), PNG)
    const result = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/docs', platform: 'docusaurus' })
    expect(result.pages.map((page) => page.navigationId)).toEqual(['public'])
    expect(result.assets.map((asset) => asset.path)).not.toContain('img/secret.png')
  })

  it('keeps assets of a gated page dropped by the file budget out of public/', () => {
    const root = docusaurusSite({
      'docs/a-public.md': '# Public\n\n![b](/img/open.png)\n',
      'docs/z-gated.md': '---\ndraft: true\n---\n![a](/img/secret.png)\n',
    })
    mkdirSync(join(root, 'static', 'img'), { recursive: true })
    for (const name of ['open', 'secret']) writeFileSync(join(root, 'static', 'img', `${name}.png`), PNG)
    const bundle = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/docs', platform: 'docusaurus', maxSourceFiles: 2 })
    expect(bundle.assets.map((asset) => asset.path)).not.toContain('img/secret.png')
  })

  it('fern: <Markdown src> partial used by a restricted page withholds its assets', () => {
    const root = mkdtempSync(join(tmpdir(), 'thally-harden-fern-assets-'))
    mkdirSync(join(root, 'fern', 'assets'), { recursive: true })
    mkdirSync(join(root, 'fern', 'snippets'))
    writeFileSync(join(root, 'fern', 'fern.config.json'), '{}')
    writeFileSync(join(root, 'fern', 'docs.yml'), 'navigation:\n  - page: Gated\n    path: gated.mdx\n  - page: Public\n    path: public.mdx\n')
    writeFileSync(join(root, 'fern', 'gated.mdx'), '---\nviewers: [admin]\n---\n<Markdown src="/snippets/part.mdx" />\n')
    writeFileSync(join(root, 'fern', 'snippets', 'part.mdx'), '![a](/assets/secret.png)\n')
    writeFileSync(join(root, 'fern', 'public.mdx'), '# Public\n')
    writeFileSync(join(root, 'fern', 'assets', 'secret.png'), PNG)
    const bundle = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/docs', platform: 'fern' })
    expect(bundle.assets.some((asset) => asset.path.endsWith('secret.png'))).toBe(false)
  })
})

describe('Fern viewers on products and versions', () => {
  it('quarantines every page of a product that sets viewers', () => {
    const root = mkdtempSync(join(tmpdir(), 'thally-harden-fern-'))
    mkdirSync(join(root, 'fern', 'products', 'staff'), { recursive: true })
    mkdirSync(join(root, 'fern', 'products', 'open'), { recursive: true })
    writeFileSync(join(root, 'fern', 'fern.config.json'), '{}')
    writeFileSync(join(root, 'fern', 'docs.yml'), 'products:\n  - display-name: Open\n    path: ./products/open/open.yml\n  - display-name: Staff\n    path: ./products/staff/staff.yml\n    viewers: [staff]\n')
    writeFileSync(join(root, 'fern', 'products', 'open', 'open.yml'), 'navigation:\n  - page: Open page\n    path: ./open.mdx\n')
    writeFileSync(join(root, 'fern', 'products', 'open', 'open.mdx'), '# Open page\n')
    writeFileSync(join(root, 'fern', 'products', 'staff', 'staff.yml'), 'navigation:\n  - page: Staff page\n    path: ./staff.mdx\n')
    writeFileSync(join(root, 'fern', 'products', 'staff', 'staff.mdx'), '# Staff page\n')
    const bundle = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/docs', platform: 'fern' })
    expect(bundle.pages.map((page) => page.title)).toEqual(['Open page'])
    expect(quarantinedPaths(bundle)).toEqual(['migration-quarantine/products/staff/staff.mdx'])
  })

  it('quarantines the pages of a default version that sets viewers', () => {
    const root = mkdtempSync(join(tmpdir(), 'thally-harden-fern-'))
    mkdirSync(join(root, 'fern', 'versions'), { recursive: true })
    writeFileSync(join(root, 'fern', 'fern.config.json'), '{}')
    writeFileSync(join(root, 'fern', 'docs.yml'), 'versions:\n  - display-name: Beta\n    path: versions/beta.yml\n    slug: beta\n    default: true\n    viewers: [beta-users]\n')
    writeFileSync(join(root, 'fern', 'versions', 'beta.yml'), 'navigation:\n  - page: Beta page\n    path: ../beta.mdx\n')
    writeFileSync(join(root, 'fern', 'beta.mdx'), '# Beta page\n')
    // Its only page is restricted, so nothing is left to publish.
    expect(() => migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/docs', platform: 'fern' }))
      .toThrow(/migration-quarantine\/beta\.mdx/)
  })
})

describe('Docusaurus config parsing stays linear on repeated openers', () => {
  const hostile: Record<string, string> = {
    'const a:': 'const a: '.repeat(6_000),
    'const a = {': 'const a = {'.repeat(5_000),
    'export default {': 'export default {'.repeat(3_300),
    'docs: {': 'docs: {'.repeat(8_000),
    '...fbContent({': '...fbContent({'.repeat(3_800),
  }
  for (const [name, source] of Object.entries(hostile)) {
    it(`reads 50k characters of "${name}" quickly`, () => {
      const root = docusaurusSite({ 'docusaurus.config.js': source, 'sidebars.js': source })
      const started = Date.now()
      try { readDocusaurusSidebars(root) } catch { /* unparseable is expected */ }
      readDocusaurusSiteSettings(root)
      expect(Date.now() - started).toBeLessThan(400)
    })
  }

  it('rejects a Docusaurus config over 20 MB', () => {
    const root = docusaurusSite({ 'sidebars.js': { head: 'module.exports = { docs: [] }\n', size: 20_000_001 } })
    expect(() => readDocusaurusSidebars(root)).toThrow(/20 MB/)
  })

  it('reads a large generated sidebar', () => {
    const items = Array.from({ length: 12_000 }, (_, index) => `{ type: 'doc', id: 'api/page-${index}' }`).join(',\n')
    const root = docusaurusSite({ 'sidebars.js': `module.exports = { docs: [${items}] }\n` })
    expect(Array.isArray(readDocusaurusSidebars(root)?.config.docs)).toBe(true)
  })

  it('still resolves the real export after more than 200 assignments', () => {
    const bindings = Array.from({ length: 300 }, (_, index) => `const helper${index} = { value: ${index} }`).join('\n')
    const root = docusaurusSite({ 'sidebars.js': `${bindings}\nmodule.exports = { main: ['intro'] }\n` })
    expect(readDocusaurusSidebars(root)?.config).toEqual({ main: ['intro'] })
  })

  it('still finds the sidebarPath after more than 200 docs: keys', () => {
    const plugins = Array.from({ length: 300 }, (_, index) => `['content-docs', { id: 'p${index}', docs: { sidebarPath: './missing${index}.js' } }]`).join(',\n')
    const root = docusaurusSite({
      'docusaurus.config.js': `module.exports = { plugins: [${plugins}], presets: [['classic', { docs: { sidebarPath: './custom-sidebar.js' } }]] }\n`,
      'custom-sidebar.js': "module.exports = { custom: ['x'] }\n",
      'sidebars.js': "module.exports = { fallback: ['y'] }\n",
    })
    expect(readDocusaurusSidebars(root)?.sourcePath).toBe('custom-sidebar.js')
  })

  it('still expands every fbContent call after more than 200', () => {
    const calls = Array.from({ length: 300 }, () => "...fbContent({ external: ['ext'] })").join(',\n')
    const root = docusaurusSite({ 'sidebars.js': `module.exports = { docs: [${calls}, 'intro'] }\n` })
    const docs = readDocusaurusSidebars(root)?.config.docs as Array<string>
    expect(docs).toHaveLength(301)
    expect(docs.at(-1)).toBe('intro')
  })
})

describe('Docusaurus identifiers containing $', () => {
  it('substitutes a sidebar binding named with $', () => {
    const root = docusaurusSite({ 'sidebars.js': "const $cat = { type: 'category', label: 'L', items: ['a'] }\nmodule.exports = { main: $cat }\n" })
    expect(readDocusaurusSidebars(root)?.config).toEqual({ main: { type: 'category', label: 'L', items: ['a'] } })
  })

  it('finds redirect options imported under a $ name', () => {
    const root = docusaurusSite({
      'docusaurus.config.js': "import $opts from './redirects.js'\nmodule.exports = { plugins: [['@docusaurus/plugin-client-redirects', $opts]] }\n",
      'redirects.js': "export const $opts = { redirects: [{ from: '/a', to: '/b' }] }\nexport default $opts\n",
    })
    expect(readDocusaurusRedirects(root, [])).toEqual([{ source: '/a', destination: '/b' }])
  })
})

describe('Docusaurus files reached through a symlinked directory', () => {
  function outsideDirectory(files: Record<string, string>): string {
    const outside = mkdtempSync(join(tmpdir(), 'thally-harden-outside-'))
    for (const [name, content] of Object.entries(files)) writeFileSync(join(outside, name), content)
    return outside
  }

  it('does not read a redirects module outside the repository', () => {
    const outside = outsideDirectory({ 'redirects.js': "export const opts = { redirects: [{ from: '/a', to: '/b' }] }\n" })
    const root = docusaurusSite({ 'docusaurus.config.js': "import { opts } from './ext/redirects.js'\nmodule.exports = { plugins: [['@docusaurus/plugin-client-redirects', opts]] }\n" })
    symlinkSync(outside, join(root, 'ext'))
    expect(readDocusaurusRedirects(root, [])).toEqual([])
  })

  it('does not read a customCss file outside the repository', () => {
    const outside = outsideDirectory({ 'custom.css': ':root { --ifm-color-primary: #123456; }\n' })
    const root = docusaurusSite({ 'docusaurus.config.js': "module.exports = { presets: [['classic', { theme: { customCss: './ext/custom.css' } }]] }\n" })
    symlinkSync(outside, join(root, 'ext'))
    expect(readDocusaurusThemeColor(root)).toBeUndefined()
  })
})

describe('Docusaurus unlisted pages', () => {
  const files = {
    'docs/pub.md': '# Public\n',
    'docs/folder/unl.md': '---\nunlisted: true\n---\n# Unlisted\n',
    'docs/folder/other.md': '# Other\n',
  }

  it('keeps an unlisted page routable but out of autogenerated navigation', () => {
    const bundle = migrateDocusaurus(files)
    const unlisted = bundle.pages.find((page) => page.navigationId === 'folder/unl')
    expect(unlisted?.hidden).toBe(true)
    expect(JSON.stringify(bundle.docsConfig.tabs)).not.toContain('folder/unl')
    expect(JSON.stringify(bundle.docsConfig.tabs)).toContain('folder/other')
  })

  it('keeps it out of an explicit sidebar and the Additional group too', () => {
    const bundle = migrateDocusaurus({ ...files, 'sidebars.ts': "export default { docs: ['pub', 'folder/unl'] }" })
    expect(bundle.pages.some((page) => page.navigationId === 'folder/unl')).toBe(true)
    expect(JSON.stringify(bundle.docsConfig.tabs)).not.toContain('folder/unl')
  })
})

describe('Docusaurus Admonition component', () => {
  it('maps <Admonition> to the same callouts as the colon fence', () => {
    const bundle = migrateDocusaurus({
      'docs/a.mdx': [
        "import Admonition from '@theme/Admonition'",
        '',
        '<Admonition type="danger" title="Careful">Do not.</Admonition>',
        '',
        '<Admonition type="caution">',
        '',
        'Outer',
        '',
        '<Admonition type="info" title=\'Inner\'>Nested</Admonition>',
        '',
        '</Admonition>',
        '',
        '<Admonition>Default</Admonition>',
        '',
      ].join('\n'),
    })
    const body = bundle.pages[0].body
    expect(body).toContain('<Error>\n**Careful**\nDo not.\n</Error>')
    expect(body).toMatch(/<Warning>\s*Outer\s*<Info>\n\*\*Inner\*\*\nNested\n<\/Info>\s*<\/Warning>/)
    expect(body).toContain('<Note>\nDefault\n</Note>')
    expect(body).not.toContain('Admonition')
  })
})

describe('Docusaurus ThemedImage component', () => {
  it('degrades <ThemedImage> to its light image', () => {
    const bundle = migrateDocusaurus({
      'docs/a.mdx': [
        "import ThemedImage from '@theme/ThemedImage'",
        "import useBaseUrl from '@docusaurus/useBaseUrl'",
        '',
        '<ThemedImage alt="Logo" sources={{ light: useBaseUrl(\'/img/l.png\'), dark: useBaseUrl(\'/img/d.png\') }} />',
        '',
        '<ThemedImage\n  alt="Plain"\n  sources={{\n    light: "/img/p-light.png",\n    dark: "/img/p-dark.png",\n  }}\n/>',
        '',
      ].join('\n'),
    })
    const body = bundle.pages[0].body
    expect(body).toContain('<img src="/img/l.png" alt="Logo" />')
    expect(body).toContain('<img src="/img/p-light.png" alt="Plain" />')
    expect(body).not.toContain('ThemedImage')
  })
})

describe('OpenAPI spec size cap', () => {
  const header = 'openapi: 3.0.0\ninfo:\n  title: Big\n  version: "1"\npaths: {}\n'
  const oversized = (): SparseFile => ({ head: header, size: 50_000_001 })

  it('does not read a Fern generators.yml spec over 50 MB', () => {
    const root = mkdtempSync(join(tmpdir(), 'thally-harden-fern-'))
    mkdirSync(join(root, 'fern'))
    writeFileSync(join(root, 'fern', 'fern.config.json'), '{}')
    writeFileSync(join(root, 'fern', 'docs.yml'), 'navigation:\n  - page: In\n    path: in.mdx\n  - api: API Reference\n')
    writeFileSync(join(root, 'fern', 'in.mdx'), '# In\n')
    writeFileSync(join(root, 'fern', 'generators.yml'), 'api:\n  specs:\n    - openapi: openapi/big.yaml\n')
    mkdirSync(join(root, 'fern', 'openapi'))
    writeSite(join(root, 'fern', 'openapi', 'big.yaml'), oversized())
    const bundle = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/docs', platform: 'fern' })
    expect(bundle.assets.some((asset) => asset.path.startsWith('openapi/'))).toBe(false)
    expect(bundle.warnings.some((warning) => warning.message.includes('50 MB') && warning.message.includes('big.yaml'))).toBe(true)
  })

  it('does not read a Mintlify docs.json spec over 50 MB', () => {
    const root = mkdtempSync(join(tmpdir(), 'thally-harden-mintlify-'))
    writeFileSync(join(root, 'docs.json'), JSON.stringify({ navigation: { tabs: [{ tab: 'API', openapi: 'big.yaml' }, { tab: 'Docs', pages: ['index'] }] } }))
    writeFileSync(join(root, 'index.mdx'), '# Home\n')
    writeSite(join(root, 'big.yaml'), oversized())
    const bundle = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/docs', platform: 'mintlify' })
    expect(bundle.assets.some((asset) => asset.path.startsWith('openapi/'))).toBe(false)
    expect(bundle.warnings.some((warning) => warning.message.includes('50 MB') && warning.message.includes('big.yaml'))).toBe(true)
  })
})

describe('symlinked intermediate directories', () => {
  function outside(files: Record<string, string>): string {
    const directory = mkdtempSync(join(tmpdir(), 'thally-harden-outside-'))
    for (const [name, content] of Object.entries(files)) writeFileSync(join(directory, name), content)
    return directory
  }
  function fernRoot(docsYml: string): { root: string; fern: string } {
    const root = mkdtempSync(join(tmpdir(), 'thally-harden-fern-'))
    const fern = join(root, 'fern')
    mkdirSync(fern)
    writeFileSync(join(fern, 'docs.yml'), docsYml)
    return { root, fern }
  }

  it('fern: a folder reached through a symlinked directory is not expanded', () => {
    const external = outside({ 'leak.mdx': '# Leak\n' })
    const { root, fern } = fernRoot('navigation:\n  - folder: link/inner\n')
    mkdirSync(join(external, 'inner'))
    writeFileSync(join(external, 'inner', 'leak.mdx'), '# Leak\n')
    symlinkSync(external, join(fern, 'link'))
    const result = projectFernNavigation({ config: { navigation: [{ folder: 'link/inner' }] }, fernRoot: fern, repositoryRoot: root })
    expect(result.descriptors).toEqual([])
  })

  it('fern: a versions file reached through a symlinked directory is not read', () => {
    const external = outside({ 'v.yml': 'navigation:\n  - page: Leak\n    path: leak.mdx\n' })
    const { root, fern } = fernRoot('versions:\n  - path: link/v.yml\n    slug: v\n')
    symlinkSync(external, join(fern, 'link'))
    const result = projectFernNavigation({ config: { versions: [{ path: 'link/v.yml', slug: 'v' }] }, fernRoot: fern, repositoryRoot: root })
    expect(result.descriptors).toEqual([])
  })

  it('fern: a product file reached through a symlinked directory is not read', () => {
    const external = outside({ 'p.yml': 'navigation:\n  - page: Leak\n    path: leak.mdx\n' })
    const { root, fern } = fernRoot('products: []\n')
    symlinkSync(external, join(fern, 'link'))
    const result = projectFernNavigation({ config: { products: [{ 'display-name': 'P', path: 'link/p.yml' }] }, fernRoot: fern, repositoryRoot: root })
    expect(result.descriptors).toEqual([])
  })

  it('docusaurus: a sidebarPath reached through a symlinked directory is not used', () => {
    const external = outside({ 'sidebar.js': "module.exports = { leaked: ['x'] }\n" })
    const root = docusaurusSite({
      'docusaurus.config.js': "module.exports = { presets: [['classic', { docs: { sidebarPath: './link/sidebar.js' } }]] }\n",
      'sidebars.js': "module.exports = { fallback: ['y'] }\n",
    })
    symlinkSync(external, join(root, 'link'))
    let config: unknown
    try { config = readDocusaurusSidebars(root)?.config } catch { config = undefined }
    expect(config).not.toEqual({ leaked: ['x'] })
  })

  it('docusaurus: category metadata reached through a symlinked directory is not read', () => {
    const external = outside({ '_category_.json': '{"label":"Leaked label"}' })
    const root = docusaurusSite({ 'docs/own.md': '# Own\n' })
    symlinkSync(external, join(root, 'docs', 'linked'))
    const result = projectDocusaurusNavigation({
      sidebars: null,
      descriptors: [{ sourcePath: 'linked/page.md', docId: 'linked/page', navigationId: 'linked/page', title: 'Page' }],
      contentRoot: join(root, 'docs'),
      sourceUrl: 'https://example.com',
    })
    expect(JSON.stringify(result.docsConfig.tabs)).not.toContain('Leaked label')
  })
})

describe('Fern <If roles> content', () => {
  const nav = 'navigation:\n  - page: Open\n    path: open.mdx\n  - page: Mixed\n    path: mixed.mdx\n'

  function site(mixed: string, extra: Record<string, string> = {}) {
    const root = mkdtempSync(join(tmpdir(), 'thally-harden-fern-if-'))
    mkdirSync(join(root, 'fern', 'assets'), { recursive: true })
    writeFileSync(join(root, 'fern', 'fern.config.json'), '{}')
    writeFileSync(join(root, 'fern', 'docs.yml'), nav)
    writeFileSync(join(root, 'fern', 'open.mdx'), '# Open\n\n![o](/assets/open.png)\n')
    writeFileSync(join(root, 'fern', 'mixed.mdx'), mixed)
    for (const name of ['open', 'secret']) writeFileSync(join(root, 'fern', 'assets', `${name}.png`), PNG)
    for (const [path, content] of Object.entries(extra)) {
      mkdirSync(join(root, 'fern', path, '..'), { recursive: true })
      writeFileSync(join(root, 'fern', path), content)
    }
    return migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/docs', platform: 'fern' })
  }

  it.each([
    ['inline roles', '# Mixed\n\n<If roles={["admin"]}>Internal</If>\n'],
    ['multi-line props', '# Mixed\n\n<If\n  products={["a"]}\n  roles={["admin", "staff"]}\n>\nInternal\n</If>\n'],
    ['viewers prop', '# Mixed\n\n<If viewers="admin">Internal</If>\n'],
    ['spread roles', '# Mixed\n\n<If {...{roles: ["admin"]}}>Internal</If>\n'],
    ['unresolved spread', '# Mixed\n\n<If {...props}>Internal</If>\n'],
    ['comment before spread', '# Mixed\n\n<If {/* props */ ...{roles: ["admin"]}}>Internal</If>\n'],
    ['brace in block comment', '# Mixed\n\n<If products={["a"] /* } > */} roles={["admin"]}>Internal</If>\n'],
    ['brace in line comment', '# Mixed\n\n<If products={["a"] // } >\n} roles={["admin"]}>Internal</If>\n'],
    ['brace in regular expression', '# Mixed\n\n<If products={/}>/.test("x") ? ["a"] : ["a"]} roles={["admin"]}>Internal</If>\n'],
  ])('quarantines a page with %s and names it in a warning', (_name, mixed) => {
    const bundle = site(mixed)
    expect(bundle.pages.map((page) => page.title)).toEqual(['Open'])
    expect(quarantinedPaths(bundle)).toContain('migration-quarantine/mixed.mdx')
    expect(bundle.warnings.some((warning) => warning.code === 'gated-page' && warning.source === 'mixed.mdx')).toBe(true)
  })

  it('keeps an asset used only inside the If block out of public/', () => {
    const bundle = site('# Mixed\n\n<If roles={["admin"]}>\n![s](/assets/secret.png)\n</If>\n')
    expect(bundle.assets.some((asset) => asset.path.endsWith('secret.png'))).toBe(false)
    expect(bundle.assets.some((asset) => asset.path.endsWith('open.png'))).toBe(true)
  })

  it('withholds a partial with <If roles> from the public page that includes it', () => {
    const bundle = site('# Mixed\n\n<Markdown src="/snippets/part.mdx" />\n', { 'snippets/part.mdx': '<If roles={["admin"]}>PARTIAL-SECRET</If>\n' })
    const body = bundle.pages.find((page) => page.title === 'Mixed')?.body ?? ''
    expect(body).not.toContain('PARTIAL-SECRET')
  })

  it('withholds a spread-gated partial and its assets', () => {
    const bundle = site('# Mixed\n\n<Markdown src="/snippets/part.mdx" />\n', {
      'snippets/part.mdx': '<If {...{roles: ["admin"]}}>PARTIAL-SECRET\n\n![s](/assets/secret.png)\n</If>\n',
    })
    expect(bundle.pages.map((page) => page.body).join('')).not.toContain('PARTIAL-SECRET')
    expect(bundle.assets.some((asset) => asset.path.endsWith('secret.png'))).toBe(false)
  })

  it('keeps a page public when <If roles> only appears in a code fence or inline code', () => {
    const bundle = site('# Mixed\n\n```mdx\n<If roles={["admin"]}>Docs example</If>\n```\n\nUse `<If roles={["a"]}>` like this.\n')
    expect(bundle.pages.map((page) => page.title).sort()).toEqual(['Mixed', 'Open'])
    expect(quarantinedPaths(bundle)).toEqual([])
  })

  it('keeps a page public when <If> has no roles or viewers', () => {
    const bundle = site('# Mixed\n\n<If products={["a"]} versions={["v1"]}>Shown</If>\n')
    expect(bundle.pages.map((page) => page.title).sort()).toEqual(['Mixed', 'Open'])
  })

  it('scans 50k characters of unterminated <If tags in linear time', () => {
    const started = Date.now()
    const bundle = site(`# Mixed\n\n${'<If a="1" '.repeat(5_500)}\n`)
    expect(bundle.pages.map((page) => page.title)).toContain('Open')
    expect(Date.now() - started).toBeLessThan(3_000)
  })
})

describe('Docusaurus partial toc and metadata imports', () => {
  const page = (source: string): string => `---\ntitle: Views\n---\n\n${source}\n`

  function body(source: string): string {
    const bundle = migrateDocusaurus({
      'docs/views.mdx': page(source),
      'docs/partials/_views.mdx': '## Partial heading\n',
      'docs/partials/_other.mdx': '## Other heading\n',
    })
    return bundle.pages.find((entry) => entry.navigationId === 'views')?.body ?? ''
  }

  it('does not leave an undefined toc spread (cypress shape)', () => {
    const result = body("import { toc as viewsToc } from '@site/docs/partials/_views.mdx'\n\nexport const toc = [\n  ...viewsToc,\n  { value: 'See also', id: 'See-also', level: 2 },\n]\n\n# Views\n")
    expect(result).not.toMatch(/=\s*undefined/)
    expect(result).toContain('export const viewsToc = [];')
  })

  it('handles a multi-line toc merging two partials', () => {
    const result = body("import { toc as viewsToc } from './partials/_views.mdx'\nimport { toc as otherToc } from './partials/_other.mdx'\n\nexport const toc = [\n  ...viewsToc,\n  ...otherToc\n]\n\n# Views\n")
    expect(result).not.toMatch(/=\s*undefined/)
    expect(result).toContain('export const otherToc = [];')
  })

  it('gives a toc used in JSX an array to work with', () => {
    const result = body("import { toc as viewsToc } from './partials/_views.mdx'\n\n# Views\n\n{viewsToc.map((item) => <span key={item.id}>{item.value}</span>)}\n")
    expect(result).not.toMatch(/viewsToc\s*=\s*undefined/)
  })

  it('binds frontMatter and assets to objects so member access cannot crash', () => {
    const result = body("import { frontMatter, assets } from './partials/_views.mdx'\n\n# Views\n\n{frontMatter.title}{assets.x}\n")
    expect(result).not.toMatch(/(?:frontMatter|assets)\s*=\s*undefined/)
  })

  it('still reports an unknown named import as undefined', () => {
    const result = body("import { custom } from './partials/_views.mdx'\n\n# Views\n\n{String(custom)}\n")
    expect(result).toMatch(/custom\s*=\s*undefined/)
  })
})

describe('Fern pages outside the fern directory', () => {
  function externalSite(files: Record<string, string>) {
    const root = mkdtempSync(join(tmpdir(), 'thally-harden-fern-ext-'))
    for (const [path, content] of Object.entries({
      'fern/fern.config.json': '{"organization":"a","version":"0.1.0"}',
      'fern/docs.yml': 'versions:\n  - display-name: v1\n    path: ../docs/v1.yml\n    slug: v1\n',
      ...files,
    })) {
      mkdirSync(join(root, path, '..'), { recursive: true })
      writeFileSync(join(root, path), content)
    }
    return migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/docs', platform: 'fern' })
  }

  it('gates frontmatter viewers, If roles, node viewers and their assets', () => {
    const bundle = externalSite({
      'docs/v1.yml': 'navigation:\n  - page: Pub\n    path: pages/pub.mdx\n  - page: FM\n    path: pages/fm.mdx\n  - page: If\n    path: pages/if.mdx\n  - page: V\n    viewers: [a]\n    path: pages/v.mdx\n',
      'docs/pages/pub.mdx': '# Pub\n',
      'docs/pages/fm.mdx': '---\nviewers: [a]\n---\n# FM\n![](../img/x.png)',
      'docs/pages/if.mdx': '# If\n<If roles={["a"]}>secret</If>',
      'docs/pages/v.mdx': '# V\nsecret',
      'docs/img/x.png': 'x',
    })
    expect(bundle.pages.map((page) => page.title)).toEqual(['Pub'])
    expect(bundle.warnings.filter((warning) => warning.code === 'gated-page' && warning.source).map((warning) => warning.source).sort())
      .toEqual(['../docs/pages/fm.mdx', '../docs/pages/if.mdx', '../docs/pages/v.mdx'])
    expect(bundle.assets.some((asset) => asset.path.endsWith('x.png'))).toBe(false)
  })

  it('does not inline a restricted partial that lives outside the fern directory', () => {
    const bundle = externalSite({
      'docs/v1.yml': 'navigation:\n  - page: Pub\n    path: pages/pub.mdx\n',
      'docs/pages/pub.mdx': '# Pub\n\n<Markdown src="../snippets/part.mdx" />\n',
      'docs/snippets/part.mdx': '---\nviewers: [a]\n---\nPARTIAL-SECRET\n',
    })
    expect(bundle.pages.map((page) => page.body).join('')).not.toContain('PARTIAL-SECRET')
  })
})

describe('Docusaurus draft partials and wording', () => {
  it('keeps the content of an underscore partial whose frontmatter says draft', () => {
    const bundle = migrateDocusaurus({
      'docs/a.md': 'import P from "./_p.md"\n\n# A\n\n<P />\n',
      'docs/_p.md': '---\ndraft: true\n---\nPARTIAL TEXT\n',
    })
    expect(bundle.pages[0].body).toContain('PARTIAL TEXT')
  })

  it('calls a draft page a draft, not access-restricted, in warnings and partial imports', () => {
    const bundle = migrateDocusaurus({
      'docs/a.md': 'import D from "./draft.md"\n\n# A\n\n<D />\n',
      'docs/draft.md': '---\ndraft: true\n---\nDRAFT TEXT\n',
    })
    const messages = bundle.warnings.map((warning) => warning.message)
    expect(messages.some((message) => message.includes('draft page that Docusaurus does not publish'))).toBe(true)
    expect(messages.join('\n')).not.toMatch(/access-restricted/i)
    expect(bundle.pages.map((page) => page.body).join('')).not.toContain('DRAFT TEXT')
  })
})

describe('Fern api nodes under restricted nodes', () => {
  const spec = 'openapi: 3.0.0\ninfo: {title: Secret API, version: "1"}\npaths:\n  /secret:\n    get:\n      summary: SECRETOP\n      responses: {"200": {description: ok}}\n'
  const base = { 'fern.config.json': '{"organization":"a","version":"0.1.0"}', 'p.mdx': '# P', 'openapi/openapi.yml': spec, 'generators.yml': 'api:\n  specs:\n    - openapi: openapi/openapi.yml\n' }

  function api(docsYml: string, extra: Record<string, string> = {}) {
    const root = mkdtempSync(join(tmpdir(), 'thally-harden-fern-api-'))
    for (const [path, content] of Object.entries({ ...base, 'docs.yml': docsYml, ...extra })) {
      mkdirSync(join(root, 'fern', path, '..'), { recursive: true })
      writeFileSync(join(root, 'fern', path), content)
    }
    const bundle = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/docs', platform: 'fern' })
    const published = renderMigrationFiles(bundle).filter((file) => !file.path.startsWith('migration-quarantine/') && Buffer.from(file.content).toString().includes('SECRETOP'))
    return { bundle, published: published.map((file) => file.path) }
  }

  it.each([
    ['an api node with viewers', 'navigation:\n  - page: P\n    path: p.mdx\n  - api: API Reference\n    viewers: [admin]\n'],
    ['an api node inside a restricted section', 'navigation:\n  - page: P\n    path: p.mdx\n  - section: Staff\n    viewers: [admin]\n    contents:\n      - api: API Reference\n'],
    ['an api node inside a restricted tab', 'tabs:\n  docs:\n    display-name: Docs\n  ref:\n    display-name: Ref\nnavigation:\n  - tab: docs\n    layout:\n      - page: P\n        path: p.mdx\n  - tab: ref\n    viewers: [admin]\n    layout:\n      - api: API Reference\n'],
  ])('does not publish the spec of %s', (_name, docsYml) => {
    const { bundle, published } = api(docsYml)
    expect(published).toEqual([])
    expect(quarantinedPaths(bundle)).toContain('migration-quarantine/assets/openapi/openapi.yml')
    expect(bundle.warnings.some((warning) => warning.message.includes('NOT published') && warning.message.includes('API'))).toBe(true)
  })

  it('keeps a spec public when a public api node uses the same file', () => {
    const { bundle, published } = api('navigation:\n  - page: P\n    path: p.mdx\n  - api: Public API\n  - api: Staff API\n    viewers: [admin]\n')
    expect(published).toContain('openapi/openapi.yml')
    expect(quarantinedPaths(bundle)).not.toContain('migration-quarantine/assets/openapi/openapi.yml')
  })
})

describe('Fern page listed under public and restricted nodes', () => {
  it('fails closed and warns', () => {
    const bundle = fernSite(
      'navigation:\n  - page: Shared\n    path: shared.mdx\n  - section: Staff\n    viewers: [staff]\n    contents:\n      - page: Shared again\n        path: shared.mdx\n      - page: Own\n        path: own.mdx\n  - page: Open\n    path: open.mdx\n',
      { 'shared.mdx': '# Shared\n', 'own.mdx': '# Own\n', 'open.mdx': '# Open\n' },
    )
    expect(bundle.pages.map((page) => page.title)).toEqual(['Open'])
    expect(quarantinedPaths(bundle)).toContain('migration-quarantine/shared.mdx')
    expect(bundle.warnings.some((warning) => warning.code === 'gated-page' && warning.source === 'shared.mdx')).toBe(true)
  })
})

describe('JSX tag scanning stays linear and quote aware', () => {
  const repeated = (unit: string): string => unit.repeat(Math.ceil(100_000 / unit.length))

  it.each(['<Admonition ', '<Admonition {a{b ', '<Admonition x="'])('converts 100k characters of %s quickly', (unit) => {
    const input = repeated(unit)
    const started = performance.now()
    normalizeDocusaurusAdmonitionTags(input)
    expect(performance.now() - started).toBeLessThan(300)
  })

  it.each(['<Link ', '<Link {a{b ', '<Link x="'])('converts 100k characters of %s quickly', (unit) => {
    const input = repeated(unit)
    const started = performance.now()
    normalizeDocusaurusLinkTags(input)
    expect(performance.now() - started).toBeLessThan(300)
  })

  it.each(['<If ', '<If {a{b ', '<If x="'])('scans 100k characters of %s quickly', (unit) => {
    const input = repeated(unit)
    const started = performance.now()
    fernIfRolesReason(input)
    expect(performance.now() - started).toBeLessThan(300)
  })

  const roles = (body: string) => {
    const bundle = fernSite('navigation:\n  - page: Open\n    path: open.mdx\n  - page: Mixed\n    path: mixed.mdx\n', { 'open.mdx': '# Open\n', 'mixed.mdx': `# Mixed\n\n${body}\n` })
    return bundle.pages.map((page) => page.title).sort()
  }

  it.each([
    ['a quoted > before roles', '<If x="a>b" roles={["admin"]}>Internal</If>'],
    ['braces nested three deep', '<If a={{ b: { c: { d: 1 } } }} roles={["admin"]}>Internal</If>'],
    ['a backtick info string that is not a fence', '```js `x`\n<If roles={["admin"]}>Internal</If>\n```'],
    ['an arrow function in braces', '<If a={(x) => x > 1} roles={["admin"]}>Internal</If>'],
  ])('quarantines %s', (_name, body) => {
    expect(roles(body)).toEqual(['Open'])
  })

  it('keeps a real code fence public', () => {
    expect(roles('```mdx\n<If roles={["admin"]}>Docs</If>\n```')).toEqual(['Mixed', 'Open'])
  })
})

describe('Mintlify partial imports', () => {
  function mintlify(index: string, files: Record<string, string> = {}) {
    const root = mkdtempSync(join(tmpdir(), 'thally-harden-mintlify-'))
    for (const [path, content] of Object.entries({
      'docs.json': JSON.stringify({ name: 'x', navigation: { pages: ['index'] } }),
      'index.mdx': `---\ntitle: I\n---\n${index}`,
      'snippets/v.mdx': 'hi\n',
      ...files,
    })) {
      mkdirSync(join(root, path, '..'), { recursive: true })
      writeFileSync(join(root, path), content)
    }
    return migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/docs', platform: 'mintlify' })
  }

  it('keeps binding an unexported name to undefined with its warning', () => {
    const bundle = mintlify('import { metadata } from "/snippets/v.mdx"\n\n# T\n\nM: {metadata}\n')
    expect(bundle.pages[0].body).toMatch(/metadata\s*=\s*undefined/)
    expect(bundle.warnings.some((warning) => warning.message.includes('"metadata" is not exported'))).toBe(true)
  })

  it('keeps a heading that directly follows a value import out of the export block', () => {
    const bundle = mintlify('import { v } from "/snippets/v.mdx"\n# Title\n\nValue {v}\n', { 'snippets/v.mdx': 'export const v = "VAL"\n' })
    expect(bundle.pages[0].body).toMatch(/export const v = "VAL";\s*\n\n# Title/)
  })
  it('keeps the children of a Mintlify <Markdown src> tag and does not treat it as a snippet', () => {
    const bundle = mintlify('# T\n\n<Markdown src="local.md">child text</Markdown>\n')
    expect(bundle.pages[0].body).toContain('child text')
    expect(bundle.warnings.map((warning) => warning.message).join('\n')).not.toMatch(/Snippet/)
  })
})

describe('Fern Markdown include wording', () => {
  it('names a missing include plainly', () => {
    const bundle = fernSite('navigation:\n  - page: In\n    path: in.mdx\n', { 'in.mdx': '# In\n\n<Markdown src="/snippets/missing.mdx" />\n' })
    expect(bundle.warnings.map((warning) => warning.message)).toContain('Included file /snippets/missing.mdx could not be found, so it was left out of the page.')
  })
})

describe('symlink and escape warnings', () => {
  it('words a sidebar symlink escape plainly, without a path or jargon', () => {
    const outside = mkdtempSync(join(tmpdir(), 'thally-harden-outside-'))
    writeFileSync(join(outside, 'sidebar.js'), "module.exports = { leaked: ['x'] }\n")
    const root = docusaurusSite({
      'docusaurus.config.js': "module.exports = { presets: [['classic', { docs: { sidebarPath: './link/sidebar.js' } }]] }\n",
      'docs/a.md': '# A\n',
    })
    symlinkSync(outside, join(root, 'link'))
    const bundle = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/docs', platform: 'docusaurus' })
    const message = bundle.warnings.map((warning) => warning.message).find((text) => text.includes('sidebar')) ?? ''
    expect(message).toBe('Skipped the sidebar file because it points outside the repository (symlink or ..). Navigation was generated from the docs folder instead.')
  })

  it('words Fern folder, version and product escapes plainly', () => {
    const external = mkdtempSync(join(tmpdir(), 'thally-harden-outside-'))
    mkdirSync(join(external, 'inner'))
    for (const name of ['v.yml', 'p.yml']) writeFileSync(join(external, name), 'navigation: []\n')
    const root = mkdtempSync(join(tmpdir(), 'thally-harden-fern-'))
    const fern = join(root, 'fern')
    mkdirSync(fern)
    symlinkSync(external, join(fern, 'link'))
    const messages = [
      ...projectFernNavigation({ config: { navigation: [{ folder: 'link/inner' }] }, fernRoot: fern, repositoryRoot: root }).warnings,
      ...projectFernNavigation({ config: { versions: [{ path: 'link/v.yml', slug: 'v' }] }, fernRoot: fern, repositoryRoot: root }).warnings,
      ...projectFernNavigation({ config: { products: [{ 'display-name': 'P', path: 'link/p.yml' }] }, fernRoot: fern, repositoryRoot: root }).warnings,
    ].map((warning) => warning.message).join('\n')
    expect(messages).toContain('Skipped the Fern folder "link/inner" because it points outside the repository')
    expect(messages).toContain('Skipped the Fern version file "link/v.yml" because it points outside the repository')
    expect(messages).toContain('Skipped the Fern product "P" because "link/p.yml" points outside the repository')
    expect(messages).not.toMatch(/escapes its root|\/(?:private|var|tmp)\//)
  })
})

describe('public Docusaurus pages keep their static assets when a draft exists', () => {
  it.each([
    ['@site/static', '![s](@site/static/img/site.png)', 'img/site.png'],
    ['relative to static', '![x](../../static/img/x.png)', 'img/x.png'],
    ['root absolute', '![r](/img/r.png)', 'img/r.png'],
    ['inside the docs folder', '![y](../img/y.png)', 'img/y.png'],
  ])('keeps an image written as %s public', (_name, markdown, asset) => {
    const root = docusaurusSite({
      'docs/sub/a.md': `# A\n\n${markdown}\n`,
      'docs/img/y.png': 'x',
      'docs/d.md': '---\ndraft: true\n---\n# D\n',
    })
    mkdirSync(join(root, 'static', 'img'), { recursive: true })
    for (const name of ['site', 'x', 'r', 'unused']) writeFileSync(join(root, 'static', 'img', `${name}.png`), PNG)
    const bundle = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/docs', platform: 'docusaurus' })
    expect(bundle.assets.map((entry) => entry.path)).toContain(asset)
    expect(bundle.assets.map((entry) => entry.path)).not.toContain('img/unused.png')
  })
})


describe('decorated source heading anchors', () => {
  it('matches visible JSX and Markdown text without consuming attributes or code examples', () => {
    const root = docusaurusSite({
      'docs/guide.mdx': '# Guide\n\n[Select](./target.mdx#Selecting-Elements)\n[Type](./target.mdx#url-String-Glob-RegExp)\n[Env](./target.mdx#2-cypressenvjson)\n[Response](./target.mdx#staticResponse-StaticResponse)\n',
      'docs/target.mdx': '# Target\n\n## <Icon name="angle-right" title="ignored > text" /> **Selecting** Elements\n\n### url (`String`, `Glob`, `RegExp`)\n\n### 2. `cypress.env.json`\n\n#### <Icon /> staticResponse (<code>[StaticResponse][staticresponse]</code>)\n\n[staticresponse]: #response\n\n```mdx\n## <Icon /> Selecting Elements\n```\n',
    })
    const bundle = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/docs', platform: 'docusaurus' })
    const target = bundle.pages.find((page) => page.id === 'target')!
    expect(target.body).toContain('<a id="Selecting-Elements"></a>')
    expect(target.body).toContain('<a id="url-String-Glob-RegExp"></a>')
    expect(target.body).toContain('<a id="2-cypressenvjson"></a>')
    expect(target.body).toContain('<a id="staticResponse-StaticResponse"></a>')
    expect(target.body.match(/id="Selecting-Elements"/g)).toHaveLength(1)
  })
})


describe('Docusaurus preset comments', () => {
  it('keeps root-mounted navbar links local despite apostrophes and brackets in comments', () => {
    const root = docusaurusSite({
      'docusaurus.config.js': `module.exports = { url: 'https://docs.example.com', presets: [['classic', { docs: { routeBasePath: '/',
        // Docusaurus's defaults [must] remain excluded.
        exclude: ['**/AGENTS.md'], /* closing ] belongs to this comment */
      } }]], themeConfig: { navbar: { items: [{ label: 'Guide', to: '/guide' }] } } }`,
      'docs/guide.mdx': '# Guide\n\nBody.',
    })
    expect(readDocusaurusSiteSettings(root).docsRouteBasePath).toBe('/')
    const bundle = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/docs', platform: 'docusaurus' })
    expect(bundle.docsConfig.navbar?.links).toContainEqual({ label: 'Guide', href: '/guide' })
  })
})


describe('Fern group expansion', () => {
  it('retains authored expansion defaults', () => {
    const bundle = fernSite('navigation:\n  - section: Guide\n    contents:\n      - section: Examples\n        collapsed: open-by-default\n        contents:\n          - page: Example\n            path: example.mdx\n', { 'example.mdx': '# Example\n\nBody.' })
    expect(JSON.stringify(bundle.docsConfig)).toContain('"defaultOpen":true')
  })
})


describe('Docusaurus native presentation', () => {
  it('maps compiled Sass variables, heading font, Prism tokens and announcement into local assets', () => {
    const root = docusaurusSite({
      'docusaurus.config.js': `module.exports = { presets: [['classic', { theme: { customCss: './src/css/custom.scss' } }]], themeConfig: { announcementBar: { id: 'launch', content: 'See <a href="https://example.com/news">news</a>', isCloseable: false }, prism: { theme: require('./src/theme/prism') } } }`,
      'src/css/custom.scss': ':root { --ifm-link-color: theme(colors.blue.500); }',
      'build/assets/css/styles.test.css': ':root { --ifm-color-primary: #69d3a7; --ifm-color-white: #fff; } html[data-theme=light] { --ifm-background-color: var(--ifm-color-white); --ifm-font-color-base: #434861; --ifm-link-color: #4956e3; --ifm-heading-font-family: Poppins; } [data-theme="dark"] { --ifm-background-color: #1b1e2e; --ifm-font-color-base: #f3f4fa; } .theme-announcement-bar { background-color: rgb(238 242 255); color: var(--ifm-font-color-base); font-size: 1rem; padding: 0.65rem 0; }',
      'src/theme/prism/index.js': `module.exports = { plain: { color: '#c3cee3', backgroundColor: '#282a36' }, styles: [{ types: ['keyword'], style: { color: '#c792ea' } }] }`,
      'docs/guide.mdx': '# Guide\n\nBody.',
    })
    const bundle = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/docs', platform: 'docusaurus' })
    expect(bundle.docsConfig.fonts?.heading?.family).toBe('Poppins')
    expect(bundle.site?.colors?.dark).toBe('#69d3a7')
    expect(bundle.docsConfig.stylesheets).toContain('/_thally/source-theme.css')
    expect(bundle.docsConfig.banner).toMatchObject({ id: 'launch', dismissible: false, content: 'See [news](https://example.com/news)' })
    const css = Buffer.from(bundle.assets.find((asset) => asset.path === '_thally/source-theme.css')!.content).toString()
    expect(css).toContain('--docs-bg:#ffffff')
    expect(css).toContain('--docs-accent:#4956e3')
    expect(css).toContain('--shiki-token-keyword:#c792ea')
    expect(css).toContain('.thally-ink-banner{background-color:#eef2ff;color:#434861;font-size:1rem;padding:0.65rem 0}')
    expect(css).not.toContain('theme(colors')
  })
})


describe('Fern remote global theme fallback', () => {
  it('continues with static fallback tokens and warns without fetching remote assets', () => {
    const bundle = fernSite('global-theme: nvidia\nlogo:\n  right-text: Guardrails\nnavigation:\n  - page: Guide\n    path: guide.mdx\n', { 'guide.mdx': '# Guide\n\nBody.' })
    expect(bundle.pages).toHaveLength(1)
    expect(bundle.site?.colors?.primary).toBe('#76B900')
    expect(bundle.warnings).toContainEqual(expect.objectContaining({ code: 'unsupported-config', message: expect.stringMatching(/global theme.*could not be fetched.*default styling tokens/i) }))
    expect(bundle.assets.every((asset) => !asset.path.startsWith('https:'))).toBe(true)
  })
  it('keeps authored colors above the static fallback', () => {
    const bundle = fernSite('global-theme: nvidia\ncolors:\n  accent-primary: "#112233"\nnavigation:\n  - page: Guide\n    path: guide.mdx\n', { 'guide.mdx': '# Guide\n\nBody.' })
    expect(bundle.site?.colors?.primary).toBe('#112233')
  })
})
