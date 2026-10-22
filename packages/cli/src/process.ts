/**
 * Subprocess helpers for the framework, provider, and sibling-package commands.
 * Output streams are inherited so the user sees live progress; `runTee` also
 * reads stdout line by line when the CLI needs a value the child prints (the
 * dev-server URL, a deployment URL) without hiding or reordering that output.
 */

import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

const require = createRequire(import.meta.url)

/**
 * Run a command with inherited stdio and resolve with its exit code (127 when
 * it cannot start). Windows needs a shell for the `npm.cmd`/`npx.cmd` shims,
 * so that is the default there. A shell joins the command and its arguments
 * without quoting them, so pass `shell: false` when spawning an executable by
 * absolute path: `C:\Program Files\nodejs\node.exe` would otherwise split at
 * the space.
 */
export function run(
  command: string,
  args: Array<string>,
  cwd = process.cwd(),
  shell = process.platform === 'win32',
): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit', shell })
    child.on('close', (code) => resolve(code ?? 0))
    child.on('error', () => resolve(127))
  })
}

// CSI/OSC escape sequences emitted by colored subprocess output.
const ANSI_PATTERN = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g

/** Remove terminal escape sequences so subprocess lines can be parsed as text. */
export function stripAnsi(value: string): string {
  return value.replace(ANSI_PATTERN, '')
}

/**
 * Run a command with inherited stdin/stderr while teeing stdout through this
 * process. Each complete stdout line (ANSI removed) is passed to `onLine`.
 * Colors are preserved for an interactive parent by setting FORCE_COLOR,
 * because the child no longer sees a TTY on its stdout.
 */
export function runTee(
  command: string,
  args: Array<string>,
  onLine: (line: string) => void,
  cwd = process.cwd(),
): Promise<number> {
  return new Promise((resolve) => {
    const env = process.stdout.isTTY && process.env.NO_COLOR === undefined && process.env.FORCE_COLOR === undefined
      ? { ...process.env, FORCE_COLOR: '1' }
      : process.env
    const child = spawn(command, args, { cwd, env, stdio: ['inherit', 'pipe', 'inherit'], shell: process.platform === 'win32' })
    let pending = ''
    const emit = (line: string) => {
      try {
        onLine(stripAnsi(line).trim())
      } catch {
        // Line observers are best-effort presentation; never break the child.
      }
    }
    child.stdout?.on('data', (chunk: Buffer) => {
      process.stdout.write(chunk)
      pending += chunk.toString('utf8')
      const lines = pending.split(/\r?\n|\r/)
      pending = lines.pop() ?? ''
      // Bound the partial-line buffer: a child that never prints a newline
      // must not grow this process's memory without limit.
      if (pending.length > 64 * 1024) pending = pending.slice(-64 * 1024)
      for (const line of lines) emit(line)
    })
    child.on('close', (code) => {
      if (pending) emit(pending)
      resolve(code ?? 0)
    })
    child.on('error', () => resolve(127))
  })
}

/** Resolve a workspace/dep package's bin path so we can invoke it via node. */
export function resolveBin(pkg: string, binName: string): string | null {
  try {
    const pkgJsonPath = require.resolve(`${pkg}/package.json`)
    const pkgDir = path.dirname(pkgJsonPath)
    const pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf8')) as { bin?: string | Record<string, string> }
    const binRel = typeof pkgJson.bin === 'string' ? pkgJson.bin : pkgJson.bin?.[binName]
    if (!binRel) return null
    return path.join(pkgDir, binRel)
  } catch {
    return null
  }
}

/** True when the current directory looks like a Thally project. */
export function isThallyProject(cwd = process.cwd()): boolean {
  return existsSync(path.join(cwd, 'docs.json'))
}

/** True when the project's dependencies have been installed. */
export function hasInstalledDependencies(cwd = process.cwd()): boolean {
  return existsSync(path.join(cwd, 'node_modules'))
}

/** The project's package name, used to name things such as an MCP server entry. */
export function projectPackageName(cwd = process.cwd()): string | undefined {
  try {
    const pkg = JSON.parse(readFileSync(path.join(cwd, 'package.json'), 'utf8')) as { name?: unknown }
    return typeof pkg.name === 'string' ? pkg.name : undefined
  } catch {
    return undefined
  }
}

export interface PackageScripts {
  scripts?: Record<string, string>
}

export function projectScripts(cwd = process.cwd()): Record<string, string> {
  try {
    const pkg = JSON.parse(readFileSync(path.join(cwd, 'package.json'), 'utf8')) as PackageScripts
    return pkg.scripts ?? {}
  } catch {
    return {}
  }
}

/**
 * Run a framework task. Prefers the project's npm script (so the framework is
 * a hidden implementation detail), falling back to `npx next <task>`.
 */
export function runFramework(
  task: string,
  scriptName: string,
  passthrough: Array<string> = [],
  onLine?: (line: string) => void,
): Promise<number> {
  const scripts = projectScripts()
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx'
  const [command, args] = scripts[scriptName]
    ? [npm, ['run', scriptName, ...(passthrough.length ? ['--', ...passthrough] : [])]]
    : [npx, ['next', task, ...passthrough]]
  return onLine ? runTee(command, args, onLine) : run(command, args)
}

/**
 * Run a sibling package binary (create-thally-docs, thally-mcp) via node.
 * Node is spawned directly, without a shell, so neither its install path nor
 * arguments such as a project path containing spaces are split on Windows.
 */
export function runPackageBin(pkg: string, binName: string, args: Array<string>): Promise<number> {
  const bin = resolveBin(pkg, binName)
  if (!bin) {
    process.stderr.write(`\n  Could not resolve the "${binName}" binary from "${pkg}".\n  Is it installed in this project?\n\n`)
    return Promise.resolve(127)
  }
  return run(process.execPath, [bin, ...args], process.cwd(), false)
}
