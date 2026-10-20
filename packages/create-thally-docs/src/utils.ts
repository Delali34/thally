/**
 * Project-creation helpers and completion output. Subprocess detail stays quiet
 * on interactive terminals, while CI/verbose output and failure diagnostics
 * remain visible. Creation never changes the starter's authored runtime.
 */
import { execFileSync, execSync, spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { terminal } from './terminal.js'
import semver from 'semver'

/** Convert a display name into a portable package identifier. */
export function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')
}

/** Run a trusted, fixed command with the historical inherited-output contract. */
export function run(cmd: string, cwd?: string): void {
  execSync(cmd, { cwd, stdio: 'inherit' })
}

interface CommandFailure extends Error { output?: string; exitCode?: number }

/** Run owner-selected project code, retaining a bounded diagnostic tail when quiet. */
export async function runProjectCommand(command: string, args: Array<string>, cwd: string, timeout?: number, onProgress?: (message: string) => void): Promise<void> {
  const isQuiet = terminal.isRich && !terminal.isVerbose
  await new Promise<void>((complete, reject) => {
    const child = spawn(command, args, {
      cwd,
      detached: process.platform !== 'win32',
      stdio: isQuiet ? ['ignore', 'pipe', 'pipe'] : 'inherit',
      // Windows resolves npm via a .cmd shim; command and arguments here are
      // fixed by the toolchain, never interpolated from imported content.
      shell: process.platform === 'win32' && ['npm', 'pnpm', 'yarn'].includes(command),
    })
    let tail = Buffer.alloc(0)
    let omitted = false
    const collect = (chunk: Buffer) => {
      const combined = Buffer.concat([tail, chunk])
      omitted ||= combined.length > 64 * 1024
      tail = combined.subarray(Math.max(0, combined.length - 64 * 1024))
      // npm/Next expose useful stage names even when their full log is quiet.
      // Report actual messages, never a guessed percentage or remaining time.
      const stages = chunk.toString('utf8').split(/[\r\n]+/).map((line) => line.trim())
        .filter((line) => /^(?:>|npm (?:warn|error)|added \d+|.*(?:Creating an optimized|Compiled successfully|Collecting page data|Generating static pages|Finalizing page optimization))/.test(line))
      if (stages.length) onProgress?.(stages.at(-1)!)
    }
    child.stdout?.on('data', collect)
    child.stderr?.on('data', collect)
    let interrupted: NodeJS.Signals | undefined
    let didTimeOut = false
    let escalation: ReturnType<typeof setTimeout> | undefined
    const killTree = (signal: NodeJS.Signals) => {
      if (!child.pid) return
      try {
        if (process.platform === 'win32') {
          execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
        } else {
          // npm owns a shell and build grandchildren. Killing only npm leaves
          // those processes holding our pipes open, defeating the timeout.
          process.kill(-child.pid, signal)
        }
      } catch { child.kill(signal) }
    }
    const interrupt = (signal: NodeJS.Signals) => {
      interrupted = signal
      killTree(signal)
      escalation = setTimeout(() => killTree('SIGKILL'), 1000)
    }
    const onInterrupt = () => interrupt('SIGINT')
    const onTerminate = () => interrupt('SIGTERM')
    const onExit = () => killTree('SIGKILL')
    const deadline = timeout ? setTimeout(() => { didTimeOut = true; interrupt('SIGTERM') }, timeout) : undefined
    process.once('SIGINT', onInterrupt)
    process.once('SIGTERM', onTerminate)
    process.once('exit', onExit)
    const cleanup = () => {
      // A descendant can close its pipes while ignoring TERM. Do not allow it
      // to outlive cancellation just because npm has already exited.
      if (interrupted) killTree('SIGKILL')
      if (deadline) clearTimeout(deadline)
      if (escalation) clearTimeout(escalation)
      process.removeListener('SIGINT', onInterrupt)
      process.removeListener('SIGTERM', onTerminate)
      process.removeListener('exit', onExit)
    }
    child.once('error', (error) => { cleanup(); reject(error) })
    child.once('close', (code, signal) => {
      cleanup()
      if (code === 0 && !interrupted) { complete(); return }
      const failure: CommandFailure = new Error(`${command} ${args.join(' ')} failed (${interrupted ?? signal ?? `exit ${code}`}).`)
      if (didTimeOut) failure.message += ` Timed out after ${timeout}ms.`
      if (interrupted && !didTimeOut) failure.exitCode = interrupted === 'SIGINT' ? 130 : 143
      failure.output = `${omitted ? 'Earlier output omitted; use --verbose for the full log.\n' : ''}${tail.toString('utf8')}`
      reject(failure)
    })
  })
}

/** Initialize a generated site's repository; owners can retry Git setup manually. */
export async function initGit(targetDir: string): Promise<void> {
  try {
    await terminal.step('Initialize Git repository', async (update) => {
      update('Initialize Git repository')
      await runProjectCommand('git', ['init'], targetDir)
      update('Stage generated project files')
      await runProjectCommand('git', ['add', '-A'], targetDir)
      update('Create initial project commit')
      await runProjectCommand('git', ['commit', '-m', 'Initial commit from create-thally-docs'], targetDir)
    }, 'Git repository initialized')
  } catch (error) {
    if ((error as CommandFailure).exitCode === 130 || (error as CommandFailure).exitCode === 143) throw error
    const failure = error as CommandFailure & { stdout?: Buffer; stderr?: Buffer }
    const diagnostic = [failure.output, failure.stdout, failure.stderr].filter(Boolean).map((value) => String(value)).join('\n').slice(-64 * 1024)
    if (diagnostic.trim()) terminal.error(diagnostic.trimEnd())
    terminal.warn('Could not finish Git setup. Run git status in the project directory, fix the reported issue, then retry the commit.')
  }
}

