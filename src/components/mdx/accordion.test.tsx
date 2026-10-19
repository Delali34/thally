import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { Accordion } from './accordion'

describe('Accordion title', () => {
  it('renders a code span in the title as code', () => {
    const html = renderToStaticMarkup(<Accordion title="Don't use this in parallel, e.g. with `Promise.all()`">Body</Accordion>)
    expect(html).toContain('Don&#x27;t use this in parallel, e.g. with <code>Promise.all()</code></span>')
    expect(html).not.toContain('`')
  })

  it('keeps the id a title without backticks would have had', () => {
    const ids = (title: string) => [...renderToStaticMarkup(<Accordion title={title}>Body</Accordion>).matchAll(/ id="([^"]+)"/g)].map((match) => match[1])
    expect(ids("Don't use this in parallel, e.g. with `Promise.all()`")).toEqual([
      'don-t-use-this-in-parallel-e-g-with-promise-all',
      'don-t-use-this-in-parallel-e-g-with-promise-all-accordion-children',
    ])
    expect(ids('Run `init` first')).toEqual(ids('Run init first'))
  })

  it('leaves a title without code as plain text', () => {
    expect(renderToStaticMarkup(<Accordion title="What is it?">Body</Accordion>)).toContain('>What is it?</span>')
  })
})
