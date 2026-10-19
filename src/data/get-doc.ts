/** Load authored MDX while keeping route identity independent of display metadata. */

import { createElement, type ComponentType, type ReactNode } from 'react'
import { compileMDX } from 'next-mdx-remote/rsc'
import { interpretMDX } from '@/lib/mdx-interpret'
import type { DocEntry, DocPageMode } from '@/data/docs'
import { deriveTitleFromSlug, getApiMdxConfig } from '@/data/docs'
import { pageApiMetadata } from '@/lib/openapi/page-api'
import { buildManualOperation, resolveTranslatedManualApi } from '@/lib/openapi/manual-operation'
import { remarkPlugins } from '@/mdx/remark'
import { rehypePlugins } from '@/mdx/rehype'
import { useMDXComponents as getMDXComponents } from '@/components/mdx/mdx-components'
import { resolveSnippetComponent } from '@/mdx/snippet-registry'
import { runtimeDocs } from '@/generated/runtime-docs'
import { readRuntimeSource, runtimeSourceExists } from '@/lib/runtime-sources'
import { getContentSource, type ContentSource } from '@/lib/content-source'
import { docPathFromSlug } from '@/lib/i18n/doc-route'
import { parseFrontmatter } from '@/lib/frontmatter'
import { findDocSource } from '@/lib/i18n/translation-source'
import { createBoundedPromiseCache, estimateRetainedPayloadBytes } from '@/lib/bounded-cache'
import { MALFORMED_PAGE_ACCESS, mergePageAccess, parsePageAccess, type PageAccess } from '@/lib/reader-auth/access'

interface DocFrontmatter {
  title?: string
  headingTitle?: string
  description?: string
  descriptionPlacement?: DocEntry['descriptionPlacement']
  group?: string
  badge?: string
  keywords?: Array<string>
  timeEstimate?: string
  lastUpdated?: string
  openapi?: unknown
  api?: unknown
  authMethod?: unknown
  playground?: unknown
  noindex?: boolean
  hidden?: boolean
  mode?: DocPageMode
  ogTitle?: string
  ogDescription?: string
  ogImage?: string
  twitterTitle?: string
  twitterDescription?: string
  twitterImage?: string
}

const PAGE_META_KEYS = ['ogTitle', 'ogDescription', 'ogImage', 'twitterTitle', 'twitterDescription', 'twitterImage'] as const

function pageMetaFields(frontmatter: DocFrontmatter | undefined): Partial<Record<(typeof PAGE_META_KEYS)[number], string>> {
  const out: Partial<Record<(typeof PAGE_META_KEYS)[number], string>> = {}
  for (const key of PAGE_META_KEYS) {
    const value = frontmatter?.[key]
    if (typeof value === 'string' && value.trim()) out[key] = value.trim()
  }
  return out
}

function projectJoin(...segments: Array<string>): string {
  return segments
    .flatMap((segment) => segment.split('/'))
    .filter(Boolean)
    .join('/')
}

const dynamicDocCache = new Map<string, Promise<(DocEntry & { isFallback: boolean; isStale: boolean }) | null>>()
// Component closures hide their rendered tree from an external estimator. Record
// its approximate payload while that tree is visible, with weak ownership so
// evicted documents and their metadata can be collected together.
const renderedPayloadBytes = new WeakMap<object, number>()
const assetDocCache = createBoundedPromiseCache<(DocEntry & { isFallback: boolean; isStale: boolean }) | null>({
  maxEntries: 64, maxBytes: 8 * 1024 * 1024,
  sizeOf: (doc) => doc ? renderedPayloadBytes.get(doc) ?? estimateRetainedPayloadBytes(doc) : 0,
})

