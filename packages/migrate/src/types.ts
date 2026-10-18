/**
 * Canonical migration contracts shared by repository, CLI, MCP, and hosted
 * import paths. Callers materialize this bundle only after discovery and
 * normalization finish, so a partial crawl can never leave a half-written site.
 */

export type MigrationPlatform =
  | 'mintlify'
  | 'docusaurus'
  | 'fern'
  | 'gitbook'
  | 'nextra'
  | 'vitepress'
  | 'starlight'
  | 'thally'
  | 'generic'
  | 'unknown'

export interface MigrationNavigationGroup {
  defaultOpen?: boolean
  group: string
  icon?: string
  hidden?: boolean
  pages: Array<string | MigrationNavigationGroup>
}

export interface MigrationNavigationTab {
  tab: string
  /** Reader-facing label when `tab` includes a version for unique identity. */
  displayLabel?: string
  version?: string
  description?: string
  icon?: string
  href?: string
  hidden?: boolean
  /** Root page/group nodes used when the source has no synthetic section heading. */
  pages?: Array<string | MigrationNavigationGroup>
  groups?: Array<MigrationNavigationGroup>
  api?: { source: string; navigation?: boolean }
}

export interface MigrationBannerConfig {
  content: string | Record<string, string>
  dismissible?: boolean
  id?: string
  revision?: string
  type?: 'info' | 'warning' | 'critical'
  color?: { light?: string; dark?: string }
}

export interface MigrationNavbarConfig {
  links?: Array<{ label: string; href: string; type?: 'github'; button?: { background: string; color?: string } }>
  /** Explicit null suppresses the starter's sample call to action. */
  primary?: { label: string; href: string; type?: 'github' } | null
  /** Local public assets used until an owner uploads a brand replacement. */
  /** Explicit null requests a text-only brand when the source has no logo. */
  logo?: { light: string; dark?: string; showTitle?: boolean; rightText?: string } | null
}

export interface MigrationFooterConfig {
  socials?: Record<string, string>
  /** Literal footer attribution; `{year}` is resolved by the site at render time. */
  copyright?: string
  links?: Array<{
    heading: string
    items: Array<{ label: string; href: string }>
  }>
}

export interface MigrationDocsConfig {
  markdown?: { enabled?: boolean }
  /** Local site-authored CSS projected from a source docs site, served from public/. */
  stylesheets?: Array<string>
  /** `false` hides the breadcrumb trail; Mintlify pages show only a group eyebrow. */
  breadcrumbs?: boolean
  tabs: Array<MigrationNavigationTab>
  navigation?: {
    /** How sibling documentation collections are presented to readers. */
    display?: 'tabs' | 'dropdown'
    versions?: Array<{ label: string; prefix: string; href: string; default?: boolean; hidden?: boolean }>
    shortcuts?: Array<{ label: string; href: string; icon?: string }>
  }
  theme?: 'default' | 'maple' | 'sharp' | 'minimal'
  appearance?: { default?: 'system' | 'light' | 'dark'; showToggle?: boolean }
  background?: { image?: string; imageDark?: string; decoration?: 'none' | 'grid' | 'gradient' }
  /** Icon set for content `icon` names; Mintlify's `icons.library` carries through. */
  contextual?: { options?: Array<string> }
  colors?: Partial<Record<'light' | 'dark', { primary?: string; accent?: string; background?: string }>>
  icons?: { library?: 'lucide' | 'fontawesome' | 'tabler' }
  banner?: MigrationBannerConfig
  navbar?: MigrationNavbarConfig
  favicon?: { light: string; dark?: string }
  footer?: MigrationFooterConfig
  seo?: { indexing?: 'navigable' | 'all'; titleSeparator?: string; sitemap?: 'navigable'; metatags?: Record<string, string> }
  fonts?: {
    body?: { family: string; weight?: Array<string> }
    heading?: { family: string; weight?: Array<string> }
  }
  feedback?: { thumbsRating?: boolean }
  customScripts?: Array<{ src: string; strategy?: 'beforeInteractive' | 'afterInteractive' | 'lazyOnload' }>
  ai?: { chat?: boolean; label?: string; icon?: string }
  admin?: { enabled?: boolean }
  analytics?: { enabled?: boolean }
  /** Manual API pages: default server(s) and auth for `api:` frontmatter pages. */
  api?: {
    mdx?: { server?: string | Array<string>; auth?: { method?: 'bearer' | 'basic' | 'key'; name?: string } }
    /** Mintlify `api.playground.display`; `auth` is carried as `simple`. */
    playground?: { display: 'interactive' | 'simple' | 'none' }
    /** `false` hides the visible "OpenAPI specification" line; Mintlify does not show it. */
    specLink?: boolean
  }
  /** Third-party analytics in Mintlify's `integrations` shape; validated again by the renderer. */
  integrations?: {
    ga4?: { measurementId: string }
    gtm?: { tagId: string }
    posthog?: { apiKey: string; apiHost?: string; sessionRecording?: boolean }
    plausible?: { domain: string; server?: string }
  }
  redirects?: Array<{ source: string; destination: string; permanent?: boolean }>
  i18n?: {
    defaultLocale: string
    locales: Array<{ code: string; label: string }>
    /** Source-authored navigation labels and ordering for each translation. */
    navigation?: Record<string, Array<MigrationNavigationTab>>
  }
}

