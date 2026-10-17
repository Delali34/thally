/** Exercise the published pipeline with external-memory accounting, not a cache mock. */
import { runUrlMigration } from '../../../dist/url-migration.js'

const aliases = 64
const size = 128 * 1024
const signature = Buffer.from('iVBORw0KGgo=', 'base64')
const retainedBytes = () => { global.gc(); return process.memoryUsage().arrayBuffers }
const baseline = retainedBytes()
let freshRetainedBytes = 0
let resumedRetainedBytes = 0
const sourceUrl = 'https://docs.test/p0'
const capture = async ({ url }) => {
  if (url.pathname === '/p0') return { finalUrl: url, contentType: 'text/html', body: `<article><h1>Aliases</h1>${Array.from({ length: aliases }, (_, index) => `<img src="/a${index}.png">`).join('')}<a href="/p1">Next</a></article>` }
  if (url.pathname === '/p1') return { finalUrl: url, contentType: 'text/html', body: '<article><h1>Next</h1><p>Retained migration cache remains live here.</p></article>' }
  throw new Error('404')
}
const first = await runUrlMigration({ sourceUrl, maxCaptures: 1, concurrency: 1, captureProvider: { capture }, assetFetcher: async (url) => {
  const content = Buffer.alloc(size)
  signature.copy(content)
  return { url: url.href, contentType: 'image/png', content }
}, onRecord: async (record) => {
  if (record.page) freshRetainedBytes = retainedBytes() - baseline
} })
const resumeBaseline = retainedBytes()
const resumed = await runUrlMigration({ sourceUrl, concurrency: 1, checkpoint: JSON.parse(JSON.stringify(first.checkpoint)), captureProvider: { capture: async (request) => {
  resumedRetainedBytes = Math.max(resumedRetainedBytes, retainedBytes() - resumeBaseline)
  return capture(request)
} }, assetFetcher: async () => { throw new Error('Committed aliases must not be fetched again') } })
console.log(JSON.stringify({ aliases, assets: resumed.bundle.assets.length, status: resumed.validation.status, freshRetainedBytes, resumedRetainedBytes }))
