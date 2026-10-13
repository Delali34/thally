/**
 * Qualify the native browser API against a running documentation site.
 * Uses an isolated Chrome profile and CDP, never the maintainer's browser session.
 * Run after the production build: tsx scripts/smoke-webmcp.mts --chrome=/path/to/chrome --url=http://localhost:3141
 */
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'

// The runtime package is CommonJS at the package boundary; tsx resolves this
// shared TypeScript registry through require without duplicating tool names.
const require = createRequire(import.meta.url)
const { toolMetadata } = require('../src/lib/mcp/tool-metadata.ts') as typeof import('../src/lib/mcp/tool-metadata')
const { webMcpToolMetadata } = require('../src/lib/mcp/web-mcp-metadata.ts') as typeof import('../src/lib/mcp/web-mcp-metadata')

const chromePath = process.argv.find((arg) => arg.startsWith('--chrome='))?.slice(9)
const siteUrl = process.argv.find((arg) => arg.startsWith('--url='))?.slice(6)
if (!chromePath || !siteUrl) throw new Error('Provide --chrome=/path/to/chrome and --url=http://localhost:3141.')
const origin = new URL(siteUrl).origin
const profile = await mkdtemp(join(tmpdir(), 'thally-webmcp-chrome-'))
const chrome = spawn(chromePath, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--enable-features=WebMCP,WebMCPTesting,DevToolsWebMCPSupport', `${origin}/quickstart`], { stdio: 'ignore' })
let socket: WebSocket | undefined
let sequence = 0
const requests = new Map<number, { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }>()
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Send a bounded CDP command; failed browser commands must fail qualification. */
async function command(method: string, params: Record<string, unknown> = {}) {
  const id = ++sequence
  const response = new Promise<Record<string, unknown>>((resolve, reject) => {
    requests.set(id, { resolve, reject })
    socket!.send(JSON.stringify({ id, method, params }))
  })
  return Promise.race([response, pause(15000).then(() => { throw new Error(`CDP command timed out: ${method}`) })])
}

/** Evaluate and await the real browser API, returning only JSON-safe evidence. */
async function evaluate(expression: string) {
  const result = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
  return (result.result as { value?: unknown }).value
}

try {
  let port = ''
  for (let attempt = 0; attempt < 150 && !port; attempt++) {
    try { port = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0] } catch { await pause(100) }
  }
  if (!port) throw new Error('Chrome did not start a debugging endpoint.')
  const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json()) as Array<{ type: string; webSocketDebuggerUrl: string }>
  const target = targets.find((item) => item.type === 'page')
  if (!target) throw new Error('Chrome did not create a page target.')
  socket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise<void>((resolve, reject) => { socket!.addEventListener('open', () => resolve(), { once: true }); socket!.addEventListener('error', () => reject(new Error('CDP connection failed.')), { once: true }) })
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data))
    const pending = requests.get(message.id)
    if (!pending) return
    requests.delete(message.id)
    if (message.error) pending.reject(new Error(JSON.stringify(message.error)))
    else pending.resolve(message.result ?? {})
  })
  let names: Array<string> = []
  for (let attempt = 0; attempt < 150; attempt++) {
    names = await evaluate('(async()=>document.modelContext ? (await document.modelContext.getTools()).map(t=>t.name) : [])()') as Array<string>
    if (names.length === webMcpToolMetadata.length) break
    await pause(100)
  }
  const expected = webMcpToolMetadata.map((tool) => tool.name).sort()
  if (JSON.stringify(names.sort()) !== JSON.stringify(expected)) throw new Error(`Native registration mismatch: ${JSON.stringify(names)}`)
  const call = async (name: string, args: Record<string, unknown>) => {
    // Pass fetched page identities as CDP values, never as executable source.
    // Resolve the context for each call because navigation replaces the document.
    const context = await command('Runtime.evaluate', { expression: 'document.modelContext' })
    if (context.exceptionDetails) throw new Error(JSON.stringify(context.exceptionDetails))
    const objectId = (context.result as { objectId?: string }).objectId
    if (!objectId) throw new Error('Native model context is unavailable.')
    const response = await command('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: 'async function(name, args) { const tool = (await this.getTools()).find(tool => tool.name === name); return await this.executeTool(tool, args); }',
      arguments: [{ value: name }, { value: args }],
      awaitPromise: true,
      returnByValue: true,
    })
    if (response.exceptionDetails) throw new Error(JSON.stringify(response.exceptionDetails))
    const raw = (response.result as { value?: unknown }).value
    const result = typeof raw === 'string' ? JSON.parse(raw) : raw
    if (!result || (result as { isError?: boolean }).isError) throw new Error(`Native tool failed: ${name} ${JSON.stringify(result)}`)
    return result as Record<string, unknown>
  }
  const index = await fetch(`${origin}/api/docs-index`).then((response) => response.json()) as { pages: Array<{ type: string; id: string; url: string }> }
  const generated = index.pages.find((page) => page.type === 'api_operation')
  const results: Record<string, unknown> = {}
  for (const tool of toolMetadata) {
    const args = ['search_docs', 'search_sections'].includes(tool.name) ? { query: 'documentation', limit: 3, locale: 'en' } : tool.name === 'read_page' ? { pageId: 'quickstart', locale: 'en' } : tool.name === 'get_api_operation' ? { operationId: generated?.id } : tool.name === 'list_pages' ? { locale: 'en' } : tool.name === 'list_api_operations' ? { query: 'posts', tag: 'Posts', limit: 3 } : tool.name === 'list_changes' ? { since: '2020-01-01', limit: 3, locale: 'en' } : {}
    const result = await call(tool.name, args)
    if (!result.structuredContent) throw new Error(`Missing structuredContent: ${tool.name}`)
    results[tool.name] = { passed: true, contentItems: (result.content as Array<unknown>).length, structured: true }
  }
  const operation = await call('get_api_operation', { operationId: generated?.id })
  const operationDetail = operation.structuredContent as { method: string; path: string }
  await call('get_api_operation', { method: operationDetail.method, path: operationDetail.path })
  const current = await call('get_current_page', {})
  if (current.pageId !== 'quickstart') throw new Error('Current page did not resolve quickstart.')
  const navigation = await call('navigate_to_page', { pageId: 'api/overview', locale: 'en' })
  if (navigation.status !== 'navigation_started') throw new Error('Navigation did not start.')
  for (let attempt = 0; attempt < 150; attempt++) {
    if (await evaluate('location.pathname') === '/api/overview') break
    await pause(100)
  }
  const destination = await call('get_current_page', {})
  if (destination.pageId !== 'api/overview') throw new Error('Current page remained stale after client navigation.')
  const roots: Array<string> = []
  for (const path of ['/', '/es']) {
    await command('Page.navigate', { url: `${origin}${path}` })
    for (let attempt = 0; attempt < 150; attempt++) {
      const ready = await evaluate('(async()=>document.modelContext ? (await document.modelContext.getTools()).length : 0)()')
      if (ready === expected.length && await evaluate('location.pathname') === path) break
      await pause(100)
    }
    const home = await call('get_current_page', {})
    if (home.pageId !== 'introduction') throw new Error(`Homepage context failed: ${path}`)
    roots.push(path)
  }
  let generatedPage: unknown = null
  if (generated) {
    await call('navigate_to_page', { pageId: new URL(generated.url).pathname, locale: 'en' })
    for (let attempt = 0; attempt < 150; attempt++) {
      if (await evaluate('location.pathname') === new URL(generated.url).pathname) break
      await pause(100)
    }
    const page = await call('get_current_page', {})
    if (!page.openapi) throw new Error('Generated API page has no operation context.')
    generatedPage = page.pageId
    const alias = new URL(generated.url).pathname.replace('/api/default/', '/api/')
    await command('Page.navigate', { url: `${origin}/es${alias}` })
    for (let attempt = 0; attempt < 150; attempt++) {
      if (await evaluate('(async()=>document.modelContext ? (await document.modelContext.getTools()).length : 0)()') === expected.length && await evaluate('location.pathname') === `/es${alias}`) break
      await pause(100)
    }
    const localizedOperation = await call('get_current_page', {})
    if (localizedOperation.pageId !== page.pageId || localizedOperation.viewLocale !== 'es') throw new Error('Localized operation alias failed.')
  }
  console.log(JSON.stringify({ browser: await evaluate('navigator.userAgent'), registeredTools: names, siteTools: results, currentPage: current.pageId, destinationPage: destination.pageId, homepages: roots, generatedPage }, null, 2))
} finally {
  socket?.close()
  chrome.kill('SIGTERM')
  await pause(300)
  await rm(profile, { recursive: true, force: true })
}
