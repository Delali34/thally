/** Unknown lazy ARIA disclosures block publication rather than silently dropping authored content. */
import { describe, expect, it } from 'vitest'
import { runUrlMigration } from '../url-run.js'

async function migrate(content: string) {
  return runUrlMigration({ sourceUrl: 'https://docs.example.test/guide', assetFetcher: async url => ({ url: url.href, contentType: 'image/png', content: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1i8AAAAASUVORK5CYII=', 'base64') }), captureProvider: { capture: async ({ url }) => {
    if (url.pathname !== '/guide') throw new Error('Missing discovery index')
    return { finalUrl: url, contentType: 'text/html', body: `<article><h1>Guide</h1><p>Complete introductory technical content.</p>${content}</article>` }
  } } })
}
const control = '<h2><button id="toggle" aria-expanded="false" aria-controls="panel">More details</button></h2>'

describe('closed ARIA disclosure completeness', () => {
  it.each([
    `${control}<div id="panel" role="region" aria-labelledby="toggle"></div>`,
    `${control}<div id="panel" aria-labelledby="toggle">Populated but unprojected content</div>`,
    '<button aria-expanded="false">Required hidden instructions</button>',
    '<div class="code-group"><div data-component-part="code-group-tab-bar"><button aria-expanded="false" aria-haspopup="menu">TypeScript</button></div><pre data-language="typescript"><code>visible()</code></pre></div>',
    control,
    control.replace('aria-expanded="false"', 'aria-expanded="true"'),
    `${control}<div id="panel">First</div><div id="panel">Second</div>`,
    `${control}<div id="panel" aria-busy="true">Loading</div>`,
    `${control}<div id="panel" aria-labelledby="different">Unrelated content</div>`,
    `<section>${control}</section><section><div id="panel">Other section content</div></section>`,
    `${control}<span id="toggle">Duplicate control ID</span><div id="panel" role="region" aria-labelledby="toggle" hidden>Captured content</div>`,
    '<div role="tablist"><button id="same" role="tab" aria-controls="one">Required first tab label</button><button id="same" role="tab" aria-controls="two">Required second tab label</button></div><div id="one" role="tabpanel" aria-labelledby="same">First content</div><div id="two" role="tabpanel" aria-labelledby="same">Second content</div>',
  ])('keeps missing, empty, duplicate, busy or unrelated controlled regions in review', async content => {
    const result = await migrate(content)
    expect(result.validation.status).toBe('partial')
    expect(result.validation.issues.some(issue => issue.code === 'unsupported-component')).toBe(true)
  })

  it('recognizes only icon-only page-action menus in the existing copy-action header contract', async () => {
    const action = '<div id="page-context-menu"><button id="page-context-menu-button">Copy page</button><button aria-expanded="false" aria-haspopup="menu" aria-label="More actions"><svg aria-hidden="true"></svg></button></div>'
    expect((await migrate('<header>' + action + '</header>')).validation.status).toBe('passed')
    expect((await migrate(action)).validation.status).toBe('partial')
    expect((await migrate('<header>' + action.replace('aria-label="More actions"><svg', 'aria-label="More actions">Uncaptured article alternatives<svg') + '</header>')).validation.status).toBe('partial')
  })

  it('recognizes image zoom only beside its already captured image wrapper', async () => {
    const wrapper = '<span class="zoom-image-trigger" data-ramka-trigger><picture><img src="https://docs.example.test/image.png" alt="Authored diagram"></picture></span>'
    const button = '<button data-ramka-trigger aria-haspopup="dialog" aria-expanded="false" aria-label="Expand image"></button>'
        const good = await migrate(wrapper + button)
    expect(good.validation.status).toBe('passed')
    expect(good.bundle.pages[0].body).toContain('Authored diagram')
    expect((await migrate('<span class="zoom-image-trigger" data-ramka-trigger>' + wrapper + button + '</span>' + button)).validation.status).toBe('passed')
    expect((await migrate((wrapper + button).replace('aria-label="Expand image"', 'aria-label="展开图像"'))).validation.status).toBe('passed')
    for (const content of [button, wrapper + '<p>Unrelated content</p>' + button, wrapper + button.replace('></button>', '>Unseen explanation</button>')]) {
      expect((await migrate(content)).validation.issues.some(issue => issue.code === 'unsupported-component')).toBe(true)
    }
  })
  it('preserves loaded native expandable panels without borrowing an unrelated region', async () => {
    const result = await migrate('<details><summary aria-expanded="false" aria-controls="loaded"><p>Original native label</p></summary><div id="loaded" data-component-part="expandable-content"><p>Original loaded content.</p></div></details>')
    expect(result.validation.status).toBe('passed')
    expect(result.bundle.pages[0].body).toContain('Original native label')
    expect(result.bundle.pages[0].body).toContain('Original loaded content.')
  })

  it('preserves a fully captured exact local region', async () => {
    const result = await migrate(`${control}<div id="panel" role="region" aria-labelledby="toggle" hidden><p>Original authored expanded content.</p><pre><code>complete()</code></pre></div>`)
    expect(result.validation.status).toBe('passed')
    expect(result.bundle.pages[0].body).toContain('Original authored expanded content.')
    expect(result.bundle.pages[0].body).toContain('complete()')
  })

  it('preserves a loaded native details region labelled by its summary descendant', async () => {
    const result = await migrate('<details><summary aria-expanded="false" aria-controls="native-panel"><p id="native-title">Original native heading</p></summary><div id="native-panel" role="region" aria-labelledby="native-title"><p>Original native content.</p><pre><code>native()</code></pre></div></details>')
    expect(result.validation.status).toBe('passed')
    expect(result.bundle.pages[0].body).toContain('Original native heading')
    expect(result.bundle.pages[0].body).toContain('Original native content.')
    expect(result.bundle.pages[0].body).toContain('native()')
  })
})


