import type { ComponentType } from 'react'
import type { NormalizedOperation } from '@/lib/openapi/types'
import { sanitizeApiMdxConfig, type ApiMdxConfig } from '@/lib/openapi/manual-operation'
import { getContentIndex, loadContentIndex, type ContentIndex } from '@/lib/content-index'
import { parseFrontmatter } from '@/lib/frontmatter'
import { listRuntimeSources, readRuntimeSource, runtimeSourceExists } from '@/lib/runtime-sources'
import { getDocsJsonConfig, getDocsJsonConfigRevision } from '@/lib/docs-json-config'
import { resolveIconLibrary, type IconLibrary, type IconStyle } from '@/lib/icon-library'
import { projectNavigationContract } from '@thallylabs/core/navigation'
import { SUPPORTED_LOCALE_OPTIONS } from '@/lib/i18n/config'
import { pageApiMetadata } from '@/lib/openapi/page-api'
import type { OpenApiFrontmatterRef } from '@/lib/openapi/page-frontmatter'
import type { ManualApiTarget } from '@/lib/openapi/manual-operation'
import { UNPUBLISHED_PAGES_FILE } from '@/lib/openapi/publication'
import { getReaderAuthConfig } from '@/lib/reader-auth/config'
import {
  ANONYMOUS_READER,
  FRONTMATTER_ERROR_MARKER,
  MALFORMED_PAGE_ACCESS,
  OPEN_PAGE_ACCESS,
  canReaderAccessPage,
  mergePageAccess,
  parsePageAccess,
  readerVisibilityKey,
  referencedGroups,
  type PageAccess,
  type ReaderContext,
} from '@/lib/reader-auth/access'


// ---------------------------------------------------------------------------
// Public interfaces (consumed by components, pages, and stores)
// ---------------------------------------------------------------------------

export type DocPageMode = 'default' | 'wide' | 'custom' | 'center' | 'home'

export interface DocEntry {
  id: string
  title: string
  /** Visible H1; title remains the metadata/search title. */
  headingTitle?: string
  description: string
  /** `operation` keeps a generated summary in metadata and renders the bound spec's full description. */
  descriptionPlacement?: 'body' | 'operation'
  slug: Array<string>
  href: string
  group: string
  badge?: string
  keywords: Array<string>
  component: ComponentType<Record<string, unknown>>
  timeEstimate: string
  lastUpdated: string
  /** Public provenance: ISO date a human last confirmed this page is accurate. */
  lastVerified?: string
  /** Public provenance: product version this page was verified against. */
  verifiedVersion?: string
  openapi?: OpenApiFrontmatterRef
  /** Target of a manual `api:` page, as the page index sees it (no ParamFields: that needs the MDX body). */
  manualTarget?: ManualApiTarget
  /** Synthetic operation for a manual `api:` page (header + Try It); see manual-operation.ts. */
  manualApi?: NormalizedOperation
  /** Page-level `playground` frontmatter; see `resolvePlaygroundDisplay`. */
  playground?: string
  noindex?: boolean
  hidden?: boolean
  /**
   * Reader access from `groups` / `public` frontmatter. Every listing in this
   * module filters on it; see `@/lib/reader-auth/access` for the semantics.
   */
  access?: PageAccess
  mode?: DocPageMode
  /** Social/SEO overrides migrated from `og:*` / `twitter:*` frontmatter. */
  ogTitle?: string
  ogDescription?: string
  ogImage?: string
  twitterTitle?: string
  twitterDescription?: string
  twitterImage?: string
}


export interface NavigationSection {
  defaultOpen?: boolean
  /** Stable structural identity; unlike a title, this remains unique when a group is split. */
  id?: string
  title: string
  icon?: string
  /** All descendant pages in authored order for routing and machine projections. */
  items: Array<NavigationItem>
  /** Recursive reader-facing tree. Omitted for generated flat sections such as OpenAPI tags. */
  nodes?: Array<NavigationNode>
}

export interface NavigationGroup {
  defaultOpen?: boolean
  id: string
  title: string
  icon?: string
  nodes: Array<NavigationNode>
}

export type NavigationNode =
  | { type: 'page'; item: NavigationItem }
  | { type: 'group'; group: NavigationGroup }

export interface NavigationPresentation {
  display: 'tabs' | 'dropdown'
  /** `all` keeps the heading of a group that is named after its collection; by default it is left out. */
  groupHeadings?: 'all'
}

export interface DocsNavigationVersion {
  label: string
  prefix: string
  href: string
  default?: boolean
  /** Hidden from the version switcher; its pages stay reachable by URL. */
  hidden?: boolean
}

export interface DocsNavigationShortcut {
  label: string
  href: string
  icon?: string
}

export interface SidebarCollection {
  id: string
  label: string
  version?: string
  description?: string
  icon?: string
  sections: Array<NavigationSection>
  href?: string
  api?: DocsJsonApiConfig
}

export interface NavigationItem {
  id: string
  title: string
  href: string
  badge?: string
  /** HTTP method of the page's `openapi:` operation, shown as a pill in the sidebar. */
  method?: string
  /** Sidebar icon from page frontmatter (name, or an image path/URL). */
  icon?: string
  iconType?: IconStyle
  description?: string
  /** Authored group ancestry, used by breadcrumbs without flattening the visible sidebar. */
  groupPath?: Array<string>
}

export interface SearchableDoc {
  id: string
  title: string
  description: string
  href: string
  keywords: Array<string>
}

// ---------------------------------------------------------------------------
// docs.json schema types
// ---------------------------------------------------------------------------

interface DocsJsonNavigationGroup {
  defaultOpen?: boolean
  group: string
  icon?: string
  hidden?: boolean
  pages: Array<string | DocsJsonNavigationGroup>
}

/** A sidebar group of an API tab; strings in `pages` are operation keys (`METHOD /path`, `WEBHOOK METHOD name`). */
export interface DocsJsonApiGroup {
  group: string
  icon?: string
  pages: Array<string | DocsJsonApiGroup>
}

export interface DocsJsonApiConfig {
  source: string
  /** Set false when authored MDX groups already provide API navigation. */
  navigation?: boolean
  /** Authored sidebar of this tab's operations, replacing the tag groups. Unlisted operations keep their pages. */
  groups?: Array<DocsJsonApiGroup>
  tagsOrder?: Array<string>
  defaultGroup?: string
  webhookGroup?: string
  overrides?: Record<
    string,
    {
      title?: string
      description?: string
      badge?: string
      group?: string
      slug?: Array<string>
      hidden?: boolean
    }
  >
}

interface DocsJsonTab {
  tab: string
  displayLabel?: string
  version?: string
  description?: string
  icon?: string
  href?: string
  hidden?: boolean
  pages?: Array<string | DocsJsonNavigationGroup>
  groups?: Array<DocsJsonNavigationGroup>
  api?: DocsJsonApiConfig
}

export interface DocsJsonRedirect {
  source: string
  destination: string
  permanent?: boolean
}

export interface DocsJsonBanner {
  /** Banner copy, or locale-keyed copy resolved against the default locale. */
  content: string | Record<string, string>
  dismissible?: boolean
  /** Stable identity used to scope dismissal state across banner revisions. */
  id?: string
  /** Change this value to show a previously dismissed banner again. */
  revision?: string
  /** Mintlify-compatible intent name. */
  type?: 'info' | 'warning' | 'critical'
  variant?: 'info' | 'warning' | 'critical'
  /** Optional, validated hex colors for the light and dark banner surfaces. */
  color?: { light?: string; dark?: string }
}

export interface DocsJsonNavLink {
  label: string
  href: string
  type?: 'github'
  /** Render the link as a filled button, for a source site that styled it that way. */
  button?: { background: string; color?: string }
}

export interface DocsJsonNavbar {
  links?: Array<DocsJsonNavLink>
  /** `type: 'github'` shows the repository name and its star count instead of a labelled button. */
  primary?: { label: string; href: string; type?: 'github' } | null
  /** Public assets for a portable, source-owned logo fallback. */
  /** Explicit null keeps a source site's text-only wordmark. */
  logo?: { light: string; dark?: string; showTitle?: boolean; rightText?: string } | null
}

