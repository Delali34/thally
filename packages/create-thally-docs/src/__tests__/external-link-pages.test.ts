/** A migrated Mintlify page that links elsewhere passes `thally check`: it is in the navigation and its path redirects off the site. */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { migrateRepository, renderMigrationFiles } from '@thallylabs/migrate'
import { describe, expect, it, vi } from 'vitest'

import { runCheck } from '../check.js'

describe('thally check on a migrated page whose frontmatter url is another site', () => {
  it('reports no orphan, no missing page and no broken link for the page or a link to it', async () => {
    const source = mkdtempSync(join(tmpdir(), 'thally-link-page-source-'))
    writeFileSync(join(source, 'docs.json'), JSON.stringify({
      navigation: { groups: [{ group: 'Community', pages: ['introduction', 'github-repo'] }] },
    }))
    writeFileSync(join(source, 'introduction.mdx'), '---\ntitle: Introduction\ndescription: Where the project lives.\n---\n\nThe [source code](/github-repo) is public, and this page has enough prose to avoid the short body notice.')
    writeFileSync(join(source, 'github-repo.mdx'), '---\ntitle: GitHub repo\ndescription: The source code.\nurl: "https://github.com/acme/docs"\n---\n\nThe project is open source on GitHub, so anyone can read and change it.')
    const bundle = migrateRepository({ repositoryDir: source, sourceUrl: 'https://github.com/acme/docs', platform: 'mintlify' })

    const site = mkdtempSync(join(tmpdir(), 'thally-link-page-site-'))
    for (const file of renderMigrationFiles(bundle)) {
      mkdirSync(dirname(join(site, file.path)), { recursive: true })
      writeFileSync(join(site, file.path), file.content)
    }
    const output: Array<string> = []
    const log = vi.spyOn(console, 'log').mockImplementation((value) => output.push(String(value)))
    try {
      expect(await runCheck(site, { fix: false, ci: true })).toBe(0)
    } finally {
      log.mockRestore()
    }
    expect(output.join('\n')).not.toMatch(/orphan|no MDX file|Broken/)
  })
})
