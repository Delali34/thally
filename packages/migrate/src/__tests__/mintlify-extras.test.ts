/** Access gating, site-wide CSS/JS/font assets, and legacy config mapping for Mintlify sources. */

import { chmodSync, existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'
import { parse as parseYaml } from 'yaml'

import { migrateRepository, renderMigrationFiles } from '../index.js'
import type { MigrationBundle } from '../index.js'
import { hydrateRemoteApiSpecs } from '../remote-api.js'
import type { MigrationFetcher } from '../types.js'

function site(files: Record<string, string | Buffer>, extra: { maxSourceFiles?: number } = {}): MigrationBundle {
  const root = mkdtempSync(join(tmpdir(), 'thally-migrate-extras-'))
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, name)), { recursive: true })
    writeFileSync(join(root, name), content)
  }
  return migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/docs', platform: 'mintlify', ...extra })
}

const page = (title: string, extra = ''): string => `---\ntitle: ${title}\n${extra}---\n\nBody of ${title}.\n`
const codes = (bundle: MigrationBundle, code: string) => bundle.warnings.filter((warning) => warning.code === code)
function navPages(bundle: MigrationBundle): Array<string> {
  const out: Array<string> = []
  const visit = (nodes: Array<unknown> = []): void => {
    for (const node of nodes) {
      if (typeof node === 'string') out.push(node)
      else visit((node as { pages: Array<unknown> }).pages)
    }
  }
  for (const tab of bundle.docsConfig.tabs) { visit(tab.pages); visit(tab.groups) }
  return out
}
describe('gated pages', () => {
  const base = {
    'docs.json': JSON.stringify({ navigation: { groups: [
      { group: 'Public', pages: ['intro', 'secret-list', 'secret-string', 'hidden-false', 'string-false'] },
      { group: 'Outer', pages: [{ group: 'Inner', pages: ['only-secret'] }, 'open'] },
    ] } }),
    'intro.mdx': page('Intro'),
    'secret-list.mdx': page('Secret list', 'groups: [admin, staff]\n'),
    'secret-string.mdx': page('Secret string', 'groups: admin\n'),
    'hidden-false.mdx': page('Hidden false', 'public: false\n'),
    'string-false.mdx': page('String false', 'public: "false"\n'),
    'only-secret.mdx': page('Only secret', 'groups: [x]\n'),
    'open.mdx': page('Open'),
  }

  it('migrates restricted pages with normalized access frontmatter and keeps them in navigation', () => {
    const bundle = site(base)
    expect(bundle.pages.map((entry) => entry.id).sort()).toEqual(['hidden-false', 'intro', 'only-secret', 'open', 'secret-list', 'secret-string', 'string-false'])
    expect(navPages(bundle).sort()).toEqual(['hidden-false', 'intro', 'only-secret', 'open', 'secret-list', 'secret-string', 'string-false'])
    expect(bundle.quarantinedFiles).toBeUndefined()
    const byId = (id: string) => bundle.pages.find((entry) => entry.id === id)!
    expect(byId('secret-list').groups).toEqual(['admin', 'staff'])
    expect(byId('secret-string').groups).toEqual(['admin'])
    expect(byId('hidden-false').public).toBe(false)
    expect(byId('string-false').public).toBe(false)
    expect(byId('intro').groups).toBeUndefined()
    expect(byId('intro').public).toBeUndefined()
    const rendered = renderMigrationFiles(bundle)
    const secret = rendered.find((file) => file.path === 'src/content/secret-list.mdx')!
    const frontmatter = parseYaml(String(secret.content).split('---')[1]) as Record<string, unknown>
    expect(frontmatter.groups).toEqual(['admin', 'staff'])
    expect(parseYaml(String(rendered.find((file) => file.path === 'src/content/string-false.mdx')!.content).split('---')[1])).toMatchObject({ public: false })
  })

  it('emits one summary warning that restricted pages stay hidden until reader auth is configured', () => {
    const bundle = site(base)
    const warnings = codes(bundle, 'gated-page')
    expect(warnings.filter((warning) => warning.source)).toHaveLength(0)
    const summary = warnings.filter((warning) => /5 page\(s\) are restricted/.test(warning.message))
    expect(summary).toHaveLength(1)
    expect(summary[0].message).toMatch(/docs\.json `auth`.*authenticated-docs/s)
  })

  it('treats empty or missing groups and public: true as non-gating', () => {
    const bundle = site({
      'docs.json': JSON.stringify({ navigation: { pages: ['a', 'b', 'c', 'd'] } }),
      'a.mdx': page('A', 'groups: []\n'),
      'b.mdx': page('B', 'groups: ""\n'),
      'c.mdx': page('C', 'public: true\n'),
      'd.mdx': page('D'),
    })
    expect(bundle.pages).toHaveLength(4)
    expect(bundle.quarantinedFiles).toBeUndefined()
    expect(bundle.docsConfig.tabs.length).toBeGreaterThan(0)
  })

  it('pushes navigation container rules down into page frontmatter', () => {
    const bundle = site({
      'docs.json': JSON.stringify({ navigation: { tabs: [
        { tab: 'Docs', groups: [
          { group: 'Members', groups: ['member'], pages: ['m1', 'm2'] },
          { group: 'Off', public: false, pages: ['off1'] },
          { group: 'Open', public: true, pages: ['open', 'own-groups'] },
        ] },
        { tab: 'Staff', groups: ['staff'], pages: ['s1'] },
      ] } }),
      'm1.mdx': page('M1'), 'm2.mdx': page('M2'), 'off1.mdx': page('Off1'), 'open.mdx': page('Open'), 's1.mdx': page('S1'),
      'own-groups.mdx': page('Own', 'groups: [beta]\n'),
    })
    const byId = (id: string) => bundle.pages.find((entry) => entry.id === id)!
    expect(bundle.pages.map((entry) => entry.id).sort()).toEqual(['m1', 'm2', 'off1', 'open', 'own-groups', 's1'])
    expect(navPages(bundle).sort()).toEqual(['m1', 'm2', 'off1', 'open', 'own-groups', 's1'])
    expect(bundle.docsConfig.tabs.map((tab) => tab.tab)).toEqual(['Docs', 'Staff'])
    expect(byId('m1').groups).toEqual(['member'])
    expect(byId('off1').public).toBe(false)
    expect(byId('s1').groups).toEqual(['staff'])
    // Mintlify's group-level `public: true` opens pages that name no groups of their own.
    expect(byId('open').public).toBe(true)
    expect(byId('own-groups').groups).toEqual(['beta'])
    expect(byId('own-groups').public).toBeUndefined()
    expect(bundle.quarantinedFiles).toBeUndefined()
  })

  it('intersects page and container groups and quarantines when they share none', () => {
    const bundle = site({
      'docs.json': JSON.stringify({ navigation: { groups: [
        { group: 'Team', groups: ['beta', 'staff'], pages: ['shared', 'disjoint'] },
        { group: 'Outer', groups: ['a', 'b'], pages: [{ group: 'Inner', groups: ['b', 'c'], pages: ['nested'] }] },
      ] } }),
      'shared.mdx': page('Shared', 'groups: [staff, other]\n'),
      'disjoint.mdx': page('Disjoint', 'groups: [other]\n'),
      'nested.mdx': page('Nested'),
    })
    expect(bundle.pages.find((entry) => entry.id === 'shared')!.groups).toEqual(['staff'])
    expect(bundle.pages.find((entry) => entry.id === 'nested')!.groups).toEqual(['b'])
    expect(bundle.pages.some((entry) => entry.id === 'disjoint')).toBe(false)
    expect((bundle.quarantinedFiles ?? []).map((file) => file.path)).toEqual(['migration-quarantine/disjoint.mdx'])
    expect(codes(bundle, 'gated-page').find((warning) => warning.source === 'disjoint.mdx')!.message).toMatch(/share no group.*NOT published/s)
  })

  it('quarantines a page whose access values are malformed', () => {
    const bundle = site({
      'docs.json': JSON.stringify({ navigation: { pages: ['guides/a', 'guides/b', 'guides/c'] } }),
      'guides/a.mdx': page('A', 'public: maybe\n'),
      'guides/b.mdx': page('B'),
      'guides/c.mdx': page('C', 'groups: [1, 2]\n'),
    })
    expect(bundle.quarantinedFiles!.map((file) => file.path).sort()).toEqual(['migration-quarantine/guides/a.mdx', 'migration-quarantine/guides/c.mdx'])
    expect(bundle.pages.map((entry) => entry.body.trim())).toEqual(['Body of B.'])
  })

  it('warns once when public: true implies a site that may have been private', () => {
    const bundle = site({
      'docs.json': JSON.stringify({ navigation: { pages: ['a', 'b'] } }),
      'a.mdx': page('A', 'public: true\n'),
      'b.mdx': page('B', 'public: true\n'),
    })
    const siteWide = codes(bundle, 'gated-page')
    expect(siteWide).toHaveLength(1)
    expect(siteWide[0].message).toMatch(/authentication.*until docs\.json `auth` is configured/s)
    expect(bundle.pages).toHaveLength(2)
    expect(codes(site({ 'docs.json': '{"navigation":{"pages":["a"]}}', 'a.mdx': page('A') }), 'gated-page').every((warning) => !/public: true/.test(warning.message))).toBe(true)
  })
})

describe('site-wide scripts, styles and fonts', () => {
  const files = {
    'docs.json': JSON.stringify({
      navigation: { pages: ['intro'] },
      fonts: { heading: { family: 'Mine', source: '/fonts/mine.woff2', format: 'woff2' }, body: { family: 'Remote', source: 'https://cdn.example/r.woff2', format: 'woff2' } },
    }),
    'intro.mdx': page('Intro'),
    'style.css': 'body{}',
    'assets/custom.js': 'console.log(1)',
    'fonts/mine.woff2': 'font',
    'fonts/unused.woff2': 'font',
    'tailwind.config.js': 'module.exports={}',
    'scripts/postcss.config.js': 'x',
    'next.config.js': 'x',
    '.eslintrc.js': 'x',
    'dist/bundle.js': 'x',
    'node_modules/pkg/index.js': 'x',
    '.hidden/x.js': 'x',
  }

  it('copies css, js and referenced fonts only, and wires scripts', () => {
    const bundle = site(files)
    const paths = bundle.assets.map((asset) => asset.path).sort()
    expect(paths).toEqual(['assets/custom.js', 'fonts/mine.woff2'])
    expect(bundle.docsConfig.customScripts).toEqual([{ src: '/assets/custom.js', strategy: 'afterInteractive' }])
  })

  it('warns about shell CSS, fonts, and copied scripts', () => {
    const bundle = site(files)
    const messages = bundle.warnings.map((warning) => warning.message)
    expect(messages.some((message) => /Skipped 1 stylesheet selector/.test(message))).toBe(true)
    expect(messages.some((message) => /"Mine".*copied to public\/fonts\/mine\.woff2/.test(message))).toBe(true)
    expect(messages.some((message) => /"Remote".*remote URL and was not downloaded/.test(message))).toBe(true)
    expect(messages.some((message) => /customScripts/.test(message))).toBe(true)
  })

  it('rejects font paths that traverse, are absolute, or are missing', () => {
    const bundle = site({
      'docs.json': JSON.stringify({ navigation: { pages: ['intro'] }, fonts: { heading: { family: 'A', source: '../../etc/x.woff2' }, body: { family: 'B', source: '/etc/passwd.woff2' } }, }),
      'intro.mdx': page('Intro'),
    })
    expect(bundle.assets).toEqual([])
    const messages = bundle.warnings.map((warning) => warning.message)
    expect(messages.some((message) => /"A".*not a safe local/.test(message))).toBe(true)
    expect(messages.some((message) => /"B".*was not found/.test(message))).toBe(true)
  })

  // docs.json of dub.co: a variable font the site hosts itself. Thally's `fonts` setting loads Google Fonts by family, so naming
  // "Satoshi" makes every page request fonts.googleapis.com/css2?family=Satoshi, which answers 400.
  const dubFonts = { heading: { family: 'Satoshi', source: '/fonts/Satoshi-Variable.woff2', format: 'woff2', weight: 700 } }

  it('does not name the family of a self-hosted font, keeps its file, and says what to do instead', () => {
    const bundle = site({
      'docs.json': JSON.stringify({ navigation: { pages: ['intro'] }, fonts: { ...dubFonts, body: { family: 'Inter' } } }),
      'intro.mdx': page('Intro'),
      'fonts/Satoshi-Variable.woff2': 'font',
    })
    expect(bundle.docsConfig.fonts).toEqual({ body: { family: 'Inter' } })
    expect(bundle.assets.map((asset) => asset.path)).toEqual(['fonts/Satoshi-Variable.woff2'])
    const warnings = bundle.warnings.map((warning) => warning.message).filter((message) => message.includes('Self-hosted font'))
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('"Satoshi" was not applied')
    expect(warnings[0]).toContain('its file was copied to public/fonts/Satoshi-Variable.woff2')
    for (const instruction of ['@font-face', '"stylesheets"', '--font-heading', '--font-sans']) expect(warnings[0]).toContain(instruction)
    expect(warnings[0]).not.toContain('Inter')
    expect(warnings[0]).not.toContain('still mapped')
    const docsJson = JSON.parse(String(renderMigrationFiles(bundle).find((file) => file.path === 'docs.json')?.content))
    expect(docsJson.fonts).toEqual({ body: { family: 'Inter' } })
  })

  it('names no family for a self-hosted font written at the top level, or hosted at another address', () => {
    for (const fonts of [
      { family: 'Mine', source: '/fonts/mine.woff2', format: 'woff2' },
      { body: { family: 'Remote', source: 'https://cdn.example/r.woff2', format: 'woff2' } },
      { heading: { family: 'Missing', source: '/fonts/missing.woff2', format: 'woff2' } },
    ]) {
      const bundle = site({ 'docs.json': JSON.stringify({ navigation: { pages: ['intro'] }, fonts }), 'intro.mdx': page('Intro'), 'fonts/mine.woff2': 'font' })
      expect(bundle.docsConfig.fonts, JSON.stringify(fonts)).toBeUndefined()
      expect(bundle.warnings.filter((warning) => warning.message.includes('Self-hosted font'))).toHaveLength(1)
    }
  })

  it('keeps the family of a font whose source is Google Fonts itself, and says nothing about it', () => {
    const bundle = site({
      'docs.json': JSON.stringify({ navigation: { pages: ['intro'] }, fonts: { body: { family: 'Inter', source: 'https://fonts.gstatic.com/s/inter/v13/x.woff2', format: 'woff2' } } }),
      'intro.mdx': page('Intro'),
    })
    expect(bundle.docsConfig.fonts).toEqual({ body: { family: 'Inter' } })
    expect(bundle.warnings.some((warning) => warning.message.includes('font'))).toBe(false)
  })

  it('applies the asset size cap to scripts', () => {
    const bundle = site({
      'docs.json': JSON.stringify({ navigation: { pages: ['intro'] } }),
      'intro.mdx': page('Intro'),
      'huge.js': Buffer.alloc(25_000_001),
    })
    expect(bundle.assets).toEqual([])
    expect(bundle.docsConfig.customScripts).toBeUndefined()
    expect(bundle.warnings.some((warning) => warning.code === 'limit-reached' && /1 asset file was not copied/.test(warning.message))).toBe(true)
  })
})

