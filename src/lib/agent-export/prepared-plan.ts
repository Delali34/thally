/**
 * Convert an already-authorized listing into physical prepared ranges.
 *
 * This adapter never lists or authenticates pages. The caller supplies the
 * ordinary reader/locale projection. Legacy missing capability keeps the old
 * renderer; a valid prepared release with incompatible order fails actionable. Only plain pruned data leaves the Next scope.
 */
import { contentFileCandidates } from '@/lib/content/document'
import { getContentSource } from '@/lib/content-source'
import type { AgentExportEntry } from './format'
import { isNativeAgentExportPlan, MAX_NATIVE_PLAN_PAYLOAD_BYTES, type NativeAgentExportPlan } from './native-protocol'

const UNAVAILABLE_CODE = 'prepared_export_unavailable'

/** A valid prepared release must fail actionable instead of falling into unbounded work. */
export function isPreparedAgentExportUnavailable(error: unknown): error is Error {
  return error instanceof Error && (error as Error & { code?: string }).code === UNAVAILABLE_CODE
}

function unavailable(detail: string): never {
  throw Object.assign(new Error(detail), { code: UNAVAILABLE_CODE })
}

/** Construct the native plan without reading or parsing a document body. */
export async function createPreparedAgentExportPlan(input: {
  origin: string
  locale: string
  engineLocale?: string
  siteName: string
  siteDescription: string
  pages: ReadonlyArray<AgentExportEntry>
  apiMarkdown: Iterable<string>
}): Promise<NativeAgentExportPlan | null> {
  const source = getContentSource()
  if (source.kind !== 'assets' || !source.bulkExport) return null
  const descriptor = await source.bulkExport()
  if (!descriptor) return null
  const plan: NativeAgentExportPlan = {
    version: 1,
    origin: input.origin,
    locale: input.locale,
    siteName: input.siteName,
    siteDescription: input.siteDescription,
    shards: descriptor.shards,
    pages: [],
    apiMarkdown: [],
  }
  let payload = (input.origin.length + input.locale.length + input.siteName.length + input.siteDescription.length) * 3 + descriptor.shards.length * 160 + 128
  for (const entry of input.pages) {
    const physicalPath = contentFileCandidates(entry.id, input.engineLocale)
      .find((candidate) => Object.hasOwn(descriptor.records, candidate))
    // The ordinary loader also omits navigation entries without an MDX file.
    // The descriptor has already proved complete coverage of current MDX paths,
    // so this cannot substitute index.mdx for a missing prepared primary file.
    if (!physicalPath) continue
    const record = descriptor.records[physicalPath]
    payload += (entry.title.length + (entry.description?.length ?? 0) + entry.href.length) * 3 + 192 + record.ranges.length * 64
    if (payload > MAX_NATIVE_PLAN_PAYLOAD_BYTES) unavailable('The authorized export metadata exceeds the native handoff budget.')
    plan.pages.push({ title: entry.title, description: entry.description ?? '', href: entry.href, ranges: record.ranges })
  }
  for (const markdown of input.apiMarkdown) {
    payload += markdown.length * 3 + 32
    if (payload > MAX_NATIVE_PLAN_PAYLOAD_BYTES) unavailable('The authorized export metadata exceeds the native handoff budget.')
    plan.apiMarkdown.push(markdown)
  }
  if (!isNativeAgentExportPlan(plan)) unavailable('The current navigation order cannot use this prepared export revision.')
  return plan
}
