/**
 * URL-only OpenAPI hydration. Never import repository traversal or cloning here:
 * the hosted URL entry must remain independent of local filesystem authority.
 */
import { createHash } from 'node:crypto'
import { downloadSpec, parseOpenApi, type OpenApiOperation } from './remote-spec.js'
import { markExcluded, operationKey, parseSpecDocument, sharedSpecMessage, withoutByteOrderMark } from './spec-exclude.js'
import { canonicalSpecRef, resolveSpecRef, specRefBaseName, splitOpenApiRef } from './openapi-ref.js'
import type { MigrationBundle } from './types.js'

const slug = (value: string): string => value.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

/** Bind unique crawled endpoints in place and generate only missing operation navigation. */
export async function hydrateUrlOpenApi(bundle: MigrationBundle, specUrl: string, fetcher?: import('./types.js').MigrationFetcher): Promise<MigrationBundle> {
  try {
    const content = withoutByteOrderMark(await downloadSpec(specUrl, fetcher))
    const { document, format } = parseSpecDocument(content.toString('utf8'))
    const operations = parseOpenApi(document)
    const path = `openapi/openapi-${createHash('sha256').update(specUrl).digest('hex').slice(0, 12)}.${format}`
    const byRoute = new Map<string, OpenApiOperation | null>()
    for (const operation of operations) {
      const key = `${slug(operation.tag)}/${slug(operation.summary)}`
      if (!slug(operation.summary)) continue
      byRoute.set(key, byRoute.has(key) ? null : operation)
    }
    const represented = new Set<string>()
    const visible = new Set(operations.map((operation) => operationKey(`${operation.method} ${operation.path}`)))
    const assets = bundle.assets.filter((asset) => /\.(?:json|ya?ml)$/i.test(asset.path)).map((asset) => ({ ...asset, sourcePath: canonicalSpecRef(asset.path), filename: specRefBaseName(asset.path) }))
    const published = new Map<string, Set<string>>()
    const defaultSource = [...bundle.docsConfig.tabs.filter((tab) => !tab.hidden), ...bundle.docsConfig.tabs.filter((tab) => tab.hidden)].find((tab) => tab.api)?.api?.source
    const isExistingBinding = (raw: string): { operation: string; source: string } | undefined => {
      const ref = splitOpenApiRef(raw)
      if (!ref) return undefined
      const key = operationKey(ref.operation)
      if (!visible.has(key)) return undefined
      const source = ref.specRef ?? defaultSource
      if (!source) return undefined
      const resolved = resolveSpecRef(source, assets, false)
      if (resolved.kind !== 'match') return undefined
      const asset = resolved.spec
      if (!published.has(asset.path)) {
        try {
          const original = parseSpecDocument(Buffer.from(asset.content).toString('utf8')).document
          published.set(asset.path, new Set(parseOpenApi(original).map((operation) => operationKey(`${operation.method} ${operation.path}`))))
        } catch { published.set(asset.path, new Set()) }
      }
      return published.get(asset.path)!.has(key) ? { operation: ref.operation, source: asset.path } : undefined
    }
    const reboundSources = new Set<string>()
    const withheld = new Set<string>()
    const kept = new Set<string>()
    const bind = (page: MigrationBundle['pages'][number], reference: string): MigrationBundle['pages'][number] => {
      const key = operationKey(reference)
      represented.add(key)
      if (page.public === false || page.groups?.length) withheld.add(key)
      else kept.add(key)
      return { ...page, openapi: `${path} ${reference}` }
    }
    const pages = bundle.pages.map((page) => {
      if (bundle.sourceKind !== 'url') return page
      if (page.openapi) {
        const selected = splitOpenApiRef(page.openapi)
        if (selected && (selected.specRef === specUrl || (selected.specRef === path && assets.some((asset) => asset.path === path)))
          && visible.has(operationKey(selected.operation))) {
          return bind(page, selected.operation)
        }
        // The evidence runner already proved some operations against declared
        // publisher schemas. Rebind their exact operation identities to the
        // explicitly selected schema, which may contain richer response data.
        // Never infer an operation from a broken/hidden source reference.
        const bound = isExistingBinding(page.openapi)
        if (bound) {
          reboundSources.add(bound.source)
          return bind(page, bound.operation)
        }
        return page
      }
      const operation = byRoute.get(page.navigationId.split('/').slice(-2).join('/').toLowerCase())
      if (!operation) return page
      const reference = `${operation.method.toUpperCase()} ${operation.path}`
      return bind(page, reference)
    })
    const remaining = operations.map((operation) => `${operation.method.toUpperCase()} ${operation.path}`).filter((reference) => !represented.has(operationKey(reference)))
    // API tab navigation is not an access gate: its spec also has machine and
    // generated endpoint routes. Apply the shared fail-closed policy so a page
    // restricted by the author cannot acquire an unrestricted spec copy.
    const pruned = markExcluded(content, [...withheld].filter((key) => !kept.has(key)), [...kept])
    const warning = pruned.excluded.length ? { code: 'gated-page' as const, source: path, message: sharedSpecMessage(path, pruned.excluded) } : undefined
    const api = { source: path, ...(represented.size ? (remaining.length ? { groups: [{ group: 'Endpoints', pages: remaining }] } : { navigation: false }) : {}) }
    // Discard only exhausted page-only mounts. Other source mounts and pages
    // stay intact; this removes the runner's per-page duplicate spec ids while
    // the selected complete document becomes their single runtime binding.
    const stillReferenced = new Set(pages.flatMap((page) => {
      const source = page.openapi ? (splitOpenApiRef(page.openapi)?.specRef ?? defaultSource) : undefined
      if (!source) return []
      const resolved = resolveSpecRef(source, assets, false)
      return resolved.kind === 'match' ? [resolved.spec.path] : []
    }))
    const tabs = bundle.docsConfig.tabs.filter((tab) => {
      if (!tab.hidden || tab.api?.navigation !== false || tab.pages?.length || tab.groups?.length || tab.href) return true
      const source = resolveSpecRef(tab.api.source, assets, false)
      return source.kind !== 'match' || !reboundSources.has(source.spec.path) || stillReferenced.has(source.spec.path)
    })
      .map((tab) => ({ ...tab }))
    const target = tabs.find((tab) => tab.api && [path, specUrl].includes(tab.api.source))
      ?? tabs.find((tab) => !tab.api && tab.tab.toLowerCase().includes('api'))
    if (target) target.api = api
    else {
      const taken = new Set(tabs.map((tab) => slug(tab.tab)))
      let label = 'API Reference'
      let suffix = 2
      while (taken.has(slug(label))) label = `API Reference ${suffix++}`
      tabs.push({ tab: label, api })
    }
    return {
      ...bundle,
      pages,
      assets: [...bundle.assets.filter((asset) => asset.path !== path), { path, content: pruned.content, projectRelative: true }],
      docsConfig: { ...bundle.docsConfig, tabs },
      warnings: warning && !bundle.warnings.some((item) => item.code === warning.code && item.source === warning.source && item.message === warning.message)
        ? [...bundle.warnings, warning] : bundle.warnings,
    }
  } catch (error) {
    return { ...bundle, warnings: [...bundle.warnings, { code: 'fetch-failed', source: specUrl, message: `OpenAPI spec could not be imported: ${error instanceof Error ? error.message : String(error)}` }] }
  }
}
