/** Published server entries must resolve independently of repository import capabilities. */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const packageDirectory = fileURLToPath(new URL('../../', import.meta.url))
const emitted = (name: string) => readFileSync(new URL(`../../dist/${name}`, import.meta.url), 'utf8')

describe('published server entrypoints', () => {
  it('loads only the passive SVG validator from its package subpath', () => {
    const result = execFileSync(process.execPath, ['--input-type=module', '-e', `
      const policy = await import('@thallylabs/migrate/svg-policy');
      console.log(JSON.stringify({
        keys: Object.keys(policy),
        passive: policy.isPassiveSvg(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>')),
        active: policy.isPassiveSvg(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>')),
      }));
    `], { cwd: packageDirectory, encoding: 'utf8' })
    expect(JSON.parse(result)).toEqual({ keys: ['isPassiveSvg'], passive: true, active: false })
    const source = emitted('svg-policy.js')
    expect(source).not.toMatch(/index\.js|chunk-/u)
    expect(source.match(/from "[^"]+"/gu)).toEqual(['from "htmlparser2"'])
    expect(emitted('svg-policy.d.ts')).toContain('isPassiveSvg')
  })

  it('runs and renders URLs without bundling repository discovery', () => {
    const result = execFileSync(process.execPath, ['--input-type=module', '-e', `
      const entry = await import('@thallylabs/migrate/url-migration');
      const source = 'https://docs.test/guide';
      const run = await entry.runUrlMigration({ sourceUrl: source, maxPages: 1,
        fetcher: async url => ({ finalUrl: url, status: url.href === source ? 200 : 404,
          contentType: 'text/html', body: url.href === source ? '<article><h1>Guide</h1><p>Preserved payload.</p></article>' : '' }),
      });
      console.log(JSON.stringify({ keys: Object.keys(entry).sort(), status: run.validation.status,
        paths: entry.renderMigrationFiles(run.bundle).map(file => file.path) }));
    `], { cwd: packageDirectory, encoding: 'utf8' })
    expect(JSON.parse(result)).toMatchObject({
      keys: ['classifyMigrationResponse', 'renderMigrationFiles', 'runUrlMigration', 'validateUrlMigration'],
      status: 'passed', paths: expect.arrayContaining(['src/content/guide.mdx', 'docs.json']),
    })
    const source = emitted('url-migration.js')
    expect(source).not.toMatch(/src\/(?:repository|source-refs|fern|docusaurus)\.ts|child_process|\b(?:readFileSync|readdirSync|spawn)\s*\(|index\.js|chunk-/u)
    expect(emitted('url-migration.d.ts')).toContain('runUrlMigration')
  })
})
