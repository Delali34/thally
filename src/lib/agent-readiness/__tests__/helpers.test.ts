/** Unit coverage for the readiness link resolver, JSON-LD validator, and golden-question config. */

import { describe, expect, it } from 'vitest'
import { compileRedirectSource, findBrokenLinks, MAX_BROKEN_LINKS_PER_PAGE, type LinkIndex } from '@/lib/agent-readiness/links'
import { isIsoDate, validateDocJsonLd } from '@/lib/agent-readiness/json-ld'
import {
  MAX_GOLDEN_QUESTIONS,
  MAX_TOP_K,
  readGoldenQuestionConfig,
  runGoldenQuestions,
} from '@/lib/agent-readiness/golden'
import { buildDocPageJsonLd } from '@/lib/json-ld'

describe('findBrokenLinks', () => {
  const index: LinkIndex = {
    pages: new Map([
      ['/', new Set<string>()],
      ['/guides/setup', new Set(['install', 'configure'])],
      ['/api/overview', new Set<string>()],
    ]),
    extraPaths: new Set(['/api/default/users/get']),
    redirects: [compileRedirectSource('/legacy/:path*')!],
    locales: new Set(['fr']),
  }

  it('accepts resolvable targets and flags dead pages and anchors', () => {
    const broken = findBrokenLinks(
      [
        '/', '/guides/setup/', '/guides/setup#install', '/guides/setup?tab=1#configure',
        '/guides/setup#gone', '/guides/missing', '/api/default/users/get#response',
        '/api/overview', '/api/unknown-runtime-route', '/legacy', '/legacy/a/b', '/fr/guides/setup#translated',
        '/images/logo.png', 'mailto:hi@example.com', '//cdn.example.com/x', 'https://x.dev', 'sibling',
        '#local', '#missing', '/guides/missing',
      ],
      new Set(['local']),
      index,
    )
    expect(broken).toEqual([
      { target: '/guides/setup#gone', kind: 'anchor' },
      { target: '/guides/missing', kind: 'page' },
      { target: '#missing', kind: 'anchor' },
    ])
  })

  it('skips same-page anchors when the page renders anchors outside the content graph', () => {
    expect(findBrokenLinks(['#param-id', '/guides/missing'], null, index)).toEqual([{ target: '/guides/missing', kind: 'page' }])
  })

  it('decodes percent-encoded fragments and paths', () => {
    const encoded: LinkIndex = { ...index, pages: new Map([['/guides/café', new Set(['überblick'])]]) }
    expect(findBrokenLinks(['/guides/caf%C3%A9#%C3%BCberblick'], new Set(), encoded)).toEqual([])
  })

  it('caps recorded links per page', () => {
    const urls = Array.from({ length: MAX_BROKEN_LINKS_PER_PAGE + 5 }, (_, i) => `/nope-${i}`)
    expect(findBrokenLinks(urls, new Set(), index)).toHaveLength(MAX_BROKEN_LINKS_PER_PAGE)
  })

  it('compiles redirect sources without matching everything on bad input', () => {
    expect(compileRedirectSource('/docs/:id')!.test('/docs/a')).toBe(true)
    expect(compileRedirectSource('/docs/:id')!.test('/docs/a/b')).toBe(false)
    expect(compileRedirectSource('/docs/:id*')!.test('/docs')).toBe(true)
    expect(compileRedirectSource('/docs/:id+')!.test('/docs')).toBe(false)
    expect(compileRedirectSource('/docs/:id+')!.test('/docs/a/b')).toBe(true)
    expect(compileRedirectSource('/a.b')!.test('/aXb')).toBe(false)
    expect(compileRedirectSource('no-leading-slash')).toBeNull()
  })
})

