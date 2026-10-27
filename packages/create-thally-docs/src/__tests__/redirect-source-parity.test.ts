/** The check reads a redirect as Next.js does, which it asks of `next.config.ts` at run time. */

import { modifyRouteRegex } from 'next/dist/lib/redirect-status.js'
import { getPathMatch } from 'next/dist/shared/lib/router/utils/path-match.js'
import { prepareDestination } from 'next/dist/shared/lib/router/utils/prepare-destination.js'
import { describe, expect, it } from 'vitest'

import { applyRedirect, compileRedirectSource } from '../check.js'

/** Next's own matcher for a redirect source, built with the options it gives one (filesystem.js `buildCustomRoute`). */
const nextMatch = (source: string) => getPathMatch(source, { strict: true, removeUnnamedParams: true, regexModifier: (regex) => modifyRouteRegex(regex, ['/_next']), sensitive: false })

const sources = [
  '/old', '/OLD', '/old/', '/', '/old/:path', '/old/:path*', '/old/:path+', '/old/:path?', '/old/:path(.*)', '/old/:path(a|b)', '/old/:path(\\d+)',
  '/old/:path(.*)/more', '/:lang(en|fr)/docs/:slug*', '/file.:ext', '/old.:ext(html|php)', '/a/(.*)', '/a/(b|c)', '/:a/:b', '/docs/:p*/edit', '/x/:id(\\d+)?',
  '/(.*)', '/guide/:slug/:rest*', '/v:version(\\d+)/docs', '/blog/:year(\\d{4})/:slug',
  '/:section-:slug', '/legacy/:slug?\\-x', '/legacy/:slug*\\-x', '/legacy/:slug+\\-x', '/legacy/:slug\\-x', '/a\\.b/:x', '/docs/:slug+', '/docs/:slug+/', '/Docs/:Slug*',
  '/legacy{/:slug}?', '/:a-:b-:c', '/:path*', '/:path(.*)',
]
const paths = [
  '/', '/old', '/OLD', '/Old/a', '/old/a', '/old/a/b', '/old/1', '/old/a/more', '/old/a/b/more', '/en/docs', '/fr/docs/a/b', '/de/docs/a', '/file.txt', '/old.html',
  '/old.js', '/oldx', '/other', '/a/b', '/a/c', '/a/d', '/docs/x/y/edit', '/docs/edit', '/x', '/x/12', '/x/ab', '/guide/a', '/guide/a/b/c', '/v2/docs', '/vx/docs',
  '/blog/2024/post', '/blog/24/post', '/docs-v1-token', '/docs-v1', '/a-b-c-d', '/legacy-x', '/legacy/a-x', '/legacy/a/b-x', '/legacy/-x', '/legacy', '/a.b/c', '/axb/c',
  '/docs/a/b', '/DOCS/A', '/docs', '/_next/static/x', '/_nextx',
]
// The check follows an address without its trailing slash, which Next.js strips before it looks at redirects.
const bare = (source: string) => source.replace(/\/$/, '') || '/'

describe('a redirect source as the check reads it', () => {
  it.each(sources)('matches the same addresses and takes the same parameters as Next.js: %s', (source) => {
    const rule = compileRedirectSource(source, '/to')
    expect(rule.match, 'a source that Next.js accepts is read').not.toBeNull()
    for (const path of paths) {
      const ours = rule.match!(path)
      const next = nextMatch(bare(source))(path)
      expect(Boolean(ours), `${source} ${path}`).toBe(next !== false)
      if (ours && next) expect({ ...ours.params }, `${source} ${path}`).toEqual({ ...next })
    }
  })

  it.each([
    ['/:section-:slug', '/:section/:slug', '/docs-v1-token'],
    ['/legacy/:slug?\\-x', '/introduction', '/legacy-x'],
    ['/legacy/:slug*\\-x', '/introduction/:slug*', '/legacy/a/b-x'],
    ['/old/:slug*', '/new/:slug*', '/old'],
    ['/old/:slug+', '/new/:slug+', '/old/a/b'],
    ['/old/:slug?', '/new/:slug?', '/old'],
    ['/old/:path(.*)', '/new/:path', '/old/a/b'],
    ['/old/(.*)', '/new/:path', '/old/a'],
    ['/OLD/:Path', '/new/:Path', '/old/A'],
    ['/old/:a/:abc', '/new/:abc/:a', '/old/1/2'],
    ['/docs/:p*', '/docs/v2/:p*#top', '/docs/a/b'],
    ['/old/:p', '/new/:p?from=old', '/old/a'],
  ])('sends a matched address where Next.js sends it: %s -> %s for %s', (source, destination, path) => {
    const rule = compileRedirectSource(source, destination)
    const params = nextMatch(bare(source))(path)
    let expected: string | null = null
    try { expected = params === false ? null : prepareDestination({ appendParamsToQuery: false, destination, params, query: {} }).newUrl } catch { /* Next.js fails here */ }
    expect(applyRedirect(rule, path)).toBe(expected ?? (params === false ? undefined : null))
  })

  it('sends an address to an external destination as it is, and one that matches nothing nowhere', () => {
    expect(applyRedirect(compileRedirectSource('/old/:p', 'https://example.com/:p'), '/old/a')).toBe('https://example.com/:p')
    expect(applyRedirect(compileRedirectSource('/old/:p', '/new'), '/other')).toBeUndefined()
  })

  it.each(['/old/(a(b))', '/old/:', '/old/:path(', '/old/:path(?x)'])('has no matcher for %s, which Next.js refuses too', (source) => {
    expect(() => nextMatch(source)).toThrow()
    expect(compileRedirectSource(source, '/to').match).toBeNull()
  })

  it('has no destination where Next.js cannot build one', () => {
    // An unnamed group is not a parameter Next.js passes on, and a destination that needs a parameter the source has not got fails.
    expect(applyRedirect(compileRedirectSource('/old/(.*)', '/new/:0'), '/old/a')).toBeNull()
    expect(applyRedirect(compileRedirectSource('/old/:p', '/new/:q'), '/old/a')).toBeNull()
  })
})
