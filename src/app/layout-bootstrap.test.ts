/** The head shim must execute synchronously before transformed serialized bootstraps. */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import { transformSync } from 'esbuild'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)

/** Render the actual dependency after the same name-preserving server transform. */
function transformedThemeBootstrap(): string {
  const file = require.resolve('next-themes')
  const transformed = transformSync(readFileSync(file, 'utf8'), { loader: 'js', format: 'cjs', keepNames: true }).code
  const themeModule = { exports: {} as typeof import('next-themes') }
  runInNewContext(transformed, { module: themeModule, exports: themeModule.exports, require })
  const html = renderToStaticMarkup(createElement(themeModule.exports.ThemeProvider, { attribute: 'class', defaultTheme: 'dark' }))
  const bootstrap = /<script\b[^>]*>([\s\S]*?)<\/script>/u.exec(html)?.[1]
  if (!bootstrap) throw new Error('The actual theme provider emitted no bootstrap.')
  return bootstrap
}

describe('document bootstrap ordering', () => {
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