export interface MigrationPage {
  /** Path below `src/content`, without the `.mdx` extension. */
  id: string
  /** Locale-independent page id used by the shared navigation projection. */
  navigationId: string
  locale?: string
  title: string
  /** Authored display H1 when the source uses a different metadata title. */
  headingTitle?: string
  navTitle?: string
  /** Sidebar icon name or image URL from page frontmatter, with its optional style. */
  icon?: string
  iconType?: 'regular' | 'solid' | 'outline' | 'brands'
  description: string
  /** Keep SEO/search description without repeating it above Docusaurus body copy. */
  descriptionPlacement?: 'body'
  badge?: string
  keywords: Array<string>
  mode?: 'default' | 'wide' | 'custom' | 'center' | 'home'
  hidden?: boolean
  noindex?: boolean
  /**
   * Reader access groups (frontmatter `groups`): trimmed, non-empty names the
   * runtime matches exactly. The page needs a signed-in reader in one of them.
   */
  groups?: Array<string>
  /** Frontmatter `public`: `true` opens the page to anyone, `false` needs any signed-in reader. */
  public?: boolean
  /** Social/SEO overrides from `og:*` and `twitter:*` frontmatter, keyed by the migrated frontmatter field. */
  meta?: Partial<Record<'ogTitle' | 'ogDescription' | 'ogImage' | 'twitterTitle' | 'twitterDescription' | 'twitterImage', string>>
  /** OpenAPI operation key rendered by Thally instead of ordinary MDX. */
  openapi?: string
  /** Manual API page: `METHOD <url-or-path>`; rendered by Thally's playground. */
  api?: string
  /** Page-level playground auth override: bearer | basic | key | none. */
  authMethod?: string
  /** Page-level `playground` override: interactive | simple | none (`auth` becomes `simple`). */
  playground?: 'interactive' | 'simple' | 'none'
  body: string
  source: string
  /** Set when the page's frontmatter was invalid YAML; the page is kept with a best-effort salvage. */
  frontmatterError?: string
}

export interface MigrationAsset {
  /** Path below `public` (or below the project root when `projectRelative`), always normalized and traversal-free. */
  path: string
  content: Uint8Array
  /** Write at the project root instead of `public/`, so the host never serves it statically. */
  projectRelative?: boolean
}

export interface MigrationWarning {
  code:
    | 'collision'
    | 'invalid-page'
    | 'missing-page'
    | 'unsupported-config'
    | 'limit-reached'
    | 'fetch-failed'
    | 'skipped-file'
    /** Access-restricted source content: migrated with access rules, withheld (quarantined), or a site-wide auth risk. */
    | 'gated-page'
  message: string
  source?: string
}