describe('config mapping', () => {
  const nav = { navigation: { pages: ['intro'] } }
  const intro = { 'intro.mdx': page('Intro') }

  it('maps legacy topbarLinks and topbarCtaButton', () => {
    const bundle = site({ 'mint.json': JSON.stringify({ ...nav, topbarLinks: [{ name: 'Blog', url: 'https://blog.example' }, { name: 'bad' }], topbarCtaButton: { name: 'Start', url: 'https://app.example' } }), ...intro })
    expect(bundle.docsConfig.navbar).toEqual({ links: [{ label: 'Blog', href: 'https://blog.example' }], primary: { label: 'Start', href: 'https://app.example' } })
    expect(bundle.warnings.some((warning) => /topbarLinks entry without a valid name and url/.test(warning.message))).toBe(true)
  })

  it('turns a styled navbar link into a button and keeps styles for markup a site script builds', () => {
    const bundle = site({
      'docs.json': JSON.stringify({ ...nav, navbar: { links: [{ label: 'Docs', href: 'https://a.example/docs' }, { label: 'Sign Up', href: 'https://a.example/signin?x=1' }] } }),
      'style.css': 'li.navbar-link a[href*="a.example/signin"] { background-color: #ff4d00; color: #fff; }\n#cta-widget { margin-top: 24px; }\n.cta-box { padding: 20px; }\n',
      'cta.js': "const w = document.createElement('div'); w.id = 'cta-widget'; w.innerHTML = '<div class=\"cta-box\"></div>'\n",
      ...intro,
    })
    expect(bundle.docsConfig.navbar?.links).toEqual([
      { label: 'Docs', href: 'https://a.example/docs' },
      { label: 'Sign Up', href: 'https://a.example/signin?x=1', button: { background: '#ff4d00', color: '#fff' } },
    ])
    const css = bundle.assets.filter((asset) => /style\.css$/.test(asset.path)).map((asset) => String(asset.content)).join('')
    expect(css).toContain('#cta-widget')
    expect(css).toContain('.cta-box')
    expect(css).not.toContain('navbar-link')
  })

  it('keeps the contextual menu options Thally supports, in order, and warns about the rest', () => {
    const bundle = site({ 'docs.json': JSON.stringify({ ...nav, contextual: { options: ['copy', 'view', 'chatgpt', 'cursor', 'claude'] } }), ...intro })
    expect(bundle.docsConfig.contextual).toEqual({ options: ['copy', 'view', 'chatgpt', 'claude'] })
    expect(bundle.warnings.some((warning) => /contextual\.options.*cursor/.test(warning.message))).toBe(true)
  })

  it('labels languages with their native names like the Mintlify picker', () => {
    const lang = (language: string) => ({ language, pages: ['intro'] })
    const bundle = site({ 'docs.json': JSON.stringify({ navigation: { languages: [lang('en'), lang('es'), lang('ja'), lang('zh'), lang('pt-BR')] } }), ...intro })
    expect(bundle.docsConfig.i18n?.locales.map((locale) => locale.label)).toEqual(['English', 'Español', '日本語', '简体中文', 'Português (BR)'])
  })

  it('carries seo.metatags through as page meta tags', () => {
    const bundle = site({ 'docs.json': JSON.stringify({ ...nav, seo: { metatags: { 'google-site-verification': 'abc123', 'bad name': 'x', count: 5 } } }), ...intro })
    expect(bundle.docsConfig.seo?.metatags).toEqual({ 'google-site-verification': 'abc123' })
  })

  it('maps the rounded Aspen theme to Maple and keeps Sharp for the square ones', () => {
    const theme = (name: string) => site({ 'docs.json': JSON.stringify({ ...nav, theme: name }), ...intro }).docsConfig.theme
    expect([theme('aspen'), theme('maple'), theme('luma')]).toEqual(['maple', 'maple', 'sharp'])
  })

  it('redirects / to the introduction page like Mintlify does', () => {
    const bundle = site({ 'docs.json': JSON.stringify({ navigation: { pages: ['introduction', 'guide'] } }), 'introduction.mdx': page('Intro'), 'guide.mdx': page('Guide') })
    expect(bundle.docsConfig.redirects).toContainEqual({ source: '/', destination: '/introduction', permanent: true })
  })

  it('maps Mintlify colors to per-mode brand colors with six-digit hex', () => {
    const bundle = site({ 'docs.json': JSON.stringify({ ...nav, colors: { primary: '#F60', light: '#fff', dark: '#000000' } }), ...intro })
    expect(bundle.docsConfig.colors).toEqual({
      light: { accent: '#ff6600', primary: '#000000' },
      dark: { accent: '#ffffff', primary: '#ffffff' },
    })
    expect(site({ 'docs.json': JSON.stringify({ ...nav, colors: { primary: 'red' } }), ...intro }).docsConfig.colors).toBeUndefined()
  })

  describe('brand logo, favicon and background', () => {
    const png = Buffer.from('PNGDATA')
    const brandWarning = (bundle: MigrationBundle) => bundle.warnings.filter((warning) => /Brand asset/.test(warning.message))

    it('uses a dark-only imported logo for both modes and says so', () => {
      const bundle = site({
        'docs.json': JSON.stringify({ ...nav, logo: { light: '/logo/light.png', dark: '/logo/dark.png' } }),
        'logo/dark.png': png,
        ...intro,
      })
      expect(bundle.docsConfig.navbar?.logo).toEqual({ light: '/logo/dark.png', dark: '/logo/dark.png', showTitle: false })
      const [warning] = brandWarning(bundle)
      expect(warning.code).toBe('unsupported-config')
      expect(warning.message).toContain('/logo/light.png')
      expect(warning.message).not.toContain('/logo/dark.png.')
      expect(warning.message).toMatch(/imported logo \(\/logo\/dark\.png\) is used for both light and dark mode/)
    })

    it('keeps a light-only imported logo for both modes and names the missing dark file', () => {
      const bundle = site({
        'docs.json': JSON.stringify({ ...nav, logo: { light: '/logo/light.png', dark: '/logo/dark.png' } }),
        'logo/light.png': png,
        ...intro,
      })
      expect(bundle.docsConfig.navbar?.logo).toEqual({ light: '/logo/light.png', showTitle: false })
      expect(brandWarning(bundle)[0].message).toMatch(/not imported: \/logo\/dark\.png\..*imported logo \(\/logo\/light\.png\) is used for both/)
    })

    it('leaves a logo with both variants imported unchanged and silent', () => {
      const bundle = site({
        'docs.json': JSON.stringify({ ...nav, logo: { light: '/logo/light.png', dark: '/logo/dark.png' } }),
        'logo/light.png': png,
        'logo/dark.png': png,
        ...intro,
      })
      expect(bundle.docsConfig.navbar?.logo).toEqual({ light: '/logo/light.png', dark: '/logo/dark.png', showTitle: false })
      expect(brandWarning(bundle)).toEqual([])
    })

    it('never points the logo at a file that was not imported', () => {
      const bundle = site({
        'docs.json': JSON.stringify({ ...nav, logo: { light: '/logo/light.png', dark: '/logo/dark.png' } }),
        ...intro,
      })
      expect(bundle.docsConfig.navbar?.logo).toBeUndefined()
      expect(brandWarning(bundle)[0].message).not.toContain('used for both')
    })

    it('uses a dark-only logo from a legacy mint.json', () => {
      const bundle = site({
        'mint.json': JSON.stringify({ ...nav, logo: { light: '/logo/light.png', dark: '/logo/dark.png' } }),
        'logo/dark.png': png,
        ...intro,
      })
      expect(bundle.docsConfig.navbar?.logo).toMatchObject({ light: '/logo/dark.png', dark: '/logo/dark.png' })
    })

    it('uses a single imported favicon variant for both modes', () => {
      const bundle = site({
        'docs.json': JSON.stringify({ ...nav, favicon: { light: '/icons/light.png', dark: '/icons/dark.png' } }),
        'icons/dark.png': png,
        ...intro,
      })
      expect(bundle.docsConfig.favicon).toEqual({ light: '/icons/dark.png', dark: '/icons/dark.png' })
      expect(brandWarning(bundle)[0].message).toMatch(/imported favicon \(\/icons\/dark\.png\) is used for both/)
    })

    it('warns that logo.href is dropped because the header logo always links home', () => {
      const withHref = (href: string) => site({
        'docs.json': JSON.stringify({ ...nav, logo: { light: '/logo/light.png', href } }),
        'logo/light.png': png,
        ...intro,
      })
      const warning = withHref('https://trigger.dev').warnings.find((entry) => /logo\.href/.test(entry.message))
      expect(warning?.code).toBe('unsupported-config')
      expect(warning?.message).toContain('https://trigger.dev')
      expect(warning?.message).toMatch(/navbar link/)
      expect(withHref('/').warnings.some((entry) => /logo\.href/.test(entry.message))).toBe(false)
    })

    it('maps background.color to per-mode canvas colours, expanding three-digit hex', () => {
      const bundle = site({
        'docs.json': JSON.stringify({ ...nav, background: { color: { light: '#fff', dark: '#121317' } } }),
        ...intro,
      })
      expect(bundle.docsConfig.colors).toEqual({ light: { background: '#ffffff' }, dark: { background: '#121317' } })
      expect(bundle.docsConfig.background).toBeUndefined()
      expect(bundle.warnings.filter((warning) => /background/.test(warning.message))).toEqual([])
    })

    it('merges background colours into the brand colours instead of replacing them', () => {
      const bundle = site({
        'docs.json': JSON.stringify({ ...nav, colors: { primary: '#F60' }, background: { color: { dark: '#121317' } } }),
        ...intro,
      })
      expect(bundle.docsConfig.colors).toEqual({
        light: { accent: '#ff6600', primary: '#ff6600' },
        dark: { accent: '#ff6600', primary: '#ff6600', background: '#121317' },
      })
    })

    it('keeps the valid background colour and warns about the invalid one', () => {
      const bundle = site({
        'docs.json': JSON.stringify({ ...nav, background: { color: { light: 'hotpink', dark: '#121317' } } }),
        ...intro,
      })
      expect(bundle.docsConfig.colors).toEqual({ dark: { background: '#121317' } })
      const warning = bundle.warnings.find((entry) => /background\.color\.light/.test(entry.message))
      expect(warning?.code).toBe('unsupported-config')
      expect(warning?.message).toContain('hotpink')
    })

    it('does not emit an empty background object', () => {
      for (const background of [{}, { color: {} }, { color: { light: 'nope' } }, { decoration: 'sparkles' }]) {
        const bundle = site({ 'docs.json': JSON.stringify({ ...nav, background }), ...intro })
        expect(bundle.docsConfig.background).toBeUndefined()
        expect(bundle.docsConfig.colors).toBeUndefined()
      }
      expect(site({ 'docs.json': JSON.stringify({ ...nav, background: { decoration: 'grid' } }), ...intro }).docsConfig.background).toEqual({ decoration: 'grid' })
    })
  })

  it('hides the breadcrumb trail because Mintlify pages show only a group eyebrow', () => {
    expect(site({ 'docs.json': JSON.stringify(nav), ...intro }).docsConfig.breadcrumbs).toBe(false)
  })

  it('turns on smart quotes in the generated docs.json because Mintlify typesets prose quotes', () => {
    const bundle = site({ 'docs.json': JSON.stringify(nav), ...intro })
    expect(bundle.docsConfig.smartQuotes).toBe(true)
    const docs = renderMigrationFiles(bundle).find((file) => file.path === 'docs.json')
    expect(JSON.parse(String(docs?.content)).smartQuotes).toBe(true)
  })

  it('takes brand colours from the stylesheet custom properties over docs.json', () => {
    const colors = { primary: '#16a34a', light: '#ffffff', dark: '#111111' }
    const withCss = (css: string) => site({ 'docs.json': JSON.stringify({ ...nav, colors }), 'style.css': css, ...intro })
    const bundle = withCss('.dark{--primary:200 255 0;--primary-light:200 255 0;--primary-dark:200 255 0}')
    expect(bundle.docsConfig.colors).toEqual({
      light: { accent: '#16a34a', primary: '#111111' },
      dark: { accent: '#c8ff00', primary: '#c8ff00' },
    })
    expect(bundle.warnings.some((warning) => /Brand colours were taken from the --primary custom properties/.test(warning.message))).toBe(true)
    expect(withCss(':root{--primary:#0af}html.dark{--primary:rgb(1, 2, 3)}').docsConfig.colors).toEqual({
      light: { accent: '#00aaff', primary: '#00aaff' },
      dark: { accent: '#010203', primary: '#010203' },
    })
    expect(withCss('p{color:red}').docsConfig.colors).toEqual({ light: { accent: '#16a34a', primary: '#111111' }, dark: { accent: '#ffffff', primary: '#ffffff' } })
  })

  it('takes brand colours from a stylesheet that also holds an @import, and from other served .css files', () => {
    const css = "@import url('https://fonts.googleapis.com/css2?family=Geist+Mono');\n.dark,\n[data-theme=\"dark\"],\nhtml.dark {\n  --primary: 200 255 0;\n  --primary-dark: 200 255 0;\n}"
    const colors = { primary: '#7624f4' }
    expect(site({ 'docs.json': JSON.stringify({ ...nav, colors }), 'style.css': css, ...intro }).docsConfig.colors?.dark).toEqual({ accent: '#c8ff00', primary: '#c8ff00' })
    expect(site({ 'docs.json': JSON.stringify({ ...nav, colors }), 'theme/extra.css': '.dark{--primary:1 2 3}', ...intro }).docsConfig.colors?.dark).toEqual({ accent: '#010203', primary: '#010203' })
  })

  it('merges stylesheet colours per variable and names every file they came from', () => {
    const bundle = site({
      'docs.json': JSON.stringify(nav),
      'style.css': ':root{--primary:#111111;--primary-dark:#222222}',
      'theme/extra.css': ':root{--primary:#333333}',
      ...intro,
    })
    expect(bundle.docsConfig.colors?.light).toEqual({ accent: '#333333', primary: '#222222' })
    expect(bundle.warnings.find((warning) => /Brand colours were taken from/.test(warning.message))?.source).toBe('style.css, theme/extra.css')
    const only = site({ 'docs.json': JSON.stringify(nav), 'theme/extra.css': ':root{--primary:#333333}', ...intro })
    expect(only.warnings.find((warning) => /Brand colours were taken from/.test(warning.message))?.source).toBe('theme/extra.css')
  })

  it('ignores malformed and at-rule-scoped stylesheet colours', () => {
    const colorsOf = (css: string) => site({ 'docs.json': JSON.stringify(nav), 'style.css': css, ...intro }).docsConfig.colors
    expect(colorsOf('.dark{--primary:300 255 0;--primary-light:nope}')).toBeUndefined()
    expect(colorsOf('@media (min-width:1px){.dark{--primary:1 2 3}}.x .dark{--primary:1 2 3}')).toBeUndefined()
  })

  it('rejects script-bearing and control-character urls in legacy topbar entries', () => {
    const bundle = site({ 'mint.json': JSON.stringify({ ...nav,
      topbarLinks: [{ name: 'X', url: 'javascript:alert(1)' }, { name: 'Y', url: ' JaVaScRiPt:alert(1)' }, { name: 'Z', url: 'java\tscript:alert(1)' }, { name: 'D', url: 'data:text/html,x' }, { name: 'Ok', url: '/relative' }],
      topbarCtaButton: { name: 'Go', url: 'javascript:alert(1)' } }), ...intro })
    expect(bundle.docsConfig.navbar).toEqual({ links: [{ label: 'Ok', href: '/relative' }] })
    expect(bundle.warnings.some((warning) => /topbarCtaButton has no valid url/.test(warning.message))).toBe(true)
  })

  it('maps a github topbarCtaButton like the docs.json github primary', () => {
    const legacy = site({ 'mint.json': JSON.stringify({ ...nav, topbarCtaButton: { type: 'github', url: 'https://github.com/a/b' } }), ...intro })
    const current = site({ 'docs.json': JSON.stringify({ ...nav, navbar: { primary: { type: 'github', href: 'https://github.com/a/b' } } }), ...intro })
    expect(legacy.docsConfig.navbar).toEqual({ primary: { label: 'GitHub', href: 'https://github.com/a/b', type: 'github' } })
    expect(legacy.docsConfig.navbar).toEqual(current.docsConfig.navbar)
  })

  it('lets docs.json navbar win over legacy keys and warns', () => {
    const bundle = site({
      'docs.json': JSON.stringify({ ...nav, navbar: { links: [{ label: 'Docs', href: 'https://d.example' }], primary: { type: 'button', label: 'Go', href: 'https://go.example' } }, topbarLinks: [{ name: 'Old', url: 'https://old.example' }], topbarCtaButton: { name: 'Old', url: 'https://old.example' } }),
      ...intro,
    })
    expect(bundle.docsConfig.navbar).toEqual({ links: [{ label: 'Docs', href: 'https://d.example' }], primary: { label: 'Go', href: 'https://go.example' } })
    expect(bundle.warnings.filter((warning) => /topbarLinks ignored|topbarCtaButton ignored/.test(warning.message))).toHaveLength(2)
  })

  it('leaves the docs.json navbar mapping unchanged (regression)', () => {
    const bundle = site({ 'docs.json': JSON.stringify({ ...nav, navbar: { links: [{ label: 'Gh', href: 'https://github.com/a/b', type: 'github' }], primary: { type: 'button', label: 'Go', href: 'https://go.example' } } }), ...intro })
    expect(bundle.docsConfig.navbar).toEqual({ links: [{ label: 'Gh', href: 'https://github.com/a/b', type: 'github' }], primary: { label: 'Go', href: 'https://go.example' } })
  })

  it('maps appearance default and strict', () => {
    const bundle = site({ 'docs.json': JSON.stringify({ ...nav, appearance: { default: 'dark', strict: true } }), ...intro })
    expect(bundle.docsConfig.appearance).toEqual({ default: 'dark', showToggle: false })
    const open = site({ 'docs.json': JSON.stringify({ ...nav, appearance: { default: 'system', strict: false } }), ...intro })
    expect(open.docsConfig.appearance).toEqual({ default: 'system' })
  })

  it('maps legacy modeToggle and prefers docs.json appearance', () => {
    const legacy = site({ 'mint.json': JSON.stringify({ ...nav, modeToggle: { default: 'light', isHidden: true } }), ...intro })
    expect(legacy.docsConfig.appearance).toEqual({ default: 'light', showToggle: false })
    const both = site({ 'docs.json': JSON.stringify({ ...nav, appearance: { default: 'dark' }, modeToggle: { default: 'light', isHidden: true } }), ...intro })
    expect(both.docsConfig.appearance).toEqual({ default: 'dark', showToggle: false })
  })

  it('skips invalid appearance values with a warning', () => {
    const bundle = site({ 'docs.json': JSON.stringify({ ...nav, appearance: { default: 'sepia', strict: 'yes' }, modeToggle: { isHidden: 1 } }), ...intro })
    expect(bundle.docsConfig.appearance).toBeUndefined()
    expect(bundle.warnings.filter((warning) => /Ignored invalid/.test(warning.message))).toHaveLength(2)
  })

  it('enables Markdown mirrors for Mintlify sources', () => {
    const bundle = site({ 'docs.json': JSON.stringify(nav), ...intro })
    expect(bundle.docsConfig.markdown).toEqual({ enabled: true })
    expect(JSON.parse(String(renderMigrationFiles(bundle).find((file) => file.path === 'docs.json')!.content)).markdown).toEqual({ enabled: true })
  })
})

