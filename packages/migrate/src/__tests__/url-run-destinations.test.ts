/** Concrete destination spans keep escaped URLs local without changing examples or labels. */
import { describe, expect, it } from 'vitest'
import remarkParse from 'remark-parse'
import { unified } from 'unified'
import { runUrlMigration } from '../url-run.js'

describe('URL migration Markdown destination localization', () => {
  it('localizes escaped and entity destinations while preserving matching titles, labels and code', async () => {
    const url = 'https://docs.test/image.png?a=1&b=2'
    const escaped = url.replace('&', '\\&')
    const source = [
      '# Guide', '', 'Original documentation prose.', '',
      `![${url}](${escaped} "${url}")`, '',
      `![Reference][image]`, '', `[image]: <${url.replace('&', '&amp;')}> "${url}"`, '',
      '[Next](https://docs.test/next?a=1\\&b=2 "https://docs.test/next?a=1&b=2")', '',
      '```md', `![Example](${escaped})`, '```', '',
    ].join('\n')
    const fetched: string[] = []
    const result = await runUrlMigration({
      sourceUrl: 'https://docs.test/guide',
      captureProvider: { capture: async ({ url: request }) => ({
        finalUrl: request, contentType: 'text/markdown',
        body: request.pathname === '/guide' ? source : '# Next\n\nOriginal destination article.',
      }) },
      assetFetcher: async request => {
        fetched.push(request.href)
        return { url: request.href, contentType: 'image/png', content: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64') }
      },
    })
    expect(result.validation.issues).toEqual([])
    expect(result.validation.status).toBe('passed')
    expect(fetched).toEqual([url])
    const body = result.bundle.pages.find(page => page.id === 'guide')!.body
    const path = `/${result.bundle.assets[0].path}`
    expect(body).toContain(`![${url}](${path} "${url}")`)
    expect(body).toContain(`[image]: <${path}> "${url}"`)
    const next = result.bundle.pages.find(page => page.id !== 'guide')!
    expect(body).toContain(`[Next](/${next.id} "https://docs.test/next?a=1&b=2")`)
    expect(body).toContain(`\`\`\`md\n![Example](${escaped})\n\`\`\``)
  })

  it('rejects previously hashed conversions after destination rules change', async () => {
    const sourceUrl = 'https://docs.test/guide'
    await expect(runUrlMigration({ sourceUrl,
      checkpoint: { schemaVersion: 1, converterVersion: 'url-evidence-v6', captureVersion: 'default', sourceUrl, scopePath: '/', records: [], navigation: [] },
      captureProvider: { capture: async () => { throw new Error('Must reject before capture') } },
    })).rejects.toThrow('Checkpoint does not match')
  })

  it.each([false, true])('preserves punctuation and literal entity text in image fragments (angle destination: %s)', async angle => {
    const destination = '/image.png#figure\\)\\&copy;'
    const result = await runUrlMigration({ sourceUrl: 'https://docs.test/guide',
      captureProvider: { capture: async ({ url }) => ({ finalUrl: url, contentType: 'text/markdown',
        body: `# Guide\n\nOriginal prose.\n\n![Figure](${angle ? `<${destination}>` : destination})`,
      }) },
      assetFetcher: async url => ({ url: url.href, contentType: 'image/png', content: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64') }),
    })
    expect(result.validation.status).toBe('passed')
    const tree = unified().use(remarkParse).parse(result.bundle.pages[0].body)
    const paragraph = tree.children.find(node => node.type === 'paragraph' && node.children.some(child => child.type === 'image'))!
    expect(paragraph).toMatchObject({ children: [{ type: 'image', url: `/${result.bundle.assets[0].path}#figure)&copy;` }] })
    if (paragraph.type === 'paragraph') expect(paragraph.children).toHaveLength(1)
  })
})
