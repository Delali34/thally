/** Portable package coverage: `thally check` resolves the heading ids the migrator preserves. */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { normalizeMdx } from '@thallylabs/migrate'
import { describe, expect, it, vi } from 'vitest'

import { runCheck } from '../check.js'

async function brokenAnchorOutput(body: string, link: string): Promise<string> {
  const projectDir = mkdtempSync(join(tmpdir(), 'thally-check-heading-ids-'))
  mkdirSync(join(projectDir, 'src/content'), { recursive: true })
  writeFileSync(join(projectDir, 'docs.json'), JSON.stringify({ tabs: [{ tab: 'Docs', pages: ['introduction'] }] }))
  writeFileSync(
    join(projectDir, 'src/content/introduction.mdx'),
    `---\ntitle: Intro\ndescription: Introduction page.\n---\n\n${body}\n\nThis page has enough prose to avoid the short body notice. [Jump](#${link})`,
  )
  const output: Array<string> = []
  const log = vi.spyOn(console, 'log').mockImplementation((value) => output.push(String(value)))
  try {
    await runCheck(projectDir, { fix: false, ci: true })
  } finally {
    log.mockRestore()
  }
  return output.join('\n')
}

describe('heading id parity between the migrator and thally check', () => {
  it.each(['1-add-firecrawl', '123', '429-responses', 'v1.2', 'a:b', 'café', '入门', '_x'])('resolves a link to the kept id %s', async (id) => {
    const body = normalizeMdx(`## Section {#${id}}\n\nContent.`, 'mintlify')
    expect(body).toContain(`{/* #${id} */}`)
    expect(await brokenAnchorOutput(body, id)).not.toContain('Broken anchor')
  })

  it.each(['a b', 'a*/b'])('drops the rejected id %j so neither side resolves it', async (id) => {
    const body = normalizeMdx(`## Section {#${id}}\n\nContent.`, 'mintlify')
    expect(body).not.toContain('#a')
    expect(await brokenAnchorOutput(body, 'nope')).toContain('Broken anchor')
  })
})
