/**
 * URL-only OpenAPI hydration. Never import repository traversal or cloning here:
 * the hosted URL entry must remain independent of local filesystem authority.
 */
import { createHash } from 'node:crypto'
import { downloadSpec, parseOpenApi, type OpenApiOperation } from './remote-spec.js'
import { parseSpecDocument, withoutByteOrderMark } from './spec-exclude.js'
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
    const pages = bundle.pages.map((page) => {
      const operation = byRoute.get(page.navigationId.split('/').slice(-2).join('/').toLowerCase())
      if (!operation || page.openapi || bundle.sourceKind !== 'url') return page
      const reference = `${operation.method.toUpperCase()} ${operation.path}`
      represented.add(reference)
      return { ...page, openapi: `${path} ${reference}` }
    })
    const remaining = operations.map((operation) => `${operation.method.toUpperCase()} ${operation.path}`).filter((reference) => !represented.has(reference))
    const api = { source: path, ...(represented.size ? (remaining.length ? { groups: [{ group: 'Endpoints', pages: remaining }] } : { navigation: false }) : {}) }
    const tabs = bundle.docsConfig.tabs.map((tab) => ({ ...tab }))
    const target = tabs.find((tab) => !tab.api && tab.tab.toLowerCase().includes('api'))
    if (target) target.api = api
    else tabs.push({ tab: 'API Reference', api })
    return {
      ...bundle,
      pages,
      assets: [...bundle.assets, { path, content, projectRelative: true }],
      docsConfig: { ...bundle.docsConfig, tabs },
    }
  } catch (error) {
    return { ...bundle, warnings: [...bundle.warnings, { code: 'fetch-failed', source: specUrl, message: `OpenAPI spec could not be imported: ${error instanceof Error ? error.message : String(error)}` }] }
  }
}