describe('gating bypass hardening', () => {
  it('treats public: no / off / 0 as private, like false, and quarantines an ambiguous yes', () => {
    const bundle = site({
      'docs.json': JSON.stringify({ navigation: { pages: ['a', 'b', 'c', 'd', 'e'] } }),
      'a.mdx': page('A', 'public: no\n'),
      'b.mdx': page('B', 'public: off\n'),
      'c.mdx': page('C', 'public: 0\n'),
      'd.mdx': page('D', 'public: False\n'),
      'e.mdx': page('E', 'public: yes\n'),
    })
    expect(bundle.pages.map((entry) => [entry.id, entry.public])).toEqual([['a', false], ['b', false], ['c', false], ['d', false]])
    // The runtime withholds `public: yes` from everyone; the migration must not publish it either.
    expect((bundle.quarantinedFiles ?? []).map((file) => file.path)).toEqual(['migration-quarantine/e.mdx'])
  })

  it('restricts orphans and extension variants, and gives a page listed in a restricted and an open group the restricted rule', () => {
    for (const groups of [
      [{ group: 'Open', pages: ['intro', 'shared'] }, { group: 'Priv', groups: ['staff'], pages: ['shared'] }],
      [{ group: 'Priv', groups: ['staff'], pages: ['shared'] }, { group: 'Open', pages: ['intro', 'shared'] }],
    ]) {
      const bundle = site({
        'docs.json': JSON.stringify({ navigation: { groups } }),
        'intro.mdx': page('Intro'),
        'shared.mdx': page('Shared'),
        'orphan.md': page('Orphan', 'groups: [x]\n'),
        'orphan2.mdx': page('Orphan2', 'public: false\n'),
      })
      const byId = (id: string) => bundle.pages.find((entry) => entry.id === id)!
      expect(bundle.pages.map((entry) => entry.id).sort()).toEqual(['intro', 'orphan', 'orphan2', 'shared'])
      expect(byId('shared').groups).toEqual(['staff'])
      expect(byId('orphan').groups).toEqual(['x'])
      expect(byId('orphan2').public).toBe(false)
      expect(byId('intro').groups).toBeUndefined()
      expect(new Set(navPages(bundle))).toEqual(new Set(['intro', 'shared']))
      expect(bundle.quarantinedFiles).toBeUndefined()
    }
  })

  it('gates pages under a restricted node inside a container the projection does not walk (tab menu items)', () => {
    const bundle = site({
      'docs.json': JSON.stringify({ navigation: { tabs: [
        { tab: 'T', menu: [{ item: 'Priv', public: false, pages: ['m1'] }, { item: 'Staff', groups: ['staff'], pages: [{ group: 'G', pages: ['m2'] }] }] },
        { tab: 'U', pages: ['open'] },
      ] } }),
      'm1.mdx': page('M1'), 'm2.mdx': page('M2'), 'open.mdx': page('Open'),
    })
    const byId = (id: string) => bundle.pages.find((entry) => entry.id === id)!
    expect(bundle.pages.map((entry) => entry.id).sort()).toEqual(['m1', 'm2', 'open'])
    expect(byId('m1').public).toBe(false)
    expect(byId('m2').groups).toEqual(['staff'])
    expect(byId('open').groups).toBeUndefined()
    expect(bundle.quarantinedFiles).toBeUndefined()
  })

  it('gates pages under restricted versions, dropdowns and anchors, and inside languages', () => {
    const bundle = site({
      'docs.json': JSON.stringify({ navigation: { languages: [
        { language: 'en', versions: [
          { version: 'v1', dropdowns: [{ dropdown: 'D', groups: ['staff'], pages: ['d1'] }, { dropdown: 'E', pages: ['open'] }] },
          { version: 'v2', public: false, anchors: [{ anchor: 'A', pages: ['v2'] }] },
        ] },
        { language: 'fr', groups: [{ group: 'F', public: false, pages: ['fr/p'] }, { group: 'G', pages: ['fr/open'] }] },
      ] } }),
      'd1.mdx': page('D1'), 'open.mdx': page('Open'), 'v2.mdx': page('V2'), 'fr/p.mdx': page('P'), 'fr/open.mdx': page('FrOpen'),
    })
    const byId = (id: string) => bundle.pages.find((entry) => entry.id === id)
    expect(byId('d1')?.groups).toEqual(['staff'])
    expect(byId('v2')?.public).toBe(false)
    expect(bundle.pages.find((entry) => entry.body.includes('Body of P.'))?.public).toBe(false)
    expect(byId('open')?.groups).toBeUndefined()
    expect(byId('open')?.public).toBeUndefined()
    expect(bundle.quarantinedFiles).toBeUndefined()
  })

  it('never inlines an access-restricted page imported as a component into a public page', () => {
    const bundle = site({
      'docs.json': JSON.stringify({ navigation: { pages: ['host'] } }),
      'host.mdx': '---\ntitle: Host\n---\n\nimport Secret from "/private.mdx"\n\nPublic text.\n\n<Secret />\n',
      'private.mdx': page('Private', 'groups: [x]\n').replace('Body of Private.', 'TOPSECRET'),
    })
    const host = bundle.pages.find((entry) => entry.id === 'host')!
    expect(host.body).not.toContain('TOPSECRET')
    expect(host.body).toContain('Public text.')
    // The restricted page itself migrates with its rule; only inlining is refused.
    expect(bundle.pages.find((entry) => entry.id === 'private')!.groups).toEqual(['x'])
    expect(codes(bundle, 'gated-page').some((warning) => warning.source === 'host.mdx' && /NOT inlined/.test(warning.message))).toBe(true)
  })

  const privateDoc = page('Private', 'groups: [admin]\ndescription: TOPSECRET desc\n').replace('Body of Private.', 'TOPSECRET')
  const snippetHost = (host: string, extra: Record<string, string> = {}) => site({
    'docs.json': JSON.stringify({ navigation: { pages: ['host'] } }),
    'host.mdx': `---\ntitle: Host\n---\n\nPublic text.\n\n${host}\n`,
    'private.mdx': privateDoc,
    ...extra,
  })
  const expectSnippetWithheld = (bundle: MigrationBundle, source: string) => {
    const host = bundle.pages.find((entry) => entry.id === 'host')!
    expect(host.body).not.toContain('TOPSECRET')
    expect(host.body).toContain('Public text.')
    expect(bundle.pages.filter((entry) => entry.id !== 'private' && JSON.stringify(entry).includes('TOPSECRET'))).toEqual([])
    expect(bundle.pages.find((entry) => entry.id === 'private')?.groups).toEqual(['admin'])
    const gated = codes(bundle, 'gated-page').filter((warning) => /Snippet file=/.test(warning.message))
    expect(gated).toHaveLength(1)
    expect(gated[0].source).toBe(source)
    expect(gated[0].message).toMatch(/NOT inlined/)
    expect(codes(bundle, 'missing-page')).toHaveLength(0)
  }

  it('never inlines an access-restricted page through <Snippet file>', () => {
    expectSnippetWithheld(snippetHost('<Snippet file="/private.mdx" />'), 'host.mdx')
  })

  it('never inlines an access-restricted page through page-relative or single-quoted <Snippet file>', () => {
    expectSnippetWithheld(snippetHost('<Snippet file="private.mdx" />'), 'host.mdx')
    expectSnippetWithheld(snippetHost("<Snippet file='/private.mdx' />"), 'host.mdx')
  })

  it('never inlines an access-restricted page through a <Snippet file> nested in a public snippet', () => {
    const bundle = snippetHost('<Snippet file="wrapper.mdx" />', { 'snippets/wrapper.mdx': 'Wrapper text.\n\n<Snippet file="/private.mdx" />\n' })
    expectSnippetWithheld(bundle, 'snippets/wrapper.mdx')
    expect(bundle.pages.find((entry) => entry.id === 'host')!.body).toContain('Wrapper text.')
  })

  it('still expands an ungated <Snippet file> and reports a missing one', () => {
    const bundle = snippetHost('<Snippet file="ok.mdx" />\n\n<Snippet file="nope.mdx" />', { 'snippets/ok.mdx': 'Ok snippet body.\n' })
    const body = bundle.pages.find((entry) => entry.id === 'host')!.body
    expect(body).toContain('Ok snippet body.')
    expect(codes(bundle, 'missing-page').filter((warning) => /nope\.mdx/.test(warning.message))).toHaveLength(1)
  })

  // Pages above the repository size cap are never imported, so the gate prepass
  // must still classify them or a snippet reference would inline them.
  const padding = 'x'.repeat(2_000_001)
  const oversize = (frontmatter: string) => `---\n${frontmatter}---\n\nTOPSECRET\n${padding}\n`
  const expectOversizedWithheld = (bundle: MigrationBundle) => {
    expect(JSON.stringify(bundle.pages).includes('TOPSECRET')).toBe(false)
    expect(bundle.pages.find((entry) => entry.id === 'host')!.body).toContain('Public text.')
    expect(bundle.pages.map((entry) => entry.id)).toEqual(['host'])
    expect(bundle.quarantinedFiles ?? []).toHaveLength(0)
    expect(codes(bundle, 'skipped-file').filter((warning) => warning.source === 'private.mdx')).toHaveLength(1)
    expect(codes(bundle, 'gated-page').filter((warning) => warning.source === 'host.mdx' && /NOT inlined/.test(warning.message))).toHaveLength(1)
    expect(codes(bundle, 'missing-page')).toHaveLength(0)
  }
  const oversizedHost = (host: string, frontmatter = 'title: Private\ngroups: [admin]\ndescription: TOPSECRET desc\n') => site({
    'docs.json': JSON.stringify({ navigation: { pages: ['host'] } }),
    'host.mdx': `---\ntitle: Host\n---\n\nPublic text.\n\n${host}\n`,
    'private.mdx': oversize(frontmatter),
  })

  it('never inlines an oversized access-restricted page through <Snippet file>', () => {
    expectOversizedWithheld(oversizedHost('<Snippet file="/private.mdx" />'))
  })

  it('never inlines an oversized access-restricted page through a component or value import', () => {
    expectOversizedWithheld(oversizedHost('import Secret from "/private.mdx"\n\n<Secret />'))
    expectOversizedWithheld(oversizedHost('import { Secret } from "/private.mdx"\n\n<Secret />'))
  })

  it('never inlines an oversized access-restricted page through an alias imported elsewhere', () => {
    const bundle = site({
      'docs.json': JSON.stringify({ navigation: { pages: ['host', 'other'] } }),
      'host.mdx': '---\ntitle: Host\n---\n\nPublic text.\n\n<Secret />\n',
      'other.mdx': '---\ntitle: Other\n---\n\nimport Secret from "/private.mdx"\n\nOther text.\n',
      'private.mdx': oversize('title: Private\ngroups: [admin]\n'),
    })
    expect(JSON.stringify(bundle.pages).includes('TOPSECRET')).toBe(false)
  })

  it('withholds an oversized page restricted by its navigation container', () => {
    const bundle = site({
      'docs.json': JSON.stringify({ navigation: { groups: [
        { group: 'Public', pages: ['host'] }, { group: 'Staff', groups: ['staff'], pages: ['private'] },
      ] } }),
      'host.mdx': '---\ntitle: Host\n---\n\nPublic text.\n\n<Snippet file="/private.mdx" />\n',
      'private.mdx': oversize('title: Private\n'),
    })
    expect(JSON.stringify(bundle.pages).includes('TOPSECRET')).toBe(false)
  })

  it('withholds an oversized page whose frontmatter cannot be bounded or parsed', () => {
    const unterminated = `---\ntitle: Private\n${'x: y\n'.repeat(20_000)}`
    const bundle = site({
      'docs.json': JSON.stringify({ navigation: { pages: ['host'] } }),
      'host.mdx': '---\ntitle: Host\n---\n\nPublic text.\n\n<Snippet file="/private.mdx" />\n',
      'private.mdx': `${unterminated}groups: [admin]\nTOPSECRET\n${padding}`,
    })
    expect(JSON.stringify(bundle.pages).includes('TOPSECRET')).toBe(false)
    expect(codes(bundle, 'gated-page').some((warning) => /NOT inlined/.test(warning.message))).toBe(true)
  })

  // Fail closed: an oversized or unclassifiable file is never inlined, restricted or not.
  const openBig = `---\ntitle: Big\n---\n\nBIGMARKER\n${padding}\n`
  const expectOversizedBlocked = (bundle: MigrationBundle, source = 'host.mdx') => {
    expect(JSON.stringify(bundle.pages).includes('BIGMARKER')).toBe(false)
    const host = bundle.pages.find((entry) => entry.id === 'host')!.body
    expect(host.includes('Public text.')).toBe(true)
    expect(host.includes('{/* Oversized content not inlined:')).toBe(true)
    const warnings = codes(bundle, 'skipped-file').filter((warning) => warning.source === source && /NOT inlined/.test(warning.message))
    expect(warnings).toHaveLength(1)
    expect(/too large/.test(warnings[0].message)).toBe(true)
    expect(codes(bundle, 'missing-page')).toHaveLength(0)
    expect(codes(bundle, 'gated-page').some((warning) => /NOT inlined/.test(warning.message))).toBe(false)
  }
  const bigHost = (host: string, extra: Record<string, string> = {}) => site({
    'docs.json': JSON.stringify({ navigation: { pages: ['host'] } }),
    'host.mdx': `---\ntitle: Host\n---\n\nPublic text.\n\n${host}\n`,
    'big.mdx': openBig,
    ...extra,
  })

  it('never inlines an unrestricted oversized page through <Snippet file>', () => {
    expectOversizedBlocked(bigHost('<Snippet file="/big.mdx" />'))
  })

  it('never inlines an unrestricted oversized page through a component import', () => {
    expectOversizedBlocked(bigHost('import Big from "/big.mdx"\n\n<Big />'))
  })

  it('never inlines an unrestricted oversized page through a value import, and drops the import', () => {
    const bundle = bigHost('import { Big } from "/big.mdx"\n\n<Big />')
    expectOversizedBlocked(bundle)
    expect(bundle.pages.find((entry) => entry.id === 'host')!.body.includes('import ')).toBe(false)
  })

  it('never inlines an unrestricted oversized page through an alias imported elsewhere', () => {
    const bundle = site({
      'docs.json': JSON.stringify({ navigation: { pages: ['host', 'other'] } }),
      'host.mdx': '---\ntitle: Host\n---\n\nPublic text.\n\n<Big />\n',
      'other.mdx': '---\ntitle: Other\n---\n\nimport Big from "/big.mdx"\n\nOther text.\n',
      'big.mdx': openBig,
    })
    expectOversizedBlocked(bundle)
  })

  it('never inlines an unrestricted oversized page nested in a public snippet', () => {
    const bundle = bigHost('<Snippet file="wrapper.mdx" />', { 'snippets/wrapper.mdx': 'Wrapper text.\n\n<Snippet file="/big.mdx" />\n' })
    expect(JSON.stringify(bundle.pages).includes('BIGMARKER')).toBe(false)
    expect(bundle.pages.find((entry) => entry.id === 'host')!.body.includes('{/* Oversized content not inlined:')).toBe(true)
    expect(codes(bundle, 'skipped-file').filter((warning) => warning.source === 'snippets/wrapper.mdx' && /NOT inlined/.test(warning.message))).toHaveLength(1)
  })

  it('never inlines an oversized file under snippets/', () => {
    expectOversizedBlocked(bigHost('<Snippet file="huge.mdx" />', { 'snippets/huge.mdx': openBig }))
  })

  it('inlines a file of exactly the size cap', () => {
    const head = '---\ntitle: Edge\n---\n\nEDGEMARKER\n'
    const edge = `${head}\n\`\`\`\n${'x'.repeat(2_000_000 - head.length - 10)}\n\`\`\`\n`
    expect(Buffer.byteLength(edge)).toBe(2_000_000)
    const bundle = site({
      'docs.json': JSON.stringify({ navigation: { pages: ['host'] } }),
      'host.mdx': '---\ntitle: Host\n---\n\nPublic text.\n\n<Snippet file="/snippets/edge.mdx" />\n',
      // One fenced code block: only the 2 MB size is under test, and 2 MB of prose makes the MDX pipeline take ~45 s.
      // Under snippets/ so it is inlined only, never also converted as a page of its own (which doubled the time).
      'snippets/edge.mdx': edge,
    })
    expect(JSON.stringify(bundle.pages).includes('EDGEMARKER')).toBe(true)
    expect(codes(bundle, 'skipped-file').some((warning) => /NOT inlined/.test(warning.message))).toBe(false)
  }, 90_000)

  it('blocks a small file whose frontmatter is not closed within the bounded read', () => {
    const unterminated = `---\ntitle: Open\n${'x: y\n'.repeat(20_000)}UNPARSEABLEMARKER\n`
    const bundle = site({
      'docs.json': JSON.stringify({ navigation: { pages: ['host'] } }),
      'host.mdx': '---\ntitle: Host\n---\n\nPublic text.\n\n<Snippet file="/open.mdx" />\n',
      'open.mdx': unterminated,
    })
    expect(JSON.stringify(bundle.pages).includes('UNPARSEABLEMARKER')).toBe(false)
    const warnings = codes(bundle, 'skipped-file').filter((warning) => warning.source === 'host.mdx' && /NOT inlined/.test(warning.message))
    expect(warnings).toHaveLength(1)
    expect(/frontmatter that could not be read/.test(warnings[0].message)).toBe(true)
  }, 60_000)

  it('still inlines small snippets and still reports a small restricted page as access-restricted', () => {
    const bundle = snippetHost('<Snippet file="ok.mdx" />\n\n<Snippet file="/private.mdx" />', { 'snippets/ok.mdx': 'Ok snippet body.\n' })
    expect(bundle.pages.find((entry) => entry.id === 'host')!.body.includes('Ok snippet body.')).toBe(true)
    expect(codes(bundle, 'gated-page').filter((warning) => /Snippet file=.*access-restricted/.test(warning.message))).toHaveLength(1)
    expect(codes(bundle, 'skipped-file').some((warning) => /NOT inlined/.test(warning.message))).toBe(false)
  })

  it('withholds a page whose invalid frontmatter declares groups or public instead of salvaging it', () => {
    const bundle = site({
      'docs.json': JSON.stringify({ navigation: { pages: ['bad', 'badpublic', 'badopen'] } }),
      'bad.mdx': '---\ntitle: Bad: colon: here\ngroups: [admin\n---\n\nTOPSECRET\n',
      'badpublic.mdx': '---\ntitle: Bad: colon: here\npublic: [false\n---\n\nTOPSECRET\n',
      'badopen.mdx': '---\ntitle: Open: colon: here\n---\n\nOpen body\n',
    })
    expect(bundle.pages.map((entry) => entry.id)).toEqual(['badopen'])
    expect((bundle.quarantinedFiles ?? []).map((file) => file.path).sort()).toEqual([
      'migration-quarantine/bad.mdx',
      'migration-quarantine/badpublic.mdx',
    ])
    const published = renderMigrationFiles(bundle).filter((file) => !file.path.startsWith('migration-quarantine/'))
    expect(published.some((file) => String(Buffer.from(file.content as Uint8Array)).includes('TOPSECRET'))).toBe(false)
  })

  it('says in the summary that the quarantine folder is local only and git-ignored', () => {
    const bundle = site({
      'docs.json': JSON.stringify({ navigation: { pages: ['a', 'b'] } }),
      // Only rules that cannot be migrated safely are quarantined now.
      'a.mdx': page('A', 'public: maybe\n'),
      'b.mdx': page('B'),
    })
    const summary = codes(bundle, 'gated-page').find((warning) => !warning.source && /1 access-restricted/.test(warning.message))!
    expect(summary.message).toMatch(/local only: git-ignored, never served or deployed/)
  })
})

