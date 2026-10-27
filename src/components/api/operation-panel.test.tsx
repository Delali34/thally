import { Window } from 'happy-dom'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterAll, describe, expect, it } from 'vitest'
import { OperationPanel } from '@/components/api/operation-panel'
import { operationFrom } from '@/components/api/test-fixtures'

const document = {
  openapi: '3.1.0',
  info: { title: 'T', version: '1' },
  servers: [{ url: 'https://api.example.com/v2' }],
  paths: {
    '/scrape': { post: { summary: 'Scrape a URL', tags: ['Scrape'], responses: { '200': { description: 'ok' } } } },
  },
}

describe('OperationPanel header', () => {
  it('renders no heading of its own and the description once', () => {
    const html = renderToStaticMarkup(<OperationPanel operation={operationFrom(document)} />)
    expect(html).not.toContain('<h1')
    expect(html.match(/Scrape a URL/g)).toHaveLength(1)
  })

  it('omits its own description when the page header shows an authored one', () => {
    const html = renderToStaticMarkup(<OperationPanel operation={operationFrom(document)} showDescription={false} />)
    expect(html).not.toContain('Scrape a URL')
  })
})

describe('OperationPanel title', () => {
  it('renders exactly one h1 with the operation title above the endpoint bar when showTitle is set', () => {
    const html = renderToStaticMarkup(<OperationPanel operation={operationFrom(document)} showTitle />)
    expect(html.match(/<h1/g)).toHaveLength(1)
    expect(html).toMatch(/<h1[^>]*>Scrape a URL<\/h1>/)
    expect(html.indexOf('<h1')).toBeLessThan(html.indexOf('/scrape'))
  })
})

describe('OperationPanel webhook', () => {
  const hook = {
    openapi: '3.1.0',
    info: { title: 'T', version: '1' },
    paths: {},
    webhooks: {
      crawlPage: {
        post: {
          summary: 'Crawl Page',
          requestBody: { content: { 'application/json': { schema: { type: 'object' }, example: { type: 'crawl.page' } } } },
          responses: { '200': { description: 'ok' } },
        },
      },
    },
  }

  it('is labelled a webhook, has no Try it or cURL, and shows the payload example', () => {
    const html = renderToStaticMarkup(<OperationPanel operation={operationFrom(hook, true)} />)
    expect(html).toContain('Webhook')
    expect(html).not.toContain('Try it')
    expect(html).not.toContain('curl')
    expect(html).toContain('&quot;type&quot;: &quot;crawl.page&quot;')
  })
})

describe('OperationPanel object defaults', () => {
  it('prints an object default as JSON, not [object Object]', () => {
    const spec = {
      openapi: '3.1.0',
      info: { title: 'T', version: '1' },
      paths: {
        '/x': {
          post: {
            summary: 'X',
            requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { opts: { type: 'object', default: {} } } } } } },
            responses: {},
          },
        },
      },
    }
    const html = renderToStaticMarkup(<OperationPanel operation={operationFrom(spec)} />)
    expect(html).not.toContain('[object Object]')
  })
})

describe('OperationPanel field details', () => {
  const spec = {
    openapi: '3.1.0',
    info: { title: 'T', version: '1' },
    paths: {
      '/x': {
        post: {
          summary: 'X',
          requestBody: {
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    id: { type: 'string', format: 'uuid' },
                    mode: { type: 'string', enum: ['a', 'b'] },
                    modes: { type: 'array', items: { type: 'string', enum: ['a'] } },
                    kind: { type: 'string', const: 'crawl.page' },
                    old: { type: 'boolean', deprecated: true },
                  },
                },
              },
            },
          },
          responses: {},
        },
      },
    },
  }

  it('shows format, enum, const and a deprecated badge in the field types', () => {
    const html = renderToStaticMarkup(<OperationPanel operation={operationFrom(spec)} />)
    expect(html).toContain('string&lt;uuid&gt;')
    expect(html).toContain('enum&lt;string&gt;<')
    expect(html).toContain('enum&lt;string&gt;[]')
    expect(html).toContain('Allowed value: <code>&quot;crawl.page&quot;</code>')
    expect(html).toContain('>deprecated<')
  })
})

