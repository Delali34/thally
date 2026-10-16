/**
 * MCP adapters for template-first migration and explicit in-place imports.
 *
 * `migrate_docs` deliberately cannot opt into an existing project. That
 * invariant ensures agents always start from Thally's supported runtime,
 * layout, and configuration instead of preserving an arbitrary source app.
 * Callers that intentionally want to keep an existing Thally runtime must use
 * the separately named `import_docs` tool.
 */

import { z } from 'zod'
import { migrateDocs } from 'create-thally-docs/migrate'

const migrationSourceShape = {
  sourceUrl: z.string().describe('GitHub repository URL or public documentation URL to migrate'),
  branch: z.string().optional().describe('Git branch (default: auto-detect)'),
  docsDir: z.string().optional().describe('Docs subdirectory in repo (default: auto-detect)'),
  apiKey: z.string().optional().describe('Anthropic API key for non-Markdown file conversion'),
  maxPages: z.number().int().min(1).max(10000).optional().describe('Maximum public URL pages to import (up to 10000)'),
  platform: z.enum(['mintlify', 'docusaurus']).optional().describe('Source platform (default: auto-detect)'),
}

export const migrateDocsSchema = z.object({
  ...migrationSourceShape,
  projectDir: z
    .string()
    .describe('Path for the new canonical Thally project; the directory must be absent or empty'),
})

export const importDocsSchema = z.object({
  ...migrationSourceShape,
  projectDir: z
    .string()
    .describe('Path to an existing Thally project whose runtime should be preserved'),
})

interface RunMigrationInput {
  sourceUrl: string
  projectDir: string
  branch?: string
  docsDir?: string
  apiKey?: string
  maxPages?: number
  platform?: 'mintlify' | 'docusaurus'
}

async function runMigration(
  input: RunMigrationInput,
  isInPlaceImport: boolean,
): Promise<Awaited<ReturnType<typeof migrateDocs>>> {
  const apiKey = input.apiKey ?? process.env.ANTHROPIC_API_KEY

  return migrateDocs({
    sourceUrl: input.sourceUrl,
    projectDir: input.projectDir,
    // Keep this decision inside the adapter so stale or adversarial callers
    // cannot turn a template-first migration into an in-place mutation.
    into: isInPlaceImport,
    apiKey,
    branch: input.branch,
    docsDir: input.docsDir,
    maxPages: input.maxPages,
    platform: input.platform,
    yes: true,
  })
}

/**
 * Creates a fresh canonical Thally project before importing source content.
 */
export async function handleMigrateDocs(input: z.infer<typeof migrateDocsSchema>): Promise<string> {
  const result = await runMigration(input, false)

  return `Created a fresh Thally template at ${result.projectDir} and imported ${result.pagesWritten} pages. ${validationSummary(result)}`
}

/**
 * Imports source content into an existing Thally project without scaffolding.
 */
export async function handleImportDocs(input: z.infer<typeof importDocsSchema>): Promise<string> {
  const result = await runMigration(input, true)

  return `Imported ${result.pagesWritten} pages into the existing Thally project at ${result.projectDir}. ${validationSummary(result)}`
}

/** Keep agent callers from mistaking file creation for a verified migration. */
function validationSummary(result: Awaited<ReturnType<typeof migrateDocs>>): string {
  const { validation } = result
  const status = validation.content === 'passed' && validation.build === 'passed'
    ? 'Content and production build passed.'
    : 'Validation is incomplete; review the failures or skipped checks before publishing.'
  return `${status} ${result.warnings.length} migration warning(s). Report: ${result.reportPath}`
}