/** Resolve a documentation route to its authored content and stable page identity. */
export async function getDocFromParams(slugSegments?: Array<string>, locale?: string) {
  // Remote content must never be baked into a static or ISR-cached render —
  // a no-op under the default filesystem source. Called before the cache
  // lookup so every request opts out, not just the first.

  const normalized = Array.isArray(slugSegments) ? slugSegments.filter(Boolean) : []
  const slugKey = normalized.join('/')

  const cacheKey = locale ? `${locale}:${slugKey}` : slugKey
  if (getContentSource().kind === 'assets') return assetDocCache.getOrLoad(cacheKey, () => loadDocFromSource(normalized, locale))
  let pending = dynamicDocCache.get(cacheKey)
  if (!pending) {
    pending = loadDocFromSource(normalized, locale)
    dynamicDocCache.set(cacheKey, pending)
  }

  return pending
}

/**
 * Reader access of the exact file(s) a route renders: the resolved file and,
 * for a translation, its primary page. Derived from the files themselves, not
 * from a page id, so no alternate spelling of a route can reach a restricted
 * file without its rules. Unreadable frontmatter fails closed.
 */
async function resolvedFileAccess(source: ContentSource, filePaths: Array<string>): Promise<PageAccess> {
  const accesses: Array<PageAccess> = []
  for (const filePath of filePaths) {
    const file = await source.read(filePath)
    if (!file) return MALFORMED_PAGE_ACCESS
    try {
      accesses.push(parsePageAccess(parseFrontmatter(file.content).data))
    } catch {
      return MALFORMED_PAGE_ACCESS
    }
  }
  return mergePageAccess(...accesses)
}

async function loadDocFromSource(
  slugSegments: Array<string>,
  locale?: string,
): Promise<(DocEntry & { isFallback: boolean; isStale: boolean }) | null> {
  const source = getContentSource()
  const slugPath = slugSegments.join('/')
  const candidate = await findDocSource(source, slugPath, locale)
  if (!candidate) {
    return null
  }
  const compiled = await compileDocEntry(source, candidate.filePath, slugSegments, candidate.isFallback, candidate.isStale, locale, candidate.sourcePath)
  const files = candidate.sourcePath && candidate.sourcePath !== candidate.filePath ? [candidate.filePath, candidate.sourcePath] : [candidate.filePath]
  const document = compiled ? { ...compiled, access: await resolvedFileAccess(source, files) } : null
  if (document && compiled) renderedPayloadBytes.set(document, renderedPayloadBytes.get(compiled) ?? estimateRetainedPayloadBytes(compiled))
  if (!document || !candidate.sourcePath || candidate.isFallback) return document
  const sourceFile = await source.read(candidate.sourcePath)
  if (!sourceFile) return null
  const sourcePolicy = parseFrontmatter(sourceFile.content).data
  const translated = {
    ...document,
    noindex: document.noindex || sourcePolicy.noindex === true,
    hidden: document.hidden || sourcePolicy.hidden === true,
  }
  renderedPayloadBytes.set(translated, renderedPayloadBytes.get(document) ?? estimateRetainedPayloadBytes(document))
  return translated
}

/**
 * Whether this render must compile MDX now instead of using the module the
 * build precompiled. Development always compiles for fresh authoring
 * feedback. The assets source compiles only files that actually changed
 * since the build: an unchanged file is byte-identical to its embedded copy,
 * so reusing the precompiled module skips the request-time compile (and, on
 * workerd, the dynamic-eval requirement) for everything except edited pages.
 */
function needsRuntimeCompile(source: ContentSource, filePath: string, content: string): boolean {
  if (process.env.NODE_ENV === 'development') return true
  if (source.kind !== 'assets') return false
  return !(runtimeSourceExists(filePath) && readRuntimeSource(filePath) === content)
}

