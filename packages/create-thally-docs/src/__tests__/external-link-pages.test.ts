/** A migrated Mintlify page that links elsewhere passes `thally check`: it is in the navigation and its path redirects off the site. */

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
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

describe('thally check on the stub the migrator writes for a Mintlify url entry', () => {
  const stubWarning = /Very short body|Missing "description"/

  /** Migrate a site whose `github-repo` page is only a title and a `url`, plus an ordinary short page, and return the check issues by file. */
  async function issuesByFile(extra: Record<string, string> = {}, editSite?: (site: string) => void): Promise<Map<string, Array<string>>> {
    const source = mkdtempSync(join(tmpdir(), 'thally-link-stub-source-'))
    writeFileSync(join(source, 'docs.json'), JSON.stringify({
      navigation: { groups: [{ group: 'Community', pages: ['introduction', 'github-repo', 'short'] }] },
    }))
    writeFileSync(join(source, 'introduction.mdx'), '---\ntitle: Introduction\ndescription: Where the project lives.\n---\n\nThis page has enough prose to avoid the short body notice, and it links nowhere.')
    writeFileSync(join(source, 'github-repo.mdx'), '---\ntitle: GitHub repo\nurl: "https://github.com/acme/docs"\n---\n')
    writeFileSync(join(source, 'short.mdx'), '---\ntitle: Short\n---\n')
    for (const [file, content] of Object.entries(extra)) writeFileSync(join(source, file), content)
    const bundle = migrateRepository({ repositoryDir: source, sourceUrl: 'https://github.com/acme/docs', platform: 'mintlify' })
    const site = mkdtempSync(join(tmpdir(), 'thally-link-stub-site-'))
    for (const file of renderMigrationFiles(bundle)) {
      mkdirSync(dirname(join(site, file.path)), { recursive: true })
      writeFileSync(join(site, file.path), file.content)
    }
    editSite?.(site)
    const found: Array<{ file?: string; message: string }> = []
    await runCheck(site, { fix: false, ci: true, silent: true, onIssues: (issues) => found.push(...issues) })
    const byFile = new Map<string, Array<string>>()
    for (const issue of found) byFile.set(issue.file ?? '', [...(byFile.get(issue.file ?? '') ?? []), issue.message])
    return byFile
  }

  it('does not warn that the page has no description or body', async () => {
    const byFile = await issuesByFile()
    expect(byFile.get('src/content/github-repo.mdx') ?? []).toEqual([])
  })

  it('does not warn when the stub redirects to a path on the site instead of another site', async () => {
    // What a root-relative `url:` (`/introduction#login`) becomes: the same never-rendered stub, redirecting within the site.
    const byFile = await issuesByFile({}, (site) => {
      writeFileSync(join(site, 'src/content/github-repo.mdx'), '---\ntitle: GitHub repo\nnoindex: true\n---\n')
      const config = JSON.parse(readFileSync(join(site, 'docs.json'), 'utf8')) as { redirects?: Array<{ source: string }> }
      config.redirects = [...(config.redirects ?? []).filter((redirect) => redirect.source !== '/github-repo'),
        { source: '/github-repo', destination: '/introduction#login' } as { source: string }]
      writeFileSync(join(site, 'docs.json'), JSON.stringify(config))
    })
    expect((byFile.get('src/content/github-repo.mdx') ?? []).filter((message) => stubWarning.test(message))).toEqual([])
  })

  describe('when the redirect from the stub does not lead anywhere', () => {
    /** The same stub, with these redirects instead of the one the migrator wrote. */
    const withRedirects = (redirects: Array<{ source: string; destination: string }>) => issuesByFile({}, (site) => {
      writeFileSync(join(site, 'src/content/github-repo.mdx'), '---\ntitle: GitHub repo\nnoindex: true\n---\n')
      const config = JSON.parse(readFileSync(join(site, 'docs.json'), 'utf8')) as { redirects?: Array<{ source: string }> }
      config.redirects = [...(config.redirects ?? []).filter((redirect) => redirect.source !== '/github-repo'), ...redirects] as Array<{ source: string }>
      writeFileSync(join(site, 'docs.json'), JSON.stringify(config))
    })
    const reported = async (redirects: Array<{ source: string; destination: string }>) =>
      (await withRedirects(redirects)).get('src/content/github-repo.mdx') ?? []

    it('reports a redirect to a page that does not exist, and keeps the stub warnings', async () => {
      const messages = await reported([{ source: '/github-repo', destination: '/missing' }])
      expect(messages.filter((message) => /Broken redirect.*\/github-repo.*\/missing/.test(message))).toHaveLength(1)
      expect(messages.filter((message) => stubWarning.test(message))).toHaveLength(2)
    })

    it('reports a redirect to itself', async () => {
      const messages = await reported([{ source: '/github-repo', destination: '/github-repo' }])
      expect(messages.filter((message) => /Broken redirect.*loop/.test(message))).toHaveLength(1)
    })

    it('reports a chain of redirects that comes back to the stub', async () => {
      const messages = await reported([{ source: '/github-repo', destination: '/other' }, { source: '/other', destination: '/github-repo' }])
      expect(messages.filter((message) => /Broken redirect.*loop/.test(message))).toHaveLength(1)
    })

    // Next matches a redirect source as the runtime does: ignoring letter case, with or without a trailing slash, with a regular
    // expression for a parameter, and on the path alone. Where the check cannot read a source it cannot tell, so it says nothing.
    it('follows a source the way the runtime matches it', async () => {
      for (const redirects of [
        [{ source: '/github-repo', destination: '/OTHER' }, { source: '/other', destination: '/introduction' }],
        [{ source: '/github-repo', destination: '/other' }, { source: '/OTHER', destination: '/introduction' }],
        [{ source: '/github-repo', destination: '/other/' }, { source: '/other', destination: '/introduction' }],
        [{ source: '/github-repo', destination: '/other' }, { source: '/other/', destination: '/introduction' }],
        [{ source: '/github-repo', destination: '/other?from=stub#top' }, { source: '/other', destination: '/introduction' }],
        [{ source: '/github-repo', destination: '/old/a' }, { source: '/old/:path(.*)', destination: '/introduction' }],
        [{ source: '/github-repo', destination: '/old/a/b' }, { source: '/old/:path(.*)', destination: '/introduction' }],
        [{ source: '/github-repo', destination: '/OLD/a' }, { source: '/old/:path*', destination: '/introduction' }],
        [{ source: '/github-repo', destination: '/old/a/b' }, { source: '/old/:path*', destination: '/introduction' }],
        [{ source: '/github-repo', destination: '/old' }, { source: '/old/:path*', destination: '/introduction' }],
        [{ source: '/github-repo', destination: '/old/a' }, { source: '/old/:path(a|b)', destination: '/introduction' }],
        [{ source: '/github-repo', destination: '/old/a' }, { source: '/old/:path(.*)', destination: '/other/:path' }, { source: '/other/a', destination: '/introduction' }],
      ]) {
        expect(await reported(redirects), JSON.stringify(redirects)).toEqual([])
      }
    })

    it('still reports a chain that a source of that syntax sends nowhere', async () => {
      for (const redirects of [
        [{ source: '/github-repo', destination: '/old/a' }, { source: '/old/:path(.*)', destination: '/missing' }],
        [{ source: '/github-repo', destination: '/old/a' }, { source: '/old/:path*', destination: '/missing' }],
        [{ source: '/github-repo', destination: '/OTHER' }, { source: '/other', destination: '/missing' }],
        // The pattern does not match, so nothing redirects `/old/c` and it is no page.
        [{ source: '/github-repo', destination: '/old/c' }, { source: '/old/:path(a|b)', destination: '/introduction' }],
      ]) {
        const messages = await reported(redirects)
        expect(messages.filter((message) => /Broken redirect/.test(message)), JSON.stringify(redirects)).toHaveLength(1)
      }
    })

    it('says nothing about a destination a source it cannot read might redirect', async () => {
      // A backslash escape and a group are route syntax the check does not read: `/legacy/a-x` may be what each of them matches.
      for (const unreadable of ['/legacy/:slug\\-x', '/legacy{/:slug}?']) {
        expect(await reported([{ source: '/github-repo', destination: '/legacy/a-x' }, { source: unreadable, destination: '/introduction' }]), unreadable).toEqual([])
      }
      // A destination it can tell they do not match is still no page.
      const messages = await reported([{ source: '/github-repo', destination: '/missing' }, { source: '/legacy/:slug\\-x', destination: '/introduction' }])
      expect(messages.filter((message) => /Broken redirect/.test(message))).toHaveLength(1)
    })

    it('reports nothing when the chain ends on a page or another site', async () => {
      for (const redirects of [
        [{ source: '/github-repo', destination: '/other' }, { source: '/other', destination: '/introduction' }],
        [{ source: '/github-repo', destination: '/introduction#login' }],
        [{ source: '/github-repo', destination: '/other' }, { source: '/other', destination: 'https://github.com/acme/docs' }],
      ]) {
        expect(await reported(redirects)).toEqual([])
      }
    })
  })

  it('still warns about an ordinary short page next to it', async () => {
    const byFile = await issuesByFile()
    expect((byFile.get('src/content/short.mdx') ?? []).filter((message) => stubWarning.test(message))).toHaveLength(2)
  })

  it('still warns about a short page that is noindex but redirects nowhere', async () => {
    const byFile = await issuesByFile({ 'short.mdx': '---\ntitle: Short\nnoindex: true\n---\n' })
    expect((byFile.get('src/content/short.mdx') ?? []).filter((message) => stubWarning.test(message))).toHaveLength(2)
  })
})
