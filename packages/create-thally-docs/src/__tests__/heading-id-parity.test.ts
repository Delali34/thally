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

describe('thally check resolves the ids Mintlify serves for punctuation-heavy headings', () => {
  it.each([
    ['### @trigger.dev/sdk/v3', '@trigger-dev/sdk/v3'],
    ['### `sessions.start(body, requestOptions?)`', 'sessions-start-body-requestoptions'],
    ['### `out.writer({ execute, ... })`', 'out-writer--execute-'],
    ['## `chat.requestUpgrade()`: same call, faster handoff', 'chat-requestupgrade--same-call-faster-handoff'],
  ])('resolves a link to the id of %s', async (heading, id) => {
    const body = normalizeMdx(`${heading}\n\nContent.`, 'mintlify')
    expect(await brokenAnchorOutput(body, id)).not.toContain('Broken anchor')
  })
})

describe('thally check resolves the id of a plain-text step', () => {
  const steps = (attributes: string) => `<Steps titleSize="p">\n<Step title="Add a new direct debit method" ${attributes}>\nBody.\n</Step>\n</Steps>`

  it('resolves a link to the id the step container carries', async () => {
    const body = steps('id="add-new-direct-debit-method"')
    expect(await brokenAnchorOutput(body, 'add-new-direct-debit-method')).not.toContain('Broken anchor')
    expect(await brokenAnchorOutput(body, 'add-a-new-direct-debit-method')).toContain('Broken anchor')
  })

  it('does not take the id from the title when the step has none', async () => {
    expect(await brokenAnchorOutput(steps(''), 'add-a-new-direct-debit-method')).toContain('Broken anchor')
  })
})