export interface DocsJsonFooterColumn {
  heading: string
  items: Array<{ label: string; href: string }>
}

export interface DocsJsonFooter {
  socials?: Record<string, string>
  /** Optional imported attribution; `{year}` follows the current year. */
  copyright?: string
  links?: Array<DocsJsonFooterColumn>
}

export interface DocsJsonSeo {
  /** "navigable" (default) excludes hidden pages; "all" indexes them too */
  indexing?: 'navigable' | 'all'
  /** Joins a page title and the site name in `<title>`; unset keeps the `title | site` template. */
  titleSeparator?: string
  /** "navigable" lists only pages shown in navigation in the sitemap, like Mintlify; default lists every indexable page. */
  sitemap?: 'navigable'
  /** Extra `<meta name content>` tags for every page, e.g. a search console verification token. Names and values are validated at render (`validMetatags`): plain names, string values of at most 1000 characters, no `http-equiv` directives. */
  metatags?: Record<string, string>
}

export interface DocsJsonScript {
  src: string
  strategy?: 'beforeInteractive' | 'afterInteractive' | 'lazyOnload'
}

export interface DocsJsonFontConfig {
  /** Google Font family name, e.g. "Plus Jakarta Sans" */
  family: string
  /** Weight values to load, e.g. ["400", "500", "600", "700"]. Defaults to ["400","500","600","700"]. */
  weight?: string[]
}

export interface DocsJsonFonts {
  /** Font applied to body text and the overall UI */
  body?: DocsJsonFontConfig
  /** Font applied to h1–h6 headings. Defaults to the body font when omitted. */
  heading?: DocsJsonFontConfig
}

export interface DocsJsonFeedback {
  /** POST endpoint for ratings and optional negative follow-ups. */
  endpoint?: string
  /** Show thumbs up/down widget. Defaults to true. */
  thumbsRating?: boolean
}

export type StructuralTheme = 'default' | 'maple' | 'sharp' | 'minimal'
export type ContentIconTone = 'neutral' | 'accent'

export interface DocsJsonConfig {
  tabs: Array<DocsJsonTab>
  /** Local, customer-owned stylesheets served from public/. */
  stylesheets?: Array<string>
  /** Page breadcrumb trail above each title. Defaults to true; `false` hides it. */
  breadcrumbs?: boolean
  /** Text above each page title: its nearest group (default) or its full group path. */
  eyebrow?: 'group' | 'path'
  /**
   * Typographic quotes in rendered prose: straight quotes become curly ones, as in Mintlify.
   * Defaults to false. Code, heading ids, Markdown, `llms.txt` and search text keep straight quotes.
   * Applied by the MDX pipeline (`src/mdx/rehype.ts`), which reads it from docs.json itself.
   */
  smartQuotes?: boolean
  /** Manual API pages (`api:` frontmatter): default server(s) and auth for the playground. */
  api?: {
    mdx?: {
      server?: string | Array<string>
      auth?: { method?: 'bearer' | 'basic' | 'key'; name?: string }
    }
    /** Mintlify `api.playground.display`: interactive (default), simple, none or auth. */
    playground?: { display?: string }
    /** Show the "OpenAPI specification: <url>" line above generated operations. Defaults to true; `false` hides it. */
    specLink?: boolean
  }
  navigation?: {
    display?: 'tabs' | 'dropdown'
    /** `all` keeps the heading of a sidebar group named after its collection; `distinct` (default) leaves it out. */
    groupHeadings?: 'distinct' | 'all'
    versions?: Array<DocsNavigationVersion>
    shortcuts?: Array<DocsNavigationShortcut>
  }
  redirects?: Array<DocsJsonRedirect>
  banner?: DocsJsonBanner
  navbar?: DocsJsonNavbar
  /** Page-menu entries (`copy`, `view`, `chatgpt`, `claude`, `perplexity`) in display order. */
  contextual?: { options?: Array<string> }
  /** Hex brand colours per mode (six digits); `primary` fills buttons, `accent` links and highlights, `background` is the canvas. */
  colors?: Partial<Record<'light' | 'dark', { primary?: string; accent?: string; background?: string }>>
  /** Public favicon fallback when no managed or admin asset is configured. */
  favicon?: { light: string; dark?: string }
  footer?: DocsJsonFooter
  seo?: DocsJsonSeo
  customScripts?: Array<DocsJsonScript>
  /**
   * Mintlify-shaped third-party analytics: `ga4.measurementId`, `gtm.tagId`,
   * `posthog.{apiKey,apiHost,sessionRecording}`, `plausible.{domain,server}`.
   * Validated by `resolveAnalyticsConfig`; `siteConfig.analytics` wins per provider.
   */
  integrations?: Record<string, unknown>
  fonts?: DocsJsonFonts
  feedback?: DocsJsonFeedback
  /** Visual choices that remain independent of the structural theme. */
  appearance?: {
    /** Initial reader mode; hidden controls enforce this preference. */
    default?: 'system' | 'light' | 'dark'
    showToggle?: boolean
    /** Card and tile icons are neutral by default or inherit the live brand accent. */
    contentIcons?: ContentIconTone
  }
  background?: {
    image?: string
    imageDark?: string
    decoration?: 'none' | 'grid' | 'gradient'
  }
  /** Icon set used for every `icon` name in content. Mirrors Mintlify's `icons.library`. */
  icons?: {
    /** "lucide" (default) | "fontawesome" | "tabler" */
    library?: IconLibrary
  }
  /**
   * Structural theme controlling border radius, sidebar active style, and nav
   * tab appearance. Independent of brand colors.
   * Values: "default" | "maple" | "sharp" | "minimal"
   */
  theme?: StructuralTheme
  ai?: {
    chat?: boolean
    /** Label shown in the navbar assistant button and chat header. Defaults to "Ask AI". */
    label?: string
    /**
     * Icon shown in the chat panel. Either a named icon ("sparkles" | "zap" | "bot" |
     * "brain" | "stars" | "wand") or a URL / path to an image (e.g. "/logo.png").
     * Defaults to "sparkles".
     */
    icon?: string
    /** Custom system prompt for the AI assistant. Appended to the docs context instruction. */
    systemPrompt?: string
  }
  /** Credentials applied to the API Try It playground from OpenAPI security scheme names. */
  apiPlayground?: {
    credentials?: Record<string, string>
    /** How long the Try It relay waits for the API, in milliseconds. Default 60000, clamped to 1000-120000. */
    timeoutMs?: number
  }
  /** Built-in analytics dashboard at /admin (requires THALLY_ADMIN_PASSWORD env). */
  admin?: {
    enabled?: boolean
  }
  analytics?: {
    enabled?: boolean
  }
  /** Optional public Markdown mirrors at `/<page>.md`; disabled by default. */
  markdown?: {
    enabled?: boolean
  }
  i18n?: {
    defaultLocale: string
    locales: Array<{ code: string; label: string }>
    /** Optional locale-specific tabs, groups, and labels from a migrated source. */
    navigation?: Record<string, Array<DocsJsonTab>>
  }
  /**
   * Admin-dashboard team — the git-committed roster. Version-controlled and
   * code-reviewed, so team-mode needs no database, even on serverless. Explicit
   * members win over domain defaults.
   */
  team?: {
    members?: Array<{ email: string; role: 'owner' | 'editor' | 'viewer' }>
    domains?: Array<{ domain: string; role: 'owner' | 'editor' | 'viewer' }>
  }
  /**
   * Thally Track — product repos whose MERGED PRs should trigger docs-agent PRs.
   * Git-committed like the team roster: adding a repo is a reviewed change.
   */
  tracking?: {
    repos?: Array<TrackingRepoConfig>
  }
}

