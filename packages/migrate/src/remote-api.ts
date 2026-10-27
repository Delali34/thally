/**
 * Resolve repository-authored remote OpenAPI references before materializing a
 * site. The local downloader pins a publicly resolved address for each HTTPS
 * hop; hosted callers may inject their own DNS-pinned fetch boundary.
 */
import { createHash } from 'node:crypto'
import { downloadSpec, parseOpenApi } from './remote-spec.js'
import { splitOpenApiRef, withSpecRef } from './openapi-ref.js'
import { addMintlifyDirectoryRedirects, insertApiTab } from './navigation.js'
import { dropConflictingRedirects, dropUnroutableRedirects, literalRoute, pageEntryRoutes, servedRoutes } from './redirects.js'
import { addEndpointPages, apiTabSpecIds, createEndpointPageLedger, DEFAULT_ENDPOINT_DIRECTORY, linkApiMounts, mintlifyEndpointUrls, mountPrefix, parseOpenApiOperationsForLinking, qualifyDisplacedBareRefs, reportEndpointPages, specLookupOrder, thallyOperationSlugSegments, titleOperationPages } from './repository.js'
import { markExcluded, parseSpecDocument, sharedSpecMessage, withoutByteOrderMark } from './spec-exclude.js'
import type { MigrationBundle, MigrationFetcher, MigrationNavigationTab, RemoteApiSpec } from './types.js'
import { isPageOnlyTab, markPageOnlyTabs, pageOnlyApi } from './repository.js'

/** The endpoint page of an operation of the spec the renderer serves under `specId`. */
function operationTarget(specId: string, operation: { method: string; path: string }): string {
  return `/api/${specId}/${thallyOperationSlugSegments(operation.path, operation.method).join('/')}`
}

/** A downloaded spec bound to its tab: what the link and redirect passes read once every spec is bound. */
interface BoundSpec {
  reference: RemoteApiSpec
  filename: string
  content: Buffer
  tabName: string
  /** Set when the operations the tab listed became pages (`addEndpointPages`): those operations, in listed order, and the spec has no API tab of its own. */
  endpointOperations?: Array<string>
}

type ApiTabReference = Pick<RemoteApiSpec, 'tabLabel' | 'parentTab' | 'icon' | 'hidden'> & { url?: string }

const apiTabLabel = (reference: ApiTabReference): string => reference.tabLabel ?? (reference.hidden ? `OpenAPI: ${reference.url}` : 'API Reference')

/** A spec only pages name (hidden, with no label of its own) always has a hidden tab of its own, made for it alone. */
const isPageOnlyReference = (reference: ApiTabReference): boolean => Boolean(reference.hidden) && !reference.tabLabel

/**
 * The tab a reference binds to: the one it names, or else an existing API tab by name, which is never the page-only tab of another spec.
 * A spec only pages name never takes a tab by its label, which an author may give any tab: it has only the tab the migrator made for it.
 */
function findApiTab(tabs: Array<MigrationNavigationTab>, reference: ApiTabReference, source: string): MigrationNavigationTab | undefined {
  if (isPageOnlyReference(reference)) return tabs.find((candidate) => isPageOnlyTab(candidate) && candidate.api?.source === source)
  if (reference.tabLabel) return tabs.find((candidate) => candidate.tab === reference.tabLabel)
  return tabs.find((candidate) => candidate.tab.toLowerCase().includes('api') && !isPageOnlyTab(candidate))
}

/** Bind a spec to the tab its reference names, or to a new API tab beside it; returns that tab's label. How every spec was bound before operations could become pages. */
function bindApiTab(
  tabs: Array<MigrationNavigationTab>,
  reference: ApiTabReference,
  api: NonNullable<MigrationNavigationTab['api']>,
): string {
  const tab = findApiTab(tabs, reference, api.source)
  const label = apiTabLabel(reference)
  if (isPageOnlyReference(reference)) pageOnlyApi(api)
  if (tab) tab.api = api
  else insertApiTab(tabs, { tab: label, ...(reference.icon ? { icon: reference.icon } : {}), ...(reference.hidden ? { hidden: true } : {}), api }, reference.parentTab)
  return tab?.tab ?? label
}

/**
 * Attach safely downloaded specs to the exact authored API tabs. A spec
 * mounted under Mintlify `directory` folders gets a redirect from each
 * endpoint URL those folders served, and a link under a mount (this bundle's
 * or any other's) reaches nothing else. A link no mount covers is redirected by
 * its tag and summary only when exactly one published operation across every
 * spec carries them, to the id its spec is served under: guessing would
 * silently route to the wrong API. A redirect never takes the place of a page
 * the site serves. Every spec is bound before any link is read, so mounts
 * nested in one another (`reference` and `reference/v2`) are told apart by
 * their longest prefix, and the repository's own mounts are linked here too:
 * a tab's position decides the id its spec is served under.
 */
