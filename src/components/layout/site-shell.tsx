/** Interactive docs shell; server props preserve attribution through hydration. */

'use client'

import { Footer } from '@/components/layout/footer'
import { TopBar } from '@/components/layout/top-bar'
import { getHeaderNavigationLayout } from '@/components/navigation/header-layout'
import { Sidebar } from '@/components/navigation/sidebar'
import { PageContainer } from '@/components/layout/sections'
import { layout, shell } from '@/config/layout'
import type { SidebarCollection, DocsJsonNavbar, DocsJsonFooter, NavigationPresentation, DocsNavigationVersion, DocsNavigationShortcut } from '@/data/docs'
import { useSidebarCollectionsStore } from './sidebar-store'
import { usePathname } from 'next/navigation'
import { useMemo, useState } from 'react'
import { localizeCollectionHrefs } from '@/components/layout/localize-collections'
import { SiteNameProvider } from '@/components/layout/use-site-name'
import type { SiteIdentity } from '@/lib/site-config'
import type { NavigationSnapshot } from '@/lib/navigation-snapshot'
import { NavigationLoader, NavigationStatus } from './navigation-loader'

export interface I18nConfig {
  defaultLocale: string
  locales: Array<{ code: string; label: string }>
}

function collectionContainsPath(collection: SidebarCollection, pathname: string, currentPath?: string, localeRoot?: string) {
  if (collection.href && (matchesPath(collection.href, pathname, localeRoot) || matchesPath(collection.href, currentPath ?? pathname))) {
    return true
  }
  // API collections own all /api/* routes — check both full pathname and locale-stripped path
  // so the API tab is recognised on /es/api/... before the locale hydration completes.
  if (collection.api && (matchesPath('/api', pathname) || matchesPath('/api', currentPath ?? pathname))) {
    return true
  }
  return collection.sections.some((section) =>
    // Until the locale snapshot hydrates, the root layout still has primary
    // language hrefs. Those identify the same collection after removing locale.
    section.items.some((item) => matchesPath(item.href, pathname, localeRoot) || matchesPath(item.href, currentPath ?? pathname)),
  )
}

function matchesPath(targetHref: string, pathname: string, localeRoot?: string) {
  if (!targetHref || /^https?:\/\//i.test(targetHref)) {
    return false
  }
  const normalizedTarget = normalizePath(targetHref)
  const normalizedPath = normalizePath(pathname)
  // A translated home link has the same exact-match ownership as `/`; its
  // locale prefix must not turn it into the parent of every translated page.
  if (normalizedTarget === '/' || normalizedTarget === localeRoot) {
    return normalizedPath === normalizedTarget
      || (normalizedTarget === '/' && normalizedPath === '/introduction')
      || (normalizedTarget === localeRoot && normalizedPath === `${localeRoot}/introduction`)
  }
  return normalizedPath === normalizedTarget || normalizedPath.startsWith(`${normalizedTarget}/`)
}

function normalizePath(value: string) {
  if (!value) {
    return '/'
  }
  if (value === '/') {
    return '/'
  }
  return value.endsWith('/') ? value.slice(0, -1) : value
}

function navigationScopeKey(
  currentLocale: string,
  currentPath: string,
  i18nConfig?: I18nConfig | null,
) {
  if (i18nConfig && currentLocale !== i18nConfig.defaultLocale) {
    return `locale:${currentLocale}`
  }
  if (matchesPath('/api', currentPath)) {
    const segment = currentPath.split('/').filter(Boolean)[1] ?? 'default'
    let specId = segment
    try { specId = decodeURIComponent(segment) } catch { /* Preserve an invalid escape as an opaque scope. */ }
    return `api:${specId}`
  }
  return 'default'
}

