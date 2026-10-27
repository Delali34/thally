/**
 * Final pass over a migrated redirect set. Next.js applies a redirect before it
 * looks for a page, so a redirect whose source is a served page hides that page,
 * and two redirects that point at each other never settle. Next also parses a
 * redirect source as a route pattern, so one with pattern operators fails the
 * whole build, and it compiles a destination the same way, so one with route
 * syntax in its path or host, or with a `:name` its source does not define,
 * fails when a visitor follows it. Every platform and every step that adds
 * redirects (source config, generated aliases, remote API specs) is checked
 * here once, instead of each caller guarding its own additions.
 *
 * A site runs on either of two servers: `next start` matches a redirect source
 * without regard to letter case, while the Cloudflare build matches it exactly.
 * A conflict is judged by the stricter reading, so a redirect that would hide a
 * page or loop on either server is left out.
 */

import type { MigrationDocsConfig, MigrationPage, MigrationWarning } from './types.js'

const LISTED = 10

/**
 * One warning for the redirects an adapter left out because they are not safe
 * to emit (`isRedirectPathSafe`), naming their sources; null when there are none.
 * A source can hold control characters, which are dropped so it cannot rewrite
 * the line it is printed in.
 */
export function skippedRedirectsWarning(sources: ReadonlyArray<string>): MigrationWarning | null {
  if (sources.length === 0) return null
  const one = sources.length === 1
  return {
    code: 'unsupported-config',
    message: `Skipped ${sources.length} redirect${one ? '' : 's'} from ${list(sources.map((source) => source.replace(/[\x00-\x1f\x7f]/g, '')))}: a redirect must start at a path on this site (one beginning with a single /) and lead to a path on this site or to an http:// or https:// address. Check ${one ? 'it' : 'these redirects'} in the source docs and add ${one ? 'it' : 'any that are still needed'} to docs.json${one ? ' if it is still needed' : ''}.`,
  }
}

/**
 * One warning for the redirects whose source or destination was written without
 * its leading slash and was read as the site path it names, listing their
 * sources as written; null when there are none.
 */
export function rootedRedirectsWarning(sources: ReadonlyArray<string>): MigrationWarning | null {
  if (sources.length === 0) return null
  const one = sources.length === 1
  return {
    code: 'unsupported-config',
    message: `Added the leading / to ${sources.length} redirect${one ? '' : 's'} written without one (from ${list([...sources])}). Mintlify serves a redirect like that as a path on the site, so ${one ? 'it was' : 'each was'} migrated with the / added. Check ${one ? 'it' : 'them'} against the live site if ${one ? 'it' : 'any'} was meant to be something else.`,
  }
}

/** Remove trailing slashes in one backward scan, including on untrusted nonliteral paths. */
export function trimTrailingSlashes(route: string): string {
  let end = route.length
  while (end > 0 && route[end - 1] === '/') end--
  return route.slice(0, end)
}