/** A repository-configured remote OpenAPI spec, downloaded after the bundle is built. */
/** A route prefix Mintlify served one spec's generated endpoint pages under (`openapi: { source, directory }`). */
export interface RemoteApiSpecDirectory {
  /** The authored `directory`, without leading or trailing slashes. */
  directory: string
  /** `METHOD /path` operations docs.json lists under that reference, in authored order; absent when Mintlify generates every operation. */
  operations?: Array<string>
}

export interface RemoteApiSpec {
  url: string
  tabLabel?: string
  parentTab?: string
  icon?: string
  hidden?: boolean
  /** Every `directory` docs.json mounts this spec under: several API tabs may share one spec URL. */
  directories?: Array<RemoteApiSpecDirectory>
  /** Operation keys (`get /x`) only access-restricted pages document; marked `x-excluded` after download. */
  withheldOperations?: Array<string>
  /** Operation keys published pages or docs.json also name; keeps a shared `$ref` path item public. */
  keptOperations?: Array<string>
}

export interface MigrationBundle {
  sourceUrl: string
  sourceKind: 'repository' | 'url'
  platform: MigrationPlatform
  pages: Array<MigrationPage>
  assets: Array<MigrationAsset>
  /** Repository-configured remote specs awaiting a bounded network fetch by the host. */
  remoteApiSpecs?: Array<RemoteApiSpec>
  /**
   * Repository OpenAPI specs docs.json mounts under a `directory` (no surrounding slashes), with the tab each is bound to; the remote ones are in
   * `remoteApiSpecs[].directories`. Present only alongside remote specs: a spec's id depends on which remote tabs bind ahead of it, so
   * hydration links the local and remote mounts together once every download has settled, and the links stay as authored until then.
   */
  localApiMounts?: Array<{ filename: string; directory: string; tab?: string }>
  /** Customer-owned component source and registry; paths are repository-relative. */
  componentFiles?: Array<RenderedMigrationFile>
  /**
   * Restricted content that cannot be published safely (pages whose access
   * rules are malformed or contradictory, and assets used only by restricted
   * pages), written outside every published path.
   */
  quarantinedFiles?: Array<RenderedMigrationFile>
  /** Access-restricted pages the file limit dropped: neither published nor saved in quarantinedFiles. */
  droppedGatedPages?: number
  /** Mintlify `sourceRef` repositories imported under a mount path, with their page counts. */
  sourceRefs?: Array<{ repo: string; mountPath: string; pages: number }>
  docsConfig: MigrationDocsConfig
  site?: {
    name?: string
    description?: string
    /**
     * Source theme accent color(s), each a `#rrggbb`/`#rgb` hex string.
     * Follows Mintlify's own `colors` schema: `light` is the color used in
     * dark mode and `dark` is the color used in light mode. Fern's colors
     * are normal (its `light`/`dark` match the mode they paint), so
     * extraction swaps them onto this shape for a single downstream contract.
     */
    colors?: {
      primary?: string
      light?: string
      dark?: string
    }
  }
  warnings: Array<MigrationWarning>
  /** Evidence checks are independent of whether generated site code builds. */
  urlMigrationValidation?: import('./url-run-types.js').UrlMigrationValidation
  stats: {
    discovered: number
    imported: number
    skipped: number
  }
}

export interface MigrationFetchRequest {
  accept: string
}

export interface MigrationFetchResponse {
  finalUrl: URL
  body: string
  contentType: string
  /** Capture adapters should retain target errors even when provider calls succeed. */
  status?: number
  headers?: Record<string, string | undefined>
}

/**
 * Network boundary injected by each host. Thally Cloud supplies a DNS-pinned,
 * SSRF-safe implementation; the local CLI uses the user's normal network.
 */
export type MigrationFetcher = (
  url: URL,
  request: MigrationFetchRequest,
) => Promise<MigrationFetchResponse>

export interface RenderedMigrationFile {
  path: string
  content: string | Uint8Array
}