interface SiteShellProps {
  children: React.ReactNode
  initialCollections: Array<SidebarCollection>
  navigationSnapshot?: NavigationSnapshot
  i18nConfig?: I18nConfig | null
  navbarConfig?: DocsJsonNavbar | null
  showPoweredBy?: boolean
  showSidebarGroupIcons?: boolean
  footerConfig?: DocsJsonFooter | null
  navigationPresentation: NavigationPresentation
  navigationVersions?: Array<DocsNavigationVersion>
  navigationShortcuts?: Array<DocsNavigationShortcut>
  identity: SiteIdentity
}

/** Compose navigation and the shared footer with request-resolved site policy. */
export function SiteShell({
  children,
  initialCollections,
  navigationSnapshot,
  i18nConfig,
  navbarConfig,
  footerConfig,
  showPoweredBy = true,
  showSidebarGroupIcons = true,
  navigationPresentation,
  navigationVersions = [],
  navigationShortcuts = [],
  identity,
}: SiteShellProps) {
  const pathname = usePathname()

  // Derive currentLocale and strip locale prefix from pathname
  let currentLocale = i18nConfig?.defaultLocale ?? 'en'
  let currentPath = pathname
  if (i18nConfig) {
    for (const locale of i18nConfig.locales) {
      if (locale.code === i18nConfig.defaultLocale) continue
      if (pathname === `/${locale.code}` || pathname.startsWith(`/${locale.code}/`)) {
        currentLocale = locale.code
        currentPath = pathname.slice(locale.code.length + 1) || '/'
        break
      }
    }
  }
  const scopeKey = navigationScopeKey(currentLocale, currentPath, i18nConfig)
  const localeRoot = pathname !== currentPath ? `/${currentLocale}` : undefined
  const hydratedCollections = useSidebarCollectionsStore(
    (state) => !navigationSnapshot || state.viewKey === navigationSnapshot.viewKey ? state.collectionsByScope[scopeKey] : undefined,
  )
  const navigationLoad = useSidebarCollectionsStore(state => !navigationSnapshot || state.viewKey === navigationSnapshot.viewKey ? state.navigationByScope?.[scopeKey] : undefined)
  const isNavigationPending = navigationLoad
    ? navigationLoad.snapshot.mode === 'deferred' && navigationLoad.status !== 'ready'
    : Boolean(navigationSnapshot && (scopeKey !== 'default' || navigationSnapshot.mode === 'deferred'))
  const routeLocale = currentLocale
  const isSecondaryLocale = Boolean(i18nConfig) && routeLocale !== i18nConfig?.defaultLocale
  const localizedInitialCollections = useMemo(
    () => (isSecondaryLocale ? localizeCollectionHrefs(initialCollections, routeLocale) : initialCollections),
    [initialCollections, isSecondaryLocale, routeLocale],
  )
  const collections = hydratedCollections ?? localizedInitialCollections
  const routeOwningVersions = navigationVersions.filter((version) => collections.some((collection) =>
    collection.version === version.label && collectionContainsPath(collection, pathname, currentPath, localeRoot)))
  const activeVersion = navigationVersions.find((version) => version.prefix
    && (currentPath === `/${version.prefix}` || currentPath.startsWith(`/${version.prefix}/`)))
    // A source can serve versioned pages outside its version prefix (for
    // example `/api-reference/v1-endpoint/scrape`). Use unique navigation
    // ownership before falling back to the default version.
    ?? (routeOwningVersions.length === 1 ? routeOwningVersions[0] : undefined)
    ?? navigationVersions.find((version) => version.default)
    ?? navigationVersions[0]
  const visibleCollections = activeVersion
    ? collections.filter((collection) => !collection.version || collection.version === activeVersion.label)
    : collections
  const navigableCollections = visibleCollections.filter((collection) => collection.sections.length > 0)
  const matchedCollection =
    navigableCollections.find((collection) => collectionContainsPath(collection, pathname, currentPath, localeRoot)) ??
    navigableCollections[0] ??
    visibleCollections[0]
  // Manual override: set when the user clicks a tab and ignored once navigation
  // leaves that collection. Deriving validity here avoids an effect-driven state reset.
  const [selectedCollectionId, setSelectedCollectionId] = useState<SidebarCollection['id'] | null>(null)
  const selectedCollection = navigableCollections.find((collection) => collection.id === selectedCollectionId)
  const activeCollection = (
    selectedCollection && collectionContainsPath(selectedCollection, pathname, currentPath, localeRoot)
      ? selectedCollection
      : matchedCollection) ?? { id: 'navigation-empty', label: identity.name, sections: [] }

  // The tab to highlight. A standalone href tab (e.g. Changelog) that owns no
  // sidebar sections still wins the highlight when its href matches the current
  // path — otherwise the section-derived collection (Overview/API/…) does.
  const activeTabId =
    visibleCollections.find(
      (collection) =>
        collection.href &&
        !/^https?:\/\//.test(collection.href) &&
        (matchesPath(collection.href, pathname, localeRoot) || matchesPath(collection.href, currentPath)),
    )?.id ?? activeCollection.id
  const relocatedGithubHref = navbarConfig?.links?.find((link) => link.type === 'github')?.href

  // `clip` contains horizontal spill without creating a scroll container,
  // which lets the banner-aware desktop sidebar remain sticky.
  return (
    <SiteNameProvider initialName={identity.name}>
      {navigationSnapshot ? <NavigationLoader scope={scopeKey} /> : null}
      <div className="thally-docs-root min-h-screen w-full overflow-x-clip bg-background text-foreground" data-navigation={navigationPresentation.display} data-header-layout={getHeaderNavigationLayout(navigationPresentation.display, visibleCollections.length)} data-thally-navigation-state={isNavigationPending ? (navigationLoad?.status === 'error' ? 'error' : 'loading') : 'ready'}>
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[100] focus:rounded-md focus:bg-background focus:px-4 focus:py-2 focus:text-foreground focus:shadow-lg"
        >
          Skip to content
        </a>
        <TopBar
          collections={visibleCollections}
          activeCollectionId={activeTabId}
          onCollectionChange={(id) => {
            const target = visibleCollections.find((collection) => collection.id === id)
            if (!target) return
            setSelectedCollectionId(target.id)
          }}
          activeSections={activeCollection.sections}
          navigationPresentation={navigationPresentation}
          navigationVersions={navigationVersions}
          activeVersion={activeVersion?.label}
          i18nConfig={i18nConfig ?? null}
          currentLocale={currentLocale}
          currentPath={currentPath}
          navbarConfig={navbarConfig ?? null}
          siteLinks={identity.links}
          showSidebarGroupIcons={showSidebarGroupIcons}
          navigationStatus={isNavigationPending ? <NavigationStatus scope={scopeKey} /> : undefined}
        />
        <div className={`thally-docs-shell flex min-h-[calc(100dvh-var(--docs-header-height,60px))] w-full ${shell.wrapper}`}>
          {isNavigationPending ? <aside className={`thally-docs-sidebar hidden shrink-0 lg:block ${layout.sidebarWidth}`}><NavigationStatus scope={scopeKey} /></aside> : <Sidebar
            sections={activeCollection.sections}
            title={activeCollection.label}
            collections={visibleCollections}
            activeCollectionId={activeCollection.id}
            onCollectionChange={setSelectedCollectionId}
            navigationPresentation={navigationPresentation}
            shortcuts={navigationShortcuts}
            showGroupIcons={showSidebarGroupIcons}
          />}
          <div className="flex min-h-[calc(100dvh-var(--docs-header-height,60px))] w-full min-w-0 flex-1 flex-col">
            <main id="main-content" className="thally-docs-main flex-1 py-10 pb-24">
              <PageContainer className={layout.pageGap}>{children}</PageContainer>
            </main>
            <Footer
              footerConfig={footerConfig ?? null}
              githubHref={relocatedGithubHref}
              showPoweredBy={showPoweredBy}
              siteName={identity.name}
              siteLinks={identity.links}
            />
          </div>
        </div>
      </div>
    </SiteNameProvider>
  )
}
