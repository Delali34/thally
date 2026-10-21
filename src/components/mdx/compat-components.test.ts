/** Focused compatibility contracts for page-scoped and legacy MDX components. */

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { InlineUpdateFilters, PagePanelSlot, PageSlotsProvider, UpdateFilterControls } from '@/components/mdx/page-slots'
import { Panel, InlinePanel } from '@/components/mdx/panel'
import { Pre, CodeBlock } from '@/components/mdx/code-blocks'
import { RequestExample, ResponseExample } from '@/components/mdx/examples'
import { Prompt, TerminalInput, TerminalOutput } from '@/components/mdx/prompt'
import { Embed, View } from '@/components/mdx/view'

describe('semantic compatibility components', () => {
  it('keeps canonical Panel content in the authored server output', () => {
    const markup = renderToStaticMarkup(
      createElement(PageSlotsProvider, null,
        createElement('main', null,
          createElement(Panel, null, createElement('p', null, 'Contextual example')),
          createElement(PagePanelSlot, {
            fallback: createElement('span', null, 'On this page'),
            footer: createElement(
              'div',
              null,
              createElement('a', { href: '/edit' }, 'Edit this page'),
              createElement('a', { href: '/issues/new' }, 'Report an issue'),
            ),
          }),
        ),
      ),
    )
    expect(markup).toContain('Contextual example')
    expect(markup).toContain('On this page')
    expect(markup).toContain('Edit this page')
    expect(markup).toContain('Report an issue')
  })

  it('preserves the explicit inline panel alias', () => {
    const markup = renderToStaticMarkup(createElement(InlinePanel, { title: 'Configuration' }, 'Set the key.'))
    expect(markup).toContain('Configuration')
    expect(markup).toContain('Set the key.')
  })

  it('renders request and response examples with optional selection', () => {
    const request = renderToStaticMarkup(createElement(RequestExample, {
      dropdown: true,
    }, [
        createElement('pre', { key: 'curl', title: 'cURL' }, 'curl /projects'),
        createElement('pre', { key: 'node', title: 'Node.js' }, 'client.projects.list()'),
      ]))
    const response = renderToStaticMarkup(createElement(ResponseExample, null, createElement('pre', null, '{}')))
    expect(request).toContain('aria-label="Request example"')
    expect(request).toContain('cURL')
    expect(response).toContain('Response')
  })

  it('keeps natural language labels when request fences have no authored titles', () => {
    const request = renderToStaticMarkup(createElement(RequestExample, null, [
      createElement(Pre, { key: 'python', language: 'python', code: 'requests.get(url)' }, createElement('code', { className: 'language-python' }, 'requests.get(url)')),
      createElement(Pre, { key: 'go', language: 'go', code: 'http.Get(url)' }, createElement('code', { className: 'language-go' }, 'http.Get(url)')),
    ]))
    expect(request).toContain('Python')
    expect(request).not.toContain('Example 1')
    const nested = renderToStaticMarkup(createElement(RequestExample, null, [
      createElement('pre', { key: 'python' }, createElement('code', { className: 'language-python' }, 'requests.get(url)')),
      createElement('pre', { key: 'ruby' }, createElement('code', { className: 'language-ruby' }, 'Net::HTTP.get(uri)')),
    ]))
    expect(nested).toContain('Python')
    expect(nested).not.toContain('Example 1')
  })

  it('uses CodeBlock filenames as request and response labels and numbers example lines', () => {
    const request = renderToStaticMarkup(createElement(RequestExample, null, [
      createElement(CodeBlock, { key: 'curl', filename: 'cURL', language: 'bash' }, 'curl /pages'),
      createElement(CodeBlock, { key: 'python', filename: 'Python', language: 'python' }, 'requests.get(url)'),
    ]))
    const response = renderToStaticMarkup(createElement(ResponseExample, null, [
      createElement(CodeBlock, { key: '201', filename: '201', language: 'json' }, '{"title":"A page"}'),
      createElement(CodeBlock, { key: '400', filename: '400', language: 'json' }, '{"error":"Invalid title"}'),
    ]))
    expect(request).toContain('cURL')
    expect(request).not.toContain('Example 1')
    expect(request).toContain('thally-code-lines')
    expect(response).toContain('>201</button>')
    expect(response).toContain('>400</button>')
    expect(response).not.toContain('Example 1')
    expect(response).toContain('thally-code-lines')
  })

  it('renders canonical prompt actions and preserves bare legacy Prompt terminals', () => {
    const canonical = renderToStaticMarkup(createElement(Prompt, {
      description: 'Add API examples', actions: ['copy', 'cursor'],
    }, 'Add one cURL example.'))
    const legacy = renderToStaticMarkup(createElement(Prompt, null,
      createElement(TerminalInput, null, 'npm run build'),
      createElement(TerminalOutput, null, 'Build completed.'),
    ))
    expect(canonical).toContain('Copy prompt')
    expect(canonical).toContain('cursor://')
    expect(legacy).toContain('npm run build')
    expect(legacy).toContain('Build completed.')
  })

  it('keeps all View content in SSR and rejects unsafe legacy embeds', () => {
    const views = renderToStaticMarkup(createElement(PageSlotsProvider, null,
      createElement(View, { title: 'Node.js' }, 'npm install'),
      createElement(View, { title: 'Python' }, 'pip install'),
    ))
    const unsafeEmbed = renderToStaticMarkup(createElement(Embed, { src: 'javascript:alert(1)' }))
    expect(views).toContain('npm install')
    expect(views).toContain('pip install')
    expect(unsafeEmbed).toBe('')
  })
})

describe('changelog filter controls', () => {
  const props = {
    tagCounts: { API: 2, Models: 1 },
    selectedTags: ['API'],
    updateShown: 2,
    updateTotal: 3,
    onToggle: () => {},
    onClear: () => {},
  }

  it('shows chips, the pressed state, and a clear button while a filter is active', () => {
    const html = renderToStaticMarkup(createElement(UpdateFilterControls, props))
    expect(html).toContain('aria-pressed="true"')
    expect(html).toContain('aria-pressed="false"')
    expect(html).toContain('Clear')
    expect(html).toContain('Showing 2 of 3 updates')
  })

  it('omits the clear button when nothing is selected', () => {
    expect(renderToStaticMarkup(createElement(UpdateFilterControls, { ...props, selectedTags: [] }))).not.toContain('Clear')
  })

  it('renders the inline copy only when the detail column does not carry the filters', () => {
    const render = (railVisible: boolean) => renderToStaticMarkup(createElement(PageSlotsProvider, null, createElement(InlineUpdateFilters, { railVisible })))
    // no tagged updates registered on the server: nothing to show either way
    expect(render(true)).toBe('')
    expect(render(false)).toBe('')
  })
})