describe('OperationPanel field descriptions', () => {
  const spec = {
    openapi: '3.1.0',
    info: { title: 'T', version: '1' },
    paths: {
      '/x': {
        post: {
          summary: 'X',
          requestBody: {
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    proxy: { type: 'string', description: 'Use `basic` or **auto**, see [docs](https://example.com/p). <script>alert(1)</script>' },
                  },
                },
              },
            },
          },
          responses: {},
        },
      },
    },
  }

  it('renders descriptions as Markdown without injecting raw HTML', () => {
    const html = renderToStaticMarkup(<OperationPanel operation={operationFrom(spec)} />)
    expect(html).toContain('<code>basic</code>')
    expect(html).toContain('<strong>auto</strong>')
    expect(html).toContain('href="https://example.com/p"')
    expect(html).not.toContain('<script>')
    expect(html).not.toContain('`basic`')
  })
})

const inertWindow = new Window({ settings: {
  enableJavaScriptEvaluation: false, disableJavaScriptFileLoading: true,
  disableCSSFileLoading: true, enableImageFileLoading: false,
} })
afterAll(() => inertWindow.happyDOM.close())

describe('OperationPanel Markdown descriptions keep their prose styles', () => {
  const fence = '```ts\nimport { configure } from "@acme/sdk";\n\nconfigure({ token: "t" });\n```'
  const markdown = `First paragraph with \`code\` and a [link](https://example.com).\n\nSecond paragraph.\n\n${fence}`
  const spec = {
    openapi: '3.1.0',
    info: { title: 'T', version: '1' },
    paths: {
      '/runs': {
        get: {
          summary: 'List runs',
          security: [{ secretKey: [] }],
          parameters: [{ in: 'query', name: 'page[after]', schema: { type: 'string' }, description: markdown }],
          responses: {
            '200': {
              description: 'ok',
              content: { 'application/json': { schema: { type: 'object', properties: { data: { type: 'object', description: markdown, properties: { id: { type: 'string', description: markdown } } } } } } },
            },
          },
        },
      },
    },
    components: { securitySchemes: { secretKey: { type: 'http', scheme: 'bearer', description: markdown } } },
  }
  const html = renderToStaticMarkup(<OperationPanel operation={operationFrom(spec)} />)
  const document = new inertWindow.DOMParser().parseFromString(html, 'text/html')

  it('renders paragraphs, inline code, links and fenced code for the auth scheme, parameters and nested fields', () => {
    const rows = [...document.querySelectorAll('section.thally-parameter')]
    // Authorization, page[after], then the data and nested id response fields.
    expect(rows.map((row) => row.querySelector('code')?.textContent)).toEqual(['Authorization', 'page[after]', 'data', 'id'])
    for (const row of rows) {
      const description = row.querySelector(':scope > div.prose')
      expect(description?.querySelectorAll('p').length, row.textContent ?? '').toBeGreaterThanOrEqual(2)
      expect([...description?.querySelectorAll('p > code') ?? []].map((code) => code.textContent)).toContain('code')
      expect(description?.querySelector('a[href="https://example.com"]')).not.toBeNull()
      expect(description?.querySelector('pre > code.language-ts')?.textContent).toContain('configure({ token: "t" });')
    }
  })

  it('keeps every description block free of a not-prose ancestor, which would switch its typography off', () => {
    const blocks = [...document.querySelectorAll('div.prose p, div.prose pre, div.prose p code, div.prose pre code')]
    expect(blocks.length).toBeGreaterThan(20)
    for (const block of blocks) {
      if (block.closest('.not-prose')) throw new Error(`${block.tagName} sits under .not-prose: ${block.parentElement?.className}`)
    }
    // Only the name, type and badge row opts out of prose.
    for (const row of document.querySelectorAll('section.thally-parameter')) {
      expect(row.className).not.toContain('not-prose')
      expect(row.querySelector(':scope > div.not-prose code')).not.toBeNull()
    }
  })

  it('applies prose typography to the request body and response descriptions too', () => {
    const body = renderToStaticMarkup(<OperationPanel operation={operationFrom({
      openapi: '3.1.0',
      info: { title: 'T', version: '1' },
      paths: { '/x': { post: { summary: 'X', requestBody: { description: markdown, content: { 'application/json': { schema: { type: 'object' } } } }, responses: { '200': { description: markdown } } } } },
    })} />)
    const parsed = new inertWindow.DOMParser().parseFromString(body, 'text/html')
    const described = [...parsed.querySelectorAll('div.prose')].filter((block) => block.querySelector(':scope > p > code'))
    expect(described).toHaveLength(2)
    for (const block of described) expect(block.closest('.not-prose')).toBeNull()
  })
})

