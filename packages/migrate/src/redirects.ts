/**
 * Final pass over a migrated redirect set. Next.js applies a redirect before it
 * looks for a page, so a redirect whose source is a served page hides that page,
 * and two redirects that point at each other never settle. Next also parses a
 * redirect source as a route pattern, so one with pattern operators fails the
 * whole build. Every platform and every step that adds redirects (source
 * config, generated aliases, remote API specs) is checked here once, instead of
 * each caller guarding its own additions.
 *
 * A site runs on either of two servers: `next start` matches a redirect source
 * without regard to letter case, while the Cloudflare build matches it exactly.
 * A conflict is judged by the stricter reading, so a redirect that would hide a
 * page or loop on either server is left out.
 */

import type { MigrationDocsConfig, MigrationPage, MigrationWarning } from './types.js'

const LISTED = 10

/** A fully literal site path, without a trailing slash and in the case it was written; null for patterns, queries and fragments. */
function exactRoute(route: string): string | null {
  return route.startsWith('/') && !/[?:*#()[\]{}]/.test(route)
    ? route.replace(/\/+$/, '') || '/'
    : null
}

/** `exactRoute` in lower case: the form routes are compared in, so `/Guide` and `/guide` are one address. */
export function literalRoute(route: string): string | null {
  return exactRoute(route)?.toLowerCase() ?? null
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
 * Drop each redirect Next.js cannot serve as written: one back to its own
 * route (a trailing slash is the same route) and one whose source has
 * route-pattern operators, which would fail the build. An omitted address with
 * operators is named in one warning; a self-redirect gets its own. A redirect
 * to its own route with a query or fragment added is left to
 * `dropConflictingRedirects`: sources match the request path alone, so it loops
 * all the same, and that check says so.
 */
export function dropUnroutableRedirects(config: MigrationDocsConfig, warnings: Array<MigrationWarning>): MigrationDocsConfig {
  if (!config.redirects?.length) return config
  const unmatchable: Array<string> = []
  const redirects = config.redirects.filter((redirect) => {
    // Exact on purpose: a redirect back to the same address in another case is a conflict for `dropConflictingRedirects`, which says why.
    const source = exactRoute(redirect.source)
    if (source && source === exactRoute(redirect.destination)) {
      warnings.push({ code: 'unsupported-config', message: `Self-redirect from ${redirect.source} to ${redirect.destination} was omitted.` })
      return false
    }
    if (!ROUTE_PATTERN_OPERATORS.test(redirect.source)) return true
    unmatchable.push(redirect.source)
    return false
  })
  if (unmatchable.length > 0) {
    warnings.push({
      code: 'unsupported-config',
      message: `Skipped ${unmatchable.length} redirect${unmatchable.length === 1 ? '' : 's'} from ${list(unmatchable)}: ${unmatchable.length === 1 ? 'that address has' : 'those addresses have'} a character (+ ? ( ) [ ] { }) that Next.js reads as route syntax and cannot match literally, so visits to ${unmatchable.length === 1 ? 'it' : 'them'} will not redirect.`,
    })
  }
  if (redirects.length === config.redirects.length) return config
  const result: MigrationDocsConfig = { ...config, redirects }
  if (redirects.length === 0) delete result.redirects
  return result
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
 * they cannot be compared with a page path.
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
  const redirects = config.redirects.filter((redirect) => {
    const source = literalRoute(redirect.source)
    if (!source) return true
    const writtenSource = exactRoute(redirect.source)!
    const retiresRootAlias = source === '/introduction' && !rootRedirected && destinationRoute(redirect.destination) === '/'
    if (served.has(source) && !retiresRootAlias) {
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
  if (redirects.length === config.redirects.length) return config
  const result: MigrationDocsConfig = { ...config, redirects }
  if (redirects.length === 0) delete result.redirects
  return result
}
