/** The head shim must execute synchronously before transformed serialized bootstraps. */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import { transformSync } from 'esbuild'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterAll, describe, expect, it } from 'vitest'
import { Window } from 'happy-dom'

const require = createRequire(import.meta.url)
const inertWindow = new Window({ settings: {
  enableJavaScriptEvaluation: false, disableJavaScriptFileLoading: true,
  disableCSSFileLoading: true, enableImageFileLoading: false,
} })
afterAll(() => inertWindow.happyDOM.close())

/** Parse rendered fixture HTML inertly; input scripts and resources never execute. */
function extractBootstrap(html: string): string | undefined {
  return new inertWindow.DOMParser().parseFromString(html, 'text/html').querySelector('script')?.textContent
}

/** Render the actual dependency after the same name-preserving server transform. */
function transformedThemeBootstrap(): string {
  const file = require.resolve('next-themes')
  const transformed = transformSync(readFileSync(file, 'utf8'), { loader: 'js', format: 'cjs', keepNames: true }).code
  const themeModule = { exports: {} as typeof import('next-themes') }
  runInNewContext(transformed, { module: themeModule, exports: themeModule.exports, require })
  const html = renderToStaticMarkup(createElement(themeModule.exports.ThemeProvider, { attribute: 'class', defaultTheme: 'dark' }))
  const bootstrap = extractBootstrap(html)
  if (!bootstrap) throw new Error('The actual theme provider emitted no bootstrap.')
  return bootstrap
}

describe('document bootstrap ordering', () => {
  it.each([['script', 'ScRiPt'], ['SCRIPT', 'script '], ['sCrIpT', 'SCRIPT \t\n']])('extracts %s fixture tags with closing whitespace', (tag, closing) => {
    expect(extractBootstrap(`<${tag} type="text/javascript">globalThis.marker = 1\n</${closing}>`)).toBe('globalThis.marker = 1\n')
  })

  it('parses quoted attribute delimiters without changing the script bytes', () => {
    expect(extractBootstrap('<script data-label="a > b">const bytes = "<tag>";</script >')).toBe('const bytes = "<tag>";')
  })

  it('extracts input without evaluating it', () => {
    const source = 'globalThis.__thallyBootstrapExecuted = true'
    expect(extractBootstrap(`<script>${source}</script >`)).toBe(source)
    expect((inertWindow as unknown as Record<string, unknown>).__thallyBootstrapExecuted).toBeUndefined()
  })

  it('runs the fixed native head shim before next-themes accesses esbuild helpers', () => {
    const layout = readFileSync('src/app/layout.tsx', 'utf8')
    // Next/font prevents importing the root layout in unit tests. Bind this
    // executable regression to its exact native element and literal payload.
    expect(layout).toContain('<script id="thally-runtime-name-shim" dangerouslySetInnerHTML={{ __html: runtimeNameShim }} />')
    expect(layout.indexOf('<script id="thally-runtime-name-shim"')).toBeGreaterThan(layout.indexOf('<head>'))
    expect(layout).not.toMatch(/<Script\s+id="thally-runtime-name-shim"/u)
    const literal = /const runtimeNameShim\s*=\s*("[^\n]+");?/u.exec(layout)?.[1]
    const shim = JSON.parse(literal ?? 'null') as string
    const bootstrap = transformedThemeBootstrap()
    expect(bootstrap).toContain('__name')
    const environment = () => ({
      document: { documentElement: { classList: { remove() {}, add() {} }, style: {} } },
      localStorage: { getItem: () => null },
      matchMedia: () => ({ matches: false }),
    })
    // The negative control reproduces the managed transform's production error.
    expect(() => runInNewContext(bootstrap, environment())).toThrow('__name is not defined')
    const context = environment()
    expect(() => runInNewContext(`${shim}\n${bootstrap}`, context)).not.toThrow()
    expect(context.document.documentElement.style).toEqual({ colorScheme: 'dark' })
  })
})
