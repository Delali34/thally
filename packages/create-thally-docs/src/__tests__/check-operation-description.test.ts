/** An API page with no description of its own is described by its operation, as the site renders it; `thally check` warns only when neither has one. */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { runCheck } from '../check.js'

const MISSING = 'Missing "description" in frontmatter'

/** The `thally check` output for a project with one API page bound to `GET /status` of the given operation body. */
async function check(options: { operation: string; pageDescription?: string; overrides?: unknown; spec?: boolean; reference?: string; hiddenTab?: boolean; other?: string }): Promise<string> {
  const projectDir = mkdtempSync(join(tmpdir(), 'thally-check-operation-description-'))
  mkdirSync(join(projectDir, 'src/content/api'), { recursive: true })
  mkdirSync(join(projectDir, 'openapi'), { recursive: true })
  // A spec referenced only from page frontmatter lives in a hidden tab, beside the visible tab of another spec.
  const specTab = { api: { source: 'openapi/api.yaml', navigation: false, ...(options.overrides ? { overrides: options.overrides } : {}) } }
  writeFileSync(join(projectDir, 'docs.json'), JSON.stringify({
    tabs: options.hiddenTab
      ? [
          { tab: 'API', api: { source: 'openapi/other.yaml', navigation: false }, groups: [{ group: 'Status', pages: ['api/status'] }] },
          { tab: 'Spec', hidden: true, ...specTab },
        ]
      : [{ tab: 'API', ...(options.spec === false ? {} : specTab), groups: [{ group: 'Status', pages: ['api/status'] }] }],
  }))
  writeFileSync(join(projectDir, 'openapi/other.yaml'), `openapi: 3.0.0\ninfo:\n  title: Other\n  version: 1.0.0\npaths:${options.other ? `\n${options.other}` : ' {}'}\n`)
  writeFileSync(join(projectDir, 'src/content/api/status.mdx'), [
    '---',
    'title: Get status',
    ...(options.pageDescription ? [`description: ${options.pageDescription}`] : []),
    `openapi: ${options.reference ?? 'openapi/api.yaml GET /status'}`,
    '---',
    '',
  ].join('\n'))
  writeFileSync(join(projectDir, 'openapi/api.yaml'), [
    'openapi: 3.0.0',
    'info:',
    '  title: Service API',
    '  version: 1.0.0',
    'paths:',
    '  /status:',
    '    get:',
    ...options.operation.split('\n').map((line) => `      ${line}`),
    '      responses:',
    "        '200':",
    '          description: Available',
    'webhooks:',
    '  status.changed:',
    '    post:',
    ...options.operation.split('\n').map((line) => `      ${line}`),
    '      responses:',
    "        '200':",
    '          description: Received',
  ].join('\n'))
  const output: Array<string> = []
  const log = vi.spyOn(console, 'log').mockImplementation((value) => output.push(String(value)))
  try {
    await runCheck(projectDir, { fix: false, ci: true })
  } finally {
    log.mockRestore()
  }
  return output.join('\n')
}

describe('thally check Missing description on OpenAPI pages', () => {
  it('does not warn when the operation has a description, which the site shows', async () => {
    expect(await check({ operation: 'description: Returns the service status.' })).not.toContain(MISSING)
  })

  it('reads the summary as the description when the operation has no description, as the site does', async () => {
    expect(await check({ operation: 'summary: Get status' })).not.toContain(MISSING)
  })

  it('reads an override description for the operation', async () => {
    expect(await check({ operation: 'operationId: getStatus', overrides: { 'GET /status': { description: 'Overridden.' } } })).not.toContain(MISSING)
  })

  it('warns when neither the page nor the operation has a description', async () => {
    expect(await check({ operation: 'operationId: getStatus' })).toContain(MISSING)
    expect(await check({ operation: 'description: ""\nsummary: Ignored, the empty description wins' })).toContain(MISSING)
  })

  it('warns when the operation cannot be read, and when there is no API spec to read it from', async () => {
    expect(await check({ operation: 'description: Returns the service status.', reference: 'openapi/api.yaml GET /missing' })).toContain(MISSING)
    expect(await check({ operation: 'description: Returns the service status.', spec: false })).toContain(MISSING)
  })

  it('reads the operation from a spec that only a hidden tab binds, as the site does', async () => {
    expect(await check({ operation: 'description: Returns the service status.', hiddenTab: true })).not.toContain(MISSING)
    expect(await check({ operation: 'operationId: getStatus', hiddenTab: true })).toContain(MISSING)
  })

  it('reads the first spec that lists the operation, not a later spec that describes it', async () => {
    const undescribed = '  /status:\n    get:\n      operationId: otherStatus\n      responses:\n        \'200\':\n          description: Available'
    const operation = 'description: Returns the service status.'
    // The visible tab's spec is the default; the hidden tab's spec comes after it.
    expect(await check({ operation, hiddenTab: true, other: undescribed, reference: 'GET /status' })).toContain(MISSING)
    expect(await check({ operation, hiddenTab: true, reference: 'GET /status' })).not.toContain(MISSING)
    expect(await check({ operation, hiddenTab: true, other: undescribed, reference: 'openapi/api.yaml GET /status' })).not.toContain(MISSING)
  })

  it('leaves a page with its own description alone', async () => {
    expect(await check({ operation: 'operationId: getStatus', pageDescription: 'Own description.' })).not.toContain(MISSING)
  })

  it('reads a webhook page by its operation too', async () => {
    expect(await check({ operation: 'description: Sent when the status changes.', reference: 'openapi/api.yaml webhook status.changed' })).not.toContain(MISSING)
    expect(await check({ operation: 'operationId: statusChanged', reference: 'openapi/api.yaml webhook status.changed' })).toContain(MISSING)
  })
})
