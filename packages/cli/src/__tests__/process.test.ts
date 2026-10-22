/** Shell use when the CLI spawns subprocesses (Windows path regression, #333). */

import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const spawn = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', () => ({ spawn }))

import { run, runPackageBin } from '../process.js'

const realPlatform = process.platform

// The shell decision depends on the platform, so the Windows behavior is
// exercised on every CI runner rather than only on Windows ones.
function setPlatform(platform: NodeJS.Platform) {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
}

function exitingChild(code: number) {
  const child = new EventEmitter()
  queueMicrotask(() => child.emit('close', code))
  return child
}

describe('subprocess shell use on Windows', () => {
  beforeEach(() => {
    setPlatform('win32')
    spawn.mockReset()
    spawn.mockImplementation(() => exitingChild(0))
  })

  afterEach(() => setPlatform(realPlatform))

  it('runs sibling package binaries through node without a shell', async () => {
    const exit = await runPackageBin('create-thally-docs', 'create-thally-docs', ['check', 'C:\\My Docs'])

    expect(exit).toBe(0)
    const [command, args, options] = spawn.mock.calls[0]
    expect(command).toBe(process.execPath)
    expect(args.slice(1)).toEqual(['check', 'C:\\My Docs'])
    expect(options.shell).toBe(false)
  })

  it('keeps the shell for other commands such as the npm shims', async () => {
    await run('npm.cmd', ['run', 'check:agents'])

    expect(spawn.mock.calls[0][2].shell).toBe(true)
  })
})