async function compileDocEntry(
  source: ContentSource,
  filePath: string,
  slugSegments: Array<string>,
  isFallback: boolean,
  isStale: boolean,
  locale?: string,
  primaryPath?: string,
): Promise<(DocEntry & { isFallback: boolean; isStale: boolean }) | null> {
  const sourceFile = await source.read(filePath)
  if (!sourceFile) return null
  const { cleanedSource, snippetInjectors } = extractSnippetComponents(sourceFile.content)
  const resolvedSnippetComponents: Record<string, ComponentType<Record<string, unknown>>> = {}
  for (const [name, resolver] of Object.entries(snippetInjectors)) {
    resolvedSnippetComponents[name] = (await resolver()) as ComponentType<Record<string, unknown>>
  }
  const components = getMDXComponents(resolvedSnippetComponents)
  let content: ReactNode
  let frontmatter: DocFrontmatter

  if (needsRuntimeCompile(source, filePath, sourceFile.content)) {
    if (process.env.NODE_ENV === 'development' && source.kind === 'filesystem') {
      const compiled = await compileMDX<DocFrontmatter>({
        source: cleanedSource,
        components,
        options: {
          parseFrontmatter: true,
          // Match the build-time MDX compiler: authored exports, expressions,
          // and local components must render while previewing migrated pages.
          blockJS: false,
          mdxOptions: {
            useDynamicImport: true,
            remarkPlugins,
            rehypePlugins,
          },
        },
      })
      content = compiled.content
      frontmatter = compiled.frontmatter
    } else {
      // Remote content remains eval-free in every environment. Production
      // Workers also forbid code generation from strings, so freshly
      // published content must use the interpreter.
      const interpreted = await interpretMDX({
        source: cleanedSource,
        components,
        parseFrontmatter: true,
      })
      content = interpreted.content
      frontmatter = interpreted.frontmatter as DocFrontmatter
    }
  } else {
    const compiled = runtimeDocs[filePath]
    if (!compiled) return null
    content = createElement(compiled.component, { components })
    frontmatter = compiled.frontmatter as DocFrontmatter
  }

  const slugPath = slugSegments.join('/')
  const href = docPathFromSlug(slugSegments)
  const GeneratedDoc: ComponentType<Record<string, unknown>> = function GeneratedDoc() {
    return content
  }
  GeneratedDoc.displayName = `DocContent(${href})`

  const warn = (message: string) => console.warn(`[thally] ${filePath}: ${message}`)
  // The page index (docs.ts) reads the same metadata through the same function.
  // A translation may not redirect the playground away from the primary page's server or auth.
  const primaryFile = !isFallback && primaryPath && frontmatter?.api !== undefined && frontmatter.api !== null ? await source.read(primaryPath) : null
  const own = { api: frontmatter?.api, authMethod: frontmatter?.authMethod }
  const trusted = primaryFile
    ? resolveTranslatedManualApi(own, parseFrontmatter(primaryFile.content).data, getApiMdxConfig(), warn)
    : own
  const meta = pageApiMetadata({ ...frontmatter, api: trusted.api }, warn)
  const openapi = meta.openapi
  const title = frontmatter?.title ?? deriveTitleFromSlug(slugPath)
  // `openapi:` wins when a page declares both: it is the existing behaviour.
  if (meta.shadowedApi) warn('both "openapi" and "api" frontmatter are set; using "openapi" and ignoring "api".')
  const manualApi = meta.manual
    ? buildManualOperation({
        pageId: slugPath || 'introduction',
        title,
        api: trusted.api,
        authMethod: trusted.authMethod,
        mdx: parseFrontmatter(sourceFile.content).content,
        config: getApiMdxConfig(),
        locale,
        warn,
      }) ?? undefined
    : undefined

  const document: DocEntry & { isFallback: boolean; isStale: boolean } = {
    // The empty route resolves introduction.mdx; titles are display metadata,
    // not source identifiers used by navigation, feedback, and GitHub edit links.
    id: slugPath || 'introduction',
    title,
    headingTitle: typeof frontmatter?.headingTitle === 'string' && frontmatter.headingTitle.trim() ? frontmatter.headingTitle.trim() : undefined,
    description: frontmatter?.description ?? '',
    descriptionPlacement: frontmatter?.descriptionPlacement === 'body' || frontmatter?.descriptionPlacement === 'operation' ? frontmatter.descriptionPlacement : undefined,
    slug: slugSegments,
    href,
    group: frontmatter?.group ?? 'Docs',
    badge: frontmatter?.badge,
    keywords: frontmatter?.keywords ?? [],
    component: GeneratedDoc,
    timeEstimate: frontmatter?.timeEstimate ?? '5 min',
    lastUpdated: frontmatter?.lastUpdated ?? new Date().toISOString().slice(0, 10),
    openapi: openapi ?? undefined,
    manualApi,
    playground: typeof frontmatter?.playground === 'string' ? frontmatter.playground : undefined,
    noindex: frontmatter?.noindex,
    hidden: frontmatter?.hidden,
    mode: frontmatter?.mode,
    ...pageMetaFields(frontmatter),
    isFallback,
    isStale,
  }
  renderedPayloadBytes.set(document, sourceFile.content.length * 2 + estimateRetainedPayloadBytes({ content, frontmatter, components, document }, 8 * 1024 * 1024))
  return document
}