describe('OperationPanel endpoint bar and servers', () => {
  const withServers = (servers: Array<{ url: string }>) => ({
    openapi: '3.1.0',
    info: { title: 'T', version: '1' },
    servers,
    paths: { '/scrape': { post: { summary: 'Scrape', responses: {} } } },
  })

  it('shows the path only, and a Servers block only when there are several servers', () => {
    const one = renderToStaticMarkup(<OperationPanel operation={operationFrom(withServers([{ url: 'https://api.example.com/v2' }]))} />)
    expect(one).toContain('>/scrape</code>')
    expect(one).not.toContain('Servers')
    expect(one).not.toContain('>https://api.example.com/v2/scrape<')
    const two = renderToStaticMarkup(
      <OperationPanel operation={operationFrom(withServers([{ url: 'https://a.example.com' }, { url: 'https://b.example.com' }]))} />,
    )
    expect(two).toContain('Servers')
  })
})

describe('OperationPanel $ref path parameter', () => {
  it('lists the path parameter and keeps {id} visible in the sample URL until it is filled in', () => {
    const spec = {
      openapi: '3.1.0',
      info: { title: 'T', version: '1' },
      servers: [{ url: 'https://api.example.com/v2' }],
      paths: { '/monitor/{id}': { get: { summary: 'Get', parameters: [{ $ref: '#/components/parameters/Id' }], responses: {} } } },
      components: { parameters: { Id: { name: 'id', in: 'path', required: true, schema: { type: 'string' } } } },
    }
    const html = renderToStaticMarkup(<OperationPanel operation={operationFrom(spec)} />)
    expect(html).toContain('>id</code>')
    const parsed = new inertWindow.DOMParser().parseFromString(html, 'text/html')
    expect(parsed.querySelector('.tc-source')?.textContent).toContain("--url 'https://api.example.com/v2/monitor/{id}'")
    expect(html).not.toContain('%7Bid%7D')
  })
})

describe('OperationPanel code samples', () => {
  it('starts with cURL and exposes an accessible language menu', () => {
    const html = renderToStaticMarkup(<OperationPanel operation={operationFrom(document)} />)
    expect(html).toContain('aria-label="Select language"')
    expect(html).toContain('aria-haspopup="menu"')
    expect(html).toContain('>cURL</span>')
    expect(html).toContain('curl --request POST')
  })
})