export interface TeamConfig {
  members: Array<{ email: string; role: 'owner' | 'editor' | 'viewer' }>
  domains: Array<{ domain: string; role: 'owner' | 'editor' | 'viewer' }>
}

export interface TrackingRepoConfig {
  owner: string
  repo: string
  /** Base branch PRs must merge into to trigger. Defaults to "main". */
  branch?: string
  /** Path globs — only PRs touching these trigger docs tasks. Absent = all. */
  paths?: Array<string>
  /** Sidebar tab generated pages should land in. */
  outputTab?: string
  /** Group heading within that tab. */
  outputGroup?: string
}

export interface TrackingConfig {
  repos: Array<TrackingRepoConfig>
}

// ---------------------------------------------------------------------------
// Content root & frontmatter cache
// ---------------------------------------------------------------------------

const CONTENT_ROOT = 'src/content'
let observedDocsConfigRevision = -1

interface FrontmatterData {
  title?: string
  headingTitle?: string
  /** Optional compact label used only in sidebar and previous/next navigation. */
  navTitle?: string
  icon?: string
  iconType?: IconStyle
  description?: string
  descriptionPlacement?: DocEntry['descriptionPlacement']
  badge?: string
  keywords?: Array<string>
  timeEstimate?: string
  lastUpdated?: string
  lastVerified?: string
  verifiedVersion?: string
  openapi?: unknown
  api?: unknown
  hidden?: boolean
  noindex?: boolean
  mode?: DocPageMode
  /** Reader access: groups allowed to read the page (any-of). */
  groups?: unknown
  /** Reader access: `true` opens the page to everyone, `false` requires sign-in. */
  public?: unknown
}

const frontmatterCache = new Map<string, FrontmatterData>()

/**
 * Returned (by identity) when no file backs a page id. Callers that only need
 * display metadata treat it as empty; access checks treat it as closed, so a
 * route that resolves a file this lookup cannot see never defaults to open.
 */
const MISSING_FRONTMATTER: FrontmatterData = Object.freeze({}) as FrontmatterData

function docsConfig(): DocsJsonConfig {
  const config = getDocsJsonConfig<DocsJsonConfig>()
  const revision = getDocsJsonConfigRevision()
  if (revision !== observedDocsConfigRevision) {
    observedDocsConfigRevision = revision
    _allEntries = null
    loadedEntriesPromise = null
    sidebarCollectionsCache.clear()
  }
  return config
}

function frontmatterCandidates(pageId: string, locale?: string): Array<string> {
  const candidates: Array<string> = []
  if (locale) {
    candidates.push(`${CONTENT_ROOT}/${locale}/${pageId}.mdx`, `${CONTENT_ROOT}/${locale}/${pageId}/index.mdx`)
  }
  candidates.push(`${CONTENT_ROOT}/${pageId}.mdx`, `${CONTENT_ROOT}/${pageId}/index.mdx`)
  return candidates
}

function readFrontmatter(pageId: string, locale?: string): FrontmatterData {
  const cacheKey = locale ? `${locale}:${pageId}` : pageId
  if (frontmatterCache.has(cacheKey)) {
    return frontmatterCache.get(cacheKey)!
  }

  const candidates = frontmatterCandidates(pageId, locale)

  // A runtime content index answers frontmatter directly and is authoritative
  // when present: the index describes the content this release actually
  // serves, while the compiled sources describe whatever this bundle was
  // built from. The two diverge after every content publish that skipped a
  // build, and falling through to the compiled copy here would pin nav
  // titles and descriptions to the stale build (or, under a shared bundle,
  // to another site's content entirely).
  const index = getContentIndex()
  if (index) {
    for (const filePath of candidates) {
      const entry = index.pages[filePath]
      if (entry) {
        frontmatterCache.set(cacheKey, entry.data as FrontmatterData)
        return entry.data as FrontmatterData
      }
    }
    frontmatterCache.set(cacheKey, MISSING_FRONTMATTER)
    return MISSING_FRONTMATTER
  }

  for (const filePath of candidates) {
    if (runtimeSourceExists(filePath)) {
      const raw = readRuntimeSource(filePath)
      let data: FrontmatterData
      try {
        data = parseFrontmatter(raw).data as FrontmatterData
      } catch {
        // Unparseable frontmatter cannot prove a page is open; the marker
        // makes its access malformed (served to nobody).
        data = { [FRONTMATTER_ERROR_MARKER]: true } as FrontmatterData
      }
      frontmatterCache.set(cacheKey, data)
      return data
    }
  }

  frontmatterCache.set(cacheKey, MISSING_FRONTMATTER)
  return MISSING_FRONTMATTER
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const Placeholder: ComponentType<Record<string, unknown>> = () => null

export function deriveTitleFromSlug(pageId: string) {
  const clean = pageId.split('/').filter(Boolean).pop()
  if (!clean) {
    return 'Overview'
  }
  return clean.replace(/[-_]/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase())
}

function slugifyId(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9/]+/g, '-')
    .replace(/(^-|-$)+/g, '')
    .replace(/\//g, '-')
}

/** The collection id a docs.json tab gets in the sidebar; hidden-tab API specs are keyed by it too. */
export function tabCollectionId(tab: string) {
  return slugifyId(tab) || tab.toLowerCase()
}

const KEYWORD_STOPWORDS = new Set([
  'the',
  'a',
  'an',
  'and',
  'or',
  'to',
  'of',
  'for',
  'with',
  'in',
  'on',
  'how',
  'your',
  'you',
  'is',
  'are',
  'using',
  'guide',
])

/**
 * Mechanical fallback keywords when a page has none in frontmatter — derived
 * from its title and slug path (which mirrors its nav category). Thinner than
 * hand-authored keywords, but real terms about the page: they feed JSON-LD and
 * the ?format=json metadata, and lift agent-retrieval signal for every page,
 * present and future, with no per-page authoring.
 */
function deriveKeywords(title: string, slug: Array<string>): Array<string> {
  const words = new Set<string>()
  const phrase = title.trim().toLowerCase()
  if (phrase) words.add(phrase) // the full title as a phrase
  for (const source of [...slug, ...title.split(/[\s/&,-]+/)]) {
    const word = source
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '')
    if (word.length >= 2 && !KEYWORD_STOPWORDS.has(word)) words.add(word)
  }
  return Array.from(words).slice(0, 12)
}

/**
 * A migrated Mintlify site redirects its root to `/introduction`. Link that page
 * by the URL it is served at instead of the redirecting alias, so no click costs a hop.
 */
function servedRootHref(href: string): string {
  const root = href.replace(/\/$/, '') || '/'
  const served = `${root === '/' ? '' : root}/introduction`
  return docsConfig().redirects?.some((redirect) => (redirect.source.replace(/\/$/, '') || '/') === root && redirect.destination === served)
    ? served
    : href
}

function buildDocEntryFromPageId(pageId: string, indexedFrontmatter?: FrontmatterData): DocEntry {
  const fm = indexedFrontmatter ?? readFrontmatter(pageId)
  const slug = pageId === 'introduction' ? [] : pageId.split('/').filter(Boolean)
  const href = slug.length ? `/${slug.join('/')}` : servedRootHref('/')
  const title = fm.title ?? deriveTitleFromSlug(pageId)
  const api = pageApiMetadata(fm)
  return {
    id: pageId,
    title,
    headingTitle: typeof fm.headingTitle === 'string' && fm.headingTitle.trim() ? fm.headingTitle.trim() : undefined,
    description: fm.description ?? '',
    descriptionPlacement: fm.descriptionPlacement === 'body' || fm.descriptionPlacement === 'operation' ? fm.descriptionPlacement : undefined,
    slug,
    href,
    group: '',
    badge: fm.badge,
    keywords: fm.keywords?.length ? fm.keywords : deriveKeywords(title, slug),
    component: Placeholder,
    timeEstimate: fm.timeEstimate ?? '5 min',
    lastUpdated: fm.lastUpdated ?? '',
    lastVerified: fm.lastVerified,
    verifiedVersion: fm.verifiedVersion,
    noindex: fm.noindex,
    hidden: fm.hidden,
    access: parsePageAccess(fm as Record<string, unknown>),
    ...(api.openapi ? { openapi: api.openapi } : {}),
    ...(api.manual ? { manualTarget: api.manual } : {}),
  }
}