export async function hydrateRemoteApiSpecs(bundle: MigrationBundle, fetcher?: MigrationFetcher): Promise<MigrationBundle> {
  if (!bundle.remoteApiSpecs?.length) return bundle
  // A bundle that was sent between threads lost the marks of the hidden tabs of specs only pages name.
  markPageOnlyTabs(bundle.docsConfig.tabs, bundle.pageOnlySpecs)
  const assets = [...bundle.assets]
  const tabs = bundle.docsConfig.tabs.map((tab) => ({ ...tab }))
  const redirects = [...(bundle.docsConfig.redirects ?? [])]
  const warnings = [...bundle.warnings]
  const pages = bundle.pages.map((page) => ({ ...page }))
  const authoredLinks = new Set<string>()
  // The operations a tab lists become pages: URLs two of them share, and what an authored page already owns, are settled once for the site.
  const ledger = createEndpointPageLedger(pages)
  const pagesBefore = pages.length
  // Mintlify endpoint URL -> Thally endpoint page, for every redirect generated below.
  const endpointUrls = new Map<string, string>()
  for (const page of bundle.pages) {
    // Scan path-shaped tokens once, then inspect segments without nested
    // regex quantifiers. Authored pages may be arbitrarily long or hostile.
    for (const match of page.body.matchAll(/\/[a-z0-9_/-]+/gi)) {
      const segments = match[0].split('/').filter(Boolean)
      if (segments.length < 3) continue
      const section = segments[0].toLowerCase()
      // `/x/y/` and `/x/y` are one URL.
      if (section.includes('api') || section.includes('reference')) authoredLinks.add(match[0].replace(/\/+$/, ''))
    }
  }
  const bound: Array<BoundSpec> = []
  // The tabs as they would be if every spec, converted or not, were bound as an API tab: the local specs whose operations became pages first.
  const apiTabs = bundle.docsConfig.tabs.map((tab) => ({ ...tab }))
  for (const mount of bundle.localApiMounts ?? []) {
    if (mount.endpointOperations) bindApiTab(apiTabs, { tabLabel: mount.tab }, { source: `openapi/${mount.filename}` })
  }
  for (const reference of bundle.remoteApiSpecs) {
    for (let index = warnings.length - 1; index >= 0; index--) {
      if (warnings[index].source === reference.url && warnings[index].message.includes('requires a network download')) warnings.splice(index, 1)
    }
    try {
      const downloaded = withoutByteOrderMark(await downloadSpec(reference.url, fetcher))
      // Fail closed: operations only access-restricted pages document are not published.
      const pruned = markExcluded(downloaded, reference.withheldOperations ?? [], reference.keptOperations)
      const body = pruned.content
      // A spec bound to several tabs is pruned the same way for each: say so once.
      if (reference.withheldOperations?.length && !warnings.some((warning) => warning.code === 'gated-page' && warning.source === reference.url)) {
        warnings.push({ code: 'gated-page', message: sharedSpecMessage(reference.url, pruned.excluded), source: reference.url })
      }
      // The format the body is in, not what its URL says: the saved extension must match it, or the install step drops a YAML spec saved as `.json` as invalid JSON.
      const { format: extension, document } = parseSpecDocument(body.toString('utf8'))
      // Refuses what is not an OpenAPI 3 document, or has too many paths to import.
      parseOpenApi(document)
      const filename = `openapi-${createHash('sha256').update(reference.url).digest('hex').slice(0, 12)}.${extension}`
      // Several tabs may bind one spec: it is saved once.
      if (!assets.some((asset) => asset.path === `openapi/${filename}`)) assets.push({ path: `openapi/${filename}`, content: body, projectRelative: true })
      // Pages that name this spec by URL now resolve to the downloaded copy.
      for (const page of pages) {
        const ref = page.openapi ? splitOpenApiRef(page.openapi) : null
        if (ref?.specRef === reference.url) page.openapi = withSpecRef(ref, `openapi/${filename}`)
      }
      // The operations the tab listed become its pages, and the spec is bound only in a hidden tab that lists nothing.
      const endpoint = reference.groups && reference.endpointPages
        ? addEndpointPages({
            tabs,
            pages,
            ledger,
            spec: {
              assetPath: `openapi/${filename}`,
              source: reference.url,
              content: body,
              groups: reference.groups,
              target: reference.endpointPages,
              tabLabel: reference.tabLabel,
              parentTab: reference.parentTab,
              icon: reference.icon,
              hidden: reference.hidden,
            },
          })
        : null
      // A spec that is kept is bound in `apiTabs` as an API tab would be: that decides which spec a bare `openapi:` reference reached first.
      // A spec the tab rejects below has no binding, so a reference never moves to it.
      if (endpoint) {
        bindApiTab(apiTabs, reference, { source: `openapi/${filename}` })
        bound.push({ reference, filename, content: body, tabName: reference.tabLabel ?? 'API Reference', endpointOperations: endpoint.operations })
        continue
      }
      const api = { source: `openapi/${filename}`, ...(reference.navigation === false ? { navigation: false } : {}), ...(reference.groups ? { groups: reference.groups } : {}) }
      // Thally binds one API spec per tab: a second spec for a tab never silently replaces the first.
      const taken = findApiTab(tabs, reference, api.source)
      if (taken?.api && taken.api.source !== api.source) {
        warnings.push({
          code: 'unsupported-config',
          source: reference.url,
          message: `Tab "${taken.tab}" already uses another OpenAPI spec, and Thally supports one API spec per tab, so ${reference.url} was not added. Put it in its own tab to include it.`,
        })
        continue
      }
      bindApiTab(apiTabs, reference, { source: `openapi/${filename}` })
      bound.push({ reference, filename, content: body, tabName: bindApiTab(tabs, reference, api) })
    } catch (error) {
      warnings.push({
        code: 'fetch-failed',
        source: reference.url,
        message: `Remote OpenAPI spec could not be imported: ${error instanceof Error ? error.message : String(error)}`,
      })
    }
  }

  // Every spec is bound, so every mount is linked once, local and remote together: each target carries the id its spec is served under,
  // and the redirects below exist before any guess from a link's last two segments.
  // A mount whose download failed is reserved all the same: it still owns the addresses under it, which stay as authored.
  // The operations of a tab that became pages are served by those pages, from the directory the pages are under: nothing is redirected there.
  const pageMounts = bound.flatMap(({ reference, endpointOperations }) => endpointOperations && reference.endpointPages ? [reference.endpointPages.directory] : [])
  const directories = [
    ...(bundle.localApiMounts ?? []).map(({ directory }) => directory),
    ...bundle.remoteApiSpecs.flatMap((reference) => (reference.directories ?? []).map(({ directory }) => directory)),
    ...pageMounts,
  ]
  const endpointRedirects = linkApiMounts(
    [
      ...(bundle.localApiMounts ?? []).map(({ filename, directory, tab, endpointOperations }) => ({
        filename,
        content: Buffer.from(assets.find((asset) => asset.path === `openapi/${filename}`)?.content ?? []),
        prefix: directory,
        ...(endpointOperations ? { endpointPages: true, operations: endpointOperations } : {}),
        ...(tab ? { tab } : {}),
      })),
      ...bound.flatMap(({ reference, filename, content, tabName, endpointOperations }) => endpointOperations && reference.endpointPages
        ? [{ filename, content, prefix: reference.endpointPages.directory, tab: tabName, endpointPages: true, operations: endpointOperations }]
        : (reference.directories ?? [])
          .map(({ directory, operations: listed }) => ({ filename, content, prefix: directory, tab: tabName, ...(listed ? { operations: listed } : {}) }))),
    ],
    { ...bundle.docsConfig, tabs, redirects },
    pages,
    warnings,
    directories,
  )
  for (const redirect of endpointRedirects) {
    redirects.push(redirect)
    endpointUrls.set(literalRoute(redirect.source) ?? redirect.source, redirect.destination)
  }

  reportEndpointPages(ledger, warnings)
  // A bare `openapi:` reference keeps the spec it reached when a spec's tab became pages and the lookup order changed.
  qualifyDisplacedBareRefs({
    pages,
    before: specLookupOrder(apiTabs, bundle.docsConfig.navigation?.versions),
    after: specLookupOrder(tabs, bundle.docsConfig.navigation?.versions),
    content: (source) => {
      const asset = assets.find((entry) => entry.path === source)
      return asset ? Buffer.from(asset.content) : undefined
    },
    qualifier: (source) => source,
  })
  // With every spec bound, a page that names an operation and sets no title takes the operation's.
  if (bundle.platform === 'mintlify') {
    titleOperationPages({
      pages,
      tabs,
      versions: bundle.docsConfig.navigation?.versions,
      content: (source) => {
        const asset = assets.find((entry) => entry.path === source)
        return asset ? Buffer.from(asset.content) : undefined
      },
    })
  }
  // The pages the operations became are routes of the site too, which no redirect may take.
  const served = servedRoutes(pages)
  // Lower case, and without a trailing slash: a redirect that differs from a guessed one only in letter case or a trailing slash wins on a server that ignores them, so none is guessed for that address.
  const existingSources = new Set(redirects.map((redirect) => literalRoute(redirect.source) ?? redirect.source.toLowerCase()))
  const mounts = directories.map(mountPrefix).filter(Boolean)
  const underMount = (source: string): boolean => mounts.some((prefix) => source.toLowerCase() === `/${prefix}` || source.toLowerCase().startsWith(`/${prefix}/`))
  // Last two segments of an operation's Mintlify URL (its tag and title, or `api-reference` and its title when it has no tag) -> its endpoint page;
  // null when more than one carries them, or its spec serves no endpoint pages.
  const guesses = new Map<string, string | null>()
  const specIds = apiTabSpecIds(tabs)
  for (const { reference, filename, content, tabName } of bound) {
    const specId = specIds.find(({ tab }) => tab.tab === tabName && tab.api?.source === `openapi/${filename}`)?.specId
    // A spec whose every mount lists operations published only those; any other spec published them all.
    const listed = reference.directories?.length && reference.directories.every((directory) => directory.operations)
      ? new Set(reference.directories.flatMap((directory) => directory.operations ?? []).map((name) => name.trim().split(/\s+/)).map(([method, ...path]) => `${method.toLowerCase()} ${path.join(' ')}`))
      : null
    const served = parseOpenApiOperationsForLinking(content).filter((operation) => !listed || listed.has(`${operation.method} ${operation.path}`))
    const endpoints = mintlifyEndpointUrls(DEFAULT_ENDPOINT_DIRECTORY, served)
    for (const operation of served) {
      const endpoint = endpoints.get(operation)!
      if (!endpoint.named) continue
      const key = endpoint.url.split('/').slice(-2).join('/')
      guesses.set(key, guesses.has(key) || !specId ? null : operationTarget(specId, operation))
    }
  }
  for (const source of authoredLinks) {
    const destination = guesses.get(source.split('/').filter(Boolean).slice(-2).join('/'))
    // Under a mount only the mount's own endpoint URLs (the redirects above) are known: anything else there is not a guess to make.
    if (!destination || existingSources.has(literalRoute(source) ?? source.toLowerCase()) || served.has(literalRoute(source) ?? source) || underMount(source)) continue
    redirects.push({ source, destination, permanent: false })
    existingSources.add(literalRoute(source) ?? source.toLowerCase())
  }
  // A page whose frontmatter `url` links to another address is reached through redirects that hide it on purpose; the
  // repository migration adds them after its own checks, so they skip these checks too and keep their place.
  const linkRedirects = new Set(pages.flatMap((page) => page.externalUrl ? pageEntryRoutes(page).map((source) => `${source} ${page.externalUrl}`) : []))
  const isLinkRedirect = (redirect: { source: string; destination: string }) => linkRedirects.has(`${redirect.source} ${redirect.destination}`)
  // A redirect that targets an endpoint URL goes straight to the endpoint page, not through a second redirect.
  // A link keeps the address its page wrote, or it would no longer be recognised as one (a site path can be an endpoint URL).
  const direct = redirects.map((redirect) => {
    const endpoint = isLinkRedirect(redirect) ? undefined : endpointUrls.get(literalRoute(redirect.destination) ?? '')
    return endpoint ? { ...redirect, destination: endpoint } : redirect
  })
  const boundConfig = { ...bundle.docsConfig, tabs, ...(direct.length > 0 ? { redirects: direct } : {}) }
  // As for any page the navigation lists, a directory the new pages sit in (a tag, a product's API folder) opens on its first page.
  const newPages = pages.slice(pagesBefore)
  const withDirectories = bundle.platform === 'mintlify' && newPages.length > 0 ? addMintlifyDirectoryRedirects(boundConfig, newPages) : boundConfig
  const links = (withDirectories.redirects ?? []).filter(isLinkRedirect)
  const unchecked = links.length > 0 ? { ...withDirectories, redirects: withDirectories.redirects!.filter((redirect) => !isLinkRedirect(redirect)) } : withDirectories
  // Redirects added above meet the same checks as any other: none may fail the build, hide a page that exists, or loop.
  const checked = dropConflictingRedirects(dropUnroutableRedirects(unchecked, warnings), pages, warnings)
  // The links come back after those checks, so the redirects the download added meet them again: a link that closes a loop with the
  // redirects before it is dropped and reported. No pages are passed because a link hides its own page on purpose.
  const checkedWithLinks = links.length > 0 ? dropConflictingRedirects({ ...checked, redirects: [...(checked.redirects ?? []), ...links] }, [], warnings) : checked
  return {
    ...bundle,
    pages,
    assets,
    docsConfig: checkedWithLinks,
    warnings,
  }
}

// Kept as a root-entry export for callers that already hydrate repository specs.
export { hydrateUrlOpenApi } from './url-openapi.js'
