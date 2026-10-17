/**
 * Canonical full-document export framing and ordering.
 *
 * Both the ordinary route and native managed delivery use these functions.
 * Document Markdown remains the canonical structured parser's projection;
 * these helpers add only request-current metadata and generated URLs.
 */

export interface AgentExportEntry {
  id: string
  title: string
  description?: string
  href: string
}

export interface AgentExportCollection {
  href?: string
  sections: ReadonlyArray<{ items: ReadonlyArray<{ href: string }> }>
}

/** Preserve sidebar first-seen order, followed by other listed documents. */
export function orderAgentExport<T extends { href: string }>(
  entries: ReadonlyArray<Pick<AgentExportEntry, 'id' | 'href'>>,
  listed: ReadonlyArray<AgentExportEntry>,
  collections: ReadonlyArray<AgentExportCollection>,
  operations: ReadonlyArray<T>,
): { pageIds: Array<string>; operations: Array<T> } {
  const idByHref = new Map(entries.map((entry) => [entry.href, entry.id]))
  const listedIds = new Set(listed.map((entry) => entry.id))
  const operationByHref = new Map(operations.map((operation) => [operation.href, operation]))
  const pageIds: Array<string> = []
  const orderedOperations: Array<T> = []
  const seenPages = new Set<string>()
  const seenOperations = new Set<T>()
  for (const collection of collections) {
    const hrefs = [
      ...(collection.sections.length === 0 && collection.href ? [collection.href] : []),
      ...collection.sections.flatMap((section) => section.items.map((item) => item.href)),
    ]
    for (const href of hrefs) {
      const operation = operationByHref.get(href)
      if (operation && !seenOperations.has(operation)) {
        seenOperations.add(operation)
        orderedOperations.push(operation)
        continue
      }
      const id = idByHref.get(href)
      if (id && listedIds.has(id) && !seenPages.has(id)) {
        seenPages.add(id)
        pageIds.push(id)
      }
    }
  }
  for (const entry of listed) if (!seenPages.has(entry.id)) pageIds.push(entry.id)
  for (const operation of operations) if (!seenOperations.has(operation)) orderedOperations.push(operation)
  return { pageIds, operations: orderedOperations }
}

/** Request-current identity and discovery links preceding the page corpus. */
export function agentExportHeader(
  site: { name: string; description: string },
  origin: string,
  locale: string,
): string {
  return [
    `# ${site.name} — Complete Documentation`, '', `> ${site.description}`, '',
    `Source: ${origin}`, `Language: ${locale}`, '', '## Instructions for agents', '',
    `- Use ${origin}/llms.txt to inspect the page index before scanning this full corpus.`,
    `- Use ${origin}/skill.md for retrieval rules and ${origin}/AGENTS.md before editing.`,
    `- Use ${origin}/api/mcp for read-only search, section retrieval, page, API and changelog tools.`,
    '- Cite canonical page URLs, distinguish documented facts from inference, and state when the documentation does not support a claim.',
    '', '---', '',
  ].join('\n')
}

/** Only generated URL fields use the origin; authored Markdown is untouched. */
export function agentExportPagePrefix(entry: Pick<AgentExportEntry, 'title' | 'description' | 'href'>, origin: string): string {
  const lines = [`# ${entry.title}`, '']
  if (entry.description) lines.push(`> ${entry.description}`, '')
  lines.push(`URL: ${origin}${entry.href}`, '', '')
  return `\n${lines.join('\n')}`
}

/** The historical separator, including its final newline. */
export const AGENT_EXPORT_PAGE_SUFFIX = '\n\n---\n'

/** API records retain the existing canonical operation projection. */
export function agentExportApiHeader(origin: string): string {
  return `\n${['# API reference', '', `Full schemas: MCP \`get_api_operation\` at ${origin}/api/mcp, or the human reference pages below.`, ''].join('\n')}`
}
