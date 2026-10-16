/**
 * Build the workspace packages in dependency order, parallelizing where the
 * dependency graph allows.
 *
 * The graph (from each package's tsup config and dependencies):
 * - core and migrate have no @thallylabs/* build-time dependencies and build
 *   concurrently.
 * - create-thally-docs imports @thallylabs/migrate and its declaration build
 *   needs migrate's generated types, so it builds next.
 * - mcp consumes the canonical create-thally-docs scaffold and release
 *   declarations, so it builds after create-thally-docs.
 * - agent marks @thallylabs/mcp external at runtime, but its `dts: true`
 *   type build reads mcp's generated declarations — it builds after mcp.
 * - cli sets `noExternal: ['@thallylabs/agent']`, bundling agent's dist into
 *   the CLI at build time — it must build last.
 *
 * The previous fully-serial `npm run build -w … && …` chain paid all five
 * builds back to back on every engine build; the fan-out keeps the ordering
 * constraints while letting the independent half run at once.
 */

import { spawn } from 'node:child_process'
import { hasCurrentWorkspaceBuild, proofContext, recordWorkspaceBuild } from './workspace-build-proof.mjs'

function buildWorkspace(workspace) {
  return new Promise((resolve, reject) => {
    const child = spawn('npm', ['run', 'build', '-w', workspace], {
      stdio: 'inherit',
      // OpenNext sets NODE_ENV for its nested build. Keep package compiler
      // inputs identical to the earlier CI compilation without changing tests.
      env: context ? { ...process.env, NODE_ENV: 'production' } : process.env,
      // npm resolves via a .cmd shim on Windows, which spawn only finds
      // through a shell.
      shell: process.platform === 'win32',
    })
    child.on('error', reject)
    child.on('close', (code, signal) => {
      if (code === 0) resolve()
      else
        reject(
          new Error(`${workspace} build failed (${signal ?? `exit ${code}`})`),
        )
    })
  })
}

const context = proofContext()
if (hasCurrentWorkspaceBuild(context)) {
  process.stdout.write('Workspace package inputs and outputs match this CI job; reusing compilation.\n')
} else {
  await Promise.all(
    ['packages/core', 'packages/migrate'].map(buildWorkspace),
  )
  await buildWorkspace('packages/create-thally-docs')
  await buildWorkspace('packages/mcp')
  await buildWorkspace('packages/agent')
  await buildWorkspace('packages/cli')
  recordWorkspaceBuild(context)
}
