/** A full asset budget drops spare files first, never the site's branding or stylesheet. */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { migrateRepository } from '../index.js'

const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect width="1" height="1"/></svg>'

function site(budget: number, config: Record<string, unknown> = { logo: { light: '/logo/light.svg', dark: '/logo/dark.svg' }, favicon: '/favicon.ico' }, extra: Record<string, string | Buffer> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'thally-migrate-budget-'))
  const files: Record<string, string | Buffer> = {
    'docs.json': JSON.stringify({
      $schema: 'https://mintlify.com/docs.json',
      name: 'Acme',
      ...config,
      navigation: { pages: ['home'] },
    }),
    'home.mdx': '---\ntitle: Home\n---\n\n![One](/images/one.png)\n\n![Two](/images/two.png)\n\n<p className="card">Styled</p>\n',
    'style.css': '.card { padding: 1rem; }',
    'logo/light.svg': svg,
    'logo/dark.svg': svg,
    'favicon.ico': Buffer.alloc(100, 1),
    // Page-referenced images, then one that nothing uses.
    'images/one.png': Buffer.alloc(300, 2),
    'images/two.png': Buffer.alloc(300, 3),
    'images/unused.png': Buffer.alloc(300, 4),
    ...extra,
  }
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), content)
  }
  return migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/docs', platform: 'mintlify', maxTotalAssetBytes: budget })
}

describe('asset budget priority', () => {
  // Images alone use 900 of the 1,000 bytes; the logos, favicon and stylesheet need about 300 more.
  const bundle = site(1_000)
  const copied = bundle.assets.map((asset) => asset.path)

  it('copies the logo and favicon docs.json names before any image', () => {
    expect(copied).toEqual(expect.arrayContaining(['logo/light.svg', 'logo/dark.svg', 'favicon.ico']))
    expect(bundle.docsConfig.navbar?.logo).toMatchObject({ light: '/logo/light.svg', dark: '/logo/dark.svg' })
    expect(bundle.docsConfig.favicon).toMatchObject({ light: '/favicon.ico' })
    expect(bundle.warnings.map((warning) => warning.message).join('\n')).not.toContain('Brand asset(s) were referenced but not imported')
  })

  it('keeps the root stylesheet when images fill the budget', () => {
    expect(bundle.docsConfig.stylesheets).toHaveLength(1)
    expect(bundle.warnings.map((warning) => warning.message).join('\n')).not.toContain('exceeded the asset budget')
  })

  it('still copies the images pages use before an image nothing uses', () => {
    expect(copied).toEqual(expect.arrayContaining(['images/one.png', 'images/two.png']))
    expect(copied).not.toContain('images/unused.png')
    expect(bundle.warnings.some((warning) => warning.code === 'limit-reached' && warning.message.includes('images/unused.png'))).toBe(true)
  })
})

describe('asset budget priority for bare docs.json file names', () => {
  // `logo.svg` and `favicon.ico` name root files without a slash; the page image alone nearly fills 350 bytes.
  const bundle = site(350, { logo: { light: 'logo.svg' }, favicon: 'favicon.ico' }, { 'logo.svg': svg })
  const copied = bundle.assets.map((asset) => asset.path)

  it('copies a logo and favicon docs.json spells without a slash before a page image', () => {
    expect(copied).toEqual(expect.arrayContaining(['logo.svg', 'favicon.ico']))
    expect(copied).not.toContain('images/one.png')
    expect(bundle.docsConfig.navbar?.logo).toMatchObject({ light: '/logo.svg' })
    expect(bundle.docsConfig.favicon).toMatchObject({ light: '/favicon.ico' })
  })

  it('warns about the page image the budget dropped', () => {
    expect(bundle.warnings.some((warning) => warning.code === 'limit-reached' && warning.message.includes('images/one.png'))).toBe(true)
  })
})