describe('alternative state completeness', () => {
  it.each([
    '<div role="tablist"><button id="tab" role="tab" aria-controls="missing">Unknown tab</button></div>',
    '<details><summary>Unknown article alternatives</summary></details>',
    '<button aria-expanded="false" aria-controls="missing">Unknown disclosure</button>',
  ])('does not let an unrelated state excuse missing base content', async content => {
    const result = await runUrlMigration({ sourceUrl: 'https://docs.example.test/guide', captureProvider: { capture: async ({ url }) => {
      if (url.pathname !== '/guide') throw new Error('Missing index')
      return { finalUrl: url, contentType: 'text/html', body: `<article><h1>Guide</h1><p>Intro</p>${content}</article>`, states: [{ id: 'unrelated', label: 'Unrelated', response: { finalUrl: url, contentType: 'text/html', body: '<article><h1>Guide</h1><p>Unrelated state prose.</p></article>' } }] }
    } } })
    expect(result.validation.status).toBe('partial')
    expect(result.validation.issues.some(issue => issue.code === 'unsupported-component')).toBe(true)
  })
  it.each(['<form><input name="unrepresented"></form>', '<button aria-expanded="false" aria-controls="missing">Unknown state content</button>'])('checks unsupported alternatives themselves', async content => {
    const result = await runUrlMigration({ sourceUrl: 'https://docs.example.test/guide', captureProvider: { capture: async ({ url }) => {
      if (url.pathname !== '/guide') throw new Error('Missing index')
      return { finalUrl: url, contentType: 'text/html', body: '<article><h1>Guide</h1><p>Intro</p></article>', states: [{ id: 'other', label: 'Other', response: { finalUrl: url, contentType: 'text/html', body: `<article><h1>Guide</h1><p>Other prose</p>${content}</article>` } }] }
    } } })
    expect(result.validation.status).toBe('partial')
    expect(result.validation.issues.some(issue => issue.code === 'unsupported-component')).toBe(true)
  })
})
