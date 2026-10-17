/** The native hook wraps generated output without modifying OpenNext handlers. */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, it } from 'vitest'
import { writeNativeAgentWorker } from './native-agent-worker'

it('retains the exact adapter entry, named exports and idempotent Wrangler-facing entry', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'thally-native-entry-'))
  try {
    mkdirSync(path.join(root, '.open-next'))
    const original = 'export const DOQueueHandler = {};\nexport default { fetch() { return new Response("adapter") }, scheduled() {} };\n'
    writeFileSync(path.join(root, '.open-next/worker.js'), original)
    writeNativeAgentWorker(root)
    const entry = readFileSync(path.join(root, '.open-next/worker.js'), 'utf8')
    expect(readFileSync(path.join(root, '.open-next/thally-opennext-worker.mjs'), 'utf8')).toBe(original)
    expect(entry).toContain("export * from './thally-opennext-worker.mjs'")
    expect(entry).toContain('...application')
    expect(entry).toContain('../src/lib/agent-export/native-worker')
    writeNativeAgentWorker(root)
    expect(readFileSync(path.join(root, '.open-next/worker.js'), 'utf8')).toBe(entry)
    expect(readFileSync(path.join(root, '.open-next/thally-opennext-worker.mjs'), 'utf8')).toBe(original)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
