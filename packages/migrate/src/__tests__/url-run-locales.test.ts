/** Imported locale paths must resolve through the real portable runtime contracts. */
import { describe, expect, it, vi } from 'vitest'
import { runUrlMigration } from '../url-run.js'
import { renderMigrationFiles } from '../render.js'
import type { MigrationCapture, MigrationCaptureProvider } from '../url-run-types.js'
import type { ContentSource } from '../../../../src/lib/content-source'
import { normalizeI18nConfig, localizedPath } from '../../../../src/lib/i18n/config'
import { resolveDocRoute } from '../../../../src/lib/i18n/doc-route'
import { findDocSource } from '../../../../src/lib/i18n/translation-source'

const config = vi.hoisted(() => ({ current: { defaultLocale: 'en', locales: [{ code: 'en', label: 'English' }] } }))
vi.mock('../../../../src/data/docs', () => ({ getI18nConfig: () => config.current }))
vi.mock('../../../../src/lib/content-source', () => ({ getContentSource: vi.fn() }))

function fixture(paths: Array<string>, explicitLocale = false) {
  let calls = 0
  const captures = new Map(paths.map((path) => {
    const parts = path.split('/')
    const locale = parts.find((part) => ['en', 'fr'].includes(part)) ?? 'en'
    const version = parts.find((part) => /^v\d$/u.test(part)) ?? 'v1'
    const capture: MigrationCapture = { finalUrl: new URL(`https://docs.test${path}`), contentType: 'text/html', status: 200,
      ...(explicitLocale ? { locale: locale === 'en' ? 'EN' : 'fr', version } : {}),
      body: `<article><h1>${locale} ${version} guide</h1><h2 id="example">Example</h2><pre><code>${locale}/${version}: {keep}\n</code></pre>${paths.filter((value) => value !== path).map((value) => `<a href="${value}#example">Related guide</a>`).join('')}</article>` }
    return [path, capture] as const
  }))
  const provider: MigrationCaptureProvider = { async capture({ url }) {
    calls++
    return captures.get(url.pathname) ?? { finalUrl: url, contentType: 'text/plain', status: 404, body: '' }
  } }
  return { provider, calls: () => calls }
}

function runtimeSource(files: ReturnType<typeof renderMigrationFiles>): ContentSource {
  const content = new Map(files.map((file) => [file.path, String(file.content)]))
  return { kind: 'assets', exists: async (path: string) => content.has(path), read: async (path: string) => content.has(path) ? { content: content.get(path)!, modifiedAtMs: 1 } : null } as unknown as ContentSource
}

async function resolvedFile(source: ContentSource, path: string) {
  const route = resolveDocRoute(path.split('/').filter(Boolean), config.current)
  return findDocSource(source, route.docSlug?.join('/') ?? '', route.locale)
}

