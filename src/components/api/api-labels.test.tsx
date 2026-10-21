import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { OperationPanel } from '@/components/api/operation-panel'
import { operationFrom } from '@/components/api/test-fixtures'
import { apiLabel } from '@/lib/i18n/api-labels'

const document = {
  openapi: '3.1.0',
  info: { title: 'T', version: '1' },
  servers: [{ url: 'https://api.example.com/v2' }],
  security: [{ bearerAuth: [] }],
  components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } } },
  paths: {
    '/scrape': {
      post: {
        summary: 'Scrape',
        parameters: [{ name: 'q', in: 'query', required: true, schema: { type: 'string' } }],
        requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['url'], properties: { url: { type: 'string' } } } } } },
        responses: { '200': { description: 'ok' } },
      },
    },
  },
}
const render = (locale?: string) => renderToStaticMarkup(<OperationPanel operation={operationFrom(document)} locale={locale} />)

describe('API panel labels', () => {
  it('stay English by default', () => {
    const html = render()
    for (const label of ['Authorizations', 'Query parameters', 'Request body', 'Responses', 'Try it', 'required']) expect(html).toContain(label)
  })

  it.each([
    ['es', ['Autorizaciones', 'Parámetros', 'Cuerpo de la solicitud', 'Respuestas', 'Pruébalo', 'requerido'], 'Request body'],
    ['fr', ['Autorisations', 'Paramètres', 'Corps de la requête', 'Réponses', 'Essayer', 'requis'], 'Request body'],
    ['ja', ['認証', 'パラメータ', 'リクエストボディ', 'レスポンス', '試す', '必須'], 'Request body'],
    ['zh', ['授权', '参数', '请求体', '响应', '试一试', '必填'], 'Request body'],
    ['pt-BR', ['Autorizações', 'Parâmetros', 'Corpo da requisição', 'Respostas', 'Experimente', 'obrigatório'], 'Request body'],
  ])('are translated for %s', (locale, labels, english) => {
    const html = render(locale)
    for (const label of labels) expect(html).toContain(label)
    expect(html).not.toContain(english)
    expect(html).not.toContain('>Try it<')
  })

  it('resolves regional codes and falls back to English for unknown locales', () => {
    expect(apiLabel('zh-Hans', 'tryIt')).toBe('试一试')
    expect(apiLabel('pt', 'required')).toBe('obrigatório')
    expect(apiLabel('xx', 'tryIt')).toBe('Try it')
  })
})
