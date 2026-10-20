/** Render canonical migration bundles into a portable Thally repository tree. */

import { destinationRoute, literalRoute } from './redirects.js'
import { mergeComponentRegistry } from './components.js'

import type {
  MigrationBundle,
  MigrationDocsConfig,
  MigrationNavigationGroup,
  RenderedMigrationFile,
} from './types.js'

function yamlString(value: string): string {
  return JSON.stringify(value.replace(/\s+/g, ' ').trim())
}

function renderPage(bundle: MigrationBundle, page: MigrationBundle['pages'][number]): string {
  return [
    '---',
    `title: ${yamlString(page.title)}`,
    page.headingTitle ? `headingTitle: ${yamlString(page.headingTitle)}` : null,
    page.navTitle ? `navTitle: ${yamlString(page.navTitle)}` : null,
    page.icon ? `icon: ${yamlString(page.icon)}` : null,
    page.iconType ? `iconType: ${yamlString(page.iconType)}` : null,
    `description: ${yamlString(page.description)}`,
    page.descriptionPlacement === 'body' || page.descriptionPlacement === 'operation' ? `descriptionPlacement: ${page.descriptionPlacement}` : null,
    page.badge ? `badge: ${yamlString(page.badge)}` : null,
    page.keywords.length > 0 ? `keywords: [${page.keywords.map(yamlString).join(', ')}]` : null,
    page.mode ? `mode: ${yamlString(page.mode)}` : null,
    page.hidden ? 'hidden: true' : null,
    page.noindex ? 'noindex: true' : null,
    // Group names must match identity-provider claims exactly, so they are
    // quoted as-is rather than whitespace-collapsed like display strings.
    page.groups?.length ? `groups: [${page.groups.map((group) => JSON.stringify(group)).join(', ')}]` : null,
    page.public !== undefined ? `public: ${page.public ? 'true' : 'false'}` : null,
    ...Object.entries(page.meta ?? {}).map(([field, value]) => `${field}: ${yamlString(value)}`),
    page.openapi ? `openapi: ${yamlString(page.openapi)}` : null,
    page.api ? `api: ${yamlString(page.api)}` : null,
    page.authMethod ? `authMethod: ${yamlString(page.authMethod)}` : null,
    page.playground ? `playground: ${yamlString(page.playground)}` : null,
    bundle.sourceKind === 'url' ? `source: ${yamlString(page.source)}` : null,
    '---',
    '',
    page.body,
    '',
  ].filter((line) => line !== null).join('\n')
}

function isIntegrationsObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/** Owner redirect sources win; distinct imported aliases survive without introducing literal cycles. */
function mergeRedirects(existing: MigrationDocsConfig['redirects'] = [], incoming: MigrationDocsConfig['redirects'] = []): NonNullable<MigrationDocsConfig['redirects']> {
  const redirects = [...existing]
  const key = (source: string): string => literalRoute(source) ?? source.replace(/\/+$/, '').toLowerCase()
  // Use the same browser normalization as migration's final redirect guard:
  // raw/encoded dot segments and queries must not disguise a cycle edge.
  const destinationKey = (destination: string): string | null => literalRoute(destinationRoute(destination) ?? '')
  const sources = new Set(existing.map((redirect) => key(redirect.source)))
  for (const redirect of incoming) {
    const source = key(redirect.source)
    if (sources.has(source)) continue
    const visited = new Set([source])
    let destination = destinationKey(redirect.destination)
    let cycle = false
    while (destination) {
      if (visited.has(destination)) { cycle = true; break }
      visited.add(destination)
      const next = redirects.find((candidate) => literalRoute(candidate.source) === destination)
      destination = next ? destinationKey(next.destination) : null
    }
    if (cycle) continue
    redirects.push(redirect)
    sources.add(source)
  }
  return redirects
}