// ---------------------------------------------------------------------------
// Build entries from all tabs
// ---------------------------------------------------------------------------

let _allEntries: Array<DocEntry> | null = null

// ---------------------------------------------------------------------------
// Publication
// ---------------------------------------------------------------------------

/**
 * A page whose `openapi:` frontmatter resolves only to hidden or excluded
 * operations 404s (see the docs page route), so no listing may offer it. The
 * build decides this with the route's own lookup, spec prefixes included, and
 * records the withheld page ids (see `UNPUBLISHED_PAGES_FILE`). Self-hosted
 * builds read that record synchronously from the embedded sources, so the
 * answer is a pure function of the module's own constants: no state to prime,
 * nothing shared between module instances, and every cache below is computed
 * after it is known.
 */
let embeddedRecord: ReadonlySet<string> | undefined
/** Managed (assets) releases only: the record cannot be read synchronously, so a loader installs it. */
let assetRecord: ReadonlySet<string> | undefined

function parseRecord(content: string): ReadonlySet<string> {
  try {
    const list = JSON.parse(content) as unknown
    return new Set(Array.isArray(list) ? list.filter((id): id is string => typeof id === 'string') : [])
  } catch {
    return new Set()
  }
}

function recordedUnpublishedPages(): ReadonlySet<string> {
  if (assetRecord) return assetRecord
  if (embeddedRecord) return embeddedRecord
  embeddedRecord = runtimeSourceExists(UNPUBLISHED_PAGES_FILE)
    ? parseRecord(readRuntimeSource(UNPUBLISHED_PAGES_FILE))
    : new Set()
  return embeddedRecord
}

/**
 * False for a page whose documented operation is hidden or excluded. A
 * secondary-locale route renders its own translation when one exists (the
 * build records it as `<locale>/<id>`) and the primary page otherwise, so
 * `locale` judges the file that route would render.
 */
export function isDocPublished(pageId: string, locale?: string): boolean {
  const record = recordedUnpublishedPages()
  if (!locale || locale === (getI18nConfig()?.defaultLocale ?? 'en')) return !record.has(pageId)
  const translation = `${locale}/${pageId}`
  if (record.has(translation)) return false
  const translated = runtimeSourceExists(`${CONTENT_ROOT}/${translation}.mdx`) || runtimeSourceExists(`${CONTENT_ROOT}/${translation}/index.mdx`)
  return translated || !record.has(pageId)
}

let assetRecordPromise: Promise<void> | undefined

/**
 * Awaited by every async loader and route that lists or serves pages. A no-op
 * for self-hosted builds; for a managed release it loads the record from the
 * release assets and drops any list computed before it was known.
 */
export function ensureDocPublication(): Promise<void> {
  // Same test as `isRemoteContentSource`, inline so this module stays free of the content-source providers.
  if (process.env.THALLY_CONTENT_SOURCE?.trim().toLowerCase() !== 'assets') return Promise.resolve()
  assetRecordPromise ??= (async () => {
    try {
      const { getContentSource } = await import('@/lib/content-source')
      const file = await getContentSource().read(UNPUBLISHED_PAGES_FILE)
      assetRecord = file ? parseRecord(String(file.content)) : new Set()
    } catch {
      assetRecord = new Set()
    }
    _allEntries = null
    loadedEntriesPromise = null
    sidebarCollectionsCache.clear()
  })()
  return assetRecordPromise
}

/** Locale directories are reserved even when Cloud selects them after build. */
function localeDirectoryCodes(): Set<string> {
  return new Set([
    ...SUPPORTED_LOCALE_OPTIONS.map((locale) => locale.code.toLowerCase()),
    ...(getI18nConfig()?.locales ?? []).map((locale) => locale.code.toLowerCase()),
  ])
}

/** Whether a first path segment names a locale content directory (`src/content/<code>/`). */
export function isLocaleDirectory(segment: string): boolean {
  return localeDirectoryCodes().has(segment.toLowerCase())
}

/** Every page that has an .mdx file under src/content (default locale only). */
function getAllContentPageIds(): Array<string> {
  const localeCodes = localeDirectoryCodes()
  return listRuntimeSources(CONTENT_ROOT)
    .filter((filePath) => filePath.endsWith('.mdx'))
    .map((filePath) => filePath.slice(`${CONTENT_ROOT}/`.length, -'.mdx'.length))
    .filter((relativePath) => !localeCodes.has((relativePath.split('/')[0] ?? '').toLowerCase()))
    .map((relativePath) => (relativePath.endsWith('/index') ? relativePath.slice(0, -'/index'.length) : relativePath))
    .filter(Boolean)
}

function getAllDocEntries(): Array<DocEntry> {
  const config = docsConfig()
  if (_allEntries) return _allEntries

  const seen = new Set<string>()
  const entries: Array<DocEntry> = []
  const add = (id: string) => {
    if (!id || seen.has(id) || !isDocPublished(id)) return
    seen.add(id)
    entries.push(buildDocEntryFromPageId(id))
  }

  // 1. Explicit navigation references and standalone local href tabs.
  for (const id of projectNavigationContract(config).authoredPageIds) add(id)

  // 2. Every remaining content page — so search, embeddings, and the agent
  //    endpoints cover the whole site, not just pages listed in a nav group.
  for (const id of getAllContentPageIds()) add(id)

  _allEntries = entries
  return entries
}

/** Page IDs reachable from navigation: nav-group pages + standalone href tabs. */
export function getNavigablePageIds(): Set<string> {
  return new Set(projectNavigationContract(docsConfig()).authoredPageIds.filter((id) => isDocPublished(id)))
}

/** Page IDs shown in visible navigation, so not hidden tabs, versions, groups or orphans. */
export function getVisiblePageIds(): Set<string> {
  return new Set(projectNavigationContract(docsConfig()).visiblePageIds.filter((id) => isDocPublished(id)))
}

/**
 * Page IDs search may return on a versioned site: the visible (current) version's navigation.
 * Older versions stay reachable by URL but must not outrank current pages. Null when the site has
 * no versions, where every indexable page stays searchable.
 */
export function getCurrentVersionPageIds(): Set<string> | null {
  return docsConfig().navigation?.versions?.length ? getVisiblePageIds() : null
}

// ---------------------------------------------------------------------------
// Public query functions
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Reader visibility
//
// The caches in this module hold every PUBLISHED page regardless of reader;
// visibility is applied when results leave the module. Every exported
// enumerator therefore takes an optional reader and defaults to the anonymous
// reader, so a caller that knows nothing about reader auth (search, embeddings,
// MCP, llms-full, sitemap, static params) can only ever see public pages.
// ---------------------------------------------------------------------------

/** Whether `reader` may see a listed entry. */
export function isDocEntryVisibleTo(entry: Pick<DocEntry, 'access'>, reader: ReaderContext = ANONYMOUS_READER): boolean {
  return canReaderAccessPage(entry.access ?? OPEN_PAGE_ACCESS, reader, getReaderAuthConfig())
}

const MAX_VISIBILITY_VIEWS = 64
const visibleEntriesCache = new WeakMap<Array<DocEntry>, Map<string, Array<DocEntry>>>()

/** Filter (and memoize per published list and visibility key) the entries a reader may see. */
function visibleEntries(entries: Array<DocEntry>, reader: ReaderContext): Array<DocEntry> {
  const key = readerVisibilityKey(reader, getReaderAuthConfig())
  let views = visibleEntriesCache.get(entries)
  if (!views) {
    views = new Map()
    visibleEntriesCache.set(entries, views)
  }
  const cached = views.get(key)
  if (cached) return cached
  const filtered = entries.filter((entry) => isDocEntryVisibleTo(entry, reader))
  if (views.size >= MAX_VISIBILITY_VIEWS) views.clear()
  views.set(key, filtered)
  return filtered
}

