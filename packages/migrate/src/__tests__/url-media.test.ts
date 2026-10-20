/** Rendered media projections preserve playback without importing remote markup. */

import { compile } from '@mdx-js/mdx'
import remarkMdx from 'remark-mdx'
import remarkParse from 'remark-parse'
import { unified } from 'unified'
import { describe, expect, it } from 'vitest'

import { htmlPage, sanitizeRemoteMarkdown } from '../url.js'
import { projectMigrationMedia } from '../url-media.js'

const base = new URL('https://docs.test/guide')

describe('rendered media projection', () => {
  it('preserves supported native playback flags, title and poster with literal attributes', async () => {
    const projected = projectMigrationMedia('<video src="/walkthrough.mp4" poster="/cover.png" title="Literal &quot;title&quot; {value}" controls muted autoplay loop playsinline preload="auto" width="100%" height="100%" class="layout"></video>', base)!
    expect(projected).toBe('<Video src="https://docs.test/walkthrough.mp4" controls={true} muted={true} loop={true} playsInline={true} autoPlay={true} poster="https://docs.test/cover.png" title="Literal &quot;title&quot; &#123;value&#125;" />')
    expect(sanitizeRemoteMarkdown(projected)).toBe(projected)
    await compile(projected)
  })

  it('retains extensionless native video semantics and gives playback safe controls', async () => {
    const projected = projectMigrationMedia('<video src="https://attachments.test/assets/opaque-id" aria-label="Recording"></video>', base)!
    expect(projected).toBe('<video src="https://attachments.test/assets/opaque-id" controls={true} title="Recording" />')
    expect(sanitizeRemoteMarkdown(projected)).toBe(projected)
    await compile(projected)
  })

  it('projects rendered publisher videos without copying passive asset provenance', async () => {
    const source = 'https://mintcdn.com/docs/images/exports.mp4?fit=max&auto=format'
    const markup = `<video autoplay="" muted="" loop="" class="mint-w-full mint-aspect-video" src="${source}" data-path="images/exports.mp4" playsinline=""></video>`
    const projected = projectMigrationMedia(markup, base)!
    expect(projected).toBe(`<Video src="https://mintcdn.com/docs/images/exports.mp4?fit=max&amp;auto=format" controls={true} muted={true} loop={true} playsInline={true} autoPlay={true} />`)
    expect(projected).not.toContain('data-path')
    expect(sanitizeRemoteMarkdown(projected)).toBe(projected)
    const page = htmlPage({ body: `<article><h1>Export</h1><p>Export instructions.</p>${markup}</article>`, finalUrl: base, contentType: 'text/html' }, 'export', { omitDocumentHeading: true }).page!
    expect(page.body).toContain(projected)
    await compile(projected)
  })

  it.each([
    'src="javascript:execute()" muted autoplay',
    'src="java&#x73;cript:execute()" muted autoplay',
    'src="data:video/mp4,bad" muted autoplay',
    'src="/clip.mp4" muted autoplay onplay="execute()"',
    'src="/clip.mp4" muted autoplay data-controls="custom"',
    'src="/clip.mp4" autoplay',
  ])('does not let passive publisher metadata relax media checks: %s', attributes => {
    expect(projectMigrationMedia(`<video ${attributes} data-path="images/exports.mp4"></video>`, base)).toBeNull()
  })

  it.each(['www.youtube.com', 'youtube.com', 'www.youtube-nocookie.com', 'youtube-nocookie.com'])('projects a recognized %s embed and removes its sharing token', async (host) => {
    const projected = projectMigrationMedia(`<iframe src="https://${host}/embed/abcdefghijk?si=share-token" title="Walkthrough" width="100%" height="315" allow="accelerometer; clipboard-write" referrerpolicy="strict-origin-when-cross-origin" allowfullscreen></iframe>`, base)!
    expect(projected).toBe('<Video src="https://www.youtube-nocookie.com/embed/abcdefghijk" title="Walkthrough" />')
    expect(sanitizeRemoteMarkdown(projected)).toBe(projected)
    await compile(projected)
  })

  it.each([
    '<video src="javascript:alert(1)"></video>',
    '<video src="java&#x73;cript:alert(1)"></video>',
    '<video src="data:video/mp4,bad"></video>',
    '<video src="https://user:pass@media.test/clip.mp4"></video>',
    '<video src="/clip.mp4" poster="javascript:alert(1)"></video>',
    '<video src="/clip.mp4" onplay="execute()"></video>',
    '<video src="/clip.mp4" style="position:fixed"></video>',
    '<video src="/clip.mp4" autoplay></video>',
    '<video src="/clip.mp4" controlslist="nodownload"></video>',
    '<video><source src="/clip.mp4" type="video/mp4"></video>',
    '<video src="/clip.mp4">Fallback copy must not disappear.</video>',
    '<video src="/clip.mp4"><button>Custom control</button></video>',
    '<iframe src="https://unknown.test/embed/abcdefghijk"></iframe>',
    '<iframe src="http://www.youtube.com/embed/abcdefghijk"></iframe>',
    '<iframe src="https://www.youtube.com:8443/embed/abcdefghijk"></iframe>',
    '<iframe src="https://www.youtube.com.evil.test/embed/abcdefghijk"></iframe>',
    '<iframe src="https://user@www.youtube.com/embed/abcdefghijk"></iframe>',
    '<iframe src="https://www.youtube.com/embed/abcdefghijk?start=30"></iframe>',
    '<iframe src="https://www.youtube.com/embed/abcdefghijk#fragment"></iframe>',
    '<iframe src="https://www.youtube.com/embed/abcdefghijk" srcdoc="&lt;script&gt;execute()&lt;/script&gt;"></iframe>',
    '<iframe src="https://www.youtube.com/embed/abcdefghijk" onload="execute()"></iframe>',
    '<iframe src="https://www.youtube.com/embed/abcdefghijk" sandbox></iframe>',
    '<iframe src="https://www.youtube.com/embed/short"></iframe>',
    '<video src="/clip.mp4"></video><p>Other content</p>',
  ])('keeps unsupported or active media reviewable: %s', (html) => {
    expect(projectMigrationMedia(html, base)).toBeNull()
  })

  it('converts real media while preserving code examples containing media markup', async () => {
    const payload = '<video src="javascript:execute()" onplay="execute()">{literal}</video>'
    const body = `<article><h1>Media</h1><span data-as="p">See the recording.</span><video id="recording" src="/walkthrough.mp4" controls></video><iframe src="https://www.youtube.com/embed/abcdefghijk?si=token" title="Guide"></iframe><pre><code language="html">${payload.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</code></pre></article>`
    const page = htmlPage({ body, finalUrl: base, contentType: 'text/html' }, 'media', { preserveAnchors: true, omitDocumentHeading: true }).page!
    expect(page.body).toContain('<a id="recording" />\n\n<Video src="https://docs.test/walkthrough.mp4" controls={true} />')
    expect(page.body).toContain('<Video src="https://www.youtube-nocookie.com/embed/abcdefghijk" title="Guide" />')
    const clean = page.body.replace(/^<a id="[^"<]*" \/>$/gm, '')
    expect(sanitizeRemoteMarkdown(clean)).toBe(clean)
    const tree = unified().use(remarkParse).use(remarkMdx).parse(page.body)
    expect(tree.children.filter((node) => node.type === 'code')).toEqual([expect.objectContaining({ lang: 'html', value: payload })])
    await compile(page.body)
  })
})

describe('inert native video syntax', () => {
  it.each([
    '<video src="javascript:alert(1)" controls={true} />',
    '<video src="https://user:pass@media.test/clip" controls={true} />',
    '<video src="/clip" poster="data:image/png,bad" controls={true} />',
    '<video src="/clip" controls="true" />',
    '<video src="/clip" controls />',
    '<video src="/clip" controls={execute()} />',
    '<video src="/clip" onplay="execute()" />',
    '<video src="/clip" style="position:fixed" />',
    '<video src="/clip" dangerouslySetInnerHTML={{"__html":"bad"}} />',
    '<video src="/clip"><Note>Unsupported nested content</Note></video>',
  ])('rejects unsafe or unsupported native media attributes: %s', (body) => {
    expect(sanitizeRemoteMarkdown(body)).toBeNull()
  })
})