describe('validateDocJsonLd', () => {
  const build = (overrides: Partial<Parameters<typeof buildDocPageJsonLd>[0]> = {}) =>
    buildDocPageJsonLd({
      siteUrl: 'https://docs.example.com',
      siteName: 'Example',
      pageUrl: 'https://docs.example.com/guides/setup',
      id: 'guides/setup',
      title: 'Set up the SDK',
      breadcrumb: [{ label: 'Guides', href: '/guides' }, { label: 'Setup' }],
      ...overrides,
    })

  it('accepts the payload the docs page emits', () => {
    expect(validateDocJsonLd(build({ lastUpdated: '2026-09-30' }))).toEqual([])
    expect(validateDocJsonLd(build({ lastUpdated: '2026-09-30T12:00:00Z' }))).toEqual([])
  })

  it('flags invalid dates, long or empty headlines, and relative URLs', () => {
    expect(validateDocJsonLd(build({ lastUpdated: 'Sept 2026' }))).toEqual([
      expect.objectContaining({ severity: 'fail', message: expect.stringMatching(/dateModified/) }),
    ])
    expect(validateDocJsonLd(build({ title: 'x'.repeat(140) }))).toEqual([
      expect.objectContaining({ severity: 'warn', message: 'headline is 140 characters (over 110)' }),
    ])
    expect(validateDocJsonLd(build({ title: ' ' }))[0]).toMatchObject({ severity: 'fail' })
    expect(validateDocJsonLd(build({ pageUrl: '/guides/setup' }))).toContainEqual(
      expect.objectContaining({ severity: 'fail', message: expect.stringMatching(/absolute/) }),
    )
  })

  it('flags malformed breadcrumbs and payloads without a TechArticle', () => {
    expect(validateDocJsonLd(build({ breadcrumb: [{ label: '' }] }))).toEqual([
      expect.objectContaining({ severity: 'warn', message: 'breadcrumb item 1 has no name' }),
    ])
    expect(validateDocJsonLd({ '@context': 'https://schema.org', '@graph': [] })[0]).toMatchObject({ severity: 'fail' })
    expect(validateDocJsonLd({})[0]).toMatchObject({ severity: 'fail' })
  })

  it('accepts only real calendar dates', () => {
    expect(isIsoDate('2026-02-28')).toBe(true)
    expect(isIsoDate('2026-02-30')).toBe(false)
    expect(isIsoDate('2026-13-01')).toBe(false)
    expect(isIsoDate(20260101)).toBe(false)
  })
})

describe('golden questions', () => {
  it('reads and normalizes the docs.json readiness block', () => {
    const config = readGoldenQuestionConfig({
      readiness: {
        topK: 50,
        goldenQuestions: [
          { question: '  How   do I start? ', expect: ['quickstart', '/guides/setup/', 'https://evil.example/x', '/quickstart#top'] },
          { question: 'No expectations', expect: [] },
          { question: 42, expect: ['/x'] },
          { question: 'x'.repeat(301), expect: ['/x'] },
          'not an object',
        ],
      },
    })
    expect(config).toEqual({
      k: MAX_TOP_K,
      questions: [{ question: 'How do I start?', expected: ['/quickstart', '/guides/setup'] }],
    })
  })

  it('returns null when nothing usable is configured', () => {
    expect(readGoldenQuestionConfig({})).toBeNull()
    expect(readGoldenQuestionConfig({ readiness: { goldenQuestions: 'nope' } })).toBeNull()
    expect(readGoldenQuestionConfig({ readiness: { goldenQuestions: [{ question: 'q', expect: [] }] } })).toBeNull()
  })

  it('bounds the number of questions', () => {
    const goldenQuestions = Array.from({ length: MAX_GOLDEN_QUESTIONS + 20 }, (_, i) => ({ question: `q${i}`, expect: '/a' }))
    expect(readGoldenQuestionConfig({ readiness: { goldenQuestions } })?.questions).toHaveLength(MAX_GOLDEN_QUESTIONS)
  })

  it('scores hit@k and isolates search failures', async () => {
    const config = { k: 2, questions: [{ question: 'a', expected: ['/a'] }, { question: 'b', expected: ['/b'] }] }
    const facts = await runGoldenQuestions(config, async (q) => (q === 'a' ? ['/x', '/a/', '/a'] : ['/x', '/y', '/b']), new Set(['/a', '/b']))
    expect(facts.results.map((result) => result.hit)).toEqual([true, false])

    const failed = await runGoldenQuestions(config, async () => { throw new Error('secret path /srv/x') }, new Set())
    expect(failed).toEqual({ k: 2, results: [], error: 'The local search index could not be built.' })
  })
})