export type PackageManager = 'npm' | 'pnpm' | 'yarn'

/** Select explicit tooling, an existing owner lockfile, or the invoking manager. */
export function detectPackageManager(targetDir: string, requested?: PackageManager, userAgent = process.env.npm_config_user_agent): PackageManager {
  if (requested) return requested
  if (existsSync(join(targetDir, 'pnpm-lock.yaml'))) return 'pnpm'
  if (existsSync(join(targetDir, 'yarn.lock'))) return 'yarn'
  if (userAgent?.startsWith('pnpm/')) return 'pnpm'
  if (userAgent?.startsWith('yarn/')) return 'yarn'
  return 'npm'
}

/** Return reproducible npm installation arguments without rewriting its lockfile. */
export function dependencyInstallArguments(targetDir: string, manager: PackageManager): Array<string> {
  if (manager !== 'npm') return ['install']
  return [existsSync(join(targetDir, 'package-lock.json')) ? 'ci' : 'install',
    '--no-audit', '--no-fund', '--progress=false']
}

/** Reject unsupported site runtimes before npm can create a partial installation. */
export function assertProjectNodeVersion(targetDir: string, nodeVersion = process.versions.node): void {
  const manifest = JSON.parse(readFileSync(join(targetDir, 'package.json'), 'utf8')) as { engines?: { node?: unknown } }
  const range = manifest.engines?.node
  if (range === undefined) return
  if (typeof range !== 'string' || !semver.validRange(range)) {
    throw new Error('The documentation project declares an invalid Node.js engine range.')
  }
  if (!semver.satisfies(nodeVersion, range)) {
    throw new Error(`This documentation project requires Node.js ${range}; you are using ${nodeVersion}. Switch to a supported Node.js version and retry installation. Your project files and lockfile are preserved.`)
  }
}

/** Install dependencies; retries rebuild incomplete node_modules from the lock. */
export async function installDeps(targetDir: string, requested?: PackageManager): Promise<void> {
  const manager = detectPackageManager(targetDir, requested)
  const args = dependencyInstallArguments(targetDir, manager)
  try {
    assertProjectNodeVersion(targetDir)
    await terminal.step('Install dependencies', (update) => runProjectCommand(manager, args,
      targetDir, undefined, (message) => update(`Install dependencies: ${message}`)), 'Dependencies installed')
  } catch (error) {
    const failure = error as CommandFailure
    if (failure.output?.trim()) terminal.error(failure.output.trimEnd())
    terminal.warn(`Installation did not complete. Your content and lockfile were kept. Retry: cd ${quoteDirectory(targetDir)} && ${manager} ${args.join(' ')}. If a package is incomplete, remove only node_modules before retrying.`)
    throw error
  }
}

/** Quote the actual destination for the user's shell, including spaces and apostrophes. */
export function quoteDirectory(directory: string): string {
  const absolute = resolve(directory)
  return process.platform === 'win32'
    ? `"${absolute.replace(/"/g, '""')}"`
    : `'${absolute.replace(/'/g, "'\\''")}'`
}

/** True when the project declares the `thally` CLI as a dependency. */
function declaresThallyCli(directory: string): boolean {
  try {
    const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, unknown>
      devDependencies?: Record<string, unknown>
    }
    return Boolean(manifest.devDependencies?.['@thallylabs/cli'] ?? manifest.dependencies?.['@thallylabs/cli'])
  } catch {
    return false
  }
}

/**
 * The command that starts the local preview. `npx thally dev` is used only
 * when the project's own `thally` binary is (or is about to be) installed: no
 * package named `thally` exists on npm, so `npx thally` must never fall back
 * to a registry lookup. Otherwise the project's `dev` script is used.
 */
export function devCommand(directory: string, needsInstall = false, requested?: PackageManager): string {
  const binary = join(directory, 'node_modules', '.bin', 'thally')
  const hasLocalCli = needsInstall
    ? declaresThallyCli(directory)
    : existsSync(binary) || existsSync(`${binary}.cmd`)
  const manager = detectPackageManager(directory, requested)
  if (!hasLocalCli) return `${manager} run dev`
  return manager === 'npm' ? 'npx thally dev' : manager === 'pnpm' ? 'pnpm exec thally dev' : 'yarn thally dev'
}

/** One copyable command; installation is included when setup skipped it. */
export function previewCommand(directory: string, needsInstall = false, requested?: PackageManager): string {
  const manager = detectPackageManager(directory, requested)
  const install = manager === 'npm' && existsSync(join(directory, 'package-lock.json')) ? 'npm ci' : `${manager} install`
  return `cd ${quoteDirectory(directory)} && ${needsInstall ? `${install} && ` : ''}${devCommand(directory, needsInstall, requested)}`
}

/** Introduce project creation with the shared wordmark and task presentation. */
export function logo(version?: string): void {
  terminal.intro('init', version, 'Build and publish docs for people and AI tools.')
}

/** Present an actionable completion summary without implying the site is deployed. */
export function success(projectDir: string, projectName: string, dependenciesInstalled: boolean, requested?: PackageManager): void {
  terminal.detail('Project', projectName)
  terminal.detail('Output', projectDir)
  terminal.section('Make it yours', [
    'src/content/      Write your documentation',
    'docs.json         Set up navigation',
    'src/data/site.ts  Name, links, and branding',
  ])
  terminal.outro('Your docs project is ready. The dev server will print your preview URL.')
  terminal.nextAction('Preview locally', previewCommand(projectDir, !dependenciesInstalled, requested))
}
