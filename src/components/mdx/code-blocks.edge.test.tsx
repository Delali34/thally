/** Render-level hostile cases for code-fence options (SSR markup only). */

import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/components/docs/code-actions-provider', () => ({
  useDocsCodeActions: () => ({
    hasAssistantEntryPoint: false,
    assistantLabel: 'Ask docs',
    canReportCode: true,
    reportCode: vi.fn(),
    askAssistant: vi.fn(),
  }),
}))

import { Code, CodeGroup, Pre } from './code-blocks'

const linesOf = (n: number, trailing = '') => Array.from({ length: n }, (_, i) => `line ${i}`).join('\n') + trailing

const render = (props: Record<string, unknown>, code = 'const a = 1') =>
  renderToStaticMarkup(
    <Pre language="typescript" code={code} {...props}>
      <Code className="language-typescript">{code}</Code>
    </Pre>,
  )

describe('expandable threshold', () => {
  it.each([
    ['9 lines', linesOf(9), false],
    ['exactly 10 lines', linesOf(10), false],
    ['10 lines plus trailing newline', linesOf(10, '\n'), false],
    ['11 lines', linesOf(11), true],
    ['11 lines plus trailing newline', linesOf(11, '\n'), true],
  ])('%s', (_name, code, toggle) => {
    const html = render({ expandable: '' }, code)
    expect(html.includes('aria-expanded="false"')).toBe(toggle)
    expect(html.includes('max-height')).toBe(toggle)
  })

  it('does not collapse without the flag', () => {
    expect(render({}, linesOf(50))).not.toContain('aria-expanded')
  })
})

describe('line numbers', () => {
  it.each([
    ['2-digit minimum for short blocks', linesOf(5), '--thally-line-digits:2'],
    ['3 digits at 100+ lines', linesOf(100), '--thally-line-digits:3'],
    ['4 digits at 1000+ lines', linesOf(1000), '--thally-line-digits:4'],
  ])('%s', (_name, code, expected) => {
    expect(render({ lines: '' }, code)).toContain(expected)
  })

  it('emits no gutter variable without the flag', () => {
    expect(render({}, linesOf(500))).not.toContain('--thally-line-digits')
  })

  it('works together with wrap, expandable and nocopy', () => {
    const html = render({ lines: '', wrap: true, expandable: '', nocopy: '' }, linesOf(20))
    expect(html).toContain('thally-code-lines')
    expect(html).toContain('whitespace-pre-wrap')
    expect(html).toContain('aria-expanded="false"')
    expect(html).not.toContain('Copy code')
  })
})

describe('wrap flag', () => {
  it('applies whitespace-pre-wrap when wrap is empty string', () => {
    expect(render({ wrap: '' })).toContain('whitespace-pre-wrap')
  })

  it('applies whitespace-pre-wrap when wrap is true', () => {
    expect(render({ wrap: true })).toContain('whitespace-pre-wrap')
  })

  it('applies overflow-x-auto by default without wrap', () => {
    expect(render({})).toContain('overflow-x-auto')
    expect(render({})).not.toContain('whitespace-pre-wrap')
  })

  it('applies hanging indent for lines + wrap with empty string flag', () => {
    expect(render({ lines: '', wrap: '' })).toContain('thally-code-hang')
  })

  it('applies hanging indent for lines + wrap with true', () => {
    expect(render({ lines: '', wrap: true })).toContain('thally-code-hang')
  })
})

describe('header crowding', () => {
  it('truncates a very long title instead of pushing the actions off screen', () => {
    const title = 'a-very-long-file-name-'.repeat(20) + '.ts'
    const html = render({ title, tag: 'Next.js', icon: 'code' })
    expect(html).toContain('truncate')
    expect(html).toContain('min-w-0')
    expect(html).toContain(`title="${title}"`)
    expect(html).toContain('Copy code')
  })

  it('escapes hostile titles', () => {
    const html = render({ title: '<img src=x onerror=alert(1)>' })
    expect(html).not.toContain('<img src=x')
  })

  it('ignores unknown and URL icon values without throwing', () => {
    expect(() => render({ icon: 'https://example.com/i.svg', title: 't' })).not.toThrow()
    expect(render({ icon: '../../etc/passwd', title: 't' })).not.toContain('data-icon-name')
    expect(render({ icon: '', title: 't' })).not.toContain('data-icon-name')
  })
})

describe('CodeGroup options', () => {
  const group = renderToStaticMarkup(
    <CodeGroup>
      <Pre language="typescript" code="a" nocopy="" title="one.ts"><Code className="language-typescript">a</Code></Pre>
      <Pre language="python" code="b" title="two.py"><Code className="language-python">b</Code></Pre>
    </CodeGroup>,
  )

  it('hides copy only for the tab that opted out', () => {
    // The first tab is selected on the server render and has nocopy; the hidden
    // second panel is rendered too and keeps its own copy button.
    const [first, second] = group.split('role="tabpanel"').slice(1)
    expect(first).not.toContain('Copy code')
    expect(second).toContain('Copy code')
  })

  it('shows copy when the selected tab has no nocopy', () => {
    const html = renderToStaticMarkup(
      <CodeGroup>
        <Pre language="python" code="b" title="two.py"><Code className="language-python">b</Code></Pre>
        <Pre language="typescript" code="a" nocopy="" title="one.ts"><Code className="language-typescript">a</Code></Pre>
      </CodeGroup>,
    )
    expect(html).toContain('Copy code')
  })
})