/** Page ids name files below src/content; anything that could leave it is never a page. */
function isSafePageId(pageId: string, locale?: string): boolean {
  if (locale !== undefined && !/^[A-Za-z0-9-]+$/.test(locale)) return false
  return pageId.length > 0 && !/[\\\0]/.test(pageId)
    && pageId.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..')
}

/**
 * Combined access of the file(s) a route serves for `pageId`: the primary
 * page and, on a secondary-locale route, its translation. The most
 * restrictive declaration wins, so a translation that forgets `groups` never
 * opens a restricted page.
 *
 * Synchronous: it answers from the content index or the compiled sources. A
 * page those do not carry is treated as nonexistent (closed). Request-time
 * checks use {@link loadPageAccess}, which distinguishes "does not exist" from
 * "index unavailable".
 */
export function getPageAccess(pageId: string, locale?: string): PageAccess {
  if (!isSafePageId(pageId, locale)) return MALFORMED_PAGE_ACCESS
  const primaryData = readFrontmatter(pageId)
  // No file for this id: fail closed rather than open.
  if (primaryData === MISSING_FRONTMATTER) return MALFORMED_PAGE_ACCESS
  const primary = parsePageAccess(primaryData as Record<string, unknown>)
  if (!locale || locale === (getI18nConfig()?.defaultLocale ?? 'en')) return primary
  const localizedData = readFrontmatter(pageId, locale)
  if (localizedData === MISSING_FRONTMATTER) return MALFORMED_PAGE_ACCESS
  return mergePageAccess(primary, parsePageAccess(localizedData as Record<string, unknown>))
}

/** Parse one file's access frontmatter; unreadable frontmatter is malformed (closed). */
function accessFromSource(raw: string): PageAccess {
  try {
    return parsePageAccess(parseFrontmatter(raw).data)
  } catch {
    return MALFORMED_PAGE_ACCESS
  }
}

/**
 * Access read from the active ContentSource — the same files page bodies are
 * rendered from. Used when an assets release has no content index (local
 * `THALLY_CONTENT_SOURCE=assets` builds, or an index that failed to load):
 * the compiled maps are empty there, so "not in the index" would otherwise
 * read as "page does not exist" and deny every page. A file the content
 * source cannot read either is still denied.
 */
async function loadPageAccessFromContentSource(pageId: string, locale?: string): Promise<PageAccess> {
  const { getContentSource } = await import('@/lib/content-source')
  const source = getContentSource()
  const readFirst = async (paths: Array<string>) => {
    for (const filePath of paths) {
      const file = await source.read(filePath)
      if (file) return String(file.content)
    }
    return null
  }
  const primary = await readFirst([`${CONTENT_ROOT}/${pageId}.mdx`, `${CONTENT_ROOT}/${pageId}/index.mdx`])
  if (primary === null) return MALFORMED_PAGE_ACCESS
  const primaryAccess = accessFromSource(primary)
  if (!locale || locale === (getI18nConfig()?.defaultLocale ?? 'en')) return primaryAccess
  const translation = await readFirst([`${CONTENT_ROOT}/${locale}/${pageId}.mdx`, `${CONTENT_ROOT}/${locale}/${pageId}/index.mdx`])
  // Like readFrontmatter, a missing translation means the route renders the primary page.
  return translation === null ? primaryAccess : mergePageAccess(primaryAccess, accessFromSource(translation))
}

/**
 * Request-time access for `pageId`, in three cases:
 * - a content index is available: it is authoritative (a page missing from it
 *   does not exist → closed; malformed or marked-unparseable frontmatter →
 *   closed);
 * - no index, compiled sources (self-hosted): they are authoritative;
 * - no index under the assets source: read the page's own files from the
 *   content source the body is rendered from, closing only if that fails.
 */
export async function loadPageAccess(pageId: string, locale?: string): Promise<PageAccess> {
  if (!isSafePageId(pageId, locale)) return MALFORMED_PAGE_ACCESS
  await ensureDocPublication()
  const index = await loadContentIndex()
  if (index) {
    hydrateContentIndex(index)
    return getPageAccess(pageId, locale)
  }
  // Same test as `isRemoteContentSource`, inline so this module stays free of the content-source providers.
  if (process.env.THALLY_CONTENT_SOURCE?.trim().toLowerCase() === 'assets') {
    return loadPageAccessFromContentSource(pageId, locale)
  }
  return getPageAccess(pageId, locale)
}

/** Whether `reader` may see the page `pageId` (optionally on a locale route). */
export async function canReaderViewPage(pageId: string, reader: ReaderContext = ANONYMOUS_READER, locale?: string): Promise<boolean> {
  return canReaderAccessPage(await loadPageAccess(pageId, locale), reader, getReaderAuthConfig())
}

const referencedGroupsCache = new WeakMap<Array<DocEntry>, ReadonlySet<string>>()

/**
 * Every group named by any published page's access rules, translations
 * included. Sign-in keeps only these groups in the reader session.
 */
export async function loadReferencedReaderGroups(): Promise<ReadonlySet<string>> {
  const entries = await loadPublishedDocEntries()
  const cached = referencedGroupsCache.get(entries)
  if (cached) return cached
  const secondaryLocales = (getI18nConfig()?.locales ?? [])
    .map((locale) => locale.code)
    .filter((code) => code !== (getI18nConfig()?.defaultLocale ?? 'en'))
  const groups = referencedGroups(entries.flatMap((entry) => [
    entry.access ?? OPEN_PAGE_ACCESS,
    ...secondaryLocales.map((locale) => getPageAccess(entry.id, locale)),
  ]))
  referencedGroupsCache.set(entries, groups)
  return groups
}

/** Published pages `reader` may see (anonymous by default). */
export function getDocEntries(reader: ReaderContext = ANONYMOUS_READER): Array<DocEntry> {
  return visibleEntries(getAllDocEntries(), reader)
}

let loadedEntriesPromise: Promise<Array<DocEntry>> | null = null
let hydratedContentIndex: ContentIndex | null = null

function hydrateContentIndex(index: ContentIndex): void {
  if (hydratedContentIndex === index) return
  hydratedContentIndex = index
  // These caches may have been populated during module initialisation before
  // a request could fetch the large asset-backed index. Rebuild them once,
  // using the authoritative release frontmatter now cached by content-index.
  frontmatterCache.clear()
  _allEntries = null
  sidebarCollectionsCache.clear()
}

function defaultLocalePageIds(index: ContentIndex): Array<string> {
  const localeCodes = localeDirectoryCodes()
  return Object.keys(index.pages)
    .filter((filePath) => filePath.startsWith(`${CONTENT_ROOT}/`) && filePath.endsWith('.mdx'))
    .map((filePath) => filePath.slice(`${CONTENT_ROOT}/`.length, -'.mdx'.length))
    .filter((relativePath) => !localeCodes.has((relativePath.split('/')[0] ?? '').toLowerCase()))
    .map((relativePath) => (relativePath.endsWith('/index') ? relativePath.slice(0, -'/index'.length) : relativePath))
    .filter(Boolean)
}

function indexedFrontmatter(index: ContentIndex, pageId: string): FrontmatterData {
  for (const filePath of frontmatterCandidates(pageId)) {
    const entry = index.pages[filePath]
    if (entry) return entry.data as FrontmatterData
  }
  return {}
}

/**
 * Request-time doc enumeration backed by the immutable content index asset.
 * The synchronous API remains unchanged for local/build consumers; managed
 * routes use this async twin when the index is too large for a text binding.
 */
export async function loadDocEntries(reader: ReaderContext = ANONYMOUS_READER): Promise<Array<DocEntry>> {
  return visibleEntries(await loadPublishedDocEntries(), reader)
}

