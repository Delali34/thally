import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { OperationPanel } from '@/components/api/operation-panel'
import { SendButton } from '@/components/api/try-it-dialog'
import { operationFrom } from '@/components/api/test-fixtures'
import type { TryItController } from '@/components/api/use-try-it-controller'

const document = {
  openapi: '3.1.0',
  info: { title: 'T', version: '1' },
  servers: [{ url: 'https://api.example.com/v2' }],
  paths: { '/scrape': { post: { summary: 'Scrape a URL', responses: { '200': { description: 'ok' } } } } },
}
const render = (playground: 'interactive' | 'simple' | 'none') =>
  renderToStaticMarkup(<OperationPanel operation={operationFrom(document)} playground={playground} />)

describe('api.playground.display', () => {
  it('interactive shows Try it', () => {
    expect(render('interactive')).toContain('Try it')
  })
  it('simple shows the endpoint to copy and no Try it', () => {
    const html = render('simple')
    expect(html).not.toContain('Try it')
    expect(html).toContain('/scrape')
    expect(html).toContain('Copy')
  })
  it('none shows no endpoint bar and no Try it', () => {
    const html = render('none')
    expect(html).not.toContain('Try it')
    expect(html).not.toContain('class="thally-endpoint-bar"')
    // Static request examples remain readable when only the playground is hidden.
    expect(html).toContain('curl --request POST')
  })
})

describe('SendButton', () => {
  const controller = (confirmingSend: boolean) =>
    ({ isSending: false, confirmingSend, requestSend: () => {}, cancelSend: () => {}, preparedRequest: { isServerConfigured: true } }) as unknown as TryItController
  it('asks for a second click on DELETE instead of a native confirm', () => {
    expect(renderToStaticMarkup(<SendButton controller={controller(false)} />)).toContain('>Send<')
    expect(renderToStaticMarkup(<SendButton controller={controller(true)} />)).toContain('Confirm delete')
  })
})