const snippetImportPattern = /^\s*import\s+\{([^}]+)\}\s+from\s+['"]([^'"]+)['"];?\s*$/gm

function extractSnippetComponents(source: string) {
  const snippetInjectors: Record<string, () => Promise<ComponentType<Record<string, unknown>>>> = {}
  const cleanedSource = source.replace(snippetImportPattern, (statement, imports, fromPath) => {
    const normalizedPath = typeof fromPath === 'string' ? fromPath.trim() : ''
    if (!normalizedPath.startsWith('/snippets/')) {
      return statement
    }

    const names = imports
      .split(',')
      .map((name: string) => name.trim())
      .filter(Boolean)

    names.forEach((name: string) => {
      const loader = resolveSnippetComponent(normalizedPath, name)
      if (loader) {
        snippetInjectors[name] = loader
      } else {
        snippetInjectors[name] = () => compileSnippetFromPath(normalizedPath)
      }
    })

    return ''
  })

  return { cleanedSource, snippetInjectors }
}

const SNIPPETS_ROOT = 'snippets'

async function compileSnippetFromPath(snippetImportPath: string): Promise<ComponentType<Record<string, unknown>>> {
  const source = getContentSource()
  const relative = snippetImportPath.replace(/^\/snippets\//, '').replace(/\.mdx$/, '')
  const candidates = [
    projectJoin(SNIPPETS_ROOT, `${relative}.mdx`),
    projectJoin(SNIPPETS_ROOT, relative, 'index.mdx'),
  ]

  let snippetFile: { content: string } | null = null
  let sourcePath: string | null = null
  for (const filePath of candidates) {
    const candidateFile = await source.read(filePath)
    if (candidateFile) {
      snippetFile = candidateFile
      sourcePath = filePath
      break
    }
  }

  if (!snippetFile || !sourcePath) {
    const MissingSnippet: ComponentType<Record<string, unknown>> = () => null
    return MissingSnippet
  }

  if (!needsRuntimeCompile(source, sourcePath, snippetFile.content)) {
    const compiled = runtimeDocs[sourcePath]
    if (!compiled) {
      const MissingSnippet: ComponentType<Record<string, unknown>> = () => null
      return MissingSnippet
    }
    const components = getMDXComponents({})
    const PrecompiledSnippet: ComponentType<Record<string, unknown>> = function PrecompiledSnippet() {
      return createElement(compiled.component, { components })
    }
    return PrecompiledSnippet
  }

  // Same trust boundary as compileDocEntry: local development authors can
  // preview executable MDX, while remote content stays eval-free.
  const content =
    process.env.NODE_ENV === 'development' && source.kind === 'filesystem'
      ? (
          await compileMDX({
            source: snippetFile.content,
            components: getMDXComponents({}),
            options: {
              parseFrontmatter: false,
              blockJS: false,
              mdxOptions: { useDynamicImport: true, remarkPlugins, rehypePlugins },
            },
          })
        ).content
      : (
          await interpretMDX({
            source: snippetFile.content,
            components: getMDXComponents({}),
          })
        ).content

  const SnippetComponent: ComponentType<Record<string, unknown>> = function SnippetComponent() {
    return content
  }
  return SnippetComponent
}