describe('expandable defaults and accessibility', () => {
  it('links the toggle to the pre with aria-controls', () => {
    const html = render({ expandable: '' }, linesOf(20))
    const id = /aria-controls="([^"]+)"/.exec(html)?.[1]
    expect(id).toBeTruthy()
    expect(html).toContain(`id="${id}"`)
    expect(html).toContain('thally-code-toggle')
    expect(html).toContain('thally-code-collapsed')
  })

  it('starts expanded when a marked line sits below the collapsed window', () => {
    const html = render({ expandable: '', lastmarked: '15' }, linesOf(20))
    expect(html).toContain('aria-expanded="true"')
    expect(html).toContain('Collapse')
    expect(html).not.toContain('max-height')
    expect(html).not.toContain('thally-code-collapsed')
  })

  it('stays collapsed when marks are inside the window', () => {
    const html = render({ expandable: '', lastmarked: '10' }, linesOf(20))
    expect(html).toContain('aria-expanded="false"')
  })

  it('plain fences get no id, print or toggle markup', () => {
    const html = render({}, linesOf(20))
    expect(html).not.toContain(' id=')
    expect(html).not.toContain('thally-code-toggle')
    expect(html).not.toContain('thally-code-collapsed')
    expect(html).not.toContain('thally-code-lines')
  })

  it('applies hanging indent only for lines + wrap', () => {
    expect(render({ lines: '', wrap: true })).toContain('thally-code-hang')
    expect(render({ lines: '' })).not.toContain('thally-code-hang')
    expect(render({ wrap: true })).not.toContain('thally-code-hang')
  })

  it('tabs each start from their own default (inactive panels unmount, state resets to default)', () => {
    const tab = (lastmarked?: string) => (
      <Pre language="typescript" code={linesOf(20)} expandable="" lastmarked={lastmarked} title={lastmarked ? 'marked.ts' : 'plain.ts'}>
        <Code className="language-typescript">{linesOf(20)}</Code>
      </Pre>
    )
    const first = renderToStaticMarkup(<CodeGroup>{tab()}{tab('15')}</CodeGroup>)
    const second = renderToStaticMarkup(<CodeGroup>{tab('15')}{tab()}</CodeGroup>)
    expect(first).toContain('aria-expanded="false"')
    expect(second).toContain('aria-expanded="true"')
  })
})

describe('round 3 contracts', () => {
  it('caps the collapsed pre at top padding plus exactly 10 line-heights', () => {
    // 1rem padding-top + 10 * (0.84rem * 1.7) = 15.28rem, so line 11 cannot peek through.
    const html = render({ expandable: '' }, linesOf(11))
    expect(html).toMatch(/max-height:15\.28\d*rem/)
  })

  it.each([
    ['99 lines + fence trailing newline', linesOf(99, '\n'), '2'],
    ['100 lines', linesOf(100), '3'],
    ['105 lines + fence trailing newline', linesOf(105, '\n'), '3'],
    ['999 lines + trailing newline', linesOf(999, '\n'), '3'],
    ['1000 lines', linesOf(1000), '4'],
  ])('gutter digits ignore the trailing newline artefact: %s', (_name, code, digits) => {
    expect(render({ lines: '' }, code)).toContain(`--thally-line-digits:${digits}`)
  })

  it('counts a trailing newline as no line for the expandable threshold', () => {
    expect(render({ expandable: '' }, linesOf(10, '\n'))).not.toContain('aria-expanded')
  })

  it('gives the toggle an inset focus-visible ring (an outer ring is clipped by the panel)', () => {
    const html = render({ expandable: '' }, linesOf(20))
    expect(html).toContain('focus-visible:ring-1')
    expect(html).toContain('focus-visible:ring-inset')
  })
})

describe('globals.css code-fence contract', () => {
  const css = readFileSync(new URL('../../app/globals.css', import.meta.url), 'utf8')

  it('does not number the trailing empty line span', () => {
    expect(css).toContain('.thally-code-lines code > span:last-child:empty::before')
  })

  it('fades collapsed blocks and prints them in full', () => {
    expect(css).toMatch(/\.thally-code-collapsed \{[^}]*mask-image: linear-gradient/)
    expect(css).toMatch(/@media print \{[\s\S]*\.thally-code-collapsed[\s\S]*mask-image: none/)
  })

  it('marks diff lines with a non-colour +/- glyph that cannot shift code', () => {
    expect(css).toMatch(/\.thally-line-add::after \{[^}]*content: '\+'/)
    expect(css).toMatch(/\.thally-line-remove::after \{[^}]*content: '\\2212'/)
    expect(css).toMatch(/\.thally-line-add::after,\s*\.thally-line-remove::after \{[^}]*position: absolute/)
    expect(css).toMatch(/\.thally-line-add::after,\s*\.thally-line-remove::after \{[^}]*text-indent: 0/)
  })
})