/** Merge imported tabs into an existing site without duplicating changelog tabs. */
export function mergeMigrationConfig(
  existing: MigrationDocsConfig,
  incoming: MigrationDocsConfig,
): MigrationDocsConfig {
  const tabs = existing.tabs.filter((tab) => tab.tab.toLowerCase() !== 'changelog')
  const names = new Set(tabs.map((tab) => tab.tab.toLowerCase()))
  const seenPages = new Set<string>()
  function recordPages(pages: Array<string | MigrationNavigationGroup> = []): void {
    for (const page of pages) {
      if (typeof page === 'string') seenPages.add(page)
      else recordPages(page.pages)
    }
  }
  for (const tab of tabs) {
    recordPages(tab.pages)
    recordPages(tab.groups)
  }
  function uniquePages(
    pages: Array<string | MigrationNavigationGroup> = [],
  ): Array<string | MigrationNavigationGroup> {
    return pages.flatMap<string | MigrationNavigationGroup>((page) => {
      if (typeof page === 'string') {
        if (seenPages.has(page)) return []
        seenPages.add(page)
        return [page]
      }
      const children = uniquePages(page.pages)
      return children.length > 0 ? [{ ...page, pages: children }] : []
    })
  }
  function uniqueGroups(
    groups: Array<MigrationNavigationGroup> | undefined,
  ): Array<MigrationNavigationGroup> {
    return uniquePages(groups ?? []) as Array<MigrationNavigationGroup>
  }
  for (const tab of incoming.tabs) {
    if (tab.tab.toLowerCase() === 'changelog') continue
    const uniqueTab = {
      ...tab,
      ...(tab.pages ? { pages: uniquePages(tab.pages) } : {}),
      ...(tab.groups ? { groups: uniqueGroups(tab.groups) } : {}),
    }
    if ((tab.pages || tab.groups)
      && !uniqueTab.pages?.length
      && !uniqueTab.groups?.length
      && !tab.href
      && !tab.api) continue
    if (!names.has(tab.tab.toLowerCase())) {
      tabs.push(uniqueTab)
      names.add(tab.tab.toLowerCase())
      continue
    }
    const target = tabs.find((item) => item.tab.toLowerCase() === tab.tab.toLowerCase())
    if (!target) continue
    const incomingRootNodes = [
      ...(uniqueTab.pages ?? []),
      ...(uniqueTab.groups ?? []),
    ]
    if (uniqueTab.pages?.length) {
      target.pages = [...(target.pages ?? target.groups ?? []), ...incomingRootNodes]
      delete target.groups
    } else if (uniqueTab.groups?.length) {
      if (target.pages) target.pages = [...target.pages, ...uniqueTab.groups]
      else target.groups = [...(target.groups ?? []), ...uniqueTab.groups]
    }
  }
  const changelog = existing.tabs.find((tab) => tab.tab.toLowerCase() === 'changelog')
    ?? incoming.tabs.find((tab) => tab.tab.toLowerCase() === 'changelog')
  if (changelog) tabs.push(changelog)
  const i18n = existing.i18n || incoming.i18n
    ? {
        defaultLocale: existing.i18n?.defaultLocale ?? incoming.i18n?.defaultLocale ?? 'en',
        locales: [...new Map(
          [...(existing.i18n?.locales ?? []), ...(incoming.i18n?.locales ?? [])]
            .map((locale) => [locale.code, locale]),
        ).values()],
      }
    : undefined
  return {
    ...incoming,
    ...existing,
    tabs,
    ...((existing.redirects || incoming.redirects) ? { redirects: mergeRedirects(existing.redirects, incoming.redirects) } : {}),
    // A starter's primary action must not discard a newly imported logo.
    // Owner-authored fields, including an explicit null logo, remain authoritative.
    ...((incoming.navbar || existing.navbar) ? { navbar: { ...incoming.navbar, ...existing.navbar } } : {}),
    // Collection presentation belongs to the imported information
    // architecture; starter defaults must not coerce source dropdowns to tabs.
    navigation: incoming.navigation ?? existing.navigation,
    ...((existing.stylesheets?.length || incoming.stylesheets?.length)
      ? { stylesheets: [...new Set([...(existing.stylesheets ?? []), ...(incoming.stylesheets ?? [])])] }
      : {}),
    ...(i18n ? { i18n } : {}),
    // Existing providers win per provider; imported ones fill the gaps.
    // A malformed (string/array) existing value must not spread into index keys.
    ...(isIntegrationsObject(existing.integrations) || isIntegrationsObject(incoming.integrations)
      ? {
          integrations: {
            ...(isIntegrationsObject(incoming.integrations) ? incoming.integrations : {}),
            ...(isIntegrationsObject(existing.integrations) ? existing.integrations : {}),
          },
        }
      : {}),
  }
}

/** Materialize every canonical page, asset, and config as repository file changes. */
export function renderMigrationFiles(
  bundle: MigrationBundle,
  options: { existingConfig?: MigrationDocsConfig; existingComponentRegistry?: string } = {},
): Array<RenderedMigrationFile> {
  const config = options.existingConfig
    ? mergeMigrationConfig(options.existingConfig, bundle.docsConfig)
    : bundle.docsConfig
  return [
    ...bundle.pages.map((page) => ({
      path: `src/content/${page.id}.mdx`,
      content: renderPage(bundle, page),
    })),
    ...bundle.assets.map((asset) => ({ path: asset.projectRelative ? asset.path : `public/${asset.path}`, content: asset.content })),
    ...(bundle.componentFiles ?? []).flatMap((file) => file.path === 'src/mdx/custom-components.tsx'
      && options.existingComponentRegistry !== undefined && typeof file.content === 'string'
      ? mergeComponentRegistry(options.existingComponentRegistry, file.content)
      : [file]),
    ...(bundle.quarantinedFiles ?? []),
    { path: 'docs.json', content: `${JSON.stringify(config, null, 2)}\n` },
  ]
}