/** Every published entry, before reader visibility. Never returned to callers. */
async function loadPublishedDocEntries(): Promise<Array<DocEntry>> {
  await ensureDocPublication()
  docsConfig()
  if (loadedEntriesPromise) return loadedEntriesPromise
  loadedEntriesPromise = (async () => {
    const index = await loadContentIndex()
    if (!index) return getAllDocEntries()
    hydrateContentIndex(index)
    const seen = new Set<string>()
    const ids: Array<string> = []
    const add = (id: string) => {
      if (!id || seen.has(id) || !isDocPublished(id)) return
      seen.add(id)
      ids.push(id)
    }
    for (const id of projectNavigationContract(docsConfig()).authoredPageIds) add(id)
    for (const id of defaultLocalePageIds(index)) add(id)
    return ids.map((id) => buildDocEntryFromPageId(id, indexedFrontmatter(index, id)))
  })()
  return loadedEntriesPromise
}

export function getDocEntryBySlug(slugPath: string): DocEntry | null
export function getDocEntryBySlug(languageCode: string, slugPath: string): DocEntry | null
export function getDocEntryBySlug(first: string, second?: string): DocEntry | null {
  const slugPath = second !== undefined ? second : first
  const entries = getDocEntries()
  return entries.find((doc) => doc.slug.join('/') === slugPath) ?? null
}

/** Async managed-release twin of {@link getDocEntryBySlug}. */
export async function loadDocEntryBySlug(first: string, second?: string): Promise<DocEntry | null> {
  const slugPath = second !== undefined ? second : first
  return (await loadDocEntries()).find((doc) => doc.slug.join('/') === slugPath) ?? null
}

export function getSearchableDocs(): Array<SearchableDoc> {
  return getDocEntries().map((doc) => ({
    id: doc.id,
    title: doc.title,
    description: doc.description,
    href: doc.href,
    keywords: doc.keywords,
  }))
}

// ---------------------------------------------------------------------------
// Sidebar construction from docs.json
// ---------------------------------------------------------------------------

function resolveNavItem(
  pageId: string,
  locale?: string,
  groupPath?: Array<string>,
): NavigationItem {
  const fm = readFrontmatter(pageId, locale)
  const slug = pageId === 'introduction' ? [] : pageId.split('/').filter(Boolean)
  const baseHref = slug.length ? `/${slug.join('/')}` : '/'
  const operation = pageApiMetadata(fm).openapi
  const href = servedRootHref(locale ? (baseHref === '/' ? `/${locale}` : `/${locale}${baseHref}`) : baseHref)
  return {
    id: slugifyId(pageId) || 'introduction',
    title: fm.navTitle ?? fm.title ?? deriveTitleFromSlug(pageId),
    href,
    badge: fm.badge,
    ...(operation ? { method: operation.webhook ? 'HOOK' : operation.method.toUpperCase() } : {}),
    ...(typeof fm.icon === 'string' && fm.icon ? { icon: fm.icon } : {}),
    ...(fm.iconType ? { iconType: fm.iconType } : {}),
    description: fm.description,
    ...(groupPath?.length ? { groupPath } : {}),
  }
}

/** Decides whether a navigation page reference is shown to the current reader. */
type PageVisibility = (pageId: string, locale?: string) => boolean

function buildNavigationGroup(
  group: DocsJsonNavigationGroup,
  indexPath: Array<number>,
  ancestors: Array<string> = [],
  locale: string | undefined,
  isVisible: PageVisibility,
): NavigationGroup | null {
  if (group.hidden) return null

  const groupPath = [...ancestors, group.group].filter(Boolean)
  const nodes = buildNavigationNodes(group.pages, indexPath, groupPath, locale, isVisible)
  if (nodes.length === 0) return null

  return {
    id: `nav-group-${indexPath.join('-')}-${slugifyId(group.group) || 'group'}`,
    title: group.group || 'General',
    icon: group.icon,
    ...(typeof group.defaultOpen === 'boolean' ? { defaultOpen: group.defaultOpen } : {}),
    nodes,
  }
}

function buildNavigationNodes(
  pages: Array<string | DocsJsonNavigationGroup>,
  indexPath: Array<number>,
  ancestors: Array<string>,
  locale: string | undefined,
  isVisible: PageVisibility,
): Array<NavigationNode> {
  return pages.flatMap<NavigationNode>((page, index) => {
    if (typeof page === 'string') {
      // Fern and some legacy docs configs list pages that are reachable by
      // direct link but explicitly hidden from the rendered sidebar.
      if (readFrontmatter(page, locale).hidden) return []
      if (!isDocPublished(page, locale)) return []
      // A page the reader may not open must not leak its title either.
      if (!isVisible(page, locale)) return []
      return [{ type: 'page', item: resolveNavItem(page, locale, ancestors) }]
    }
    const child = buildNavigationGroup(page, [...indexPath, index], ancestors, locale, isVisible)
    return child ? [{ type: 'group', group: child }] : []
  })
}

function collectNavigationItems(nodes: Array<NavigationNode>): Array<NavigationItem> {
  return nodes.flatMap((node) => node.type === 'page'
    ? [node.item]
    : collectNavigationItems(node.group.nodes))
}

const sidebarCollectionsCache = new Map<string, Array<SidebarCollection>>()

/**
 * Sidebar collections as `reader` sees them (anonymous by default): pages the
 * reader may not open are omitted, and groups left empty disappear.
 */
export function getSidebarCollections(locale?: string, reader: ReaderContext = ANONYMOUS_READER): Array<SidebarCollection> {
  const config = docsConfig()
  const policy = getReaderAuthConfig()
  const cacheKey = `${locale ?? '__default__'}\u0001${readerVisibilityKey(reader, policy)}`
  if (sidebarCollectionsCache.has(cacheKey)) {
    return sidebarCollectionsCache.get(cacheKey)!
  }
  // A navigation reference with NO backing file at all (neither the primary
  // nor the locale's translation) reveals only its slug-derived title, so it
  // keeps its existing broken-link entry. If any file exists, its title could
  // be shown, so the access rules decide (a translation without its primary
  // page is closed).
  const isVisible: PageVisibility = (pageId, pageLocale) =>
    (readFrontmatter(pageId) === MISSING_FRONTMATTER &&
      (!pageLocale || readFrontmatter(pageId, pageLocale) === MISSING_FRONTMATTER)) ||
    canReaderAccessPage(getPageAccess(pageId, pageLocale), reader, policy)

  const collections = ((locale ? config.i18n?.navigation?.[locale] : undefined) ?? config.tabs)
    // Mintlify marks non-default versions hidden in the combined navigation.
    // Once a version picker scopes the tabs, those entries must be available
    // when their version is active or its entire route renders an empty shell.
    .filter((tab) => !tab.hidden || Boolean(tab.version && config.navigation?.versions?.some((version) => version.label === tab.version)))
    .map((tab) => {
      const id = tabCollectionId(tab.tab)
      const groups = tab.groups ?? []
      const groupSections = groups.flatMap((group, index) => {
        const tree = buildNavigationGroup(group, [index], [], locale, isVisible)
        if (!tree) return []
        return [{
          id: tree.id,
          title: tree.title,
          icon: tree.icon,
          defaultOpen: tree.defaultOpen,
          items: collectNavigationItems(tree.nodes),
          nodes: typeof tree.defaultOpen === 'boolean'
            ? [{ type: 'group' as const, group: tree }]
            : tree.nodes,
        }]
      })
      const rootNodes = tab.pages
        ? buildNavigationNodes(tab.pages, [groups.length], [], locale, isVisible)
        : []
      const sections = [
        ...(rootNodes.length > 0 ? [{
          id: `nav-root-${id}`,
          title: tab.displayLabel ?? tab.tab,
          items: collectNavigationItems(rootNodes),
          nodes: rootNodes,
        }] : []),
        ...groupSections,
      ]

      return {
        id,
        label: tab.displayLabel ?? tab.tab,
        version: tab.version,
        description: tab.description,
        icon: tab.icon,
        sections,
        href: tab.href,
        api: tab.api,
      }
    })

  // Distinct group sets are few in practice; the bound only stops a pathological set of tokens growing the map.
  if (sidebarCollectionsCache.size >= MAX_VISIBILITY_VIEWS * 4) sidebarCollectionsCache.clear()
  sidebarCollectionsCache.set(cacheKey, collections)
  return collections
}

