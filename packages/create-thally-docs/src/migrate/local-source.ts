/**
 * Trusted CLI-only local migration boundary. Repository discovery runs on a
 * bounded inert snapshot, never the caller's live checkout or executable config.
 * Remote and Cloud URL adapters deliberately do not accept this capability.
 */
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { detectRepositoryDocsDir, projectMintlifyNavigation, readMintlifyConfig } from '@thallylabs/migrate'
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'

const generatedDirectories = new Set(['dist', 'build', 'coverage'])
const extensions = new Set(['.md', '.mdx', '.json', '.yaml', '.yml', '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.css', '.scss', '.sass', '.avif', '.bmp', '.gif', '.ico', '.jpeg', '.jpg', '.m4a', '.mp3', '.mp4', '.ogg', '.pdf', '.png', '.svg', '.wav', '.webm', '.webp'])

function contains(root: string, candidate: string): boolean {
  const path = relative(root, candidate)
  return !isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`)
}

/** Resolve an output that may not exist yet without overlooking ancestor symlinks. */
function physicalPath(path: string): string {
  if (existsSync(path)) return realpathSync(path)
  const parent = dirname(path)
  return parent === path ? path : join(physicalPath(parent), relative(parent, path))
}

/** Refuse either direction of overlap before discovery or destination mutation. */
export function assertSeparateMigrationDirectories(source: string, output: string): void {
  const sourceRoot = realpathSync(resolve(source))
  if (!statSync(sourceRoot).isDirectory()) throw new Error('The local migration source must be a directory.')
  const target = physicalPath(resolve(output))
  if (contains(sourceRoot, target) || contains(target, sourceRoot)) {
    throw new Error('Local migration source and output directories must not overlap. Choose a separate output directory.')
  }
}

/** Reject symlink writes, including dangling links, before creating any directories. */
export function assertMigrationDestination(projectDir: string, candidate = ''): string {
  const root = resolve(projectDir)
  const target = resolve(root, candidate)
  if (!contains(root, target)) throw new Error(`Generated migration path escapes the project: ${candidate}`)
  const parts = relative(root, target).split(sep).filter(Boolean)
  let current = root
  for (const [index, part] of ['', ...parts].entries()) {
    if (part) current = join(current, part)
    try {
      const entry = lstatSync(current)
      if (entry.isSymbolicLink()) throw new Error(`Migration destination must not traverse a symbolic link: ${current}`)
      if ((index < parts.length || parts.length === 0) && !entry.isDirectory()) throw new Error(`Migration destination parent must be a directory: ${current}`)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  return target
}

/** Copy inert documentation inputs while excluding secrets and escaping symlinks. */
export function snapshotLocalMigration(source: string, snapshot: string, docsDir?: string): void {
  const root = realpathSync(resolve(source))
  let files = 0
  let bytes = 0
  const visited = new Set<string>()
  const safeName = (name: string): boolean => name === '.mintignore' || (!name.startsWith('.') && name !== 'node_modules')
  const detectedDocsDir = detectRepositoryDocsDir(root)
  const conventionalDocsDir = ['docs', 'documentation', 'content', 'pages', 'src/content', 'src/pages', 'guide', 'guides'].find((path) => {
    try { return lstatSync(join(root, path)).isDirectory() } catch { return false }
  })
  const selectedDocsDir = docsDir ?? (detectedDocsDir || conventionalDocsDir)
  const contentRoot = selectedDocsDir ? resolve(root, selectedDocsDir) : undefined
  if (contentRoot && (!contains(root, contentRoot) || (existsSync(contentRoot) && !contains(root, realpathSync(contentRoot))))) throw new Error('The selected documentation directory must remain inside the local source.')
  const references = new Set<string>()
  for (const configRoot of new Set([root, ...(contentRoot ? [contentRoot] : [])])) {
    const config = readMintlifyConfig(configRoot)
    if (!config) continue
    for (const { ref } of projectMintlifyNavigation(config).pageReferences) {
      const path = resolve(configRoot, ref.replace(/^\//, '').replace(/\.mdx?$/i, ''))
      if (contains(root, path)) references.add(path)
    }
  }
  const includesGeneratedName = (directory: string): boolean => relative(root, directory).split(sep).some((name) => generatedDirectories.has(name))
  const shouldCopyDirectory = (directory: string): boolean => !includesGeneratedName(directory)
    // Once a docs root is selected, build/overview can be an authored section.
    // At the repository root, only navigation-proven paths override output names.
    || Boolean(contentRoot && contains(contentRoot, directory))
    || [...references].some((page) => contains(directory, page))
  function walk(directory: string, destination: string): void {
    const real = realpathSync(directory)
    if (!contains(root, real) || visited.has(real)) return
    if (relative(root, real).split(sep).some((name) => name && !safeName(name))) return
    visited.add(real)
    mkdirSync(destination, { recursive: true })
    for (const entry of readdirSync(real, { withFileTypes: true })) {
      if (!safeName(entry.name)) continue
      const path = join(real, entry.name)
      let actual: string
      try { actual = realpathSync(path) } catch { continue }
      if (!contains(root, actual) || relative(root, actual).split(sep).some((name) => !safeName(name))) continue
      const info = statSync(actual)
      const target = join(destination, entry.name)
      if (info.isDirectory() && shouldCopyDirectory(path)) walk(actual, target)
      else if (info.isFile() && (entry.name === '.mintignore' || extensions.has(extname(actual).toLowerCase()))) {
        if (++files > 100_000 || (bytes += info.size) > 256_000_000 || info.size > 16_000_000) {
          throw new Error('Local documentation exceeds the migration input limit (100000 files, 256 MB total, 16 MB per file). Select a smaller source directory.')
        }
        copyFileSync(actual, target)
      }
    }
  }
  walk(root, snapshot)
}
