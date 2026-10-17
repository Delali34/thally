/**
 * Add the public native-export transport around the unmodified OpenNext entry.
 *
 * Wrangler resolves the authored TypeScript module during its normal bundle.
 * No generated handler is patched and every named OpenNext export survives.
 * Build calls this once after OpenNext regenerates its entry from scratch.
 */
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/** Install one idempotent generated entry; customer config still points at worker.js. */
export function writeNativeAgentWorker(projectRoot: string): void {
  const directory = path.join(projectRoot, '.open-next')
  const entryPath = path.join(directory, 'worker.js')
  const originalPath = path.join(directory, 'thally-opennext-worker.mjs')
  const marker = '/** Generated native agent-export entry. Do not edit. */'
  if (readFileSync(entryPath, 'utf8').startsWith(marker)) return
  copyFileSync(entryPath, originalPath)
  writeFileSync(entryPath, `${marker}\n` +
    `import application from './thally-opennext-worker.mjs';\n` +
    `import { fetchWithNativeAgentExport } from '../src/lib/agent-export/native-worker';\n` +
    `export * from './thally-opennext-worker.mjs';\n` +
    `export default { ...application, fetch(request, environment, context) {\n` +
    `  return fetchWithNativeAgentExport(application, request, environment, context);\n` +
    `} };\n`)
}