/**
 * Request-time navigation backed by the release index asset when the index is
 * too large for a Worker text binding.
 */
export async function loadSidebarCollections(locale?: string, reader: ReaderContext = ANONYMOUS_READER): Promise<Array<SidebarCollection>> {
  await ensureDocPublication()
  const index = await loadContentIndex()
  if (index) hydrateContentIndex(index)
  return getSidebarCollections(locale, reader)
}

// ---------------------------------------------------------------------------
// Prev / Next navigation
// ---------------------------------------------------------------------------

export interface PrevNextLink {
  title: string
  href: string
}

/** Select a translated navigation tree only for a configured locale prefix. */
function navigationLocaleForHref(href: string): string | undefined {
  const firstSegment = href.split('/')[1]
  const i18n = docsConfig().i18n
  return firstSegment && firstSegment !== i18n?.defaultLocale
    && i18n?.locales.some((locale) => locale.code === firstSegment)
    ? firstSegment
    : undefined
}

/**
 * Adjacent readable pages in first-seen navigation order, deduplicated by exact
 * href. Pagination stays inside the page's own tab: the first collection that
 * lists the exact href (the rule `getNavContext` uses), so a tab's first and
 * last pages never borrow neighbours from the tabs around it.
 */
export function getPrevNextLinks(currentHref: string, reader: ReaderContext = ANONYMOUS_READER): {
  prev: PrevNextLink | null
  next: PrevNextLink | null
} {
  const collection = getSidebarCollections(navigationLocaleForHref(currentHref), reader).find((candidate) =>
    candidate.sections.some((section) => section.items.some((item) => item.href === currentHref)))
  if (!collection) {
    return { prev: null, next: null }
  }

  const flatPages: Array<{ title: string; href: string }> = []
  // Pages may occur in several groups. Exact href membership preserves the
  // first title/order without rescanning every earlier page on large sites.
  const seenHrefs = new Set<string>()

  for (const section of collection.sections) {
    for (const item of section.items) {
      const href = item.href
      if (!seenHrefs.has(href)) {
        seenHrefs.add(href)
        flatPages.push({ title: item.title, href })
      }
    }
  }

  const index = flatPages.findIndex((p) => p.href === currentHref)

  return {
    prev: index > 0 ? flatPages[index - 1] : null,
    next: index < flatPages.length - 1 ? flatPages[index + 1] : null,
  }
}

// ---------------------------------------------------------------------------
// Breadcrumbs
// ---------------------------------------------------------------------------

export interface BreadcrumbItem {
  label: string
  href?: string
}

function navigationGroupParts(section: NavigationSection, item: NavigationItem): Array<string> {
  if (item.groupPath) return item.groupPath
  return section.id?.startsWith('nav-root-') ? [] : [section.title]
}

export function getBreadcrumbs(currentHref: string, reader: ReaderContext = ANONYMOUS_READER): Array<BreadcrumbItem> {
  const collections = getSidebarCollections(navigationLocaleForHref(currentHref), reader)

  for (const collection of collections) {
    for (const section of collection.sections) {
      const match = section.items.find((item) => item.href === currentHref)
      if (match) {
        const crumbs: Array<BreadcrumbItem> = []
        // Tab level
        const firstPageHref = collection.sections[0]?.items[0]?.href
        crumbs.push({ label: collection.label, href: firstPageHref })
        // Group level follows the authored recursive path without flattening
        // those groups into duplicate visual sections.
        // A group named after its tab (e.g. "Get started" › "Get started")
        // would stutter — collapse consecutive duplicate labels.
        const groupParts = navigationGroupParts(section, match)
        for (const part of groupParts) {
          if (crumbs[crumbs.length - 1]?.label !== part) crumbs.push({ label: part })
        }
        // Current page
        crumbs.push({ label: match.title })
        return crumbs
      }
    }
  }

  return []
}

/**
 * The page's nearest navigation group — the "category" shown as an eyebrow
 * above the page title. Derived from the docs.json navigation model (never
 * from per-page frontmatter) so it stays correct across tabs, nested groups
 * and locales: group labels are single-sourced from docs.json, which also
 * guarantees the eyebrow is identical in every locale. Returns null for pages
 * that sit outside any navigation group (e.g. direct-link tabs).
 */
export function getNavCategory(currentHref: string, reader: ReaderContext = ANONYMOUS_READER): string | null {
  return getNavGroupPath(currentHref, reader).at(-1) || null
}

/** Every authored group above the page, outermost first; empty outside any group. */
export function getNavGroupPath(currentHref: string, reader: ReaderContext = ANONYMOUS_READER): Array<string> {
  for (const collection of getSidebarCollections(navigationLocaleForHref(currentHref), reader)) {
    for (const section of collection.sections) {
      const item = section.items.find((candidate) => candidate.href === currentHref)
      if (item) return [...navigationGroupParts(section, item)]
    }
  }
  return []
}

// ---------------------------------------------------------------------------
// Nav context for agent API responses
// ---------------------------------------------------------------------------

export interface NavContext {
  tab: string
  /** The nearest group: the last of `groupPath`. */
  group: string
  groupPath: Array<string>
  prev: PrevNextLink | null
  next: PrevNextLink | null
  breadcrumb: Array<BreadcrumbItem>
}

export function getNavContext(pageId: string, locale?: string, reader: ReaderContext = ANONYMOUS_READER): NavContext {
  const slug = pageId === 'introduction' ? [] : pageId.split('/').filter(Boolean)
  const baseHref = slug.length ? `/${slug.join('/')}` : '/'
  const href = servedRootHref(locale && locale !== docsConfig().i18n?.defaultLocale
    ? `/${locale}${baseHref === '/' ? '' : baseHref}` : baseHref)

  const { prev, next } = getPrevNextLinks(href, reader)
  const breadcrumb = getBreadcrumbs(href, reader)

  // Find which tab and group this page belongs to
  const collections = getSidebarCollections(locale, reader)
  let tabName = ''
  let groupPath: Array<string> = []

  outer: for (const collection of collections) {
    for (const section of collection.sections) {
      const item = section.items.find((candidate) => candidate.href === href)
      if (item) {
        tabName = collection.label
        groupPath = [...navigationGroupParts(section, item)]
        break outer
      }
    }
  }

  return { tab: tabName, group: groupPath.at(-1) ?? '', groupPath, prev, next, breadcrumb }
}

/** Async managed-release twin of {@link getNavContext}. */
export async function loadNavContext(pageId: string, locale?: string, reader: ReaderContext = ANONYMOUS_READER): Promise<NavContext> {
  await ensureDocPublication()
  const index = await loadContentIndex()
  if (index) hydrateContentIndex(index)
  return getNavContext(pageId, locale, reader)
}

export function getAiConfig(): {
  chat?: boolean
  label?: string
  icon?: string
  systemPrompt?: string
} {
  return docsConfig().ai ?? {}
}

const apiMdxCache = new WeakMap<object, ApiMdxConfig>()

/** Validated docs.json `api.mdx` settings; invalid parts are dropped with one warning each. */
export function getApiMdxConfig(): ApiMdxConfig {
  const config = docsConfig()
  let cached = apiMdxCache.get(config)
  if (!cached) {
    cached = sanitizeApiMdxConfig(config.api?.mdx, (message) => console.warn(`[thally] ${message}`))
    apiMdxCache.set(config, cached)
  }
  return cached
}

/** Raw docs.json `api.playground.display`; resolve it with `resolvePlaygroundDisplay`. */
export function getApiPlaygroundDisplay(): unknown {
  return docsConfig().api?.playground?.display
}

