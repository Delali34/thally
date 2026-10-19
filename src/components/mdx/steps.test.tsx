import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { Step, Steps } from './steps'

describe('Step title element', () => {
  it('stays an h3 by default so native sites are unchanged', () => {
    const html = renderToStaticMarkup(<Steps><Step title="One" /></Steps>)
    expect(html).toMatch(/<h3 [^>]*>One<\/h3>/)
  })

  it('renders a non-heading paragraph for titleSize="p", set on Steps or on a Step', () => {
    for (const html of [
      renderToStaticMarkup(<Steps titleSize="p"><Step title="One" /></Steps>),
      renderToStaticMarkup(<Steps><Step title="One" titleSize="p" /></Steps>),
    ]) {
      expect(html).toMatch(/<p [^>]*>One<\/p>/)
      expect(html).not.toMatch(/<h[1-6]/)
    }
  })

  it('renders h2 and h4, and a Step keeps its own size over Steps', () => {
    expect(renderToStaticMarkup(<Steps titleSize="h2"><Step title="One" /></Steps>)).toMatch(/<h2 [^>]*>One<\/h2>/)
    const html = renderToStaticMarkup(<Steps titleSize="p"><Step title="A" titleSize="h4" /><Step title="B" /></Steps>)
    expect(html).toMatch(/<h4 [^>]*>A<\/h4>/)
    expect(html).toMatch(/<p [^>]*>B<\/p>/)
  })

  it('gives non-Step children no titleSize prop and lets a Step nested in a wrapper inherit', () => {
    const html = renderToStaticMarkup(
      <Steps titleSize="p"><p>plain</p><div><Step title="Nested" /></div></Steps>,
    )
    expect(html).not.toContain('titleSize')
    expect(html).not.toContain('titlesize')
    expect(html).toContain('<p>plain</p>')
    expect(html).toMatch(/<p [^>]*>Nested<\/p>/)
  })

  it('has no data-heading marker unless the page registered the title as a heading', () => {
    expect(renderToStaticMarkup(<Steps><Step title="One" /></Steps>)).not.toContain('data-heading')
    expect(renderToStaticMarkup(<Steps titleSize="h3"><Step title="One" /></Steps>)).not.toContain('data-heading')
  })

  it('marks a registered heading title with its id and level for the table of contents', () => {
    const html = renderToStaticMarkup(<Steps titleSize="h3"><Step title="Create a project" id="create-a-project" /></Steps>)
    expect(html).toMatch(/<h3 [^>]*\bid="create-a-project"[^>]*>Create a project<\/h3>/)
    expect(html).toContain('data-heading="Create a project"')
    expect(html).toContain('data-level="3"')
    const h2 = renderToStaticMarkup(<Steps><Step title="One" id="one" titleSize="h2" /></Steps>)
    expect(h2).toContain('data-level="2"')
  })

  it('never marks a plain-text title, even when handed an id', () => {
    const html = renderToStaticMarkup(<Steps titleSize="p"><Step title="One" id="one" /></Steps>)
    expect(html).toMatch(/<p [^>]*>One<\/p>/)
    expect(html).not.toMatch(/data-heading|\bid="one"/)
  })

  it('renders a code span in the title as code, in plain-text and heading titles alike', () => {
    expect(renderToStaticMarkup(<Steps titleSize="p"><Step title="Run the CLI `init` command" /></Steps>))
      .toMatch(/<p [^>]*>Run the CLI <code>init<\/code> command<\/p>/)
    expect(renderToStaticMarkup(<Steps><Step title="Create an `actions.ts` file" /></Steps>))
      .toMatch(/<h3 [^>]*>Create an <code>actions\.ts<\/code> file<\/h3>/)
  })

  it('labels a registered heading with the title text, without the backticks', () => {
    const html = renderToStaticMarkup(<Steps titleSize="h3"><Step title="Run the CLI `init` command" id="run-the-cli-init-command" /></Steps>)
    expect(html).toContain('data-heading="Run the CLI init command"')
    expect(html).toMatch(/<h3 [^>]*\bid="run-the-cli-init-command"/)
  })
})
