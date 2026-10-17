/** Shared physical-source identity; derived assets never hash themselves. */
import { createHash } from 'node:crypto'
import { isBulkSha256 } from './prepared-contract'

/** Legacy manifests without raw source identities cannot authorize a bulk file. */
export function bulkSourceRevision(files: Readonly<Record<string, { sha256?: string }>>): string | null {
  const hash = createHash('sha256')
  for (const physicalPath of Object.keys(files).sort()) {
    const sha256 = files[physicalPath].sha256
    if (!isBulkSha256(sha256)) return null
    hash.update(JSON.stringify([physicalPath, sha256]) + '\n')
  }
  return hash.digest('hex')
}