describe('OperationPanel response examples', () => {
  const spec = {
    openapi: '3.1.0',
    info: { title: 'T', version: '1' },
    servers: [{ url: 'https://api.example.com/v2' }],
    paths: {
      '/scrape': {
        post: {
          summary: 'Scrape',
          responses: {
            '200': { description: 'ok', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' } } } } } },
            '404': { description: 'not found' },
            '429': { description: 'slow', content: { 'application/json': { schema: { type: 'object', properties: { error: { type: 'string' } } } } } },
          },
        },
      },
    },
  }

  it('shows a status tab per response and the first one example under the request', () => {
    const html = renderToStaticMarkup(<OperationPanel operation={operationFrom(spec)} />)
    const tabs = html.match(/role="tablist" aria-label="Response status".*?<\/div>/)![0]
    expect(tabs).toContain('>200<')
    expect(tabs).toContain('>429<')
    expect(tabs).toContain('>404<')
    const parsed = new inertWindow.DOMParser().parseFromString(html, 'text/html')
    expect(parsed.querySelector('.tc-res pre')?.textContent).toContain('"success": true')
    expect(html).not.toContain('Send a request to preview the response.')
  })
})

describe('OperationPanel oneOf / anyOf', () => {
  const wait = { title: 'Wait by Duration', type: 'object', properties: { type: { type: 'string', enum: ['wait'] }, milliseconds: { type: 'integer' } }, required: ['type'] }
  const click = { title: 'Click', type: 'object', properties: { type: { type: 'string', enum: ['click'] }, selector: { type: 'string' } } }
  const spec = (extra: Record<string, unknown> = {}) => ({
    openapi: '3.1.0',
    info: { title: 'T', version: '1' },
    servers: [{ url: 'https://api.example.com/v2' }],
    paths: {
      '/scrape': {
        post: {
          summary: 'Scrape',
          requestBody: {
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    actions: { type: 'array', items: { oneOf: [wait, click] } },
                    source: { oneOf: [{ type: 'object', properties: { kind: { const: 'a' } } }, { type: 'object', properties: { other: { type: 'string' } } }] },
                    flag: { oneOf: [{ type: 'boolean' }, { type: 'object', properties: { deep: { type: 'string' } } }] },
                    kinds: { discriminator: { propertyName: 'kind' }, oneOf: [{ type: 'object', properties: { kind: { const: 'pdf' } } }, { type: 'object', properties: { kind: { const: 'doc' } } }] },
                    ...extra,
                  },
                },
              },
            },
          },
          responses: {
            '200': {
              description: 'ok',
              content: { 'application/json': { schema: { anyOf: [{ title: 'Done', type: 'object', properties: { id: { type: 'string' } } }, { title: 'Pending', type: 'object', properties: { eta: { type: 'integer' } } }] } } },
            },
          },
        },
      },
    },
  })
  const render = (extra?: Record<string, unknown>) => renderToStaticMarkup(<OperationPanel operation={operationFrom(spec(extra))} />)

  it('lists the variant titles in the type, not the literal oneOf', () => {
    const html = render()
    expect(html).not.toContain('oneOf')
    expect(html).toContain('(Wait by Duration · object | Click · object)[]')
    expect(html).toContain('object | object')
    expect(html).toContain('boolean | object')
  })

  it('shows a tab per variant and the first variant\'s fields', () => {
    const html = render()
    for (const label of ['Wait by Duration', 'Click', 'Option 1', 'Option 2', 'Done', 'Pending']) {
      expect(html).toMatch(new RegExp(`role="tab"[^>]*>${label}</button>`))
    }
    expect(html).toContain('milliseconds')
    expect(html).not.toContain('selector')
    expect(html).toContain('>id<')
    expect(html).not.toContain('>eta<')
  })

  it('spreads a variant that is only a union into the list', () => {
    const html = render({
      nested: { type: 'array', items: { oneOf: [{ title: 'Wrapper', oneOf: [{ title: 'Inner A', type: 'object', properties: { a: { type: 'string' } } }, { title: 'Inner B', type: 'object', properties: { b: { type: 'string' } } }] }, { title: 'Outer', type: 'object', properties: { c: { type: 'string' } } }] } },
    })
    expect(html).toContain('(Inner A · object | Inner B · object | Outer · object)[]')
    expect(html).not.toContain('Wrapper')
  })

  it('labels variants by the discriminator value when they have no title', () => {
    const html = render()
    expect(html).toMatch(/role="tab"[^>]*>pdf<\/button>/)
    expect(html).toMatch(/role="tab"[^>]*>doc<\/button>/)
  })

  it('stops expanding a deeply recursive union at a depth limit', () => {
    let schema: Record<string, unknown> = { type: 'object', properties: { leaf: { type: 'string' } } }
    for (let level = 12; level >= 1; level -= 1) {
      schema = { type: 'object', properties: { [`level${level}`]: { oneOf: [schema, { type: 'object', properties: { other: { type: 'string' } } }] } } }
    }
    const html = render({ deep: schema })
    expect(html).toContain('>level3<')
    expect(html).not.toContain('>level12<')
  })
})