describe('script hardening', () => {
  it('does not register a module imported by pages as a site-wide script', () => {
    const bundle = site({
      'docs.json': JSON.stringify({ navigation: { pages: ['intro'] } }),
      'intro.mdx': '---\ntitle: Intro\n---\n\nimport { Widget } from "/snippets/widget.js"\n\n<Widget />\n',
      'snippets/widget.js': 'export const Widget = () => <div>hi</div>\n',
      'site.js': 'console.log(1)',
    })
    expect((bundle.componentFiles ?? []).some((file) => file.path.endsWith('snippets/widget.js'))).toBe(true)
    expect(bundle.docsConfig.customScripts).toEqual([{ src: '/site.js', strategy: 'afterInteractive' }])
    expect(bundle.assets.map((asset) => asset.path)).toEqual(['site.js'])
  })

  it('URL-encodes script paths with spaces and special characters', () => {
    const bundle = site({
      'docs.json': JSON.stringify({ navigation: { pages: ['intro'] } }),
      'intro.mdx': page('Intro'),
      'my scripts/a b#c.js': 'console.log(1)',
    })
    expect(bundle.docsConfig.customScripts).toEqual([{ src: '/my%20scripts/a%20b%23c.js', strategy: 'afterInteractive' }])
  })
})

describe('assets used only by withheld pages', () => {
  const png = Buffer.from('PNGDATA')
  const withheldSite = () => site({
    'docs.json': JSON.stringify({ navigation: { pages: ['pub', 'secret'] } }),
    'pub.mdx': '---\ntitle: Pub\n---\n\n![shared](/img/shared.png)\n\n![open](/img/open.png)\n',
    'secret.mdx': '---\ntitle: Secret\ngroups: [admin]\n---\n\n![a](/img/private.png)\n\n![shared](/img/shared.png)\n\n<Snippet file="private-snippet.mdx" />\n',
    'snippets/private-snippet.mdx': '![b](/img/via-snippet.png)\n',
    'img/private.png': png,
    'img/shared.png': png,
    'img/open.png': png,
    'img/via-snippet.png': png,
    'img/unreferenced.png': png,
  })
  const publicPaths = (bundle: MigrationBundle) => bundle.assets.map((asset) => asset.path)

  it('keeps an image used only by a gated page out of public/ and saves it in quarantine', () => {
    const bundle = withheldSite()
    expect(publicPaths(bundle).includes('img/private.png')).toBe(false)
    expect((bundle.quarantinedFiles ?? []).some((file) => file.path === 'migration-quarantine/assets/img/private.png')).toBe(true)
  })

  it('keeps an image used only through a gated page snippet out of public/', () => {
    expect(publicPaths(withheldSite()).includes('img/via-snippet.png')).toBe(false)
  })

  it('still copies an image shared by a gated and a published page', () => {
    const paths = publicPaths(withheldSite())
    expect(paths.includes('img/shared.png')).toBe(true)
    expect(paths.includes('img/open.png')).toBe(true)
  })

  it('keeps an unreferenced image out of public/ on a gated site, quarantines it and counts it in one summary', () => {
    const bundle = withheldSite()
    expect(publicPaths(bundle).includes('img/unreferenced.png')).toBe(false)
    expect((bundle.quarantinedFiles ?? []).some((file) => file.path === 'migration-quarantine/assets/img/unreferenced.png')).toBe(true)
    const summaries = codes(bundle, 'gated-page').filter((item) => /kept out of public\//.test(item.message))
    expect(summaries).toHaveLength(1)
    expect(summaries[0].message).toContain('1 unreferenced asset(s) were kept out of public/ because this site has access-restricted content; review migration-quarantine/assets/ and copy any that published pages need')
  })

  it('still copies an unreferenced image when nothing is withheld', () => {
    const bundle = site({
      'docs.json': JSON.stringify({ navigation: { pages: ['pub'] } }),
      'pub.mdx': page('Pub'),
      'img/unreferenced.png': png,
    })
    expect(publicPaths(bundle).includes('img/unreferenced.png')).toBe(true)
    expect(bundle.quarantinedFiles).toBeUndefined()
  })

  it.each([
    ['markdown image', { 'pub.mdx': '---\ntitle: Pub\n---\n\n![a](/img/x.png)\n' }],
    ['img tag', { 'pub.mdx': '---\ntitle: Pub\n---\n\n<img src="/img/x.png" />\n' }],
    ['JSX src', { 'pub.mdx': '---\ntitle: Pub\n---\n\n<Frame src={"/img/x.png"} />\n' }],
    ['Card img', { 'pub.mdx': '---\ntitle: Pub\n---\n\n<Card title="t" img="/img/x.png">c</Card>\n' }],
    ['inline style url()', { 'pub.mdx': '---\ntitle: Pub\n---\n\n<div style={{ backgroundImage: "url(/img/x.png)" }} />\n' }],
    ['frontmatter image', { 'pub.mdx': '---\ntitle: Pub\nimage: /img/x.png\n---\n\nHi\n' }],
    ['frontmatter og:image', { 'pub.mdx': '---\ntitle: Pub\n"og:image": /img/x.png\n---\n\nHi\n' }],
    ['frontmatter icon', { 'pub.mdx': '---\ntitle: Pub\nicon: /img/x.png\n---\n\nHi\n' }],
    ['docs.json logo', { 'docs.json': JSON.stringify({ logo: { light: '/img/x.png', dark: '/img/x.png' }, navigation: { pages: ['pub', 'secret'] } }) }],
    ['docs.json favicon', { 'docs.json': JSON.stringify({ favicon: '/img/x.png', navigation: { pages: ['pub', 'secret'] } }) }],
    ['docs.json background', { 'docs.json': JSON.stringify({ background: { image: '/img/x.png' }, navigation: { pages: ['pub', 'secret'] } }) }],
    ['stylesheet url()', { 'pub.mdx': '---\ntitle: Pub\n---\n\n<div className="widget">Hello.</div>\n', 'style.css': '.widget { background: url("img/x.png") }\n' }],
    ['snippet', { 'pub.mdx': '---\ntitle: Pub\n---\n\n<Snippet file="s.mdx" />\n', 'snippets/s.mdx': '![s](/img/x.png)\n' }],
  ])('keeps an otherwise unreferenced image public on a gated site when used by a published %s', (_name, extra) => {
    const bundle = site({
      'docs.json': JSON.stringify({ navigation: { pages: ['pub', 'secret'] } }),
      'pub.mdx': page('Pub'),
      'secret.mdx': page('Secret', 'groups: [admin]\n'),
      'img/x.png': png,
      ...extra,
    })
    expect(publicPaths(bundle).includes('img/x.png')).toBe(true)
    expect((bundle.quarantinedFiles ?? []).some((file) => file.path.endsWith('img/x.png'))).toBe(false)
  })

  it('does not publish an asset referenced only by a discarded shell selector', () => {
    const bundle = site({
      'docs.json': JSON.stringify({ navigation: { pages: ['pub', 'secret'] } }),
      'pub.mdx': page('Pub'),
      'secret.mdx': page('Secret', 'groups: [admin]\n'),
      'style.css': 'body { background: url("img/x.png") }\n',
      'img/x.png': png,
    })
    expect(publicPaths(bundle)).not.toContain('img/x.png')
    expect(publicPaths(bundle)).not.toContain('style.css')
  })

  it('keeps an image that a published page names only in its frontmatter', () => {
    const bundle = site({
      'docs.json': JSON.stringify({ navigation: { pages: ['pub', 'secret'] } }),
      'pub.mdx': '---\ntitle: Pub\nimage: /img/cover.png\n---\n\nHello.\n',
      'secret.mdx': '---\ntitle: Secret\ngroups: [admin]\n---\n\n![a](/img/cover.png)\n',
      'img/cover.png': png,
    })
    expect(publicPaths(bundle).includes('img/cover.png')).toBe(true)
  })
})

describe('dashboard access warning', () => {
  const dashboardWarnings = (bundle: MigrationBundle) => bundle.warnings.filter((warning) => /dashboard/i.test(warning.message) && warning.code === 'gated-page')

  it('warns exactly once on a Mintlify migration with no public flags', () => {
    const warnings = dashboardWarnings(site({ 'docs.json': JSON.stringify({ navigation: { pages: ['a'] } }), 'a.mdx': page('A') }))
    expect(warnings).toHaveLength(1)
    expect(/Check the source site's dashboard access settings before publishing/.test(warnings[0].message)).toBe(true)
  })

  it('merges the public: true specifics into the same single warning', () => {
    const warnings = dashboardWarnings(site({ 'docs.json': JSON.stringify({ navigation: { pages: ['a'] } }), 'a.mdx': page('A', 'public: true\n') }))
    expect(warnings).toHaveLength(1)
    expect(/public: true/.test(warnings[0].message)).toBe(true)
  })

  it('does not warn on non-Mintlify migrations', () => {
    const root = mkdtempSync(join(tmpdir(), 'thally-migrate-extras-'))
    writeFileSync(join(root, 'docusaurus.config.js'), 'module.exports = { title: "T" }\n')
    mkdirSync(join(root, 'docs'))
    writeFileSync(join(root, 'docs', 'intro.md'), '---\ntitle: Intro\n---\n\nHello\n')
    const bundle = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/docs', platform: 'docusaurus' })
    expect(bundle.warnings.some((warning) => /Mintlify dashboard/.test(warning.message))).toBe(false)
  })
})

describe('custom stylesheet migration', () => {
  const cssWarnings = (bundle: MigrationBundle) => bundle.warnings.filter((warning) => warning.code === 'unsupported-config' && /stylesheet/i.test(warning.message))

  it('reports platform shell selectors that cannot be projected', () => {
    const bundle = site({
      'docs.json': JSON.stringify({ navigation: { pages: ['a'] } }),
      'a.mdx': page('A'),
      'style.css': '#navbar { color: red }\n',
    })
    const warnings = cssWarnings(bundle)
    expect(warnings).toHaveLength(1)
    expect(warnings[0].source).toBe('style.css')
    expect(warnings[0].message).toMatch(/Skipped 1 stylesheet selector/)
    expect(bundle.docsConfig.stylesheets).toBeUndefined()
  })

  it('reports a rule nested inside another rule, which Thally cannot confine to the page content', () => {
    const bundle = site({
      'docs.json': JSON.stringify({ navigation: { pages: ['a'] } }),
      'a.mdx': '---\ntitle: A\n---\n\n<div className="widget">Hi</div>\n',
      'style.css': '.widget { color: red; &:hover { color: blue } :is(&, :root) .lucide { display: none } }\n',
    })
    const warnings = cssWarnings(bundle)
    expect(warnings).toHaveLength(1)
    expect(warnings[0].message).toMatch(/Skipped 2 rules nested inside other rules/)
  })

  it('reports a registered custom property it left out', () => {
    const bundle = site({
      'docs.json': JSON.stringify({ navigation: { pages: ['a'] } }),
      'a.mdx': '---\ntitle: A\n---\n\n<div className="widget">Hi</div>\n',
      'style.css': '@property --docs-bg { syntax: "<color>"; inherits: false; initial-value: red }\n.widget { color: red }\n',
    })
    const warnings = cssWarnings(bundle)
    expect(warnings).toHaveLength(1)
    expect(warnings[0].message).toMatch(/Left out of the style\.css stylesheet: @property --docs-bg/)
  })

  it('gives the keyframes of the stylesheet a prefix of the site\'s own, so none replaces one of the runtime', () => {
    const bundle = site({
      'docs.json': JSON.stringify({ navigation: { pages: ['a'] } }),
      'a.mdx': '---\ntitle: A\n---\n\n<div className="widget">Hi</div>\n',
      'style.css': '@keyframes spin { to { opacity: 1 } }\n.widget { animation: spin 1s }\n',
    })
    const sheet = bundle.assets.find((asset) => /migrated\/[0-9a-f]{12}\/style\.css$/.test(asset.path))
    const prefix = /migrated\/([0-9a-f]{12})\/style\.css$/.exec(sheet?.path ?? '')?.[1]
    expect(String(sheet?.content)).toContain(`@keyframes src-${prefix}-spin`)
    expect(String(sheet?.content)).toContain(`animation: src-${prefix}-spin 1s`)
  })

  it('counts the at-rules it left out in the same warning as the selectors', () => {
    const bundle = site({
      'docs.json': JSON.stringify({ navigation: { pages: ['a'] } }),
      'a.mdx': '---\ntitle: A\n---\n\n<div className="widget">Hi</div>\n',
      'style.css': '@page { margin: 0 }\n@counter-style unused { system: cyclic; symbols: "a" }\n#navbar { color: red }\n.widget { color: red }\n',
    })
    const warnings = cssWarnings(bundle)
    expect(warnings).toHaveLength(1)
    expect(warnings[0].message).toMatch(/Skipped 1 stylesheet selector .* and 2 at-rules \(@page, @counter-style unused\)/)
  })

  it('does not warn when there is no stylesheet', () => {
    expect(cssWarnings(site({ 'docs.json': JSON.stringify({ navigation: { pages: ['a'] } }), 'a.mdx': page('A') }))).toHaveLength(0)
  })
})

describe('assets used only by oversized withheld pages', () => {
  const png = Buffer.from('PNGDATA')
  const bigGated = (padding: number) => `---\ntitle: Big\ngroups: [admin]\n---\n\n![o](/img/only.png)\n\n![s](/img/shared.png)\n${'x'.repeat(padding)}\n`
  const build = (padding: number) => site({
    'docs.json': JSON.stringify({ navigation: { pages: ['pub'] } }),
    'pub.mdx': '---\ntitle: Pub\n---\n\n![s](/img/shared.png)\n',
    'big.mdx': bigGated(padding),
    'img/only.png': png,
    'img/shared.png': png,
  })
  const publicPaths = (bundle: MigrationBundle) => bundle.assets.map((asset) => asset.path)

  it('keeps an image used only by an oversized gated page out of public/ and quarantines it', () => {
    const bundle = build(2_000_001)
    expect(publicPaths(bundle).includes('img/only.png')).toBe(false)
    expect((bundle.quarantinedFiles ?? []).some((file) => file.path === 'migration-quarantine/assets/img/only.png')).toBe(true)
  })

  it('still copies an image the oversized gated page shares with a published page', () => {
    expect(publicPaths(build(2_000_001)).includes('img/shared.png')).toBe(true)
  })

  it('emits one summary warning with the withheld asset count when only an oversized gated page exists', () => {
    const summaries = codes(build(2_000_001), 'gated-page').filter((item) => /not copied to public\//.test(item.message))
    expect(summaries).toHaveLength(1)
    expect(/1 file\(s\) used only by access-restricted pages/.test(summaries[0].message)).toBe(true)
  })

  it('warns, naming the page, when a gated page is too large to scan for assets', () => {
    const bundle = build(16_000_001)
    const warning = codes(bundle, 'gated-page').find((item) => item.source === 'big.mdx' && /could not be checked/.test(item.message))
    expect(warning).toBeDefined()
  }, 60_000)
})

describe('fail-closed inlining of gated and unclassified files', () => {
  const secretBody = (extra = 'groups: [a]\n') => `---\ntitle: Sec\n${extra}---\n\nTOPSECRET\n`
  const bodies = (bundle: MigrationBundle) => bundle.pages.map((entry) => entry.body).join('\n')
  const nav = (...pages: Array<string>) => JSON.stringify({ navigation: { pages } })

  it('does not inline a gated page the file budget dropped', () => {
    const files: Record<string, string> = {
      'docs.json': nav('index'),
      'index.mdx': "---\ntitle: I\n---\n\nimport Sec from '/zz/deep/secret.mdx'\n\n<Sec/>\n",
      'zz/deep/secret.mdx': secretBody(),
    }
    for (let i = 0; i < 30; i++) files[`filler/f${i}.mdx`] = '---\ntitle: F\n---\n\nx\n'
    const bundle = site(files, { maxSourceFiles: 20 })
    expect(bodies(bundle)).not.toContain('TOPSECRET')
  }, 30_000)

  it('does not inline a gated page imported with a different path case', (context) => {
    const probe = mkdtempSync(join(tmpdir(), 'thally-case-'))
    writeFileSync(join(probe, 'a'), '')
    if (!existsSync(join(probe, 'A'))) { context.skip(); return }
    const bundle = site({
      'docs.json': nav('index', 's'),
      'index.mdx': "---\ntitle: I\n---\n\nimport Sec from '/S.mdx'\n\n<Sec/>\n",
      's.mdx': secretBody(),
    })
    // Only the restricted page itself (migrated with its `groups`) may carry its text.
    expect(bundle.pages.filter((entry) => !entry.groups).map((entry) => entry.body).join('\n')).not.toContain('TOPSECRET')
    expect(bundle.pages.filter((entry) => !entry.groups)).toHaveLength(1)
  })

  it('still inlines a Docusaurus partial that starts with a thematic break', () => {
    const root = mkdtempSync(join(tmpdir(), 'thally-migrate-extras-'))
    writeFileSync(join(root, 'docusaurus.config.js'), 'module.exports = { title: "T" }\n')
    mkdirSync(join(root, 'docs'))
    writeFileSync(join(root, 'docs', '_part.mdx'), '---\n\nPARTIALTEXT\n')
    writeFileSync(join(root, 'docs', 'intro.md'), "---\ntitle: Intro\n---\n\nimport Part from './_part.mdx'\n\n<Part />\n")
    const bundle = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/docs', platform: 'docusaurus' })
    expect(bodies(bundle)).toContain('PARTIALTEXT')
  })

  it('does not say "too large" for a Mintlify block whose frontmatter is unclosed', () => {
    const bundle = site({
      'docs.json': nav('index'),
      'index.mdx': "---\ntitle: I\n---\n\nimport Part from '/snippets/p.mdx'\n\n<Part />\n",
      'snippets/p.mdx': '---\n\nUNCLOSED\n',
    })
    const warning = bundle.warnings.find((item) => /snippets\/p\.mdx/.test(item.message))
    expect(warning).toBeDefined()
    expect(bodies(bundle)).not.toContain('Oversized')
  })

  it.each([
    ['default import', "import S from '/snippets/s.mdx'\n\n<S />\n", ''],
    ['value import', "import { x } from '/snippets/s.mdx'\n\n{x}\n", ''],
    ['global alias', '<S />\n', "---\ntitle: Other\n---\n\nimport S from '/snippets/s.mdx'\n\n<S />\n"],
    ['Snippet tag', '<Snippet file="s.mdx" />\n', ''],
  ])('refuses to inline a snippet that declares groups (%s) and warns', (_name, hostBody, otherPage) => {
    const bundle = site({
      'docs.json': nav('index', 'other'),
      'index.mdx': `---\ntitle: I\n---\n\n${hostBody}`,
      'other.mdx': otherPage || page('Other'),
      'snippets/s.mdx': '---\ngroups: [a]\n---\n\nexport const x = "TOPSECRET"\n\nTOPSECRET <b>y</b>\n',
    })
    expect(bodies(bundle)).not.toContain('TOPSECRET')
    expect(codes(bundle, 'gated-page').some((item) => /does not enforce groups on snippets/.test(item.message))).toBe(true)
    expect((bundle.quarantinedFiles ?? []).some((file) => file.path.endsWith('s.mdx'))).toBe(false)
  })

  it('gates a page listed under a navigation entry with different letter case', () => {
    const bundle = site({
      'docs.json': JSON.stringify({ navigation: { groups: [{ group: 'G', groups: ['admin'], pages: ['S'] }, { group: 'Open', pages: ['pub'] }] } }),
      's.mdx': page('S'),
      'pub.mdx': page('Pub'),
    })
    expect(bundle.pages.find((entry) => entry.id.toLowerCase() === 's')!.groups).toEqual(['admin'])
    expect(bundle.pages.find((entry) => entry.id === 'pub')!.groups).toBeUndefined()
  })

  it('gates a navigation container whose groups array mixes strings and objects', () => {
    const bundle = site({
      'docs.json': JSON.stringify({ navigation: { groups: [{ group: 'G', groups: ['x', { y: 1 }], pages: ['p'] }, { group: 'Open', pages: ['pub'] }] } }),
      'p.mdx': page('P'),
      'pub.mdx': page('Pub'),
    })
    expect((bundle.quarantinedFiles ?? []).map((file) => file.path)).toEqual(['migration-quarantine/p.mdx'])
  })

  it('does not gate a tab whose groups are nested navigation groups', () => {
    const bundle = site({
      'docs.json': JSON.stringify({ navigation: { tabs: [{ tab: 'T', groups: [{ group: 'G', pages: ['p'] }] }] } }),
      'p.mdx': page('P'),
    })
    expect(bundle.quarantinedFiles).toBeUndefined()
  })
})

describe('oversized and unreadable gated pages', () => {
  it('warns with a source that an oversized gated page was not published, even without assets', () => {
    const bundle = site({
      'docs.json': JSON.stringify({ navigation: { pages: ['pub'] } }),
      'pub.mdx': page('Pub'),
      'big.mdx': `---\ntitle: Big\ngroups: [admin]\n---\n\n${'x'.repeat(2_100_000)}\n`,
    })
    const warning = codes(bundle, 'gated-page').find((item) => item.source === 'big.mdx')
    expect(warning !== undefined && /too large to migrate.*NOT published/.test(warning.message)).toBe(true)
  })

  it.skipIf(process.getuid?.() === 0)('warns instead of crashing when a gated page cannot be read', () => {
    const root = mkdtempSync(join(tmpdir(), 'thally-migrate-extras-'))
    writeFileSync(join(root, 'docs.json'), JSON.stringify({ navigation: { pages: ['pub', 'locked'] } }))
    writeFileSync(join(root, 'pub.mdx'), page('Pub'))
    writeFileSync(join(root, 'locked.mdx'), page('Locked', 'groups: [admin]\n'))
    chmodSync(join(root, 'locked.mdx'), 0o000)
    try {
      const bundle = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/docs', platform: 'mintlify' })
      expect(codes(bundle, 'gated-page').some((item) => item.source === 'locked.mdx' && /could not be read/.test(item.message))).toBe(true)
      expect(bundle.pages.map((entry) => entry.id)).toEqual(['pub'])
    } finally {
      chmodSync(join(root, 'locked.mdx'), 0o644)
    }
  })
})

describe('OpenAPI specs referenced by gated pages', () => {
  const spec = JSON.stringify({ openapi: '3.0.0', info: { title: 'T', version: '1' }, paths: { '/x': { get: { summary: 'SECRETSUMMARY' } } } })
  const base = {
    'docs.json': JSON.stringify({ navigation: { pages: ['pub', 's'] } }),
    's.mdx': page('S', 'groups: [admin]\nopenapi: GET /x\n'),
    'openapi/openapi.json': spec,
  }
  const specPaths = (bundle: MigrationBundle) => bundle.assets.map((asset) => asset.path).filter((path) => path.endsWith('openapi.json'))

  it('quarantines a spec every referencing page of which is withheld', () => {
    const bundle = site({ ...base, 'pub.mdx': page('Pub') })
    expect(specPaths(bundle)).toEqual([])
    expect((bundle.quarantinedFiles ?? []).some((file) => file.path === 'migration-quarantine/assets/openapi/openapi.json')).toBe(true)
    expect(JSON.stringify(bundle.docsConfig)).not.toContain('openapi.json')
  })

  it('keeps the spec and warns when a published page also uses it', () => {
    const bundle = site({ ...base, 'pub.mdx': page('Pub', 'openapi: GET /x\n') })
    expect(specPaths(bundle)).toEqual(['openapi/openapi.json'])
    expect(codes(bundle, 'gated-page').some((item) => /shared with access-restricted pages.*may describe restricted endpoints/.test(item.message))).toBe(true)
  })

  it('keeps a spec listed in docs.json and warns that restricted pages use it', () => {
    const bundle = site({
      ...base,
      'docs.json': JSON.stringify({ api: { openapi: 'openapi/openapi.json' }, navigation: { pages: ['pub', 's'] } }),
      'pub.mdx': page('Pub'),
    })
    expect(specPaths(bundle)).toEqual(['openapi/openapi.json'])
    expect(codes(bundle, 'gated-page').some((item) => /shared with access-restricted pages/.test(item.message))).toBe(true)
  })
})

describe('OpenAPI specs named only by page frontmatter', () => {
  const spec = JSON.stringify({ openapi: '3.0.0', info: { title: 'T', version: '1' }, paths: { '/x': { get: { summary: 'SECRETSUMMARY' } } } })
  const files = (extra: Record<string, string>) => ({
    'docs.json': JSON.stringify({ navigation: { pages: ['pub', 's'] } }),
    'api-reference/spec.json': spec,
    ...extra,
  })
  const specPaths = (bundle: MigrationBundle) => bundle.assets.map((asset) => asset.path).filter((path) => path.endsWith('spec.json'))

  it('migrates the spec of a published page and binds it to a hidden tab', () => {
    const bundle = site(files({
      'pub.mdx': page('Pub', 'openapi: "/api-reference/spec.json GET /x"\n'),
      's.mdx': page('S'),
    }))
    expect(specPaths(bundle)).toEqual(['openapi/spec.json'])
    expect(bundle.pages.find((entry) => entry.id === 'pub')?.openapi).toBe('openapi/spec.json GET /x')
    expect(bundle.docsConfig.tabs.filter((tab) => tab.api)).toEqual([
      expect.objectContaining({ hidden: true, api: { source: 'openapi/spec.json' } }),
    ])
    expect(codes(bundle, 'unsupported-config').some((item) => /not referenced from docs.json/.test(item.message))).toBe(false)
  })

  it('saves two specs that share a file name under distinct names even when docs.json binds both to one tab', () => {
    const only = (path: string): string => JSON.stringify({ openapi: '3.0.0', info: { title: 'T', version: '1' }, paths: { [path]: { get: { summary: path } } } })
    const bundle = site({
      'docs.json': JSON.stringify({ api: { openapi: ['a/spec.json', 'b/spec.json'] }, navigation: { pages: ['pa', 'pb'] } }),
      'a/spec.json': only('/a'),
      'b/spec.json': only('/b'),
      'pa.mdx': page('A', 'openapi: "a/spec.json GET /a"\n'),
      'pb.mdx': page('B', 'openapi: "b/spec.json GET /b"\n'),
    })
    const paths = (path: string): Array<string> => Object.keys(JSON.parse(String(bundle.assets.find((asset) => asset.path === path)!.content)).paths)
    expect(bundle.assets.map((asset) => asset.path).filter((path) => path.startsWith('openapi/')).sort()).toEqual(['openapi/b-spec.json', 'openapi/spec.json'])
    expect(paths('openapi/spec.json')).toEqual(['/a'])
    expect(paths('openapi/b-spec.json')).toEqual(['/b'])
    expect(bundle.pages.find((entry) => entry.id === 'pa')?.openapi).toBe('openapi/spec.json GET /a')
    expect(bundle.pages.find((entry) => entry.id === 'pb')?.openapi).toBe('openapi/b-spec.json GET /b')
    expect(bundle.docsConfig.tabs.flatMap((tab) => tab.api ? [tab.api.source] : []).sort()).toEqual(['openapi/b-spec.json', 'openapi/spec.json'])
  })

  it('names the spec the repository scan picks and a page-only spec of the same file name from one allocator', () => {
    const only = (title: string, scanned: boolean): string => scanned
      ? JSON.stringify({ openapi: '3.0.0', info: { title, version: '1' }, paths: { '/x': { get: { summary: 'X' } } } })
      : JSON.stringify({ info: { title, version: '1' }, paths: { '/x': { get: { summary: 'X' } } }, openapi: '3.0.0' })
    const bundle = site({
      'docs.json': JSON.stringify({ navigation: { pages: ['pub'] } }),
      'a/openapi.json': only('DEFAULT-A', true),
      'b/openapi.json': only('PAGE-B', false),
      'pub.mdx': page('Pub', 'openapi: "./b/openapi.json GET /x"\n'),
    })
    const titleAt = (path: string): string => JSON.parse(String(bundle.assets.find((asset) => asset.path === path)!.content)).info.title
    const bound = bundle.pages.find((entry) => entry.id === 'pub')!.openapi!.split(' ')[0]
    expect(titleAt(bound)).toBe('PAGE-B')
    expect(bundle.docsConfig.tabs.filter((tab) => tab.api).map((tab) => [tab.hidden === true, titleAt(tab.api!.source)])).toEqual([[false, 'DEFAULT-A'], [true, 'PAGE-B']])
  })

  it('treats names that differ only in letter case as one name when saving specs', () => {
    const only = (path: string): string => JSON.stringify({ openapi: '3.0.0', info: { title: 'T', version: '1' }, paths: { [path]: { get: { summary: path } } } })
    const bundle = site({
      'docs.json': JSON.stringify({ api: { openapi: ['a/Spec.json', 'b/spec.json'] }, navigation: { pages: ['pa'] } }),
      'a/Spec.json': only('/a'),
      'b/spec.json': only('/b'),
      'pa.mdx': page('A', 'openapi: "a/Spec.json GET /a"\n'),
    })
    const names = bundle.assets.map((asset) => asset.path).filter((path) => path.startsWith('openapi/'))
    expect(new Set(names.map((path) => path.toLowerCase())).size).toBe(2)
    expect(bundle.pages.find((entry) => entry.id === 'pa')?.openapi).toBe('openapi/Spec.json GET /a')
  })

  it('keeps a spec out of the published output when only a withheld page names it', () => {
    const bundle = site(files({
      'pub.mdx': page('Pub'),
      's.mdx': page('S', 'groups: [admin]\nopenapi: "/api-reference/spec.json GET /x"\n'),
    }))
    expect(specPaths(bundle)).toEqual([])
    expect(JSON.stringify(bundle.docsConfig)).not.toContain('spec.json')
  })
})

describe('operations documented only on access-restricted pages', () => {
  const spec = JSON.stringify({ openapi: '3.0.0', info: { title: 'T', version: '1' }, paths: { '/x': { get: { summary: 'PUBLICOP' } }, '/internal': { get: { summary: 'INTERNALSECRET' } } } })
  const specContent = (bundle: MigrationBundle) => JSON.parse(String(bundle.assets.find((asset) => asset.path.endsWith('spec.json'))!.content))

  it('marks an operation only a gated page names x-excluded in a page-only spec', () => {
    const bundle = site({
      'docs.json': JSON.stringify({ navigation: { pages: ['pub', 's'] } }),
      'spec.json': spec,
      'pub.mdx': page('Pub', 'openapi: "/spec.json GET /x"\n'),
      's.mdx': page('S', 'groups: [admin]\nopenapi: "/spec.json GET /internal"\n'),
    })
    const out = specContent(bundle)
    expect(out.paths['/internal'].get['x-excluded']).toBe(true)
    expect(out.paths['/x'].get['x-excluded']).toBeUndefined()
    expect(codes(bundle, 'gated-page').some((item) => /withheld from it \(GET \/internal\)/.test(item.message))).toBe(true)
  })

  it('keeps an operation a published page or docs.json also names', () => {
    const bundle = site({
      'docs.json': JSON.stringify({ api: { openapi: 'spec.json' }, navigation: { pages: ['pub', 's', 'GET /internal'] } }),
      'spec.json': spec,
      'pub.mdx': page('Pub', 'openapi: "/spec.json GET /x"\n'),
      's.mdx': page('S', 'groups: [admin]\nopenapi: "/spec.json GET /internal"\n'),
    })
    const out = specContent(bundle)
    expect(out.paths['/internal'].get['x-excluded']).toBeUndefined()
  })

  it('does not keep an operation listed only under restricted navigation', () => {
    const bundle = site({
      'docs.json': JSON.stringify({
        api: { openapi: 'spec.json' },
        navigation: { groups: [
          { group: 'Public', pages: ['pub'] },
          { group: 'Private', public: false, pages: ['s', 'GET /internal'] },
        ] },
      }),
      'spec.json': spec,
      'pub.mdx': page('Pub', 'openapi: "/spec.json GET /x"\n'),
      's.mdx': page('S', 'groups: [admin]\nopenapi: "/spec.json GET /internal"\n'),
    })
    const out = specContent(bundle)
    expect(out.paths['/internal'].get['x-excluded']).toBe(true)
    expect(out.paths['/x'].get['x-excluded']).toBeUndefined()
  })

  it('withholds an operation a public page names without a spec when the site has several, and says so', () => {
    const bundle = site({
      'docs.json': JSON.stringify({ api: { openapi: ['first.json', 'second.json'] }, navigation: { pages: ['pub', 's'] } }),
      'first.json': spec,
      'second.json': spec,
      'pub.mdx': page('Pub', 'openapi: "GET /internal"\n'),
      's.mdx': page('S', 'groups: [admin]\nopenapi: "second.json GET /internal"\n'),
    })
    const out = JSON.parse(String(bundle.assets.find((asset) => asset.path === 'openapi/second.json')!.content))
    expect(out.paths['/internal'].get['x-excluded']).toBe(true)
    expect(codes(bundle, 'gated-page').some((item) => /GET \/internal\) are also named by a published page or navigation entry that does not say which spec/.test(item.message))).toBe(true)
  })

  describe('spec named by file stem', () => {
    const excluded = (bundle: MigrationBundle, path: string, operation: string): unknown =>
      JSON.parse(String(bundle.assets.find((asset) => asset.path === path)!.content)).paths[operation].get['x-excluded']
    const twoSpecs = {
      'a/spec.json': spec,
      'b/spec.yaml': spec,
    }

    it('withholds an operation a restricted page names through the spec file stem', () => {
      const bundle = site({
        'docs.json': JSON.stringify({ api: { openapi: 'spec.json' }, navigation: { pages: ['pub', 's'] } }),
        'spec.json': spec,
        'pub.mdx': page('Pub', 'openapi: "/spec.json GET /x"\n'),
        's.mdx': page('S', 'groups: [admin]\nopenapi: "spec GET /internal"\n'),
      })
      expect(excluded(bundle, 'openapi/spec.json', '/internal')).toBe(true)
      expect(excluded(bundle, 'openapi/spec.json', '/x')).toBeUndefined()
    })

    it('withholds the operation from every spec a restricted stem could name', () => {
      const bundle = site({
        'docs.json': JSON.stringify({ api: { openapi: ['a/spec.json', 'b/spec.yaml'] }, navigation: { pages: ['pub', 's'] } }),
        ...twoSpecs,
        'pub.mdx': page('Pub', 'openapi: "a/spec.json GET /x"\n'),
        's.mdx': page('S', 'groups: [admin]\nopenapi: "spec GET /internal"\n'),
      })
      for (const path of ['openapi/spec.json', 'openapi/spec.yaml']) {
        expect(excluded(bundle, path, '/internal')).toBe(true)
        expect(excluded(bundle, path, '/x')).toBeUndefined()
      }
    })

    it('does not let a public page that names several specs keep a restricted operation public', () => {
      const bundle = site({
        'docs.json': JSON.stringify({ api: { openapi: ['a/spec.json', 'b/spec.yaml'] }, navigation: { pages: ['pub', 's'] } }),
        ...twoSpecs,
        'pub.mdx': page('Pub', 'openapi: "spec GET /internal"\n'),
        's.mdx': page('S', 'groups: [admin]\nopenapi: "a/spec.json GET /internal"\n'),
      })
      expect(excluded(bundle, 'openapi/spec.json', '/internal')).toBe(true)
      expect(excluded(bundle, 'openapi/spec.yaml', '/internal')).toBeUndefined()
    })

    it('keeps an operation a public page names through the spec file stem', () => {
      const bundle = site({
        'docs.json': JSON.stringify({ api: { openapi: 'spec.json' }, navigation: { pages: ['pub', 's'] } }),
        'spec.json': spec,
        'pub.mdx': page('Pub', 'openapi: "spec GET /internal"\n'),
        's.mdx': page('S', 'groups: [admin]\nopenapi: "/spec.json GET /internal"\n'),
      })
      expect(excluded(bundle, 'openapi/spec.json', '/internal')).toBeUndefined()
    })
  })

  describe('refs are compared by source identity and one canonical spelling', () => {
    const published = (bundle: MigrationBundle, path: string): { paths: Record<string, { get: Record<string, unknown> }> } =>
      JSON.parse(String(bundle.assets.find((asset) => asset.path === path)!.content))
    const excluded = (bundle: MigrationBundle, path: string, operation: string): unknown => published(bundle, path).paths[operation].get['x-excluded']
    const tabs = (specs: Array<string>) => JSON.stringify({ navigation: { tabs: [
      { tab: 'Guides', pages: ['pub', 's'] },
      ...specs.map((source, index) => ({ tab: `API ${index}`, openapi: source })),
    ] } })

    it('keeps a restricted operation out of a spec whose file was renamed to avoid a collision', () => {
      // `b/spec.json` is published as `b-spec.json`, but pages name it by what they wrote in the source.
      const bundle = site({
        'docs.json': tabs(['a/spec.json', 'b/spec.json']),
        'a/spec.json': spec,
        'b/spec.json': spec,
        'pub.mdx': page('Pub', 'openapi: "spec GET /internal"\n'),
        's.mdx': page('S', 'groups: [admin]\nopenapi: "b/spec.json GET /internal"\n'),
      })
      expect(excluded(bundle, 'openapi/b-spec.json', '/internal')).toBe(true)
      expect(excluded(bundle, 'openapi/b-spec.json', '/x')).toBeUndefined()
      // A restricted page names only B, so the other spec still publishes its operation.
      expect(excluded(bundle, 'openapi/spec.json', '/internal')).toBeUndefined()
    })

    it('keeps the operation public in the one spec a public page names by its full path', () => {
      const bundle = site({
        'docs.json': tabs(['a/spec.json', 'b/spec.json']),
        'a/spec.json': spec,
        'b/spec.json': spec,
        'pub.mdx': page('Pub', 'openapi: "a/spec.json GET /internal"\n'),
        's.mdx': page('S', 'groups: [admin]\nopenapi: "spec GET /internal"\n'),
      })
      expect(excluded(bundle, 'openapi/spec.json', '/internal')).toBeUndefined()
      expect(excluded(bundle, 'openapi/b-spec.json', '/internal')).toBe(true)
    })

    it('does not let a public path that merely ends like another spec path keep that spec\'s operation public', () => {
      const bundle = site({
        'docs.json': tabs(['a/spec.json', 'x/a/spec.json']),
        'a/spec.json': spec,
        'x/a/spec.json': spec,
        'pub.mdx': page('Pub', 'openapi: "a/spec.json GET /internal"\n'),
        's.mdx': page('S', 'groups: [admin]\nopenapi: "x/a/spec.json GET /internal"\n'),
      })
      expect(excluded(bundle, 'openapi/spec.json', '/internal')).toBeUndefined()
      expect(excluded(bundle, 'openapi/x-a-spec.json', '/internal')).toBe(true)
    })

    it('withholds from the spec a restricted page reaches through a folder that does not exist', () => {
      const bundle = site({
        'docs.json': JSON.stringify({ navigation: { pages: ['pub', 's'] } }),
        'bar/spec.json': spec,
        'pub.mdx': page('Pub', 'openapi: "bar/spec.json GET /x"\n'),
        's.mdx': page('S', 'groups: [admin]\nopenapi: "foo/spec.json GET /internal"\n'),
      })
      expect(excluded(bundle, 'openapi/spec.json', '/internal')).toBe(true)
      expect(excluded(bundle, 'openapi/spec.json', '/x')).toBeUndefined()
    })

    it('does not let a public page naming a spec whose path contains a space keep another spec\'s operation public', () => {
      const bundle = site({
        'docs.json': tabs(['my spec.json', 'other.json']),
        'my spec.json': spec,
        'other.json': spec,
        'pub.mdx': page('Pub', 'openapi: "my spec.json GET /internal"\n'),
        's.mdx': page('S', 'groups: [admin]\nopenapi: "other.json GET /internal"\n'),
      })
      expect(excluded(bundle, 'openapi/other.json', '/internal')).toBe(true)
      expect(excluded(bundle, 'openapi/my spec.json', '/internal')).toBeUndefined()
    })

    const spellings = ['./spec', './/spec.json', '/./spec', 'spec#section', 'spec?version=3', '.\\spec.json', './SPEC', 'spec.json?v=1#top']
    for (const config of ['docs.json', 'mint.json'] as const) {
      for (const spelling of spellings) {
        it(`withholds an operation a restricted page names as "${spelling}" in ${config}`, () => {
          const bundle = site({
            [config]: JSON.stringify(config === 'docs.json' ? { navigation: { pages: ['pub', 's'] } } : { navigation: [{ group: 'G', pages: ['pub', 's'] }] }),
            'spec.json': spec,
            'pub.mdx': page('Pub', 'openapi: "spec GET /x"\n'),
            's.mdx': page('S', `groups: [admin]\nopenapi: "${spelling.replace(/\\/g, '\\\\')} GET /internal"\n`),
          })
          expect(excluded(bundle, 'openapi/spec.json', '/internal')).toBe(true)
          expect(excluded(bundle, 'openapi/spec.json', '/x')).toBeUndefined()
        })
      }
    }

    it('keeps an operation public when a public page names it with the same non-canonical spelling', () => {
      const bundle = site({
        'docs.json': JSON.stringify({ navigation: { pages: ['pub', 's'] } }),
        'spec.json': spec,
        'pub.mdx': page('Pub', 'openapi: "./spec#section GET /internal"\n'),
        's.mdx': page('S', 'groups: [admin]\nopenapi: "spec.json GET /internal"\n'),
      })
      expect(excluded(bundle, 'openapi/spec.json', '/internal')).toBeUndefined()
    })
  })

  it('applies to a spec listed in docs.json and to YAML specs', () => {
    const yaml = 'openapi: 3.0.0\ninfo: {title: T, version: "1"}\npaths:\n  /x:\n    get: {summary: A}\n  /internal:\n    get: {summary: B}\n'
    const bundle = site({
      'docs.json': JSON.stringify({ api: { openapi: 'spec.yaml' }, navigation: { pages: ['pub', 's'] } }),
      'spec.yaml': yaml,
      'pub.mdx': page('Pub'),
      's.mdx': page('S', 'groups: [admin]\nopenapi: "/spec.yaml GET /internal"\n'),
    })
    const text = String(bundle.assets.find((asset) => asset.path.endsWith('spec.yaml'))!.content)
    const out = parseYaml(text)
    expect(out.paths['/internal'].get['x-excluded']).toBe(true)
    expect(out.paths['/x'].get['x-excluded']).toBeUndefined()
  })

  describe('remote specs', () => {
    const URL_ = 'https://specs.example.com/openapi.json'
    const fetcherFor = (): MigrationFetcher => vi.fn(async (url) => ({ finalUrl: url, body: spec, contentType: 'application/json' }))

    it('marks a gated-only operation x-excluded in a remote spec shared with a public page', async () => {
      const bundle = site({
        'docs.json': JSON.stringify({ api: { openapi: URL_ }, navigation: { pages: ['pub', 's'] } }),
        'pub.mdx': page('Pub', `openapi: "${URL_} GET /x"\n`),
        's.mdx': page('S', `groups: [admin]\nopenapi: "${URL_} GET /internal"\n`),
      })
      const fetcher = fetcherFor()
      const result = await hydrateRemoteApiSpecs(bundle, fetcher)
      const out = JSON.parse(Buffer.from(result.assets.find((asset) => asset.path.startsWith('openapi/'))!.content).toString('utf8'))
      expect(out.paths['/internal'].get['x-excluded']).toBe(true)
      expect(out.paths['/x'].get['x-excluded']).toBeUndefined()
      expect(codes(result, 'gated-page').some((item) => /withheld from it \(GET \/internal\)/.test(item.message))).toBe(true)
    })

    it('never fetches a remote spec only a gated page names', async () => {
      const bundle = site({
        'docs.json': JSON.stringify({ navigation: { pages: ['pub', 's'] } }),
        'pub.mdx': page('Pub'),
        's.mdx': page('S', `groups: [admin]\nopenapi: "${URL_} GET /internal"\n`),
      })
      const fetcher = fetcherFor()
      const result = await hydrateRemoteApiSpecs(bundle, fetcher)
      expect(bundle.remoteApiSpecs).toBeUndefined()
      expect(fetcher).not.toHaveBeenCalled()
      expect(result.assets.some((asset) => asset.path.startsWith('openapi/'))).toBe(false)
    })
  })
})

describe('playground display "auth"', () => {
  it('says plainly that reader sign-in is unsupported and what to set instead', () => {
    const bundle = site({ 'docs.json': JSON.stringify({ api: { playground: { display: 'auth' } }, navigation: { pages: ['a'] } }), 'a.mdx': page('A') })
    const warning = codes(bundle, 'unsupported-config').find((item) => /"auth"/.test(item.message))
    expect(warning?.message).toContain('requires reader sign-in, which Thally does not support')
    expect(warning?.message).toContain('Set it to "interactive"')
  })
})

describe('dropped colors and metatags are reported', () => {
  const withConfig = (extra: Record<string, unknown>) => site({ 'docs.json': JSON.stringify({ navigation: { pages: ['a'] }, ...extra }), 'a.mdx': page('A') })
  const messages = (bundle: MigrationBundle) => codes(bundle, 'unsupported-config').map((item) => item.message)

  it('warns with the names of dropped seo.metatags entries and keeps the valid ones', () => {
    const bundle = withConfig({ seo: { metatags: { good: 'yes', refresh: '0;url=https://x.test', 'http-equiv': 'refresh', obj: { a: 1 }, 'bad name': 'x', long: 'x'.repeat(1001) } } })
    expect(bundle.docsConfig.seo?.metatags).toEqual({ good: 'yes' })
    const warning = messages(bundle).find((message) => message.startsWith('seo.metatags entries were dropped'))!
    for (const key of ['refresh', 'http-equiv', 'obj', 'bad name', 'long']) expect(warning).toContain(key)
    expect(warning).not.toContain('good')
  })

  it('warns when a colour is not a hex value, and says which', () => {
    const bundle = withConfig({ colors: { primary: '#16A34A', dark: 'hsl(140 70% 40%)' } })
    expect(bundle.docsConfig.colors).toBeDefined()
    expect(messages(bundle).some((message) => message.includes('colors.dark "hsl(140 70% 40%)" is not a 3- or 6-digit hex colour'))).toBe(true)
    expect(messages(withConfig({ colors: { primary: 'green' } })).some((message) => message.includes('colors.primary "green"'))).toBe(true)
  })

  it('stays quiet for valid colours and metatags', () => {
    const bundle = withConfig({ colors: { primary: '#16a34a' }, seo: { metatags: { good: 'yes' } } })
    expect(messages(bundle).some((message) => /colors|metatags/.test(message))).toBe(false)
  })
})

describe('page-relative image that falls back to the site root', () => {
  const png = Buffer.from('PNGDATA')
  const nested = (gatedBody: string) => site({
    'docs.json': JSON.stringify({ navigation: { pages: ['v1/intro', 'secret'] } }),
    'v1/intro.mdx': '---\ntitle: Intro\n---\n\n![x](./images/shared.png)\n',
    'secret.mdx': `---\ntitle: Secret\ngroups: [admin]\n---\n\n${gatedBody}\n`,
    'images/shared.png': png,
  })

  it('warns that the root file was used and published, naming the page', () => {
    const bundle = nested('No image.')
    expect(bundle.assets.map((asset) => asset.path)).toContain('images/shared.png')
    const warning = codes(bundle, 'unsupported-config').find((item) => /not found beside this page/.test(item.message))
    expect(warning?.source).toBe('v1/intro.mdx')
    expect(warning?.message).toContain('"./images/shared.png"')
    expect(warning?.message).toContain('"images/shared.png" in the site root')
  })

  it('still publishes it when a gated page also uses the same file, because a published page spells it', () => {
    const bundle = nested('![x](/images/shared.png)')
    expect(bundle.assets.map((asset) => asset.path)).toContain('images/shared.png')
    expect(codes(bundle, 'unsupported-config').some((item) => /not found beside this page/.test(item.message))).toBe(true)
  })

  it('does not warn when the image sits beside the page', () => {
    const bundle = site({
      'docs.json': JSON.stringify({ navigation: { pages: ['v1/intro'] } }),
      'v1/intro.mdx': '---\ntitle: Intro\n---\n\n![x](./images/own.png)\n',
      'v1/images/own.png': png,
    })
    expect(codes(bundle, 'unsupported-config').some((item) => /not found beside this page/.test(item.message))).toBe(false)
  })
})

describe('page spec references that cannot be migrated explain why', () => {
  const spec = JSON.stringify({ openapi: '3.0.0', info: { title: 'T', version: '1' }, paths: { '/x': { get: { summary: 'S' } } } })
  const missing = (bundle: MigrationBundle) => codes(bundle, 'unsupported-config').find((item) => /references the OpenAPI spec/.test(item.message))!.message
  const nav = JSON.stringify({ navigation: { pages: ['pub'] } })

  it('names a case mismatch', () => {
    const message = missing(site({ 'docs.json': nav, 'api/spec.json': spec, 'pub.mdx': page('Pub', 'openapi: "/API/SPEC.json GET /x"\n') }))
    expect(message).toContain('paths are case-sensitive; the file is at "api/spec.json"')
    expect(message).not.toMatch(/api setting|not referenced from docs.json/)
  })

  it('names a .mintignore exclusion', () => {
    const message = missing(site({ '.mintignore': 'private/\n', 'docs.json': nav, 'private/spec.json': spec, 'pub.mdx': page('Pub', 'openapi: "/private/spec.json GET /x"\n') }))
    expect(message).toContain('excluded by .mintignore')
  })

  it('names a symbolic link', () => {
    const root = mkdtempSync(join(tmpdir(), 'thally-migrate-extras-'))
    writeFileSync(join(root, 'docs.json'), nav)
    writeFileSync(join(root, 'pub.mdx'), page('Pub', 'openapi: "/link.json GET /x"\n'))
    const outside = mkdtempSync(join(tmpdir(), 'thally-migrate-outside-'))
    writeFileSync(join(outside, 'real.json'), spec)
    symlinkSync(join(outside, 'real.json'), join(root, 'link.json'))
    const bundle = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/docs', platform: 'mintlify' })
    expect(missing(bundle)).toContain('symbolic link')
  })

  it('names a missing file', () => {
    expect(missing(site({ 'docs.json': nav, 'pub.mdx': page('Pub', 'openapi: "/nope.json GET /x"\n') }))).toContain('no file exists at "nope.json"')
  })
})

describe('asset reach is decided by exact normalized path, never by file name', () => {
  const png = Buffer.from('PNGDATA')
  const nav = JSON.stringify({ navigation: { pages: ['pub', 'secret'] } })
  const secret = (body: string) => `---\ntitle: Secret\ngroups: [admin]\n---\n\n${body}\n`
  const publicPaths = (bundle: MigrationBundle) => bundle.assets.map((asset) => asset.path)
  const quarantined = (bundle: MigrationBundle) => (bundle.quarantinedFiles ?? []).map((file) => file.path)

  it('keeps /private/logo.png in quarantine when a public page uses /public/logo.png', () => {
    const bundle = site({
      'docs.json': nav,
      'pub.mdx': '---\ntitle: Pub\n---\n\n![l](/public/logo.png)\n',
      'secret.mdx': secret('![l](/private/logo.png)'),
      'public/logo.png': png,
      'private/logo.png': png,
    })
    expect(publicPaths(bundle)).toContain('logo.png')
    expect(publicPaths(bundle)).not.toContain('private/logo.png')
    expect(quarantined(bundle)).toContain('migration-quarantine/assets/private/logo.png')
  }, 30_000)

  it('keeps the restricted folder copy private when the same filename is referenced relatively from two folders', () => {
    const bundle = site({
      'docs.json': JSON.stringify({ navigation: { pages: ['open/page', 'closed/page'] } }),
      'open/page.mdx': '---\ntitle: Open\n---\n\n![l](./img/logo.png)\n',
      'closed/page.mdx': secret('![l](./img/logo.png)'),
      'open/img/logo.png': png,
      'closed/img/logo.png': png,
    })
    expect(publicPaths(bundle)).toContain('open/img/logo.png')
    expect(publicPaths(bundle)).not.toContain('closed/img/logo.png')
    expect(quarantined(bundle)).toContain('migration-quarantine/assets/closed/img/logo.png')
  }, 30_000)

  it('matches a docs.json logo by its full path', () => {
    const bundle = site({
      'docs.json': JSON.stringify({ logo: { light: '/brand/logo.svg', dark: '/brand/logo.svg' }, navigation: { pages: ['pub', 'secret'] } }),
      'pub.mdx': page('Pub'),
      'secret.mdx': secret('![l](/internal/logo.svg)'),
      'brand/logo.svg': png,
      'internal/logo.svg': png,
    })
    expect(publicPaths(bundle)).toContain('brand/logo.svg')
    expect(publicPaths(bundle)).not.toContain('internal/logo.svg')
  }, 30_000)

  it('matches a frontmatter image by its full path', () => {
    const bundle = site({
      'docs.json': nav,
      'pub.mdx': '---\ntitle: Pub\nimage: /img/cover.png\n---\n\nHi\n',
      'secret.mdx': secret('![c](/restricted/cover.png)'),
      'img/cover.png': png,
      'restricted/cover.png': png,
    })
    expect(publicPaths(bundle)).toContain('img/cover.png')
    expect(publicPaths(bundle)).not.toContain('restricted/cover.png')
  }, 30_000)

  it('keeps candidates of an ambiguous bare-filename reference in quarantine and names them', () => {
    const bundle = site({
      'docs.json': nav,
      'pub.mdx': '---\ntitle: Pub\n---\n\nSee the file logo.png for the mark.\n',
      'secret.mdx': secret('![l](/private/logo.png)'),
      'private/logo.png': png,
      'other/logo.png': png,
    })
    expect(publicPaths(bundle)).not.toContain('private/logo.png')
    expect(publicPaths(bundle)).not.toContain('other/logo.png')
    const warning = codes(bundle, 'gated-page').find((item) => /does not give its folder/.test(item.message))
    expect(warning?.message).toContain('private/logo.png')
    expect(warning?.message).toContain('other/logo.png')
  }, 30_000)
})

describe('assets when the file budget dropped pages', () => {
  const png = Buffer.from('PNGDATA')
  const filler = (count: number): Record<string, string> => {
    const files: Record<string, string> = {}
    for (let i = 0; i < count; i++) files[`filler/f${i}.mdx`] = '---\ntitle: F\n---\n\nx\n'
    return files
  }
  const publicPaths = (bundle: MigrationBundle) => bundle.assets.map((asset) => asset.path)

  it('keeps the image of the only restricted page out of public/ when the budget dropped that page', () => {
    const bundle = site({
      'docs.json': JSON.stringify({ navigation: { pages: ['index'] } }),
      'index.mdx': '---\ntitle: I\n---\n\n![k](/img/kept.png)\n',
      ...filler(30),
      'zz/secret.mdx': '---\ntitle: S\ngroups: [admin]\n---\n\n![p](/img/private.png)\n',
      'img/kept.png': png,
      'img/private.png': png,
    }, { maxSourceFiles: 20 })
    expect(bundle.pages.some((entry) => entry.id.includes('secret'))).toBe(false)
    expect(publicPaths(bundle)).not.toContain('img/private.png')
    expect((bundle.quarantinedFiles ?? []).some((file) => file.path === 'migration-quarantine/assets/img/private.png')).toBe(true)
    expect(publicPaths(bundle)).toContain('img/kept.png')
    expect(codes(bundle, 'gated-page').some((item) => item.source === 'zz/secret.mdx' && /file limit/.test(item.message))).toBe(true)
  }, 30_000)

  it('quarantines the image of a dropped non-restricted page and says why', () => {
    const bundle = site({
      'docs.json': JSON.stringify({ navigation: { pages: ['index'] } }),
      'index.mdx': '---\ntitle: I\n---\n\n![k](/img/kept.png)\n',
      ...filler(30),
      'zz/dropped.mdx': '---\ntitle: D\n---\n\n![d](/img/dropped.png)\n',
      'img/kept.png': png,
      'img/dropped.png': png,
      'img/loose.png': png,
    }, { maxSourceFiles: 20 })
    expect(publicPaths(bundle)).toContain('img/kept.png')
    expect(publicPaths(bundle)).not.toContain('img/dropped.png')
    expect(publicPaths(bundle)).not.toContain('img/loose.png')
    expect((bundle.quarantinedFiles ?? []).map((file) => file.path)).toContain('migration-quarantine/assets/img/dropped.png')
    const conservative = codes(bundle, 'gated-page').filter((item) => /dropped by the file limit/.test(item.message))
    expect(conservative).toHaveLength(1)
  }, 30_000)

  it('keeps the image of a restricted snippet out of public/ when the budget dropped only that snippet', () => {
    const bundle = site({
      'docs.json': JSON.stringify({ navigation: { pages: ['index'] } }),
      'index.mdx': page('I'),
      'snippets/secret.mdx': '---\ngroups: [admin]\n---\n\n![s](/img/secret.png)\n',
      'img/secret.png': png,
    }, { maxSourceFiles: 2 })
    expect(publicPaths(bundle)).not.toContain('img/secret.png')
    expect((bundle.quarantinedFiles ?? []).map((file) => file.path)).toContain('migration-quarantine/assets/img/secret.png')
  }, 30_000)

  it('never publishes a restricted page or snippet image at any file budget', () => {
    const files = {
      'docs.json': JSON.stringify({ navigation: { pages: ['index', 'private'] } }),
      'index.mdx': '---\ntitle: I\n---\n\n![p](/img/public.png)\n',
      'private.mdx': '---\ntitle: P\ngroups: [admin]\n---\n\n![x](/img/private.png)\n',
      'guide.mdx': '---\ntitle: G\n---\n\nNo images.\n',
      'snippets/secret.mdx': '---\ngroups: [admin]\n---\n\n![s](/img/secret.png)\n',
      'snippets/open.mdx': 'Shared text.\n',
      'img/public.png': png,
      'img/private.png': png,
      'img/secret.png': png,
    }
    // Without the restricted page, the snippet is the only restricted content.
    const { 'private.mdx': _private, ...snippetOnly } = files
    for (const variant of [files, snippetOnly]) {
      for (let budget = 1; budget <= Object.keys(variant).length + 1; budget++) {
        const published = publicPaths(site(variant, { maxSourceFiles: budget }))
        expect(published, `${variant === files ? "full" : "snippet-only"} budget ${budget}`).not.toContain('img/private.png')
        expect(published, `${variant === files ? "full" : "snippet-only"} budget ${budget}`).not.toContain('img/secret.png')
      }
    }
  }, 60_000)

  it('keeps the image of a .mintignore\'d restricted page or snippet out of public/', () => {
    for (const [ignore, path] of [['r.mdx', 'r.mdx'], ['snippets/', 'snippets/s.mdx']]) {
      const bundle = site({
        'docs.json': JSON.stringify({ navigation: { pages: ['index'] } }),
        'index.mdx': page('I'),
        '.mintignore': `${ignore}\n`,
        [path]: '---\ntitle: R\ngroups: [a]\n---\n\n![s](/img/secret.png)\n',
        'img/secret.png': png,
      })
      expect(publicPaths(bundle), ignore).not.toContain('img/secret.png')
    }
  }, 30_000)

  it('does not let the icon of a restricted navigation group make an image public', () => {
    const bundle = site({
      'docs.json': JSON.stringify({ navigation: { groups: [
        { group: 'G', pages: ['index'] },
        { group: 'P', groups: ['a'], icon: '/img/secret.png', pages: ['r'] },
      ] } }),
      'index.mdx': page('I'),
      'r.mdx': page('R'),
      'img/secret.png': png,
    })
    expect(publicPaths(bundle)).not.toContain('img/secret.png')
  }, 30_000)

  it('counts the restricted pages the budget dropped on the bundle', () => {
    const bundle = site({
      'docs.json': JSON.stringify({ navigation: { pages: ['index'] } }),
      'index.mdx': page('I'),
      ...filler(30),
      'zz/a.mdx': page('A', 'groups: [admin]\n'),
      'zz/b.mdx': page('B', 'public: false\n'),
    }, { maxSourceFiles: 20 })
    expect(bundle.droppedGatedPages).toBe(2)
  }, 30_000)

  it('is unchanged for a site under the budget', () => {
    const bundle = site({
      'docs.json': JSON.stringify({ navigation: { pages: ['index'] } }),
      'index.mdx': '---\ntitle: I\n---\n\n![k](/img/kept.png)\n',
      ...filler(50),
      'img/kept.png': png,
      'img/loose.png': png,
    })
    expect(publicPaths(bundle)).toEqual(expect.arrayContaining(['img/kept.png', 'img/loose.png']))
    expect(bundle.quarantinedFiles).toBeUndefined()
    expect(bundle.warnings.some((item) => /file limit/.test(item.message) && item.code === 'gated-page')).toBe(false)
  }, 30_000)
})

describe('asset and spec decisions that must not err toward public', () => {
  const png = Buffer.from('PNGDATA')
  const publicPaths = (bundle: MigrationBundle) => bundle.assets.map((asset) => asset.path)
  const quarantined = (bundle: MigrationBundle) => (bundle.quarantinedFiles ?? []).map((file) => file.path)

  it('treats a snippet that declares groups as restricted content: its image and unreferenced images stay out of public/', () => {
    const bundle = site({
      'docs.json': JSON.stringify({ navigation: { pages: ['pub'] } }),
      'pub.mdx': page('Pub'),
      'snippets/s.mdx': '---\ngroups: [a]\n---\n\n![s](/img/snippet-only.png)\n',
      'img/snippet-only.png': png,
      'img/loose.png': png,
    })
    expect(publicPaths(bundle)).not.toContain('img/snippet-only.png')
    expect(publicPaths(bundle)).not.toContain('img/loose.png')
    expect(quarantined(bundle)).toContain('migration-quarantine/assets/img/snippet-only.png')
  }, 30_000)

  it('does not count the images of a page that was skipped as a duplicate as published references', () => {
    const bundle = site({
      'docs.json': JSON.stringify({ navigation: { pages: ['pub', 'secret'] } }),
      'pub.mdx': page('Pub'),
      'secret.mdx': page('Secret', 'groups: [admin]\n'),
      'dup.mdx': '---\ntitle: Dup\nimage: /img/kept.png\n---\n\n![k](/img/kept.png)\n',
      'dup/index.mdx': '---\ntitle: Dup2\nimage: /img/skipped2.png\n---\n\n![s](/img/skipped.png)\n',
      'img/kept.png': png,
      'img/skipped.png': png,
      'img/skipped2.png': png,
    })
    expect(codes(bundle, 'collision')).toHaveLength(1)
    expect(publicPaths(bundle)).toContain('img/kept.png')
    expect(publicPaths(bundle)).not.toContain('img/skipped.png')
    expect(publicPaths(bundle)).not.toContain('img/skipped2.png')
  }, 30_000)

  it('quarantines two files that map to the same public path on a restricted site', () => {
    const bundle = site({
      'docs.json': JSON.stringify({ navigation: { pages: ['pub', 'secret'] } }),
      'pub.mdx': '---\ntitle: Pub\n---\n\n![l](/logo.png)\n',
      'secret.mdx': page('Secret', 'groups: [admin]\n'),
      'public/logo.png': png,
      'logo.png': Buffer.from('RESTRICTED'),
    })
    expect(publicPaths(bundle)).not.toContain('logo.png')
    expect(quarantined(bundle)).toContain('migration-quarantine/assets/logo.png')
  }, 30_000)

  it('keeps a letter-case variant of a path in frontmatter from making a file public', () => {
    const bundle = site({
      'docs.json': JSON.stringify({ navigation: { pages: ['pub', 'secret'] } }),
      'pub.mdx': '---\ntitle: Pub\nimage: /IMG/cover.png\n---\n\nHi\n',
      'secret.mdx': page('Secret', 'groups: [admin]\n'),
      'img/cover.png': png,
    })
    expect(publicPaths(bundle)).not.toContain('img/cover.png')
    expect(codes(bundle, 'gated-page').some((item) => /does not give its folder/.test(item.message) && /img\/cover\.png/.test(item.message))).toBe(true)
  }, 30_000)

  it('does not let a path that merely ends like a spec path publish the spec', () => {
    const spec = JSON.stringify({ openapi: '3.0.0', info: { title: 'T', version: '1' }, paths: { '/x': { get: { summary: 'SECRETSUMMARY' } } } })
    const bundle = site({
      'docs.json': JSON.stringify({ navigation: { pages: ['pub', 's'] } }),
      's.mdx': page('S', 'groups: [admin]\nopenapi: GET /x\n'),
      'pub.mdx': page('Pub', 'openapi: pi/openapi.json GET /x\n'),
      'api/openapi.json': spec,
    })
    expect(publicPaths(bundle).filter((path) => path.endsWith('openapi.json'))).toEqual([])
  }, 30_000)
  it('matches a differently-cased link by the real on-disk spelling on a case-insensitive filesystem', (context) => {
    const probe = mkdtempSync(join(tmpdir(), 'thally-case-'))
    writeFileSync(join(probe, 'a'), '')
    if (!existsSync(join(probe, 'A'))) { context.skip(); return }
    const bundle = site({
      'docs.json': JSON.stringify({ navigation: { pages: ['pub', 'secret'] } }),
      'pub.mdx': '---\ntitle: Pub\n---\n\n![l](/IMG/Logo.PNG)\n',
      'secret.mdx': page('Secret', 'groups: [admin]\n'),
      'img/logo.png': png,
      'img/other.png': png,
    })
    expect(publicPaths(bundle)).toContain('img/logo.png')
    expect(publicPaths(bundle)).not.toContain('img/other.png')
  }, 30_000)
})