describe('URL locale output and runtime lookup', () => {
  it.each([false, true])('serves primary/secondary versions and switcher paths (explicit metadata: %s)', async (explicit) => {
    const paths = ['/docs/en/v1/guide', '/docs/fr/v1/guide', '/docs/en/v2/guide', '/docs/fr/v2/guide']
    const capture = fixture(paths, explicit)
    const run = await runUrlMigration({ sourceUrl: `https://docs.test${paths[0]}`, scopePath: '/docs', captureProvider: capture.provider })
    expect(run.validation.issues).toEqual([])
    config.current = normalizeI18nConfig(run.bundle.docsConfig.i18n)
    expect(config.current.defaultLocale).toBe('en')
    const files = renderMigrationFiles(run.bundle)
    expect(files.filter((file) => file.path.endsWith('.mdx')).map((file) => file.path).sort()).toEqual(['src/content/fr/v1/guide.mdx', 'src/content/fr/v2/guide.mdx', 'src/content/v1/guide.mdx', 'src/content/v2/guide.mdx'])
    const source = runtimeSource(files)
    for (const version of ['v1', 'v2']) for (const locale of ['en', 'fr']) {
      const path = localizedPath(`/${version}/guide`, locale, config.current.defaultLocale)
      const found = await resolvedFile(source, path)
      expect(found?.filePath).toBe(`src/content/${locale === 'en' ? '' : 'fr/'}${version}/guide.mdx`)
      expect(found?.isFallback).toBe(false)
      const content = await source.read(found!.filePath)
      expect(content?.content).toContain(`${locale}/${version}: {keep}\n`)
    }
    expect(run.bundle.pages.find((page) => page.id === 'v1/guide')?.body).toContain('(/fr/v1/guide#example)')
    const committed = JSON.stringify(run.checkpoint)
    const previousCalls = capture.calls()
    const resumed = await runUrlMigration({ sourceUrl: `https://docs.test${paths[0]}`, scopePath: '/docs', captureProvider: capture.provider, checkpoint: JSON.parse(committed) })
    expect(capture.calls()).toBe(previousCalls)
    expect(renderMigrationFiles(resumed.bundle)).toEqual(files)
    expect(JSON.stringify(resumed.checkpoint)).toBe(committed)
  })

  it('serves a French-only site as its observed primary language without inventing English content', async () => {
    const capture = fixture(['/docs/fr/v1/guide', '/docs/fr/v2/guide'])
    const run = await runUrlMigration({ sourceUrl: 'https://docs.test/docs/fr/v1/guide', scopePath: '/docs', captureProvider: capture.provider })
    expect(run.validation.status).toBe('passed')
    config.current = normalizeI18nConfig(run.bundle.docsConfig.i18n)
    expect(config.current).toEqual({ defaultLocale: 'fr', locales: [{ code: 'fr', label: 'fr' }] })
    const source = runtimeSource(renderMigrationFiles(run.bundle))
    expect((await resolvedFile(source, '/v1/guide'))?.filePath).toBe('src/content/v1/guide.mdx')
    expect(run.bundle.pages[0].body).toContain('(/v2/guide#example)')
  })

  it('requires review for an orphan secondary translation that the runtime cannot serve', async () => {
    const capture = fixture(['/docs/en/v1/guide', '/docs/fr/v2/guide'])
    const run = await runUrlMigration({ sourceUrl: 'https://docs.test/docs/en/v1/guide', scopePath: '/docs', captureProvider: capture.provider })
    expect(run.validation.status).toBe('partial')
    expect(run.validation.issues).toContainEqual(expect.objectContaining({ code: 'missing-page', message: expect.stringContaining('orphan translation') }))
    config.current = normalizeI18nConfig(run.bundle.docsConfig.i18n)
    expect(await resolvedFile(runtimeSource(renderMigrationFiles(run.bundle)), '/fr/v2/guide')).toBeNull()
    expect(run.bundle.pages.some((page) => page.id === 'v2/guide')).toBe(false)
  })

  it('observes fresh native HTML language even when the selected scope removes its URL prefix', async () => {
    const provider: MigrationCaptureProvider = { async capture({ url }) {
      return { finalUrl: url, contentType: 'text/html', status: url.pathname === '/docs/fr/v2/guide' ? 200 : 404,
        body: url.pathname === '/docs/fr/v2/guide' ? '<html lang="fr"><article><h1>Guide français</h1><p>Contenu français.</p></article></html>' : '' }
    } }
    const run = await runUrlMigration({ sourceUrl: 'https://docs.test/docs/fr/v2/guide', scopePath: '/docs/fr/v2', captureProvider: provider })
    expect(run.validation.status).toBe('passed')
    expect(run.bundle.docsConfig.i18n?.defaultLocale).toBe('fr')
    expect(run.bundle.pages[0]).toMatchObject({ id: 'guide', locale: 'fr' })
    expect(run.checkpoint.records.find((record) => record.page)?.version).toBe('v2')
    config.current = normalizeI18nConfig(run.bundle.docsConfig.i18n)
    expect((await resolvedFile(runtimeSource(renderMigrationFiles(run.bundle)), '/guide'))?.filePath).toBe('src/content/guide.mdx')
    const oldJournal = { ...run.checkpoint, converterVersion: 'url-evidence-v1' }
    const unavailable = vi.fn(async () => { throw new Error('Old journals must fail before any capture.') })
    await expect(runUrlMigration({ sourceUrl: run.checkpoint.sourceUrl, scopePath: run.checkpoint.scopePath,
      captureProvider: { capture: unavailable }, checkpoint: oldJournal })).rejects.toThrow('Checkpoint does not match')
    expect(unavailable).not.toHaveBeenCalled()
  })

  it('uses HTML language on a neutral URL and reports conflicting or unrecognized language evidence', async () => {
    for (const declared of ['fr', 'en_US']) {
      const provider: MigrationCaptureProvider = { async capture({ url }) {
        return { finalUrl: url, contentType: 'text/html', status: url.pathname === '/docs/guide' ? 200 : 404,
          body: url.pathname === '/docs/guide' ? `<html lang="${declared}"><article><h1>Guide</h1><p>Source payload.</p></article></html>` : '' }
      } }
      const run = await runUrlMigration({ sourceUrl: 'https://docs.test/docs/guide', scopePath: '/docs', captureProvider: provider })
      if (declared === 'fr') {
        expect(run.validation.status).toBe('passed')
        expect(run.bundle.docsConfig.i18n?.defaultLocale).toBe('fr')
      } else {
        expect(run.validation.status).toBe('partial')
        expect(run.validation.issues.some((issue) => issue.message.includes('unsupported HTML language'))).toBe(true)
      }
    }
    const capture = fixture(['/docs/fr/v1/guide'])
    const run = await runUrlMigration({ sourceUrl: 'https://docs.test/docs/fr/v1/guide', scopePath: '/docs',
      captureProvider: { async capture(request) { const result = await capture.provider.capture(request); return { ...result, body: `<html lang="en">${result.body}</html>` } } } })
    expect(run.validation.status).toBe('partial')
    expect(run.validation.issues.some((issue) => issue.message.includes('locale metadata disagrees'))).toBe(true)
  })

  it('reports primary output collisions rather than silently overwriting localized aliases', async () => {
    const capture = fixture(['/docs/en/v1/guide', '/docs/v1/guide'])
    const run = await runUrlMigration({ sourceUrl: 'https://docs.test/docs/en/v1/guide', scopePath: '/docs', captureProvider: capture.provider })
    expect(run.validation.status).toBe('partial')
    expect(run.validation.issues).toContainEqual(expect.objectContaining({ code: 'collision', message: expect.stringContaining('v1/guide') }))
  })
})