describe('OperationPanel arrays of objects', () => {
  const link = { type: 'object', required: ['url'], properties: { url: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } }, geo: { type: 'object', properties: { country: { type: 'string' } } } } }
  const error = { title: 'Failure', type: 'object', properties: { error: { type: 'string' } } }
  const node = { type: 'object', properties: { name: { type: 'string' }, children: { type: 'array', items: { $ref: '#/components/schemas/Node' } } } }
  const schemas = { Link: link, Failure: error, Node: node, Links: { type: 'array', items: { $ref: '#/components/schemas/Link' } } }

  const spec = (body?: Record<string, unknown>, response?: Record<string, unknown>) => ({
    openapi: '3.1.0',
    info: { title: 'T', version: '1' },
    paths: {
      '/links': {
        post: {
          summary: 'Links',
          ...(body ? { requestBody: { content: { 'application/json': { schema: body } } } } : {}),
          responses: response ? { '200': { description: 'A list of links', content: { 'application/json': { schema: response } } } } : {},
        },
      },
    },
    components: { schemas },
  })
  const render = (body?: Record<string, unknown>, response?: Record<string, unknown>) => renderToStaticMarkup(<OperationPanel operation={operationFrom(spec(body, response))} />)
  /** The name of every field row, in page order. */
  const rows = (html: string) => [...html.matchAll(/<code class="text-sm font-semibold[^"]*">([^<]*)<\/code>/g)].map((match) => match[1])
  const flat = ['url', 'tags', 'geo']

  it('shows the fields of a request body array of objects, as it does for an object body', () => {
    expect(rows(render(link))).toEqual([...flat, 'country'])
    const html = render({ type: 'array', items: link })
    expect(rows(html)).toEqual([...flat, 'country'])
    expect(html).toContain('geo properties')
    expect(html).toContain('string[]')
    expect(html).not.toContain('(body)')
    expect(html.match(/>required</g)).toHaveLength(1)
  })

  it('shows the fields of a response array of objects', () => {
    const html = render(undefined, { type: 'array', items: link })
    expect(rows(html)).toEqual([...flat, 'country'])
    expect(html).toContain('geo properties')
  })

  it('follows a $ref to the item, and a $ref to the whole array', () => {
    const byItem = { type: 'array', items: { $ref: '#/components/schemas/Link' } }
    const whole = { $ref: '#/components/schemas/Links' }
    for (const schema of [byItem, whole]) {
      expect(rows(render(schema))).toEqual([...flat, 'country'])
      expect(rows(render(undefined, schema))).toEqual([...flat, 'country'])
    }
  })

  it('merges an allOf item, and shows a tab per oneOf or anyOf item', () => {
    const merged = render(undefined, { type: 'array', items: { allOf: [{ $ref: '#/components/schemas/Link' }, { type: 'object', properties: { id: { type: 'string' } } }] } })
    expect(rows(merged)).toEqual(['url', 'tags', 'geo', 'country', 'id'])
    for (const key of ['oneOf', 'anyOf']) {
      const html = render(undefined, { type: 'array', items: { [key]: [{ $ref: '#/components/schemas/Link' }, { $ref: '#/components/schemas/Failure' }] } })
      expect(html).toMatch(/role="tab"[^>]*>Option 1<\/button>/)
      expect(html).toMatch(/role="tab"[^>]*>Failure<\/button>/)
      expect(rows(html)).toEqual([...flat, 'country'])
    }
  })

  it('unwraps a list of lists, and still nests an array inside an object', () => {
    expect(rows(render({ type: 'array', items: { type: 'array', items: link } }))).toEqual([...flat, 'country'])
    const inside = render({ type: 'object', properties: { links: { type: 'array', items: link }, label: { type: 'string' } } })
    expect(rows(inside)).toEqual(['links', 'url', 'tags', 'geo', 'country', 'label'])
    expect(inside).toContain('links properties')
  })

  it('stops at a recursive item schema', () => {
    const html = render({ type: 'array', items: { $ref: '#/components/schemas/Node' } }, { type: 'array', items: { $ref: '#/components/schemas/Node' } })
    expect(rows(html)).toEqual(['name', 'children', 'name', 'children'])
    expect(html).not.toContain('children properties')
  })

  it('cuts a deeply nested list off at the same depth limit as nested objects', () => {
    let item: Record<string, unknown> = { type: 'object', properties: { leaf: { type: 'string' } } }
    for (let level = 12; level >= 1; level -= 1) item = { type: 'object', properties: { next: { type: 'array', items: item } } }
    expect(rows(render(undefined, { type: 'array', items: item }))).toEqual(Array(7).fill('next'))
  })

  it('keeps an array of scalars as one row', () => {
    const html = render({ type: 'array', items: { type: 'string' } }, { type: 'array', items: { type: 'integer' } })
    expect(rows(html)).toEqual(['(body)'])
    expect(html).toContain('string[]')
  })
})
