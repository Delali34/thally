/** Portable package coverage: `thally check` resolves the ids Mintlify gives `<ParamField>` and `<ResponseField>`. */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { runCheck } from '../check.js'

async function brokenAnchorOutput(body: string, link: string): Promise<string> {
  const projectDir = mkdtempSync(join(tmpdir(), 'thally-check-field-ids-'))
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

// Each pair was read from a live Mintlify page (dub.co, unkey.com, mintlify.com docs).
describe('field ids as Mintlify serves them', () => {
  it.each([
    ['<ParamField body="expiresInDays" type="integer">Days.</ParamField>', 'param-expires-in-days'],
    ['<ParamField body="data-attribution-model" type="string">Model.</ParamField>', 'param-data-attribution-model'],
    ['<ParamField body="--root-key" type="string">Key.</ParamField>', 'param-root-key'],
    ['<ParamField path="Workspace name">Name.</ParamField>', 'param-workspace-name'],
    ['<ParamField path="GitHub">Org.</ParamField>', 'param-git-hub'],
    ['<ParamField body="ratelimits[].name" type="string">Name.</ParamField>', 'param-ratelimits-name'],
    ['<ResponseField name="pagination.hasMore" type="boolean">More.</ResponseField>', 'param-pagination-has-more'],
    ['<ResponseField name="latency_p75" type="number">Latency.</ResponseField>', 'param-latency-p75'],
    ['<ResponseField name="variables.[variableName]">Variable.</ResponseField>', 'param-variables-variable-name'],
  ])('resolves a link to the id of %s', async (field, id) => {
    expect(await brokenAnchorOutput(field, id)).not.toContain('Broken anchor')
    expect(await brokenAnchorOutput(field, `${id}-1`)).toContain('Broken anchor')
  })

  it('reads a field nested in an Expandable and in other components', async () => {
    const body = '<Tabs>\n<Tab title="One">\n<ParamField body="x">\n<Expandable title="properties">\n<ParamField body="expiresInDays" type="integer">Days.</ParamField>\n</Expandable>\n</ParamField>\n</Tab>\n</Tabs>'
    expect(await brokenAnchorOutput(body, 'param-expires-in-days')).not.toContain('Broken anchor')
  })

  it('numbers a repeated name -1, -2, and shares the numbering between the two components', async () => {
    const body = '<ParamField body="keyId">One.</ParamField>\n\n<ResponseField name="keyId">Two.</ResponseField>\n\n<ResponseField name="key_id">Three.</ResponseField>'
    for (const id of ['param-key-id', 'param-key-id-1', 'param-key-id-2']) expect(await brokenAnchorOutput(body, id), id).not.toContain('Broken anchor')
    expect(await brokenAnchorOutput(body, 'param-key-id-3')).toContain('Broken anchor')
  })

  it('does not read a field written inside inline code, a comment or a fence', async () => {
    const inlineCode = 'Write `<ParamField body="shown">` in the file.'
    const comment = '{/* <ParamField body="shown">x</ParamField> */}'
    const fence = '```mdx\n<ParamField body="shown">x</ParamField>\n```'
    for (const body of [inlineCode, comment, fence]) expect(await brokenAnchorOutput(body, 'param-shown'), body).toContain('Broken anchor')
  })
})

describe('field ids when an attribute is a string written in braces', () => {
  it('resolves a field named in braces, as it does one named in quotes', async () => {
    const body = '<ParamField body={"expiresInDays"}>Days.</ParamField>\n\n<ResponseField name={`pagination.hasMore`}>More.</ResponseField>'
    expect(await brokenAnchorOutput(body, 'param-expires-in-days')).not.toContain('Broken anchor')
    expect(await brokenAnchorOutput(body, 'param-pagination-has-more')).not.toContain('Broken anchor')
  })

  it('numbers a field after the id an Accordion made from a title written in braces', async () => {
    const body = '<Accordion title={"Param name"}>\n\nText.\n\n</Accordion>\n\n<ParamField body="name">The name.</ParamField>'
    for (const id of ['param-name', 'param-name-accordion-children', 'param-name-1']) expect(await brokenAnchorOutput(body, id), id).not.toContain('Broken anchor')
    expect(await brokenAnchorOutput(body, 'param-name-2')).toContain('Broken anchor')
  })

  it('resolves the id written in braces on a field, and gives the field no other', async () => {
    const body = '<ParamField body="x" id={"mine"}>One.</ParamField>\n\n<ParamField body="y" id={someId}>Two.</ParamField>'
    expect(await brokenAnchorOutput(body, 'mine')).not.toContain('Broken anchor')
    expect(await brokenAnchorOutput(body, 'param-x')).toContain('Broken anchor')
    expect(await brokenAnchorOutput(body, 'param-y')).toContain('Broken anchor')
  })
})

describe('field ids next to a heading that GitHub-flavored Markdown reads', () => {
  it('numbers a field after a heading with a tight strikethrough, which renders as the text between the tildes', async () => {
    const body = '## Param a~b~c\n\n<ParamField body="abc">Text.</ParamField>'
    for (const id of ['param-abc', 'param-abc-1']) expect(await brokenAnchorOutput(body, id), id).not.toContain('Broken anchor')
    expect(await brokenAnchorOutput(body, 'param-a-b-c')).toContain('Broken anchor')
  })

  it('adds the number of a footnote reference to the id of its heading', async () => {
    const body = 'Text[^b].\n\n## Alpha[^a]\n\n[^a]: A.\n\n[^b]: B.'
    expect(await brokenAnchorOutput(body, 'alpha2')).not.toContain('Broken anchor')
    expect(await brokenAnchorOutput(body, 'alpha-a')).toContain('Broken anchor')
  })
})