/** A fully literal site path, without a trailing slash and in the case it was written; null for patterns, queries and fragments. */
function exactRoute(route: string): string | null {
  return route.startsWith('/') && !/[?:*#()[\]{}]/.test(route)
    ? trimTrailingSlashes(route) || '/'
    : null
}

/** `exactRoute` in lower case: the form routes are compared in, so `/Guide` and `/guide` are one address. */
export function literalRoute(route: string): string | null {
  return exactRoute(route)?.toLowerCase() ?? null
}

/**
 * Write each exact redirect source (a literal path: no `:param`, `*`, `+`, `?`, `(` or `{`) without its trailing slash; the root stays
 * `/`. Next removes the slash from a request before it looks for a redirect (the site runs with `trailingSlash` off), so an exact source
 * that keeps it, like Mintlify's `/libsql/client-access/`, never matches and its URL is a 404. Mintlify sends such a request to the
 * slashless address first, then through the redirect. Two exact sources that differ only by the slash are one address: the first listed
 * fires, so the later one is left out and named in a warning. A stripped source that is now a redirect to itself, in any letter case
 * (Next matches a source without regard to case), is omitted as a self-redirect.
 *
 * A pattern source (`/docs/:path*\/`) is left exactly as written. It never matches either, but stripping its slash would start a redirect
 * that can loop: `/docs/:path*\/ -> /docs/v2/:path*` would send `/docs/a` to `/docs/v2/a`, then `/docs/v2/v2/a` and on, and
 * `/Docs/:path*\/ -> /docs/:path*` would send every visit to itself.
 */
function trimRedirectSources(config: MigrationDocsConfig, warnings: Array<MigrationWarning>): MigrationDocsConfig {
  if (!config.redirects?.length) return config
  const firstWritten = new Map<string, string>()
  const repeats: Array<string> = []
  const redirects: NonNullable<MigrationDocsConfig['redirects']> = []
  for (const redirect of config.redirects) {
    const source = exactRoute(redirect.source)
    if (source === null) {
      redirects.push(redirect)
      continue
    }
    // Only a source that lost its slash is judged here: the pass before this one read the others, and `dropConflictingRedirects` reads the rest.
    // The omitted redirect does not take the address from one listed after it.
    if (source !== redirect.source && source.toLowerCase() === literalRoute(redirect.destination)) {
      warnings.push({ code: 'unsupported-config', message: `Self-redirect from ${redirect.source} to ${redirect.destination} was omitted.` })
      continue
    }
    const first = firstWritten.get(source)
    if (first !== undefined && first !== redirect.source) {
      repeats.push(redirect.source)
      continue
    }
    firstWritten.set(source, first ?? redirect.source)
    redirects.push(source === redirect.source ? redirect : { ...redirect, source })
  }
  if (repeats.length > 0) {
    warnings.push({
      code: 'unsupported-config',
      message: `Skipped ${repeats.length} redirect${repeats.length === 1 ? '' : 's'} from ${list(repeats)}: ${repeats.length === 1 ? 'its source differs' : 'each source differs'} from an earlier redirect's source only by a trailing slash, which Thally ignores when matching, so the earlier redirect was kept. Check ${repeats.length === 1 ? 'it' : 'them'} in the source docs.`,
    })
  }
  return redirects.length === config.redirects.length && redirects.every((redirect, index) => redirect === config.redirects![index]) ? config : { ...config, redirects }
}

/** A literal path with its `.` and `..` segments resolved, as a browser does; a segment is one whether it is written `..` or `%2e%2e` in either case. Nothing else is decoded. */
function resolveDotSegments(route: string): string {
  const segments: Array<string> = []
  for (const segment of route.split('/').slice(1)) {
    const dots = segment.replace(/%2e/gi, '.')
    if (dots === '..') segments.pop()
    else if (dots !== '.') segments.push(segment)
  }
  return `/${segments.join('/')}`
}

/**
 * The site path a redirect destination sends visitors to, as `exactRoute` reads
 * a source, with dot segments resolved (`/x/../a` is `/a`). Next matches a
 * source against the request path alone, so a query or fragment on the
 * destination does not stop the redirect for that path from firing next. Null
 * for a pattern and for an address off the site (`//host/x`; `https://host/x`
 * already fails `exactRoute`'s leading slash).
 */
export function destinationRoute(destination: string): string | null {
  const route = destination.startsWith('//') ? null : exactRoute(destination.split(/[?#]/, 1)[0])
  return route === null ? null : resolveDotSegments(route)
}

/** The routes a site's pages are served at, in the case they are written; a directory page (`section/index`) is served at its parent route too. */
function pageRoutes(pages: ReadonlyArray<Pick<MigrationPage, 'id'>>): Array<string> {
  return pages.flatMap((page) => [`/${page.id}`, `/${page.id.replace(/\/index$/, '')}`])
}

/**
 * Every address that opens a page. That is `pageRoutes`, plus the site root for
 * the home document: the runtime serves `introduction` at `/` (`navigationPagePath`
 * in `@thallylabs/core`, which is also what its sidebar links to) and still accepts
 * `/introduction` as an alias (`matchesNavigationPath`). A redirect that has to take
 * a page over must cover all of them.
 */
export function pageEntryRoutes(page: Pick<MigrationPage, 'id'>): Array<string> {
  return [...new Set([...pageRoutes([page]), ...(page.id === 'introduction' ? ['/'] : [])])]
}

/** The literal routes a site's pages are served at, as `literalRoute` writes them. */
export function servedRoutes(pages: ReadonlyArray<Pick<MigrationPage, 'id'>>): Set<string> {
  return new Set(pageRoutes(pages).map((route) => route.toLowerCase()))
}

function list(sources: Array<string>): string {
  return `${sources.slice(0, LISTED).join(', ')}${sources.length > LISTED ? ', ...' : ''}`
}

/** Characters Next's route-pattern parser reads as operators, so a source holding one (Mintlify's literal `/client/c++`) is rejected. */
const ROUTE_PATTERN_OPERATORS = /[+?()[\]{}]/

/**
 * A source's final segment as a catch-all: `/:name*` also matches the path without it, `/:name+` needs one or more segments.
 * A slash written after the segment changes neither reading (Next matches `/` for `/:path*` with or without it), so it is allowed and kept.
 */
const TRAILING_ZERO_OR_MORE = /\/:[A-Za-z_][A-Za-z0-9_]*\*\/?$/
const TRAILING_ONE_OR_MORE = /\/:[A-Za-z_][A-Za-z0-9_]*\+\/?$/

/** A destination split into the scheme and host of an absolute address (empty for a site path), its path, and the query and fragment after it. */
const DESTINATION_PARTS = /^((?:https?:\/\/[^/?#]*)?)([^?#]*)([\s\S]*)$/i

/**
 * What Next compiles in a destination's path (and a site path's whole text) with
 * path-to-regexp, which reads these as route syntax although a URL holds them as
 * plain characters. `+`, `(` and `)` fail at once. A `:` starts a parameter, so
 * `:name` (with `*` or `+` for a catch-all) is kept when the source defines it,
 * and any other colon fails when a visitor follows the redirect (a destination on
 * the site fails the build as well). A `[`, `]` or `)` compiles as written, and
 * `{` and `}` are percent-encoded by the URL parser before Next compiles them.
 */
const DESTINATION_PATH_SYNTAX = /:(\w*)([*+]?)|[+()]/g

/** The parameters a source defines, each with whether it matches several segments (`:path*`, `:path+`). */
function sourceParameters(source: string): Map<string, boolean> {
  const parameters = new Map<string, boolean>()
  for (const [, name, modifier] of source.matchAll(/:(\w+)([*+]?)/g)) parameters.set(name, modifier !== '')
  return parameters
}

/** A host name Next can compile: letters, digits, hyphens and underscores in dot-separated labels, which a punycode `xn--` label is too. */
const DNS_HOST = /^(?:[a-z0-9_](?:[a-z0-9_-]*[a-z0-9_])?\.)*[a-z0-9_](?:[a-z0-9_-]*[a-z0-9_])?\.?$/

/**
 * The host Next compiles for an absolute destination is the one its URL parser
 * reads: percent escapes decoded (`exa%2Bmple.com` is `exa+mple.com`), lower
 * case, an international name in punycode. Next reads `+ * ( ) { }` in it as
 * route syntax and cannot escape them, so anything but a valid host name would
 * fail when a visitor follows the redirect. Null for a valid host and for a
 * path on the site; otherwise the host as Next reads it.
 */
function invalidHost(origin: string): string | null {
  if (!origin) return null
  let host: string
  try {
    host = new URL(origin).hostname
  } catch {
    host = origin.replace(/^https?:\/\//i, '')
  }
  return DNS_HOST.test(host) ? null : host
}

/**
 * A destination with its path made safe for Next to compile, which it does with
 * path-to-regexp. `+`, `(` and `)` are written as `%2B`, `%28` and `%29`, which
 * Next sends back unchanged and a server reads as the same path. A `:name` the
 * source defines (a catch-all carried over from it) is kept. Any other colon is
 * written `%3A`: Next throws when it compiles a parameter nothing gave a value,
 * so a `:oops` the source does not have can only be meant as text. The query
 * and fragment are left as written. A catch-all the source does not have
 * (`:rest*`) has nothing to fill it, and one of its own written without its `*`
 * or `+` cannot be compiled: either comes back as the reason.
 */
function encodeDestinationPath(destination: string, source: string): string | { reason: string } {
  const [, origin, path, rest] = DESTINATION_PARTS.exec(destination)!
  const parameters = sourceParameters(source)
  let reason: string | undefined
  const percent = (char: string): string => `%${char.charCodeAt(0).toString(16).toUpperCase()}`
  const encoded = path.replace(DESTINATION_PATH_SYNTAX, (match, name?: string, modifier = '') => {
    if (name === undefined) return percent(match)
    const repeats = parameters.get(name)
    if (repeats === undefined) {
      if (name && modifier) reason ??= `its destination has :${name}${modifier}, a wildcard the source does not have, so there is nothing to fill it with`
      return `%3A${name}${[...modifier].map(percent).join('')}`
    }
    if (repeats && !modifier) reason ??= `:${name} matches several path segments in the source, so its destination has to write it :${name}* or :${name}+, and Next.js cannot follow it otherwise`
    return match
  })
  return reason ? { reason } : `${origin}${encoded}${rest}`
}

/**
 * Drop each redirect Next.js cannot serve as written: one back to its own
 * route (a trailing slash is the same route), one whose source has
 * route-pattern operators, which would fail the build, one whose destination
 * host is not a valid host name, and one whose destination has a catch-all its
 * source cannot give it. The path of every other destination is made safe to
 * compile (`encodeDestinationPath`) instead, so a `+`, `(` or stray `:` in it no
 * longer fails when the redirect is followed. A final `/:name+`
 * segment is route syntax Next reads as intended: `dropConflictingRedirects`
 * writes it, and a set that passes through here again must keep it. An omitted
 * address with operators is named in one warning; a self-redirect and a
 * destination with a wildcard of its own each get a warning. A redirect
 * to its own route with a query or fragment added is left to
 * `dropConflictingRedirects`: sources match the request path alone, so it loops
 * all the same, and that check says so.
 */
function omitUnroutableRedirects(config: MigrationDocsConfig, warnings: Array<MigrationWarning>): MigrationDocsConfig {
  if (!config.redirects?.length) return config
  const unmatchable: Array<string> = []
  const unreachable: Array<string> = []
  const redirects: Array<NonNullable<MigrationDocsConfig['redirects']>[number]> = []
  for (const redirect of config.redirects) {
    // Exact on purpose: a redirect back to the same address in another case is a conflict for `dropConflictingRedirects`, which says why.
    const source = exactRoute(redirect.source)
    if (source && source === exactRoute(redirect.destination)) {
      warnings.push({ code: 'unsupported-config', message: `Self-redirect from ${redirect.source} to ${redirect.destination} was omitted.` })
      continue
    }
    const host = invalidHost(DESTINATION_PARTS.exec(redirect.destination)![1])
    if (host !== null) {
      unreachable.push(`${redirect.source} (${host})`)
      continue
    }
    if (ROUTE_PATTERN_OPERATORS.test(redirect.source.replace(TRAILING_ONE_OR_MORE, ''))) {
      unmatchable.push(redirect.source)
      continue
    }
    const destination = encodeDestinationPath(redirect.destination, redirect.source)
    if (typeof destination !== 'string') {
      warnings.push({ code: 'unsupported-config', message: `Redirect from ${redirect.source} to ${redirect.destination} was omitted: ${destination.reason}.` })
      continue
    }
    redirects.push(destination === redirect.destination ? redirect : { ...redirect, destination })
  }
  if (unmatchable.length > 0) {
    warnings.push({
      code: 'unsupported-config',
      message: `Skipped ${unmatchable.length} redirect${unmatchable.length === 1 ? '' : 's'} from ${list(unmatchable)}: ${unmatchable.length === 1 ? 'that address has' : 'those addresses have'} a character (+ ? ( ) [ ] { }) that Next.js reads as route syntax and cannot match literally, so visits to ${unmatchable.length === 1 ? 'it' : 'them'} will not redirect.`,
    })
  }
  if (unreachable.length > 0) {
    warnings.push({
      code: 'unsupported-config',
      message: `Skipped ${unreachable.length} redirect${unreachable.length === 1 ? '' : 's'} from ${list(unreachable)}: the address ${unreachable.length === 1 ? 'it leads' : 'each leads'} to has a host name that is not valid (a host name has only letters, digits, hyphens, underscores and dots, then an optional :port), so following ${unreachable.length === 1 ? 'it' : 'them'} would fail. Check ${unreachable.length === 1 ? 'it' : 'these redirects'} in the source docs.`,
    })
  }
  if (redirects.length === config.redirects.length && redirects.every((redirect, index) => redirect === config.redirects![index])) return config
  const result: MigrationDocsConfig = { ...config, redirects }
  if (redirects.length === 0) delete result.redirects
  return result
}

/**
 * `omitUnroutableRedirects`, then each source written without its trailing slash (`trimRedirectSources`). The slash comes last so a
 * redirect that is omitted never takes the address from one that is kept.
 */
export function dropUnroutableRedirects(config: MigrationDocsConfig, warnings: Array<MigrationWarning>): MigrationDocsConfig {
  return trimRedirectSources(omitUnroutableRedirects(config, warnings), warnings)
}

/**
 * The redirects kept so far under one reading of letter case, by source. Next
 * uses the first match, so a later duplicate never fires and is not recorded.
 * A redirect that leaves the site, or whose destination is not a literal path,
 * claims its source all the same: it ends a chain there, with no internal
 * edge. The graph stays acyclic as long as each redirect is recorded only
 * after `closesLoop` has said it is safe. A walk points each source it passes
 * at the end of its chain, so later walks are short however the redirects are
 * ordered.
 */
function redirectChains(): {
  has: (source: string) => boolean
  add: (source: string, destination: string | null) => void
  closesLoop: (source: string, destination: string) => boolean
} {
  const kept = new Map<string, string>()
  const terminal = new Set<string>()
  const has = (source: string): boolean => kept.has(source) || terminal.has(source)
  const add = (source: string, destination: string | null): void => {
    if (destination === null) terminal.add(source)
    else kept.set(source, destination)
  }
  const closesLoop = (source: string, destination: string): boolean => {
    let end = destination
    // A chain through `kept` passes each source once, so a longer walk means a cycle is already there; treat it as a loop instead of walking forever.
    for (let steps = 0; kept.has(end); steps++) {
      if (steps >= kept.size) return true
      end = kept.get(end)!
    }
    for (let step = destination; step !== end;) {
      const next = kept.get(step)!
      kept.set(step, end)
      step = next
    }
    return end === source
  }
  return { has, add, closesLoop }
}

/**
 * Drop each literal redirect that hides a page of the site, and each one that
 * closes a loop with the redirects before it (so an authored redirect, listed
 * first, wins over a generated one). Every redirect is judged under both
 * readings of letter case, before it is recorded under either: ignoring case
 * (`next start`) and as written (OpenNext). It is dropped if it hides a page or
 * closes a loop under either one. A conflict that exists only because case is
 * ignored gets its own warning, which says the redirect can come back on a
 * case-sensitive host. Patterns are left to the callers that translate them:
 * they cannot be compared with a page path, with one exception. A source that
 * ends in a catch-all `/:name*` also matches the path without that segment, so
 * when that path is a page, or is where the redirect itself goes, the redirect
 * would hide the page or send it to itself. It is rewritten to `/:name+`, which
 * keeps redirecting every deeper path. For `/:name*` that path is the root,
 * which answers with the home page or a redirect of its own.
 */
export function dropConflictingRedirects(
  config: MigrationDocsConfig,
  pages: ReadonlyArray<Pick<MigrationPage, 'id'>>,
  warnings: Array<MigrationWarning>,
): MigrationDocsConfig {
  if (!config.redirects?.length) return config
  const served = servedRoutes(pages)
  const servedAsWritten = new Set(pageRoutes(pages))
  const hidden: Array<string> = []
  const hiddenByCase: Array<string> = []
  const looping: Array<string> = []
  const loopingByCase: Array<string> = []
  const folded = redirectChains()
  const asWritten = redirectChains()
  // The introduction page is also served at `/`, so `/introduction` -> `/` only
  // retires an alias of it, unless `/` itself redirects somewhere.
  const rootRedirected = config.redirects.some((redirect) => literalRoute(redirect.source) === '/')
  const retiresRootAlias = (route: string, destination: string | null): boolean => route === '/introduction' && !rootRedirected && destination === '/'
  // The root answers with the home page the runtime serves there, or with a redirect of its own; a catch-all must not take it over.
  const rootAnswers = rootRedirected || pages.some((page) => pageEntryRoutes(page).includes('/'))
  // `served` holds every page route in lower case, so one lookup judges both readings of letter case.
  const requiresSegment = <T extends { source: string; destination: string }>(redirect: T): T => {
    if (!TRAILING_ZERO_OR_MORE.test(redirect.source)) return redirect
    const prefix = literalRoute(redirect.source.replace(TRAILING_ZERO_OR_MORE, '') || '/')
    if (!prefix) return redirect
    const destination = destinationRoute(redirect.destination)?.toLowerCase() ?? null
    const hidesPage = (served.has(prefix) || (prefix === '/' && rootAnswers)) && !retiresRootAlias(prefix, destination)
    return hidesPage || destination === prefix ? { ...redirect, source: redirect.source.replace(/\*(\/?)$/, '+$1') } : redirect
  }
  const narrowed = config.redirects.map(requiresSegment)
  const redirects = narrowed.filter((redirect) => {
    const source = literalRoute(redirect.source)
    if (!source) return true
    const writtenSource = exactRoute(redirect.source)!
    if (served.has(source) && !retiresRootAlias(source, destinationRoute(redirect.destination))) {
      const hides = servedAsWritten.has(writtenSource) ? hidden : hiddenByCase
      hides.push(redirect.source)
      return false
    }
    const writtenDestination = destinationRoute(redirect.destination)
    const destination = writtenDestination?.toLowerCase() ?? null
    // A source that already has a redirect under a reading never fires there (the first listed wins), so it cannot loop there and is not recorded there.
    // A case variant of a listed source is unreachable on `next start` but live on OpenNext, so it is still checked, and recorded, as written.
    const firesFolded = !folded.has(source)
    const firesAsWritten = !asWritten.has(writtenSource)
    const loopsFolded = firesFolded && destination !== null && folded.closesLoop(source, destination)
    const loopsAsWritten = firesAsWritten && writtenDestination !== null && asWritten.closesLoop(writtenSource, writtenDestination)
    if (loopsFolded || loopsAsWritten) {
      const loops = loopsAsWritten ? looping : loopingByCase
      loops.push(`${redirect.source} -> ${redirect.destination}`)
      return false
    }
    if (firesFolded) folded.add(source, destination)
    if (firesAsWritten) asWritten.add(writtenSource, writtenDestination)
    return true
  })
  if (hidden.length > 0) {
    warnings.push({
      code: 'unsupported-config',
      message: `Skipped ${hidden.length} redirect${hidden.length === 1 ? '' : 's'} from ${list(hidden)}: ${hidden.length === 1 ? 'that URL is' : 'those URLs are'} also ${hidden.length === 1 ? 'a page' : 'pages'} in this site, and a redirect would hide ${hidden.length === 1 ? 'it' : 'them'}. To redirect instead, delete the page and add the redirect to docs.json.`,
    })
  }
  if (hiddenByCase.length > 0) {
    const one = hiddenByCase.length === 1
    warnings.push({
      code: 'unsupported-config',
      message: `Skipped ${hiddenByCase.length} redirect${one ? '' : 's'} from ${list(hiddenByCase)}: ${one ? 'that URL differs' : 'those URLs differ'} only in letter case from ${one ? 'a page' : 'pages'} in this site, so on a server that ignores letter case ${one ? 'it' : 'they'} would hide ${one ? 'that page' : 'those pages'}. If your host matches URLs case-sensitively, add ${one ? 'it' : 'them'} back to docs.json.`,
    })
  }
  if (looping.length > 0) {
    warnings.push({
      code: 'unsupported-config',
      message: `Skipped ${looping.length} redirect${looping.length === 1 ? '' : 's'} that would send visitors in a circle: ${list(looping)}. Check these redirects in the source docs.`,
    })
  }
  if (loopingByCase.length > 0) {
    const one = loopingByCase.length === 1
    warnings.push({
      code: 'unsupported-config',
      message: `Skipped ${loopingByCase.length} redirect${one ? '' : 's'} that would send visitors in a circle on a server that ignores letter case, since the addresses involved differ only in letter case: ${list(loopingByCase)}. If your host matches URLs case-sensitively, add ${one ? 'it' : 'them'} back to docs.json.`,
    })
  }
  if (redirects.length === config.redirects.length && narrowed.every((redirect, index) => redirect === config.redirects![index])) return config
  const result: MigrationDocsConfig = { ...config, redirects }
  if (redirects.length === 0) delete result.redirects
  return result
}
