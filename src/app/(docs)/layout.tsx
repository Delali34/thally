/** Request-bound documentation shell shared by every rendered content route. */

import { shouldShowPoweredBy } from '@/lib/cloud-link/powered-by'
import { getBuildContentControls } from '@/lib/cloud-link/content-controls'
import { SiteShell } from '@/components/layout/site-shell'
import { SidebarCollectionsHydrator } from '@/components/layout/sidebar-hydrator'
import { getAiConfig, getNavbarConfig, getFooterConfig, getNavigationPresentation, getNavigationVersions, getNavigationShortcuts } from '@/data/docs'
import { DocsCodeActionsProvider } from '@/components/docs/code-actions-provider'
import { getEffectiveI18nConfig } from '@/lib/i18n/request'
import { resolveBuildSiteConfig, siteIdentity } from '@/lib/site-config'
import { loadNavigationSnapshot } from '@/lib/navigation-snapshot-server'

interface DocsLayoutProps {
  children: React.ReactNode
}

/** Resolve attribution on the server so paid removal never emits footer markup. */
export default async function DocsLayout({ children }: DocsLayoutProps) {
  const showPoweredBy = await shouldShowPoweredBy()
  const contentControls = getBuildContentControls()
  // Navigation is filtered per reader: restricted page titles never reach
  // readers who cannot open them. API-reference navigation has no page
  // frontmatter, so it follows the site default visibility.
  const navigationSnapshot = await loadNavigationSnapshot('default')
  const collections = navigationSnapshot.collections
  const aiConfig = getAiConfig()
  const i18nConfig = await getEffectiveI18nConfig()
  const navbarConfig = getNavbarConfig()
  const footerConfig = getFooterConfig()
  const navigationPresentation = getNavigationPresentation()
  const effectiveSite = resolveBuildSiteConfig()
  const codeReportRepositoryUrl =
    effectiveSite.repoUrl ||
    effectiveSite.links.find((link) => link.label.toLowerCase() === 'github')?.href ||
    ''

  return (
    <>
      <SidebarCollectionsHydrator collections={collections} snapshot={navigationSnapshot} />
      <DocsCodeActionsProvider
        initialRepositoryUrl={codeReportRepositoryUrl}
        label={aiConfig.label}
        icon={aiConfig.icon}
      >
        <SiteShell
          initialCollections={collections}
          navigationSnapshot={navigationSnapshot}
          i18nConfig={i18nConfig}
          navbarConfig={navbarConfig}
          footerConfig={footerConfig}
          showPoweredBy={showPoweredBy}
          showSidebarGroupIcons={contentControls.showSidebarGroupIcons}
          navigationPresentation={navigationPresentation}
          navigationVersions={getNavigationVersions()}
          navigationShortcuts={getNavigationShortcuts()}
          identity={siteIdentity(effectiveSite)}
        >
          {children}
        </SiteShell>
      </DocsCodeActionsProvider>
    </>
  )
}