/** The visible spec link stays on unless docs.json sets `api.specLink: false`. */
export function getApiSpecLinkVisible(): boolean {
  return docsConfig().api?.specLink !== false
}

export const TRY_IT_DEFAULT_TIMEOUT_MS = 60_000

/** How long the Try it relay waits for the API: `apiPlayground.timeoutMs` clamped to 1-120 s, else 60 s. */
export function getApiPlaygroundTimeoutMs(): number {
  const configured = docsConfig().apiPlayground?.timeoutMs
  return typeof configured === 'number' && Number.isFinite(configured)
    ? Math.min(120_000, Math.max(1_000, Math.round(configured)))
    : TRY_IT_DEFAULT_TIMEOUT_MS
}

/** Credentials from `apiPlayground.credentials`, keyed by OpenAPI security scheme name. */
export function getApiPlaygroundCredentials(): Record<string, string> {
  return docsConfig().apiPlayground?.credentials ?? {}
}

export function isAnalyticsEnabled(): boolean {
  return docsConfig().analytics?.enabled !== false
}

export function isAdminDashboardEnabled(): boolean {
  return docsConfig().admin?.enabled !== false
}

export function getI18nConfig(): {
  defaultLocale: string
  locales: Array<{ code: string; label: string }>
} | null {
  return docsConfig().i18n ?? null
}

/** The git-committed admin team roster. Always returns arrays. */
export function getTeamConfig(): TeamConfig {
  return {
    members: docsConfig().team?.members ?? [],
    domains: docsConfig().team?.domains ?? [],
  }
}

/** The git-committed Thally Track roster. Always returns an array. */
export function getTrackingConfig(): TrackingConfig {
  return { repos: docsConfig().tracking?.repos ?? [] }
}

export function getBannerConfig(): DocsJsonBanner | null {
  const candidate = docsConfig().banner as unknown
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null
  const raw = candidate as Record<string, unknown>
  let content: string | Record<string, string> | null = null
  if (typeof raw.content === 'string' && raw.content.trim()) {
    content = raw.content
  } else if (raw.content && typeof raw.content === 'object' && !Array.isArray(raw.content)) {
    const localized = Object.fromEntries(
      Object.entries(raw.content).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string' && Boolean(entry[1].trim()),
      ),
    )
    if (Object.keys(localized).length > 0) content = localized
  }
  if (!content) return null

  const intent = raw.type === 'info' || raw.type === 'warning' || raw.type === 'critical'
    ? raw.type
    : raw.variant === 'info' || raw.variant === 'warning' || raw.variant === 'critical'
      ? raw.variant
      : undefined
  const rawColor = raw.color && typeof raw.color === 'object' && !Array.isArray(raw.color)
    ? raw.color as Record<string, unknown>
    : null
  const color = rawColor
    ? {
        light: typeof rawColor.light === 'string' ? rawColor.light : undefined,
        dark: typeof rawColor.dark === 'string' ? rawColor.dark : undefined,
      }
    : undefined

  return {
    content,
    dismissible: typeof raw.dismissible === 'boolean' ? raw.dismissible : undefined,
    id: typeof raw.id === 'string' ? raw.id : undefined,
    revision: typeof raw.revision === 'string' ? raw.revision : undefined,
    type: intent,
    color,
  }
}

export function getNavbarConfig(): DocsJsonNavbar | null {
  return docsConfig().navbar ?? null
}

/** Resolve how sibling navigation collections are exposed in the docs chrome. */
export function getNavigationPresentation(): NavigationPresentation {
  const navigation = docsConfig().navigation
  return {
    display: navigation?.display === 'dropdown' ? 'dropdown' : 'tabs',
    ...(navigation?.groupHeadings === 'all' ? { groupHeadings: 'all' as const } : {}),
  }
}

export function getFooterConfig(): DocsJsonFooter | null {
  return docsConfig().footer ?? null
}

export function getFeedbackConfig(): DocsJsonFeedback {
  return docsConfig().feedback ?? { thumbsRating: true }
}

export function getFontsConfig(): DocsJsonFonts {
  return docsConfig().fonts ?? {}
}

export function getRedirectsConfig(): Array<DocsJsonRedirect> {
  return docsConfig().redirects ?? []
}

/** Raw, unvalidated `integrations` block; callers must run it through `resolveAnalyticsConfig`. */
export function getIntegrationsConfig(): unknown {
  return docsConfig().integrations
}

export function getCustomScriptsConfig(): Array<DocsJsonScript> {
  return docsConfig().customScripts ?? []
}

/** Breadcrumbs stay on unless docs.json sets `breadcrumbs: false`. */
export function getBreadcrumbsEnabled(): boolean {
  return docsConfig().breadcrumbs !== false
}

/** The eyebrow above a page title: its nearest group unless docs.json sets `eyebrow: "path"`. */
export function getEyebrowMode(): 'group' | 'path' {
  return docsConfig().eyebrow === 'path' ? 'path' : 'group'
}

/** Only local CSS files may be injected into the document head. */
export function getStylesheetsConfig(): Array<string> {
  const configured = docsConfig().stylesheets
  if (!Array.isArray(configured)) return []
  return configured.slice(0, 16).filter((path): path is string =>
    typeof path === 'string' && /^\/[A-Za-z0-9_./-]+\.css$/.test(path)
      && !path.split('/').some((segment) => segment === '.' || segment === '..')
      && !path.includes('//'),
  )
}

/** Version navigation stays in docs.json so scaffolded sites carry it intact. */
export function getNavigationVersions(): Array<DocsNavigationVersion> {
  const versions = docsConfig().navigation?.versions
  if (!Array.isArray(versions)) return []
  return versions.slice(0, 32).filter((item): item is DocsNavigationVersion =>
    Boolean(item && typeof item.label === 'string' && item.label.trim()
      && typeof item.prefix === 'string' && (!item.prefix || (/^[A-Za-z0-9._-]+$/.test(item.prefix) && item.prefix !== '.' && item.prefix !== '..'))
      && typeof item.href === 'string' && /^\/(?!\/)[A-Za-z0-9_./-]*$/.test(item.href)
      && !item.href.split('/').some((segment) => segment === '.' || segment === '..')),
  )
}

/** Global shortcut links sit above the active collection's sidebar tree. */
export function getNavigationShortcuts(): Array<DocsNavigationShortcut> {
  const shortcuts = docsConfig().navigation?.shortcuts
  if (!Array.isArray(shortcuts)) return []
  return shortcuts.slice(0, 24).filter((item): item is DocsNavigationShortcut =>
    Boolean(item && typeof item.label === 'string' && item.label.trim()
      && typeof item.href === 'string'
      && (/^\/(?!\/)[^\s\\]*$/.test(item.href) || /^https?:\/\//i.test(item.href)
        || /^(?:mailto|tel):[^\s]+$/i.test(item.href))),
  )
}

/** docs.json `contextual.options`: which page-menu entries show, in order. Undefined keeps every entry. */
export function getContextualOptions(): Array<string> | undefined {
  return docsConfig().contextual?.options
}

/** Brand colours per mode; `/api/brand.css` from the managed dashboard still wins. */
export function getBrandColors(): DocsJsonConfig['colors'] {
  return docsConfig().colors
}

export function getSeoConfig(): DocsJsonSeo {
  return docsConfig().seo ?? {}
}

export function getStructuralTheme(): StructuralTheme {
  return docsConfig().theme ?? 'default'
}

/** Resolve the global card/tile icon treatment, defaulting to the site accent. */
export function getContentIconTone(): ContentIconTone {
  return docsConfig().appearance?.contentIcons === 'neutral' ? 'neutral' : 'accent'
}

/**
 * Resolve the repository's icon library, defaulting to Lucide. Managed sites
 * layer the Thally Cloud branding choice on top in `@/lib/cloud-link/icon-library`;
 * this reader stays free of server-only imports so Node build scripts can use it.
 */
export function getIconLibrary(): IconLibrary {
  return resolveIconLibrary(docsConfig().icons?.library)
}
