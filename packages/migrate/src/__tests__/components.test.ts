/** Component migration preserves executable source without running source code. */

import { compileSync } from '@mdx-js/mdx'
import { transformSync } from 'esbuild'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import ts from 'typescript'
import { afterEach, describe, expect, it } from 'vitest'

import { createComponentMigrator, declarationsReferenceBrowserGlobal, hasAnyFunctionValuedProp, mergeComponentRegistry, propsTargetExtractedClientComponent, SCAFFOLD_PROVIDED_IMPORTS } from '../components.js'
import { migrateRepository } from '../repository.js'
import { renderMigrationFiles } from '../render.js'
import type { MigrationWarning } from '../types.js'
import { withoutDashboardWarning } from './dashboard-warning.js'

const roots: Array<string> = []
function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'thally-components-'))
  roots.push(root)
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), content)
  }
  return root
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe('repository component migration', () => {
  it('resolves extensionless declaration dependencies used by typed components', () => {
    const root = fixture({
      'docusaurus.config.js': 'module.exports = {}',
      'docs/index.mdx': "import Picture from '@site/src/Picture'\n\n<Picture src='/photo.svg' />",
      'src/Picture.tsx': "import { Props } from './types'\nexport default function Picture({src}: Props) { return <img src={src} /> }",
      'src/types.d.ts': 'export interface Props { src: string }',
    })
    const bundle = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/example/docs', platform: 'docusaurus' })
    expect(bundle.componentFiles.some((file) => file.path.endsWith('/Picture.tsx'))).toBe(true)
    expect(bundle.warnings).toEqual([])
  })

  it('copies site-authored Docusaurus components rather than claiming they are platform widgets', () => {
    const root = fixture({
      'website/docusaurus.config.js': 'module.exports = {}',
      'website/docs/index.mdx': [
        "import Showcase from '@site/src/components/Showcase'",
        '',
        '<Showcase><p>Preview</p></Showcase>',
      ].join('\n'),
      'website/src/components/Showcase.jsx': 'export default function Showcase({ children }) { return <section className="custom-showcase">{children}</section> }',
    })
    const bundle = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/example/docs', platform: 'docusaurus' })
    const body = bundle.pages.find((page) => page.body.includes('Preview'))?.body ?? ''
    expect(body).toMatch(/<Migrated[a-f0-9]+>/)
    expect(bundle.componentFiles.some((file) => file.path.endsWith('/Showcase.jsx'))).toBe(true)
    expect(body).not.toContain('<BrowserPreview')
    expect(bundle.warnings).toEqual([])
  })

  it('isolates components and inline handlers from different sources across sequential imports', () => {
    function source(pageName: string, label: string): string {
      return fixture({
        'docs.json': JSON.stringify({ navigation: { pages: [pageName] } }),
        [`${pageName}.mdx`]: `import Widget, { Counter } from './snippets/widget.jsx'\n\n<Widget />\n\n<Counter />`,
        'shared.mdx': `<button onClick={() => {}}>${label}</button>`,
        'snippets/widget.jsx': `export default () => <p>${label}</p>; export const Counter = () => <p>Counter ${label}</p>`,
      })
    }
    const first = migrateRepository({ repositoryDir: source('first', 'First'), sourceUrl: 'https://github.com/first/docs' })
    const second = migrateRepository({ repositoryDir: source('second', 'Second'), sourceUrl: 'https://github.com/second/docs' })
    const firstFiles = renderMigrationFiles(first)
    const firstRegistry = String(firstFiles.find((file) => file.path === 'src/mdx/custom-components.tsx')!.content)
    const secondFiles = renderMigrationFiles(second, { existingConfig: first.docsConfig, existingComponentRegistry: firstRegistry })
    const firstGraph = firstFiles.filter((file) => file.path.startsWith('src/mdx/migrated/'))
    const secondGraph = secondFiles.filter((file) => file.path.startsWith('src/mdx/migrated/'))
    expect(firstGraph.length).toBeGreaterThan(1)
    expect(secondGraph.length).toBeGreaterThan(1)
    expect(secondGraph.every((file) => !firstGraph.some((prior) => prior.path === file.path))).toBe(true)
    expect(first.pages.find((page) => page.id === 'first')!.body).not.toBe(second.pages.find((page) => page.id === 'second')!.body)
    expect(first.pages.find((page) => page.id === 'first')!.body.match(/Migrated[a-f0-9]+/g)).toHaveLength(2)
    expect(new Set(first.pages.find((page) => page.id === 'first')!.body.match(/Migrated[a-f0-9]+/g)).size).toBe(2)
    const mergedRegistry = String(secondFiles.find((file) => file.path === 'src/mdx/custom-components.tsx')!.content)
    for (const line of firstRegistry.split('\n').filter((line) => line.startsWith('import '))) expect(mergedRegistry).toContain(line)
    expect(mergedRegistry).toContain('...MigratedRegistry')
    expect(withoutDashboardWarning(second.warnings)).toEqual([])
  })

  it('keeps repeat imports stable across clone directories and equivalent GitHub URLs', () => {
    const files = {
      'site/docs.json': JSON.stringify({ navigation: { pages: ['introduction'] } }),
      'site/introduction.mdx': "import Widget from './widget.jsx'\n\n<div onClick={() => {}}><Widget /></div>",
      'site/widget.jsx': 'export default () => <p>Stable component</p>',
    }
    const first = migrateRepository({ repositoryDir: fixture(files), sourceUrl: 'https://github.com/Example/Docs.git' })
    const repeated = migrateRepository({ repositoryDir: fixture(files), sourceUrl: 'https://github.com/example/docs/tree/main/site' })
    expect(first.componentFiles).toEqual(repeated.componentFiles)
    expect(first.pages[0].body).toBe(repeated.pages[0].body)
    const inline = String(first.componentFiles!.find((file) => file.path.includes('/inline-'))!.content)
    // Destination paths are relative to the repository (the confinement
    // root fix's `confined`), not the narrower Mintlify project root
    // (`site/`) — so `site/widget.jsx` lands at `./source/site/widget.jsx`.
    expect(inline).toContain('"./source/site/widget.jsx"')
  })

  it('migrates local components imported by a Fern page (../../components from fern/pages/...)', () => {
    const root = fixture({
      'fern/fern.config.json': JSON.stringify({ organization: 'acme' }),
      'fern/docs.yml': [
        'navigation:',
        '  - section: Guides',
        '    contents:',
        '      - page: Cookbook',
        '        path: ./pages/guides/cookbook.mdx',
      ].join('\n'),
      'fern/pages/guides/cookbook.mdx': [
        '---',
        'title: Cookbook',
        '---',
        "import { CookbookHeader } from '../../components/cookbook-header'",
        '',
        '<CookbookHeader href="https://github.com/example/docs" />',
      ].join('\n'),
      'fern/components/cookbook-header.tsx': [
        "export const CookbookHeader = ({ href }: { href: string }) => <a href={href}>Open in GitHub</a>",
      ].join('\n'),
    })
    const bundle = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/example/docs', platform: 'fern' })
    expect(bundle.warnings.filter((warning) => /Module not found|module not found/i.test(warning.message))).toEqual([])
    const files = renderMigrationFiles(bundle)
    const graph = files.filter((file) => file.path.startsWith('src/mdx/migrated/'))
    expect(graph.length).toBeGreaterThan(0)
    expect(graph.some((file) => String(file.content).includes('Open in GitHub'))).toBe(true)
  })

  it('migrates a Fern page whose companion import binding (an enum) is used inside a JSX prop expression', () => {
    // Mirrors cohere-developer-experience's `model-showcase.tsx`: one import
    // statement brings in both the rendered component (`ModelShowcase`, used
    // as a bare tag) and a value-only companion (`Capability`, used only via
    // `Capability.SafetyModes` inside a prop expression). The whole file is
    // local and copyable, so both bindings are migrated together and the
    // page is kept — excluding a page the migration can satisfy would be
    // the wrong tradeoff.
    const root = fixture({
      'fern/fern.config.json': JSON.stringify({ organization: 'acme' }),
      'fern/docs.yml': [
        'navigation:',
        '  - page: Welcome',
        '    path: ./pages/welcome.mdx',
        '  - page: Model',
        '    path: ./pages/model.mdx',
      ].join('\n'),
      'fern/pages/welcome.mdx': '---\ntitle: Welcome\n---\n\nHello.',
      'fern/pages/model.mdx': [
        '---',
        'title: Model',
        '---',
        "import { ModelShowcase, Capability } from '../components/model-showcase'",
        '',
        '<ModelShowcase model={{ capabilities: [Capability.Reasoning] }} />',
      ].join('\n'),
      'fern/components/model-showcase.tsx': [
        'export enum Capability { Reasoning }',
        'export const ModelShowcase = ({ model }: { model: { capabilities: Capability[] } }) => <p>{model.capabilities.length}</p>',
      ].join('\n'),
    })
    const bundle = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/example/docs', platform: 'fern' })
    expect(bundle.pages.map((page) => page.id).sort()).toEqual(['model', 'welcome'])
    expect(bundle.warnings.filter((warning) => warning.code === 'skipped-file')).toEqual([])
    const modelPage = bundle.pages.find((page) => page.id === 'model')!
    expect(modelPage.body).not.toContain('../components/model-showcase')
    const graph = bundle.componentFiles ?? []
    expect(graph.some((file) => String(file.content).includes('enum Capability'))).toBe(true)
    expect(graph.some((file) => String(file.content).includes('ModelShowcase'))).toBe(true)
    // MDX only resolves a JSX *tag* name (`<ModelShowcase>`) through the
    // shared `_components` scope (the customComponents registry below);
    // `Capability.Reasoning` is a bare identifier inside a prop expression,
    // which that mechanism can never reach (MDX's own component-injection
    // pass only rewrites JSX tag names) and throws `ReferenceError` at
    // render if registered there instead. So `Capability` gets a real
    // page-level import pointing at the copied module directly, keeping its
    // original name, while `ModelShowcase` (JSX-tag-only) still goes through
    // the registry.
    expect(modelPage.body).toMatch(/^import \{ Capability as Capability \} from ['"]@\//m)
    const graphFile = graph.find((file) => String(file.content).includes('enum Capability'))!
    const expectedSpecifier = `@/${graphFile.path.replace(/^src\//, '').replace(/\.tsx?$/, '')}`
    expect(modelPage.body).toContain(`from ${JSON.stringify(expectedSpecifier)}`)
    const registry = String(graph.find((file) => file.path === 'src/mdx/custom-components.tsx')!.content)
    expect(registry).not.toContain('Capability')
    expect(registry).toContain('ModelShowcase')
    expect(registry).toMatch(/}\s*as unknown as MDXComponents/)
    const check = ts.transpileModule(registry, {
      compilerOptions: { jsx: ts.JsxEmit.Preserve, module: ts.ModuleKind.ESNext, noEmit: true },
      reportDiagnostics: true,
    })
    // transpileModule only checks syntax (no cross-file type info), so this
    // proves the cast parses as valid TS; the real type-check is exercised
    // by a live `next build` (see the E2E verification, not run in unit tests).
    expect(check.diagnostics?.some((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error)).toBe(false)
  })

  it('copies mixed component and lowercase helper exports from a local JSX module', () => {
    const root = fixture({
      'docs.json': JSON.stringify({ name: 'Demo', navigation: { tabs: [{ tab: 'Docs', pages: ['index'] }] } }),
      'index.mdx': '---\ntitle: Index\n---\n\nimport { rows, Table } from "/snippets/table.jsx";\n\n<Table data={rows()} />',
      'snippets/table.jsx': 'export const rows = () => [{ name: "A" }]; export const Table = ({ data }) => <p>{data[0].name}</p>;',
    })
    const bundle = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/example/docs', platform: 'mintlify' })
    expect(bundle.pages).toHaveLength(1)
    expect(bundle.pages[0].body).toContain('export const rows = () => ([{ name: "A" }]);')
    expect(bundle.pages[0].body).not.toContain('from "/snippets/table.jsx"')
    expect(bundle.componentFiles?.some((file) => String(file.content).includes('export const rows'))).toBe(true)
  })

  it('separates sibling documentation roots within the same repository', () => {
    const files = Object.fromEntries(['first', 'second'].flatMap((directory) => [
      [`${directory}/docs.json`, JSON.stringify({ navigation: { pages: ['introduction'] } })],
      [`${directory}/introduction.mdx`, `<button onClick={() => {}}>${directory}</button>`],
    ]))
    const repositoryDir = fixture(files)
    const first = migrateRepository({ repositoryDir, sourceUrl: 'https://github.com/example/docs', docsDir: 'first' })
    const second = migrateRepository({ repositoryDir, sourceUrl: 'https://github.com/example/docs', docsDir: 'second' })
    expect(first.componentFiles![0].path).not.toBe(second.componentFiles![0].path)
  })

  it('merges an authored registry without replacing its imports, comments, or overrides', () => {
    const existing = `/** Customer explanation */\nimport { Highlight } from './highlight'\nexport const customComponents = { Highlight } satisfies Record<string, unknown>\nexport const other = 42\n`
    const incoming = `export const customComponents = { Imported: () => null }\n`
    const merged = mergeComponentRegistry(existing, incoming)
    const registry = merged.find((file) => file.path === 'src/mdx/custom-components.tsx')!
    expect(registry.content).toContain('/** Customer explanation */')
    expect(registry.content).toContain("import { Highlight } from './highlight'")
    expect(registry.content).toMatch(/\.\.\.MigratedRegistry[a-f0-9]+, Highlight/)
    expect(registry.content).toContain('export const other = 42')
    expect(merged.find((file) => file.path.includes('migrated-components-'))?.content).toBe(incoming)
    expect(mergeComponentRegistry(String(registry.content), incoming)).toEqual(merged)
  })

  it('fails before rendering files when an existing registry cannot be merged safely', () => {
    expect(() => mergeComponentRegistry('export { customComponents } from "./registry"', 'export const customComponents = {}'))
      .toThrow('existing registry was preserved')
  })

  it('preserves the directive prologue of an existing client registry', () => {
    const files = mergeComponentRegistry("'use client';\nexport const customComponents = {}", 'export const customComponents = {}')
    expect(files.at(-1)?.content).toMatch(/^'use client';\nimport /)
  })

  it('resolves a relative component import that escapes the platform root but stays inside the repository (Redux: docs/ is a sibling of website/)', () => {
    const root = fixture({
      'website/docusaurus.config.js': 'module.exports = {}',
      'components/DetailedExplanation.jsx': 'export default () => <p>Explanation</p>',
    })
    const warnings: Array<MigrationWarning> = []
    // siteRoot (the Docusaurus project root) is narrower than the
    // repository; confinementRoot is the whole repository, per fix 4.
    const migrator = createComponentMigrator(join(root, 'website'), root, warnings, 'https://github.com/example/docs')
    const source = "import DetailedExplanation from '../components/DetailedExplanation.jsx'\n\n<DetailedExplanation />"
    const result = migrator.transform(source, join(root, 'docs', 'guide.mdx'))
    expect(result.trim()).toMatch(/^<Migrated[a-f0-9]+ \/>$/)
    expect(migrator.files().some((file) => file.path.endsWith('/DetailedExplanation.jsx'))).toBe(true)
    expect(warnings).toEqual([])
  })

  it("drops a named (non-component) .mdx import and its spread usage instead of leaving an unresolvable module reference (cypress-documentation's views.mdx: `import { toc as viewsToc } from '@site/docs/partials/_views.mdx'`, merged via `export const toc = [...viewsToc, ...]`)", () => {
    const root = fixture({
      'website/docusaurus.config.js': 'module.exports = {}',
      'docs/partials/_views.mdx': '## Why use views?\n\nSome content.',
    })
    const warnings: Array<MigrationWarning> = []
    const migrator = createComponentMigrator(join(root, 'website'), root, warnings, 'https://github.com/example/docs')
    const source = [
      "import { toc as viewsToc } from '@site/docs/partials/_views.mdx'",
      '',
      'export const toc = [',
      '  ...viewsToc,',
      "  { value: 'See also', id: 'See-also', level: 2 },",
      ']',
      '',
      '# Views',
    ].join('\n')
    const result = migrator.transform(source, join(root, 'docs', 'views.mdx'))
    expect(result).not.toContain("from '@site/docs/partials/_views.mdx'")
    expect(result).not.toContain('viewsToc')
    expect(result).toContain("export const toc = [")
    expect(result).toContain("{ value: 'See also', id: 'See-also', level: 2 }")
    expect(warnings).toHaveLength(1)
    expect(warnings[0].message).toContain('_views.mdx')
    expect(warnings[0].message).toContain('removed')
  })

  it("neutralizes a @site component import even when the page's MDX can't be parsed at all, instead of leaving the raw import in place to break next build (safety net for the 'could not parse this MDX' fallback)", () => {
    const root = fixture({})
    const warnings: Array<MigrationWarning> = []
    const migrator = createComponentMigrator(join(root, 'docs'), root, warnings, 'https://github.com/example/docs')
    // An unclosed JSX tag (a real, independent MDX parse failure Docusaurus
    // itself tolerates less strictly) breaks remark-mdx's parse before this
    // migration's own AST walk — the walk that would normally copy or drop
    // the import below — ever gets a chance to run.
    const source = "import Thumbnail from '@site/src/components/Thumbnail'\n\n<Note>\n\n<Thumbnail src=\"/img/x.png\" />\n\nUnclosed admonition."
    const result = migrator.transform(source, join(root, 'docs', 'broken.mdx'))
    expect(result).not.toContain("from '@site/src/components/Thumbnail'")
    expect(result).not.toContain('<Thumbnail ')
    expect(result).toContain('{/* Removed <Thumbnail>')
    expect(warnings.some((w) => w.message.includes('could not parse this MDX'))).toBe(true)
    expect(warnings.some((w) => w.message.includes('Thumbnail') && w.message.includes('removed'))).toBe(true)
  })

  it('reports a dangling relative import as unresolved instead of silently shadowing it with an unrelated same-named file at the repository root (a plain nested docs/ layout, not a flattened monorepo)', () => {
    const root = fixture({
      // docs/ is the detected component (site) root, one level under the
      // repository root — the ordinary case, not a Playwright-style
      // monorepo that flattens a project root's contents up into it.
      'docs/snippets/foo.jsx': "import Bogus from './bogus'\nexport default function Foo() { return <Bogus /> }",
      // An unrelated top-level directory that happens to collide with the
      // broken import's path once mirrored onto the repository root.
      'snippets/bogus.jsx': 'export default function Bogus() { return <div>UNRELATED-TOP-LEVEL-CODE</div> }',
    })
    const warnings: Array<MigrationWarning> = []
    const migrator = createComponentMigrator(join(root, 'docs'), root, warnings, 'https://github.com/example/docs')
    const source = "import Foo from './snippets/foo.jsx'\n\n<Foo />"
    const result = migrator.transform(source, join(root, 'docs', 'index.mdx'))
    expect(result).toBe('\n\n<Foo />')
    expect(migrator.files().some((file) => file.content.toString().includes('UNRELATED-TOP-LEVEL-CODE'))).toBe(false)
    expect(warnings).toHaveLength(1)
    expect(warnings[0].message).toContain('./bogus')
    expect(warnings[0].message).toContain('could not be copied and was removed')
  })

  it('still refuses (and removes) a relative component import that escapes the repository itself, not just the platform root', () => {
    const outside = fixture({ 'secret.jsx': 'export default () => <p>Secret</p>' })
    const root = fixture({ 'website/docusaurus.config.js': 'module.exports = {}' })
    const warnings: Array<MigrationWarning> = []
    const migrator = createComponentMigrator(join(root, 'website'), root, warnings, 'https://github.com/example/docs')
    const source = `import Secret from ${JSON.stringify(`${relative(join(root, 'docs'), outside)}/secret.jsx`.replace(/\\/g, '/'))}\n\n<Secret />`
    const result = migrator.transform(source, join(root, 'docs', 'guide.mdx'))
    // The import is still refused (repositoryDir remains the outer
    // boundary) and, per the dead-import fix, removed rather than left
    // dangling; `<Secret />` is untouched here for the page-level
    // unknown-component fallback to neutralize.
    expect(result).toBe('\n\n<Secret />')
    expect(migrator.files()).toEqual([])
    expect(warnings[0].message).toContain('could not be copied and was removed')
    expect(warnings[0].message).toContain('escapes its root')
  })

  it('imports implicit React globals without replacing explicit imports or local bindings', () => {
    const root = fixture({
      'implicit.jsx': `export default function Widget() { const [n] = useState(1); useEffect(() => {}, []); return React.createElement('p', null, n) }`,
      'explicit.jsx': `import { useState as useCounter, useEffect } from 'react'; const useState = () => [7]; export default function Widget() { const [n] = useState(); useEffect(() => {}, []); return <p>{n}</p> }`,
    })
    const warnings: Array<MigrationWarning> = []
    const migrator = createComponentMigrator(root, root, warnings, 'https://github.com/example/docs')
    migrator.transform("import Implicit from './implicit.jsx'\nimport Explicit from './explicit.jsx'\n\n<Implicit />\n\n<Explicit />", join(root, 'index.mdx'))
    const implicit = migrator.files().find((file) => file.path.endsWith('/implicit.jsx'))!
    expect(implicit.content).toContain("import * as React from 'react'")
    expect(implicit.content).toContain("import { useEffect, useState } from 'react'")
    const explicit = migrator.files().find((file) => file.path.endsWith('/explicit.jsx'))!
    expect(String(explicit.content).match(/import /g)).toHaveLength(1)
    expect(warnings).toEqual([])
  })

  it('extracts a page-local inline component that calls a hook into its own client module', () => {
    const root = fixture({})
    const warnings: Array<MigrationWarning> = []
    const migrator = createComponentMigrator(root, root, warnings, 'https://github.com/example/docs')
    const source = 'export const Counter = () => {\n  const [n, setN] = useState(0)\n  return <button onClick={() => setN(n + 1)}>{n}</button>\n}\n\n<Counter />'
    const body = migrator.transform(source, join(root, 'index.mdx'))

    expect(body).not.toContain('export const Counter')
    expect(body).not.toContain('useState')
    expect(body.trim()).toMatch(/^<Migrated[a-f0-9]+ \/>$/)
    expect(warnings).toEqual([])

    const client = migrator.files().find((file) => file.path.includes('inline-'))!
    expect(client.content).toMatch(/^'use client';/)
    expect(client.content).toContain("import { useState } from 'react'")
    expect(client.content).toContain('export const Counter')
    const registry = migrator.files().find((file) => file.path === 'src/mdx/custom-components.tsx')!
    expect(registry.content).toContain('Counter as Migrated')
  })

  it('extracts an inline hook-using component that the page renders with children', () => {
    const root = fixture({})
    const warnings: Array<MigrationWarning> = []
    const migrator = createComponentMigrator(root, root, warnings, 'https://github.com/example/docs')
    const source = 'export const Counter = ({ children }) => {\n  const [n] = useState(0)\n  return <span>{n}{children}</span>\n}\n\n<Counter>child</Counter>'
    const body = migrator.transform(source, join(root, 'index.mdx'))

    expect(body).not.toContain('export const Counter')
    expect(body).toMatch(/<Migrated[a-f0-9]+>child<\/Migrated[a-f0-9]+>/)
    expect(warnings).toEqual([])
  })

  it('resolves a Thally built-in used by an extracted hook component from the built-in registry', () => {
    const root = fixture({})
    const warnings: Array<MigrationWarning> = []
    const migrator = createComponentMigrator(root, root, warnings, 'https://github.com/example/docs')
    const source = 'export const Snippet2 = () => {\n  const [n] = useState(0)\n  return <CodeBlock>{n}</CodeBlock>\n}\n\n<Snippet2 />'
    migrator.transform(source, join(root, 'index.mdx'))

    const client = migrator.files().find((file) => file.path.includes('inline-'))!
    // `CodeBlock` is a Thally built-in, not declared or imported inside this
    // extracted module: it must be resolved from the built-in registry
    // directly instead of being left as a bare, unbound identifier.
    expect(client.content).toContain("import { builtinMdxComponents } from '@/components/mdx/builtin-components';")
    expect(client.content).toMatch(/const \{ CodeBlock \} = builtinMdxComponents;/)
    expect(warnings).toEqual([])
  })

  it('provides the implicit MintlifyComponents global copied .jsx snippets rely on', () => {
    const root = fixture({
      // Mirrors Mintlify's own snippet convention: no import, a global
      // `MintlifyComponents` object destructured for its built-ins.
      'calculator.jsx': `const { Card, Columns } = MintlifyComponents;\nexport const Calculator = () => <Columns><Card title="x" /></Columns>`,
      'plain.jsx': `export const Plain = () => <div>no globals here</div>`,
    })
    const warnings: Array<MigrationWarning> = []
    const migrator = createComponentMigrator(root, root, warnings, 'https://github.com/example/docs')
    migrator.transform("import Calculator from './calculator.jsx'\nimport Plain from './plain.jsx'\n\n<Calculator />\n\n<Plain />", join(root, 'index.mdx'))
    const calculator = migrator.files().find((file) => file.path.endsWith('/calculator.jsx'))!
    // Every leaf module is imported directly (never the app's
    // mdx-components.tsx registry, which re-exports this very file via
    // custom-components.tsx and would be circular) and aliased so none of
    // the ~50 bare component names land in the snippet's own scope.
    expect(calculator.content).toContain("import { Card as __mintlify_Card")
    expect(calculator.content).toContain("@/components/mdx/content-cards")
    expect(calculator.content).not.toContain('mdx-components')
    expect(calculator.content).toContain('const MintlifyComponents = {')
    expect(calculator.content).toContain('Card: __mintlify_Card')
    expect(calculator.content).toContain('Columns: __mintlify_Columns')
    const plain = migrator.files().find((file) => file.path.endsWith('/plain.jsx'))!
    expect(plain.content).not.toContain('MintlifyComponents')
    expect(warnings).toEqual([])
  })

  it('imports bare Mintlify built-ins used by an interactive snippet', () => {
    const root = fixture({
      'picker.jsx': `export const Picker = () => <Steps><Step title="Start">Hello</Step></Steps>`,
    })
    const migrator = createComponentMigrator(root, root, [], 'https://github.com/example/docs')
    migrator.transform("import { Picker } from './picker.jsx'\n\n<Picker />", join(root, 'index.mdx'))
    const picker = migrator.files().find((file) => file.path.endsWith('/picker.jsx'))!
    expect(picker.content).toContain("import { Steps, Step } from '@/components/mdx/steps';")
  })

  describe('Mintlify global components in preserved modules', () => {
    const REGISTRY_IMPORT = "import { builtinMdxComponents } from '@/components/mdx/builtin-components';"

    /** Copy `snippet.jsx` (or `file`), imported by a page, and return the module the renderer will execute. */
    function copied(source: string, extra: Record<string, string> = {}, warnings: Array<MigrationWarning> = [], file = 'snippet.jsx'): string {
      const root = fixture({ [file]: source, ...extra })
      const migrator = createComponentMigrator(root, root, warnings, 'https://github.com/example/docs')
      migrator.transform(`import { Probe } from './${file}'\n\n<Probe />`, join(root, 'index.mdx'))
      return String(migrator.files().find((copy) => copy.path.endsWith(`/${file}`))!.content)
    }

    it('binds the callout family a snippet renders without declaring (Trigger.dev feature-status.jsx)', () => {
      const warnings: Array<MigrationWarning> = []
      const content = copied([
        'export const RollingOut = ({ children }) => (',
        '  <Warning>',
        '    <strong>Rolling out.</strong> This feature is being enabled gradually.',
        '    {children}',
        '  </Warning>',
        ');',
        'export const PrivateBeta = ({ children }) => (',
        '  <Warning>',
        '    <strong>Private beta.</strong> {children}',
        '  </Warning>',
        ');',
        'export const Probe = () => <Info><Tip>Both bind</Tip></Info>;',
      ].join('\n'), {}, warnings)
      expect(content).toContain(REGISTRY_IMPORT)
      expect(content.match(/const \{ ([^}]+) \} = builtinMdxComponents;/)![1].split(', ')).toEqual(['Info', 'Tip', 'Warning'])
      expect(content.match(/builtinMdxComponents \}/g)).toHaveLength(1)
      expect(content).toContain('<strong>Rolling out.</strong>')
      expect(warnings).toEqual([])
    })

    it('binds every callout name to the built-in registry, not the untyped leaf component', () => {
      const content = copied('export const Probe = () => <><Note>n</Note><Check>c</Check><Danger>d</Danger><Callout type="info">i</Callout></>')
      expect(content).toMatch(/const \{ Callout, Check, Danger, Note \} = builtinMdxComponents;/)
      expect(content).not.toContain('@/components/mdx/note')
    })

    it('binds registry names next to leaf-module imports without declaring any name twice', () => {
      const content = copied('export const Probe = () => <Steps><Step title="a"><Warning>w</Warning></Step></Steps>')
      expect(content).toContain("import { Steps, Step } from '@/components/mdx/steps';")
      expect(content).toMatch(/const \{ Warning \} = builtinMdxComponents;/)
    })

    it('does not shadow names the module declares, imports or receives as parameters', () => {
      const content = copied([
        "import Info from './info.jsx';",
        'const Warning = ({ children }) => <aside>{children}</aside>;',
        'function Tip() { return <p>own</p> }',
        'export const Probe = ({ Check }) => {',
        '  const Danger = () => <b>local</b>;',
        '  return <div><Warning>w</Warning><Info /><Tip /><Check /><Danger /></div>;',
        '};',
      ].join('\n'), { 'info.jsx': 'export default function Info() { return <i>info</i> }' })
      expect(content).not.toContain('builtinMdxComponents')
    })

    it('leaves HTML elements, unknown components and non-global member roots alone', () => {
      const content = copied('export const Probe = () => <div><span>x</span><Widget /><Foo.Bar /><Warning.Title>t</Warning.Title></div>')
      expect(content).toMatch(/const \{ Warning \} = builtinMdxComponents;/)
      expect(content).not.toMatch(/\b(?:div|span|Widget|Foo)\b[^<>]*\} = builtinMdxComponents/)
    })

    it('keeps a module that renders <Error> and also constructs one, and warns instead of shadowing the global', () => {
      const warnings: Array<MigrationWarning> = []
      const content = copied('export const Probe = () => { if (!ok) throw new Error("bad"); return <Error>nope</Error> }', {}, warnings)
      expect(content).not.toContain('builtinMdxComponents')
      expect(content).toContain('throw new Error("bad")')
      expect(warnings).toHaveLength(1)
      expect(warnings[0].message).toContain('snippet.jsx')
      expect(warnings[0].message).toContain('<Error>')
      expect(warnings[0].source).toBe('snippet.jsx')
      expect(copied('export const Probe = () => <Error>nope</Error>')).toMatch(/const \{ Error \} = builtinMdxComponents;/)
    })

    /** Execute a migrated module with React and the built-in registry stubbed; each built-in is a marker function named after its tag. */
    type Rendered = { type: { displayName?: string } }
    type Marker = { displayName?: string }
    function evaluate<T>(moduleSource: string, fileName = 'module.tsx', extraModules: Record<string, unknown> = {}): T {
      const { outputText } = ts.transpileModule(moduleSource, {
        fileName,
        compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2020 },
      })
      const element = (type: unknown, props: unknown) => ({ type, props })
      const registry = new Proxy({}, { get: (_target, name) => (typeof name === 'string' ? Object.assign(() => null, { displayName: name }) : undefined) })
      const stubs: Record<string, unknown> = {
        'react/jsx-runtime': { jsx: element, jsxs: element, Fragment: 'fragment' },
        react: { createElement: (type: unknown, props: unknown) => element(type, props), useState: (value: unknown) => [value, () => undefined] },
        '@/components/mdx/builtin-components': { builtinMdxComponents: registry },
        ...extraModules,
      }
      const exports: Record<string, unknown> = {}
      new Function('require', 'exports', outputText)((id: string) => {
        if (!(id in stubs)) throw new Error(`unexpected import ${id}`)
        return stubs[id]
      }, exports)
      return exports as T
    }

    describe('block scope', () => {
      it.each(['Note', 'Warning'])('binds <%s> used outside the block that declares a component of that name', (name) => {
        const content = copied(`export function Probe({ enabled }) { if (enabled) { const ${name} = () => <aside />; return <${name} />; } return <${name}>global</${name}>; }`)
        expect(content).toMatch(new RegExp(`const \\{ ${name} \\} = builtinMdxComponents;`))
        const { Probe } = evaluate<{ Probe: (props: { enabled: boolean }) => Rendered }>(content)
        // The block's own component wins inside the block; the global one is the built-in.
        expect(Probe({ enabled: true }).type.displayName).toBeUndefined()
        expect(Probe({ enabled: false }).type.displayName).toBe(name)
      })

      it.each([
        ['a for-of binding', 'for (const Warning of list) { return <Warning /> } return <Warning>x</Warning>'],
        ['a for binding', 'for (let Warning = () => null; ; ) { return <Warning /> } return <Warning>x</Warning>'],
        ['a switch case', 'switch (k) { case 1: { const Warning = () => null; return <Warning /> } default: return <Warning>x</Warning> }'],
        ['a switch case without braces', 'switch (k) { case 1: const Warning = () => null; return <Warning /> } return <Warning>x</Warning>'],
        ['a catch parameter', 'try { list() } catch (Warning) { return <Warning /> } return <Warning>x</Warning>'],
        ['a block-level function', 'if (k) { function Warning() { return null } return <Warning /> } return <Warning>x</Warning>'],
        ['a block-level class', 'if (k) { class Warning { render() { return null } } return <Warning /> } return <Warning>x</Warning>'],
        ['a nested block', 'if (k) { if (list) { let Warning = () => null; void Warning } } return <Warning>x</Warning>'],
      ])('binds <Warning> outside the scope of %s', (_label, body) => {
        expect(copied(`export function Probe({ k, list }) { ${body} }`)).toMatch(/const \{ Warning \} = builtinMdxComponents;/)
      })

      it('leaves a name alone wherever the block that declares it is the only place it is used', () => {
        const content = copied([
          'export function Probe({ on, list }) {',
          '  if (on) { const Tip = () => <i />; return <Tip /> }',
          '  for (const Warning of list) { void <Warning /> }',
          '  try { list() } catch (Info) { return <Info /> }',
          '  return null',
          '}',
        ].join('\n'))
        expect(content).not.toContain('builtinMdxComponents')
      })

      it('keeps a `var` in a block visible to the whole function, as the language does', () => {
        expect(copied('export function Probe({ on }) { if (on) { var Info = () => <i /> } return <Info /> }')).not.toContain('builtinMdxComponents')
      })

      it('keeps a name bound by a function parameter or a body-level declaration', () => {
        expect(copied('export function Probe({ Check }) { const Danger = () => null; return <><Check /><Danger /></> }')).not.toContain('builtinMdxComponents')
      })
    })

    describe('parameter initialisers', () => {
      type Probed = { Probe: (...args: Array<unknown>) => Rendered }

      // Defaults run in the parameter scope, before the body's declarations exist: the
      // body's `Note` is a different binding, so the default still reads the built-in.
      it.each([
        ['a function declaration', 'export function Probe(Component = Note) { var Note = () => null; return React.createElement(Component) }'],
        ['a function expression', 'export const Probe = function (Component = Note) { var Note = () => null; return React.createElement(Component) }'],
        ['an arrow function', 'export const Probe = (Component = Note) => { var Note = () => null; return React.createElement(Component) }'],
        ['a method', 'export const Probe = { render(Component = Note) { var Note = () => null; return React.createElement(Component) } }.render'],
        ['an object destructuring default', 'export function Probe({ C = Note } = {}) { var Note = () => null; return React.createElement(C) }'],
        ['an array destructuring default', 'export const Probe = ([C = Note] = []) => { var Note = () => null; return React.createElement(C) }'],
        ['a nested destructuring default', 'export function Probe({ a: [{ C = Note }] } = { a: [{}] }) { var Note = () => null; return React.createElement(C) }'],
        ['a computed destructuring key', 'export function Probe({ [Note.displayName]: C = Note } = {}) { var Note = () => null; return React.createElement(C) }'],
        ['a closure in a default', 'export function Probe(get = () => Note) { var Note = () => null; return React.createElement(get()) }'],
      ])('binds a built-in read by %s, although the body declares a `var` of that name', (_label, source) => {
        const content = copied(source)
        expect(content).toMatch(/const \{ Note \} = builtinMdxComponents;/)
        // Unbound, the default would throw `ReferenceError: Note is not defined`.
        expect(evaluate<Probed>(content).Probe().type.displayName).toBe('Note')
      })

      it('binds a built-in a class constructor default reads, although the constructor body declares a `var` of that name', () => {
        const content = copied('export class Probe { constructor(Component = Note) { var Note = () => null; this.type = Component } }')
        expect(content).toMatch(/const \{ Note \} = builtinMdxComponents;/)
        const { Probe } = evaluate<{ Probe: new () => Rendered }>(content)
        expect(new Probe().type.displayName).toBe('Note')
      })

      it.each([
        ['a var', 'var Note = () => null'],
        ['a function declaration', 'function Note() { return null }'],
        ['a const', 'const Note = () => null'],
        ['a let', 'let Note = () => null'],
        ['a class', 'class Note {}'],
      ])('binds a built-in a default reads, although the body declares %s of that name', (_label, declaration) => {
        const content = copied(`export function Probe(Component = Note) { ${declaration}; void Note; return React.createElement(Component) }`)
        expect(content).toMatch(/const \{ Note \} = builtinMdxComponents;/)
        expect(evaluate<Probed>(content).Probe().type.displayName).toBe('Note')
      })

      const marker = Object.assign(() => null, { displayName: 'mine' })
      it.each([
        ['an earlier parameter', 'export function Probe(Note, Component = Note) { return React.createElement(Component) }', [marker]],
        ['an earlier arrow parameter', 'export const Probe = (Note, Component = Note) => React.createElement(Component)', [marker]],
        ['an earlier destructured parameter', 'export const Probe = ({ Note }, Component = Note) => React.createElement(Component)', [{ Note: marker }]],
        ['an earlier element of the same pattern', 'export function Probe({ Note, C = Note }) { return React.createElement(C) }', [{ Note: marker }]],
      ])('leaves a name alone when a default reads %s of that name', (_label, source, args) => {
        const content = copied(source)
        expect(content).not.toContain('builtinMdxComponents')
        expect(evaluate<Probed>(content).Probe(...args).type).toBe(marker)
      })

      it('leaves a function expression\'s own name alone when a default reads it', () => {
        const content = copied('export const Probe = function Note(Component = Note) { return React.createElement(Component) }')
        expect(content).not.toContain('builtinMdxComponents')
        const { Probe } = evaluate<Probed>(content)
        expect(Probe().type).toBe(Probe)
      })

      it.each([
        ['a var', 'var Note = () => null'],
        ['a function declaration', 'function Note() { return null }'],
        ['a const', 'const Note = () => null'],
        ['a class', 'class Note {}'],
      ])('leaves a name alone when only the body uses it and the body declares %s of it', (_label, declaration) => {
        const content = copied(`export function Probe(Component = null) { ${declaration}; return React.createElement(Component ?? Note) }`)
        expect(content).not.toContain('builtinMdxComponents')
        expect(evaluate<Probed>(content).Probe().type.displayName).toBeUndefined()
      })

      it('leaves a name alone when only an arrow body uses it and the body declares a `var` of it', () => {
        const content = copied('export const Probe = (Component = null) => { var Note = () => null; return React.createElement(Component ?? Note) }')
        expect(content).not.toContain('builtinMdxComponents')
        expect(evaluate<Probed>(content).Probe().type.displayName).toBeUndefined()
      })
    })

    describe('module-level `var`', () => {
      const probe = (declaration: string, tag = 'Warning'): string => `${declaration}\nexport const Probe = () => <${tag} />;`

      it.each([
        ['a block', 'if (true) { var Warning = () => null }'],
        ['a destructuring pattern', 'if (true) { var { Warning } = { Warning: () => null } }'],
        ['an array pattern', 'if (true) { var [Warning] = [() => null] }'],
        ['a nested pattern with a default and a rest element', 'if (true) { var { a: [{ Warning = () => null }], ...rest } = { a: [{}] } }'],
        ['a for loop head', 'for (var Warning = () => null, i = 0; i < 1; i++) {}'],
        ['a for-of head', 'for (var Warning of [() => null]) {}'],
        ['a for-in head', 'for (var Warning in { a: 1 }) {}'],
        ['a loop body', 'while (true) { var Warning = () => null; break }'],
        ['a try block', 'try { var Warning = () => null } catch (e) {}'],
        ['a catch block', 'try { throw 1 } catch (e) { var Warning = () => null }'],
        ['a finally block', 'try {} finally { var Warning = () => null }'],
        ['a switch case', 'switch (1) { case 1: var Warning = () => null }'],
        ['a labeled block', 'outer: { var Warning = () => null }'],
      ])('does not bind <Warning> over a `var` declared in %s', (_label, declaration) => {
        const content = copied(probe(declaration))
        // The migrated module must parse and run: a second declaration of the name is a SyntaxError.
        expect(evaluate<{ Probe: () => Rendered }>(content).Probe().type.displayName).toBeUndefined()
        expect(content).not.toContain('builtinMdxComponents')
      })

      it('does not import a leaf component, a hook or React over a `var` of the same name', () => {
        const content = copied('if (true) { var Card = () => null; var useState = () => [0]; var React = { createElement: () => null } }\nexport const Probe = () => { const [n] = useState(); return <Card>{n}</Card> }')
        expect(content).not.toContain("from 'react'")
        expect(content).not.toContain('@/components/mdx/card')
        expect(() => evaluate<{ Probe: () => Rendered }>(content).Probe()).not.toThrow()
      })

      it.each([
        ['a function', 'const f = () => { var Warning = 1; return Warning }'],
        ['a method', 'class A { m() { var Warning = 1; return Warning } }'],
        ['a class static block', 'class A { static { var Warning = 1; void Warning } }'],
        ['a block-level function', 'if (true) { function Warning() { return null } }'],
        ['a block-level class', 'if (true) { class Warning {} }'],
        ['a block-level let', 'if (true) { let Warning = () => null; void Warning }'],
      ])('still binds <Warning> when only %s declares that name', (_label, declaration) => {
        const content = copied(probe(declaration))
        expect(content).toMatch(/const \{ Warning \} = builtinMdxComponents;/)
        expect(evaluate<{ Probe: () => Rendered }>(content).Probe().type.displayName).toBe('Warning')
      })
    })

    describe('value references', () => {
      it('binds a built-in a module passes to createElement or aliases, like one it renders as a tag', () => {
        const content = copied([
          "export const Probe = () => React.createElement(Note, null, 'x');",
          'export const Alias = Warning;',
          'export const Table = { info: Info, tip: Tip };',
        ].join('\n'))
        expect(content.match(/const \{ ([^}]+) \} = builtinMdxComponents;/)![1].split(', ')).toEqual(['Info', 'Note', 'Tip', 'Warning'])
        const { Probe, Alias, Table } = evaluate<{ Probe: () => Rendered; Alias: Marker; Table: { info: Marker } }>(content)
        expect(Probe().type.displayName).toBe('Note')
        expect(Alias.displayName).toBe('Warning')
        expect(Table.info.displayName).toBe('Info')
      })

      it('binds a built-in read as a value inside a function, a default parameter and a JSX prop', () => {
        const content = copied('export const Probe = ({ as = Callout }) => <Wrapper as={Note} fallback={as} />')
        expect(content).toMatch(/const \{ Callout, Note \} = builtinMdxComponents;/)
      })

      it('never rebinds a value name the module declares, imports or receives as a parameter', () => {
        const content = copied([
          "import Info from './info.jsx';",
          'const Warning = () => null;',
          'export const Probe = ({ Check }) => {',
          '  const Danger = () => null;',
          '  return [Warning, Info, Check, Danger, Tip].map((Component) => React.createElement(Component));',
          '};',
        ].join('\n'), { 'info.jsx': 'export default function Info() { return <i /> }' })
        expect(content.match(/const \{ ([^}]+) \} = builtinMdxComponents;/)![1]).toBe('Tip')
      })

      it('does not bind a name only a block-level declaration of the module uses', () => {
        expect(copied('export const Probe = ({ on }) => { if (on) { const Note = () => null; return React.createElement(Note) } return null }')).not.toContain('builtinMdxComponents')
      })

      it('leaves a JavaScript or browser global that shares a built-in name alone when it is only read as a value', () => {
        const content = copied('export const Probe = () => { const f = new File(["a"], "a.txt"); throw new Error(String(f)) }')
        expect(content).not.toContain('builtinMdxComponents')
      })

      describe('in every module file type', () => {
        const createElementProbe = "import { createElement } from 'react';\nexport const Probe = () => createElement(Note, null, 'Hello');"

        it.each(['banner.ts', 'banner.tsx', 'banner.jsx', 'banner.js', 'banner.mjs'])('binds a built-in a %s module passes to createElement, so it runs', (file) => {
          const content = copied(createElementProbe, {}, [], file)
          expect(content).toMatch(/const \{ Note \} = builtinMdxComponents;/)
          expect(evaluate<{ Probe: () => Rendered }>(content, file.endsWith('.ts') ? file : undefined).Probe().type.displayName).toBe('Note')
        })

        it('reads a .ts module the way TypeScript does: angle-bracket assertions and generic arrows are not JSX', () => {
          const content = copied([
            "import { createElement } from 'react';",
            'const id = <T>(value: T): T => value;',
            "export const Probe = () => createElement(Note, null, <string>id('x'));",
          ].join('\n'), {}, [], 'banner.ts')
          expect(content).toMatch(/const \{ Note \} = builtinMdxComponents;/)
          expect(evaluate<{ Probe: () => Rendered }>(content, 'banner.ts').Probe().type.displayName).toBe('Note')
        })

        it('never rebinds a name a .ts module declares as an enum, a namespace or an import alias', () => {
          const content = copied([
            "import { createElement } from 'react';",
            "export enum Color { Red = 'red' }",
            'export namespace Tip { export const kind = 1 }',
            'import Danger = Tip;',
            'export const Probe = () => createElement(Note, null, Color.Red, Tip.kind, Danger.kind, Check);',
          ].join('\n'), {}, [], 'banner.ts')
          expect(content.match(/const \{ ([^}]+) \} = builtinMdxComponents;/)![1]).toBe('Check, Note')
          // A second declaration of any of those names would be a SyntaxError here.
          expect(evaluate<{ Probe: () => Rendered }>(content, 'banner.ts').Probe().type.displayName).toBe('Note')
        })

        it('leaves a .ts module that never reads a built-in alone', () => {
          expect(copied("export const label = (kind: string): string => kind.toUpperCase();", {}, [], 'labels.ts')).not.toContain('builtinMdxComponents')
        })
      })

      it('keeps the <Error> rule: a tag alone binds, a tag beside the global is left unbound with a warning', () => {
        const warnings: Array<MigrationWarning> = []
        expect(copied('export const Probe = () => React.createElement(Error)')).not.toContain('builtinMdxComponents')
        expect(copied('export const Probe = () => { if (!ok) throw new Error("bad"); return <Error>nope</Error> }', {}, warnings)).not.toContain('builtinMdxComponents')
        expect(warnings).toHaveLength(1)
      })
    })

    describe('registry import name', () => {
      type Probed = { type: { displayName?: string }; props: { children?: unknown } }

      /** Execute a migrated module, first requiring that a bundler accepts it: esbuild rejects a name declared twice ("has already been declared"). */
      function run<T>(content: string, extraModules: Record<string, unknown> = {}): T {
        expect(() => transformSync(content, { loader: 'jsx' })).not.toThrow()
        return evaluate<T>(content, 'module.tsx', extraModules)
      }

      it('imports the registry under a free name when the module declares builtinMdxComponents itself', () => {
        const content = copied('const builtinMdxComponents = { label: "local data" };\nexport const Probe = () => <Note>{builtinMdxComponents.label}</Note>;')
        expect(content).toContain("import { builtinMdxComponents as builtinMdxComponents2 } from '@/components/mdx/builtin-components';")
        expect(content).toContain('const { Note } = builtinMdxComponents2;')
        const probe = run<{ Probe: () => Probed }>(content).Probe()
        expect(probe.type.displayName).toBe('Note')
        expect(probe.props.children).toBe('local data')
      })

      it('skips suffixes the module already uses', () => {
        const content = copied('const builtinMdxComponents = 1, builtinMdxComponents2 = 2;\nexport const Probe = () => <Note>{builtinMdxComponents + builtinMdxComponents2}</Note>;')
        expect(content).toContain('const { Note } = builtinMdxComponents3;')
        expect(run<{ Probe: () => Probed }>(content).Probe().props.children).toBe(3)
      })

      it('imports the registry under a free name when the module imports builtinMdxComponents from elsewhere', () => {
        const content = copied(
          "import { builtinMdxComponents } from './data.js';\nexport const Probe = () => <Note>{builtinMdxComponents.label}</Note>;",
          { 'data.js': "export const builtinMdxComponents = { label: 'imported data' };" },
        )
        expect(content).toContain('const { Note } = builtinMdxComponents2;')
        const dataModule = content.match(/from "(\.\/[^"]+)"/)![1]
        const probe = run<{ Probe: () => Probed }>(content, { [dataModule]: { builtinMdxComponents: { label: 'imported data' } } }).Probe()
        expect(probe.type.displayName).toBe('Note')
        expect(probe.props.children).toBe('imported data')
      })

      it('imports the registry under a free name when the module reads builtinMdxComponents as a global', () => {
        const content = copied('export const Probe = () => <Note>{builtinMdxComponents.label}</Note>;')
        expect(content).toContain('const { Note } = builtinMdxComponents2;')
        const host = globalThis as Record<string, unknown>
        host.builtinMdxComponents = { label: 'global data' }
        try {
          expect(run<{ Probe: () => Probed }>(content).Probe().props.children).toBe('global data')
        } finally {
          delete host.builtinMdxComponents
        }
      })

      it('imports the registry under a free name in a hook component extracted into its own module', () => {
        const root = fixture({})
        const migrator = createComponentMigrator(root, root, [], 'https://github.com/example/docs')
        migrator.transform([
          "export const builtinMdxComponents = { label: 'page data' }",
          'export const Gate = () => {',
          '  const [n] = useState(0)',
          '  return <Warning>{builtinMdxComponents.label}{n}</Warning>',
          '}',
          '',
          '<Gate />',
        ].join('\n'), join(root, 'index.mdx'))
        const inline = String(migrator.files().find((file) => file.path.includes('/inline-'))!.content)
        expect(inline).toContain('const { Warning } = builtinMdxComponents2;')
        const probe = run<{ Gate: () => Probed }>(inline).Gate()
        expect(probe.type.displayName).toBe('Warning')
        expect(probe.props.children).toEqual(['page data', 0])
      })

      it('imports the registry under a free name in a page-level component that travels with an interactive root', () => {
        const root = fixture({})
        const migrator = createComponentMigrator(root, root, [], 'https://github.com/example/docs')
        migrator.transform([
          "export const builtinMdxComponents = { label: 'page data' }",
          'export const Notice = () => <Warning>{builtinMdxComponents.label}</Warning>',
          '',
          '<div onClick={() => {}}>Click</div>',
        ].join('\n'), join(root, 'index.mdx'))
        const inline = String(migrator.files().find((file) => file.path.includes('/inline-'))!.content)
        expect(inline).toContain('const { Warning } = builtinMdxComponents2;')
        const probe = run<{ Notice: () => Probed }>(inline).Notice()
        expect(probe.type.displayName).toBe('Warning')
        expect(probe.props.children).toBe('page data')
      })

      it('keeps the plain name when nothing in the module uses it', () => {
        const content = copied('export const Probe = () => <Note>x</Note>;')
        expect(content).toContain("import { builtinMdxComponents } from '@/components/mdx/builtin-components';\nconst { Note } = builtinMdxComponents;")
        expect(content).not.toContain(' as builtinMdxComponents')
        expect(run<{ Probe: () => Probed }>(content).Probe().type.displayName).toBe('Note')
      })
    })

    it('binds callouts used by a page-level component that travels with an interactive root', () => {
      const root = fixture({})
      const migrator = createComponentMigrator(root, root, [], 'https://github.com/example/docs')
      migrator.transform('export const Notice = () => <Warning>Heads up</Warning>\n\n<div onClick={() => {}}>Click</div>', join(root, 'index.mdx'))
      const inline = String(migrator.files().find((file) => file.path.includes('/inline-'))!.content)
      expect(inline).toContain(REGISTRY_IMPORT)
      expect(inline).toMatch(/const \{ Warning \} = builtinMdxComponents;/)
    })

    it('binds callouts in a hook component extracted into its own module', () => {
      const root = fixture({})
      const migrator = createComponentMigrator(root, root, [], 'https://github.com/example/docs')
      migrator.transform('export const Gate = () => {\n  const [n] = useState(0)\n  return <Warning>{n}</Warning>\n}\n\n<Gate />', join(root, 'index.mdx'))
      const inline = String(migrator.files().find((file) => file.path.includes('/inline-'))!.content)
      expect(inline.match(/builtinMdxComponents \}/g)).toHaveLength(1)
      expect(inline).toMatch(/const \{ Warning \} = builtinMdxComponents;/)
    })

    it('binds the same names for Mintlify, Docusaurus and Fern repositories (one shared copy path)', () => {
      const snippet = 'export const Probe = () => <Warning>shared</Warning>'
      const bound = (bundle: ReturnType<typeof migrateRepository>) => String(bundle.componentFiles!.find((file) => file.path.endsWith('/snippet.jsx'))!.content)
      const mintlify = migrateRepository({
        repositoryDir: fixture({
          'docs.json': JSON.stringify({ navigation: { pages: ['index'] } }),
          'index.mdx': "---\ntitle: Home\n---\nimport { Probe } from '/snippets/snippet.jsx'\n\n<Probe />",
          'snippets/snippet.jsx': snippet,
        }),
        sourceUrl: 'https://example.com/docs', platform: 'mintlify',
      })
      expect(bound(mintlify)).toMatch(/const \{ Warning \} = builtinMdxComponents;/)
      expect(withoutDashboardWarning(mintlify.warnings)).toEqual([])
      const docusaurus = migrateRepository({
        repositoryDir: fixture({
          'docusaurus.config.js': 'module.exports = {}',
          'docs/index.mdx': "import { Probe } from '@site/src/snippet.jsx'\n\n<Probe />",
          'src/snippet.jsx': snippet,
        }),
        sourceUrl: 'https://github.com/example/docs', platform: 'docusaurus',
      })
      expect(bound(docusaurus)).toMatch(/const \{ Warning \} = builtinMdxComponents;/)
      const fern = migrateRepository({
        repositoryDir: fixture({
          'fern/fern.config.json': '{}',
          'fern/docs.yml': 'navigation:\n  - page: Guide\n    path: guide.mdx\n',
          'fern/guide.mdx': "import { Probe } from './snippet.jsx'\n\n# Guide\n\n<Probe />",
          'fern/snippet.jsx': snippet,
        }),
        sourceUrl: 'https://github.com/acme/docs', platform: 'fern',
      })
      expect(bound(fern)).toMatch(/const \{ Warning \} = builtinMdxComponents;/)
    })
  })

  it('registers multiline named/default imports and copies their dependency graph once', () => {
    const root = fixture({
      'docs.json': JSON.stringify({ navigation: { pages: ['index'] } }),
      'index.mdx': `---\ntitle: Home\n---\nimport DefaultWidget, {\n  Counter as Visits,\n} from '/snippets/widget'\n\n<Visits initial={4} />\n\n<DefaultWidget>Children</DefaultWidget>`,
      'snippets/widget.tsx': `import { useState } from 'react';\nimport { label } from './label.js';\nexport const Counter = ({ initial = 0 }) => { const [n, setN] = useState(initial); return <button onClick={() => setN(n + 1)}>{label}: {n}</button> };\nexport default function Widget({ children }) { return <div>{children}</div> }`,
      'snippets/label.ts': `export { label } from './data';`,
      'snippets/data.ts': `export const label = 'Visits';`,
    })
    const bundle = migrateRepository({ repositoryDir: root, sourceUrl: 'https://example.com/docs', platform: 'mintlify' })
    expect(withoutDashboardWarning(bundle.warnings)).toEqual([])
    const body = bundle.pages[0].body
    expect(body).not.toContain('import ')
    expect(body).not.toContain('<Visits')
    expect(body).toMatch(/<Migrated[a-f0-9]+ initial=\{4\} \/>/)
    expect(body).toMatch(/<Migrated[a-f0-9]+>Children<\/Migrated[a-f0-9]+>/)
    const files = renderMigrationFiles(bundle)
    expect(files.filter((file) => file.path.endsWith('/widget.tsx'))).toHaveLength(1)
    const widget = files.find((file) => file.path.endsWith('/widget.tsx'))!
    expect(widget.content).toContain("'use client';")
    expect(widget.content).toContain('"./label"')
    expect(files.find((file) => file.path === 'src/mdx/custom-components.tsx')?.content).not.toContain('widget.tsx')
    expect(files.find((file) => file.path === 'src/mdx/custom-components.tsx')?.content).toContain('Counter as Migrated')
    expect(files.find((file) => file.path === 'src/mdx/custom-components.tsx')?.content).toContain('default as Migrated')
  })

  it('keeps identically named imports page-local and leaves fenced examples untouched', () => {
    const root = fixture({ 'one.jsx': 'export default () => <p>One</p>', 'two.jsx': 'export default () => <p>Two</p>' })
    const warnings: Array<MigrationWarning> = []
    const migrator = createComponentMigrator(root, root, warnings, 'https://github.com/example/docs')
    const first = migrator.transform("import Widget from './one.jsx'\n\n<Widget />\n\n```jsx\nimport Widget from './missing.jsx'\n<Widget />\n```", join(root, 'one.mdx'))
    const second = migrator.transform("import Widget from './two.jsx'\n\n<Widget />", join(root, 'two.mdx'))
    expect(first.match(/<Migrated[^ ]+/)?.[0]).not.toBe(second.match(/<Migrated[^ ]+/)?.[0])
    expect(first).toContain("```jsx\nimport Widget from './missing.jsx'\n<Widget />\n```")
    expect(warnings).toEqual([])
  })

  it('extracts HTML event handlers into client JSX while preserving passive MDX', () => {
    const root = fixture({})
    const warnings: Array<MigrationWarning> = []
    const migrator = createComponentMigrator(root, root, warnings, 'https://github.com/example/docs')
    const body = migrator.transform(`---\ntitle: Welcome\nmode: custom\n---\nexport function openSearch() { document.getElementById('search-bar-entry').click(); }\n\n<div><button onClick={openSearch}>Search docs</button></div>\n\n<CardGroup cols={2}>\n  <Card title="Start" href="/start">Read the guide</Card>\n</CardGroup>`, join(root, 'home.mdx'))
    expect(body).toContain('title: Welcome')
    expect(body).toContain('<CardGroup cols={2}>')
    expect(body).toMatch(/<Migrated[a-f0-9]+ \/>/)
    expect(body).not.toContain('onClick')
    expect(body).not.toContain('export function')
    const inline = migrator.files().find((file) => file.path.includes('/inline-'))!
    // Exactly one directive, and it must lead the file, or Next rejects the
    // module ("use client" must be the first statement).
    expect(String(inline.content).match(/'use client'/g)).toHaveLength(1)
    expect(inline.content).toMatch(/^'use client';/)
    expect(inline.content).toContain('onClick={openSearch}')
    expect(inline.content).toContain("new KeyboardEvent('keydown'")
    expect(warnings).toEqual([])
  })

  it('extracts a page-local stateful declaration invoked via a bare tag, so its hooks resolve in the client module', () => {
    const root = fixture({})
    const warnings: Array<MigrationWarning> = []
    const migrator = createComponentMigrator(root, root, warnings, 'https://github.com/example/docs')
    // Mintlify makes `useState` available without import inside inline
    // MDX-declared components. The invocation tag `<Counter />` itself has no
    // `onClick`, so nothing about its own JSX marks it interactive — only the
    // declaration body does. Left inline, this compiles into the page's own
    // server-rendered module, where `useState` is never in scope.
    const source = `export const Counter = () => {\n  const [count, setCount] = useState(0)\n  return <button onClick={() => setCount(count + 1)}>{count}</button>\n}\n\n<Counter />`
    const body = migrator.transform(source, join(root, 'index.mdx'))
    expect(body).not.toContain('export const Counter')
    expect(body).toMatch(/<Migrated[a-f0-9]+ \/>/)
    const inline = migrator.files().find((file) => file.path.includes('/inline-'))!
    expect(inline.content).toContain("import { useState } from 'react'")
    expect(String(inline.content).match(/'use client'/g)).toHaveLength(1)
    expect(inline.content).toMatch(/^'use client';/)
    expect(warnings).toEqual([])
  })

  it('keeps a copied client playground with a page-local code callback and MDX children', () => {
    const root = fixture({ 'playground.jsx': 'export const Playground = ({ children, CodeBlockComponent }) => <section><CodeBlockComponent>sample</CodeBlockComponent>{children}</section>' })
    const warnings: Array<MigrationWarning> = []
    const migrator = createComponentMigrator(root, root, warnings, 'https://github.com/example/docs')
    const source = "import { Playground } from './playground.jsx'\n\nexport const WidgetCodeBlock = ({ children, ...props }) => (<CodeBlock {...props}>{children}</CodeBlock>);\n\n<Playground CodeBlockComponent={WidgetCodeBlock}><Warning>Keep this.</Warning></Playground>"
    const body = migrator.transform(source, join(root, 'index.mdx'))
    expect(body).toMatch(/<Migrated[a-f0-9]+ ><Warning>Keep this.<\/Warning><\/Migrated[a-f0-9]+>/)
    expect(body).not.toContain('CodeBlockComponent={WidgetCodeBlock}')
    const adapter = migrator.files().find((file) => file.path.includes('/callback-'))!
    expect(adapter.content).toContain("'use client';")
    expect(adapter.content).toContain('<pre><code>{children}</code></pre>')
    expect(adapter.content).toContain('CodeBlockComponent={WidgetCodeBlock}')
    expect(warnings[0].message).toContain('basic code block')
  })

  it('removes a React hook import unused outside fenced examples', () => {
    const root = fixture({})
    const warnings: Array<MigrationWarning> = []
    const migrator = createComponentMigrator(root, root, warnings, 'https://github.com/example/docs')
    const source = 'import { useState } from "react";\n\n<Step title="Example">\n\n```tsx\nconst [count] = useState(0);\n```\n\n</Step>'
    const body = migrator.transform(source, join(root, 'index.mdx'))
    expect(body).not.toContain('import { useState }')
    expect(body).toContain('const [count] = useState(0)')
  })

  it('keeps imports inside an indented JSX code fence as part of the example', () => {
    const root = fixture({})
    const warnings: Array<MigrationWarning> = []
    const migrator = createComponentMigrator(root, root, warnings, 'https://github.com/example/docs')
    const source = '<Steps>\n  <Step title="Use the hook">\n    ```tsx\n    import { useState } from "react";\n    import { useChat } from "@ai-sdk/react";\n\n    function MyComponent() { const [input] = useState(""); return input }\n    ```\n  </Step>\n</Steps>'
    const body = migrator.transform(source, join(root, 'index.mdx'))
    expect(body).toContain('```tsx\nimport { useState } from "react";\nimport { useChat } from "@ai-sdk/react";')
    expect(body).toMatch(/^<Steps>/)
    expect(warnings).toEqual([])
  })

  it('preserves shared declarations when passive page expressions still reference them', () => {
    const root = fixture({})
    const warnings: Array<MigrationWarning> = []
    const migrator = createComponentMigrator(root, root, warnings, 'https://github.com/example/docs')
    const source = `export const label = 'Visible';\n\n<div onClick={() => {}}>{label}</div>\n\n{label}`
    expect(migrator.transform(source, join(root, 'index.mdx'))).toBe(source)
    expect(migrator.files()).toEqual([])
    expect(warnings[0].message).toContain('shares declarations')
  })

  it.each([
    ["export const props = { title: 'Visible' };", '<Card {...props} />'],
    ["export const UI = { Card: () => <p>Visible</p> };", '<UI.Card />'],
    ["export const Widget = () => <p>Visible</p>;", '<Widget />'],
  ])('preserves shared declarations referenced through JSX spreads or component tags: %s', (declaration, usage) => {
    const root = fixture({})
    const warnings: Array<MigrationWarning> = []
    const migrator = createComponentMigrator(root, root, warnings, 'https://github.com/example/docs')
    const source = `${declaration}\n\n<div onClick={() => {}}>Click</div>\n\n${usage}`
    expect(migrator.transform(source, join(root, 'index.mdx'))).toBe(source)
    expect(migrator.files()).toEqual([])
    expect(warnings[0].message).toContain('shares declarations')
  })

  it.each([
    '{true && <Widget />}',
    '<Widget.Item />',
    'export const Wrapped = () => <Widget />;\n\n<Wrapped />',
    '<Other as={Widget} />',
    '<Other {...{ component: Widget }} />',
  ])('gives a binding a real import, not the aliased components registry, whenever it is used anywhere but a direct top-level JSX tag: %s', (usage) => {
    // MDX's own component-injection pass (recma-jsx-rewrite) — and the
    // alias-rename walk that mirrors it further down this file — only
    // reach a JSX tag that is a genuine, direct mdast JSX node (`<Widget
    // />` as its own markdown/JSX child). Nested inside a `{...}`
    // expression, inside an `export const` declaration's function body, as
    // a member tag (`<Widget.Item />`), or passed as a plain prop value —
    // none of these are visible to either mechanism, so registering the
    // binding under an aliased key (`Migratedxxx`) would leave the page's
    // still-literal reference to `Widget` unresolved (`ReferenceError` at
    // render — reproduced against a real Cohere build). A real import,
    // keeping the original name, resolves every one of these directly.
    const root = fixture({ 'widget.jsx': 'export default () => <p>Widget</p>' })
    const warnings: Array<MigrationWarning> = []
    const migrator = createComponentMigrator(root, root, warnings, 'https://github.com/example/docs')
    const source = `import Widget from './widget.jsx'\n\n${usage}`
    const body = migrator.transform(source, join(root, 'index.mdx'))
    expect(body).not.toContain("from './widget.jsx'")
    expect(body).toMatch(/^import \{ default as Widget \} from ['"]@\//m)
    expect(body).toContain(usage)
    // Only the copied component — nothing was registered, so no registry file is emitted.
    expect(migrator.files()).toHaveLength(1)
    expect(warnings).toEqual([])
  })

  it('removes the dead import (without excluding the page) when the local component copy genuinely fails', () => {
    const root = fixture({})
    const warnings: Array<MigrationWarning> = []
    const migrator = createComponentMigrator(root, root, warnings, 'https://github.com/example/docs')
    // './missing.jsx' does not exist on disk, so `resolveDependency` throws;
    // that is a genuine copy failure, distinct from any usage pattern. The
    // dead import is dropped and `<Widget />` is left for the page-level
    // unknown-component fallback to neutralize, rather than excluding the
    // whole page.
    const source = "import Widget from './missing.jsx'\n\n<Widget />"
    expect(migrator.transform(source, join(root, 'index.mdx'))).toBe('\n\n<Widget />')
    expect(migrator.files()).toEqual([])
    expect(warnings).toContainEqual(expect.objectContaining({ message: expect.stringContaining('could not be copied and was removed') }))
    expect(warnings.some((warning) => warning.code === 'skipped-file')).toBe(false)
  })

  it('handles cycles without evaluating any source', () => {
    const root = fixture({
      'widget.jsx': "import './helper.js';\nthrow new Error('must never execute');\nexport default () => <div />;",
      'helper.js': "import './widget.jsx';\nexport const value = 1;",
    })
    const warnings: Array<MigrationWarning> = []
    const migrator = createComponentMigrator(root, root, warnings, 'https://github.com/example/docs')
    expect(() => migrator.transform("import Widget from './widget.jsx'\n\n<Widget />", join(root, 'index.mdx'))).not.toThrow()
    expect(migrator.files()).toHaveLength(3)
    expect(warnings).toEqual([])
  })

  it.each([
    ['traversal', "import data from '../outside.js'"],
    ['external package', "import data from 'unavailable-package'"],
    ['computed import', 'const data = import(window.location.hash)'],
    ['missing dependency', "import data from './missing.js'"],
    ['server directive', "'use server'"],
  ])('warns and removes the dead import for unsupported %s source, leaving its JSX usage for the page-level fallback', (_name, dependency) => {
    const root = fixture({ 'widget.jsx': `${dependency};\nexport default () => <div />` })
    const warnings: Array<MigrationWarning> = []
    const migrator = createComponentMigrator(root, root, warnings, 'https://github.com/example/docs')
    const source = "import Widget from './widget.jsx'\n\n<Widget />"
    // The import itself is removed (leaving it would reference a module the
    // migrated project never has, breaking `next build` for the whole
    // site); `<Widget />` is untouched here — repository.ts's page-level
    // `replaceUnknownComponents` pass (mdx.ts) neutralizes it afterward,
    // since `Widget` is no longer declared anywhere on the page.
    expect(migrator.transform(source, join(root, 'index.mdx'))).toBe('\n\n<Widget />')
    expect(migrator.files()).toEqual([])
    expect(warnings).toHaveLength(1)
    expect(warnings[0].message).toContain('could not be copied and was removed')
  })

  it('removes an unsupported npm-package MDX import and replaces its usage instead of shipping a broken build', () => {
    const root = fixture({})
    const warnings: Array<MigrationWarning> = []
    const migrator = createComponentMigrator(root, root, warnings, 'https://github.com/example/docs')
    const source = "import LiteYouTubeEmbed from 'react-lite-youtube-embed';\n\n<LiteYouTubeEmbed id=\"3YDiloj8_d0\" />"
    const result = migrator.transform(source, join(root, 'index.mdx'))
    expect(result).not.toContain('react-lite-youtube-embed')
    expect(result).not.toContain('LiteYouTubeEmbed')
    expect(result).toContain('<iframe')
    expect(result).toContain('3YDiloj8_d0')
    expect(warnings).toEqual([expect.objectContaining({
      code: 'unsupported-config',
      message: expect.stringContaining("'react-lite-youtube-embed'"),
      source: 'index.mdx',
    })])
  })

  it('embeds a YouTube iframe for a locally-owned @site/... wrapper whose own body imports a known YouTube-embed package, instead of losing the embed to the generic unknown-component fallback (Playwright: LiteYouTube wraps react-lite-youtube-embed)', () => {
    const root = fixture({
      'src/components/LiteYouTube/index.tsx': "import LiteYouTubeEmbed from 'react-lite-youtube-embed';\nexport default function LiteYouTube({ id, title }) { return <LiteYouTubeEmbed id={id} title={title} />; }",
    })
    const warnings: Array<MigrationWarning> = []
    const migrator = createComponentMigrator(root, root, warnings, 'https://github.com/example/docs')
    const source = "import LiteYouTube from '@site/src/components/LiteYouTube'\n\n<LiteYouTube id=\"3YDiloj8_d0\" title=\"Demo\" />"
    const result = migrator.transform(source, join(root, 'docs', 'index.mdx'))
    expect(result).not.toContain('LiteYouTube')
    expect(result).toContain('<iframe')
    expect(result).toContain('3YDiloj8_d0')
    // The wrapper file itself is never copied (its own dependency is
    // unsupported), only the working iframe fallback is emitted.
    expect(migrator.files()).toEqual([])
  })

  it('does not embed a YouTube iframe for an unrelated player package, even when its usage looks video-shaped', () => {
    const root = fixture({})
    const warnings: Array<MigrationWarning> = []
    const migrator = createComponentMigrator(root, root, warnings, 'https://github.com/example/docs')
    // "VimeoEmbed"/"react-vimeo-embed" match the old, too-broad
    // `video|embed|player` heuristic, but Vimeo ids don't resolve on
    // youtube.com, so this must fall back to the comment stub, not a
    // silently-broken (or wrong-video) iframe.
    const source = "import VimeoEmbed from 'react-vimeo-embed';\n\n<VimeoEmbed id=\"12345678\" />"
    const result = migrator.transform(source, join(root, 'index.mdx'))
    expect(result).not.toContain('<iframe')
    expect(result).toContain("{/* Removed <VimeoEmbed>: unsupported import 'react-vimeo-embed' */}")
  })

  it('rejects an id that is not a bare YouTube video id instead of interpolating it unescaped', () => {
    const root = fixture({})
    const warnings: Array<MigrationWarning> = []
    const migrator = createComponentMigrator(root, root, warnings, 'https://github.com/example/docs')
    const source = 'import LiteYouTubeEmbed from \'react-lite-youtube-embed\';\n\n<LiteYouTubeEmbed id="x onerror=alert(1)" />'
    const result = migrator.transform(source, join(root, 'index.mdx'))
    expect(result).not.toContain('<iframe')
    expect(result).not.toContain('onerror')
    expect(result).toContain("unsupported import 'react-lite-youtube-embed'")
  })

  it('does not embed a JSX-expression id, since its literal source text is not the runtime value', () => {
    const root = fixture({})
    const warnings: Array<MigrationWarning> = []
    const migrator = createComponentMigrator(root, root, warnings, 'https://github.com/example/docs')
    const source = "import LiteYouTubeEmbed from 'react-lite-youtube-embed';\n\nconst videoId = '3YDiloj8_d0';\n\n<LiteYouTubeEmbed id={videoId} />"
    const result = migrator.transform(source, join(root, 'index.mdx'))
    expect(result).not.toContain('<iframe')
    expect(result).toContain("unsupported import 'react-lite-youtube-embed'")
  })

  it('embeds a YouTube URL passed to react-player, extracting the video id', () => {
    const root = fixture({})
    const warnings: Array<MigrationWarning> = []
    const migrator = createComponentMigrator(root, root, warnings, 'https://github.com/example/docs')
    const source = "import ReactPlayer from 'react-player';\n\n<ReactPlayer url=\"https://www.youtube.com/watch?v=3YDiloj8_d0\" />"
    const result = migrator.transform(source, join(root, 'index.mdx'))
    expect(result).toContain('<iframe')
    expect(result).toContain('3YDiloj8_d0')
  })

  it('replaces a non-video unsupported import usage with a comment naming the removed component and package', () => {
    const root = fixture({})
    const warnings: Array<MigrationWarning> = []
    const migrator = createComponentMigrator(root, root, warnings, 'https://github.com/example/docs')
    const source = "import Confetti from 'react-confetti';\n\n<Confetti pieces={200} />"
    const result = migrator.transform(source, join(root, 'index.mdx'))
    expect(result).toBe("\n\n{/* Removed <Confetti>: unsupported import 'react-confetti' */}")
  })

  it('resolves a @site/... component import to its copied file, same as a relative import', () => {
    const root = fixture({ 'src/components/Widget.jsx': 'export default () => <p>Widget</p>' })
    const warnings: Array<MigrationWarning> = []
    const migrator = createComponentMigrator(root, root, warnings, 'https://github.com/example/docs')
    const result = migrator.transform("import Widget from '@site/src/components/Widget.jsx'\n\n<Widget />", join(root, 'docs', 'index.mdx'))
    expect(result.trim()).toMatch(/^<Migrated[a-f0-9]+ \/>$/)
    expect(migrator.files().some((file) => file.path.endsWith('/Widget.jsx'))).toBe(true)
    expect(warnings).toEqual([])
  })

  it('resolves a @site/... component import against the repository root when it is not nested under the narrower project root (Playwright: shared src/components/HTMLCard lives at the repository root, a sibling of the nodejs/ project)', () => {
    const root = fixture({ 'src/components/HTMLCard.jsx': 'export default () => <p>HTMLCard</p>' })
    const warnings: Array<MigrationWarning> = []
    const migrator = createComponentMigrator(join(root, 'nodejs'), root, warnings, 'https://github.com/example/docs')
    const result = migrator.transform("import HTMLCard from '@site/src/components/HTMLCard'\n\n<HTMLCard />", join(root, 'nodejs', 'docs', 'index.mdx'))
    expect(result.trim()).toMatch(/^<Migrated[a-f0-9]+ \/>$/)
    expect(migrator.files().some((file) => file.path.endsWith('/HTMLCard.jsx'))).toBe(true)
    expect(warnings).toEqual([])
  })

  it('prepends // @ts-nocheck to a copied component, since it was never type-checked by the source platform\'s own build (Oasis: window.ethereum and an implicit-any parameter fail next build\'s tsc gate)', () => {
    const root = fixture({
      'src/AddToMetaMask.tsx': 'export default function AddToMetaMask(props) { window.ethereum.request({ method: "wallet_watchAsset" }); return null; }',
    })
    const warnings: Array<MigrationWarning> = []
    const migrator = createComponentMigrator(root, root, warnings, 'https://github.com/example/docs')
    migrator.transform("import AddToMetaMask from './src/AddToMetaMask.tsx'\n\n<AddToMetaMask />", join(root, 'index.mdx'))
    const copied = migrator.files().find((file) => file.path.endsWith('/AddToMetaMask.tsx'))!
    expect(String(copied.content)).toMatch(/^\/\/ @ts-nocheck\n'use client';/)
  })

  it('leaves a pure copied component a server module so it can read and rewrite the children it is given (a children-walking template), while anything interactive stays client', () => {
    const root = fixture({
      'src/Template.jsx': 'export const Template = ({ children, data }) => { const walk = (n) => typeof n === "string" ? n.replace(/\\{\\{(\\w+)\\}\\}/g, (_, k) => data[k]) : n; return <>{walk(children)}</> }',
      'src/Hook.jsx': 'export const Hook = () => { const [n] = useState(0); return <p>{n}</p> }',
      'src/Handler.jsx': 'export const Handler = () => <button onClick={() => 1}>x</button>',
      'src/Browser.jsx': 'export const Browser = () => <p>{window.innerWidth}</p>',
      'src/Ctx.jsx': 'import { createContext } from "react"\nexport const C = createContext(1)\nexport const Ctx = () => null',
      'src/Declared.jsx': "'use client'\nexport const Declared = () => <p>x</p>",
    })
    const warnings: Array<MigrationWarning> = []
    const migrator = createComponentMigrator(root, root, warnings, 'https://github.com/example/docs')
    migrator.transform(["import { Template } from './src/Template.jsx'", "import { Hook } from './src/Hook.jsx'", "import { Handler } from './src/Handler.jsx'",
      "import { Browser } from './src/Browser.jsx'", "import { Ctx } from './src/Ctx.jsx'", "import { Declared } from './src/Declared.jsx'",
      '', '<Template data={{ A: "b" }}>{{A}}</Template>', '', '<Hook />', '', '<Handler />', '', '<Browser />', '', '<Ctx />', '', '<Declared />'].join('\n'), join(root, 'index.mdx'))
    const content = (name: string) => String(migrator.files().find((file) => file.path.endsWith(`/${name}.jsx`))!.content)
    expect(content('Template')).not.toContain('use client')
    for (const name of ['Hook', 'Handler', 'Browser', 'Ctx', 'Declared']) expect(content(name)).toContain("'use client';")
  })

  it('keeps a client boundary for every interactive or browser-bound pattern, and only a plain children-walker stays a server module', () => {
    const client: Record<string, string> = {
      ReactState: 'import React from "react"\nexport const ReactState = () => { const [n] = React.useState(0); return <p>{n}</p> }',
      ReactEffect: 'import React from "react"\nexport const ReactEffect = () => { React.useEffect(() => {}, []); return null }',
      Ctx2: 'import { useContext } from "react"\nexport const Ctx2 = () => { useContext(null); return null }',
      Forward: 'import { forwardRef } from "react"\nexport const Forward = forwardRef((p, ref) => <div ref={ref} />)',
      ForwardNoHandler: 'import React from "react"\nexport const ForwardNoHandler = React.forwardRef((p, r) => null)',
      Klass: 'import React from "react"\nexport class Klass extends React.Component { render() { this.setState({}); return null } }',
      Nav: 'export const Nav = () => <p>{navigator.userAgent}</p>',
      Loc: 'export const Loc = () => <p>{location.href}</p>',
      Media: 'export const Media = () => <p>{String(matchMedia("(min-width: 1px)").matches)}</p>',
      Obs: 'export const Obs = () => { new IntersectionObserver(() => {}); return null }',
      Raf: 'export const Raf = () => { requestAnimationFrame(() => {}); return null }',
      Timeout: 'export const Timeout = () => { setTimeout(() => {}, 1); return null }',
      Interval: 'export const Interval = () => { setInterval(() => {}, 1); return null }',
      Passthrough: 'export const Passthrough = (props) => <button onClick={props.onClick}>x</button>',
      Spread: 'export const Spread = (props) => <div {...props} />',
      Handler2: 'export const Handler2 = ({ onClick }) => <p>{typeof onClick}</p>',
      Listener: 'export const Listener = ({ node }) => { node.addEventListener("x", () => {}); return null }',
      HookAlias: 'import React from "react"\nconst h = React.useState\nexport const HookAlias = () => <p>{String(h)}</p>',
    }
    const pure: Record<string, string> = {
      PureDefault: 'import React from "react"\nexport const PureDefault = ({ children }) => <div>{React.Children.map(children, (c) => c)}</div>',
      PureSpreadComponent: 'import React from "react"\nconst Inner = ({ children }) => <>{children}</>\nexport const PureSpreadComponent = (props) => <Inner {...props} />',
    }
    const files: Record<string, string> = {}
    const names = [...Object.keys(client), ...Object.keys(pure)]
    for (const [name, source] of Object.entries({ ...client, ...pure })) files[`src/${name}.jsx`] = source
    const root = fixture(files)
    const migrator = createComponentMigrator(root, root, [], 'https://github.com/example/docs')
    migrator.transform([...names.map((name) => `import { ${name} } from './src/${name}.jsx'`), '', ...names.map((name) => `<${name} />`)].join('\n'), join(root, 'index.mdx'))
    const content = (name: string) => String(migrator.files().find((file) => file.path.endsWith(`/${name}.jsx`))!.content)
    for (const name of Object.keys(client)) expect(content(name), name).toContain("'use client';")
    for (const name of Object.keys(pure)) expect(content(name), name).not.toContain('use client')
  })

  it('makes every module that imports a client module a client module, and leaves a pure Template untouched', () => {
    const root = fixture({
      'src/util.js': 'export const fmt = (key) => localStorage.getItem(key)\n',
      'src/Foo.jsx': 'import { fmt } from "./util.js"\nexport const Foo = () => <p>{fmt("a")}</p>\n',
      'src/Outer.jsx': 'import { Foo } from "./Foo.jsx"\nexport const Outer = () => <Foo />\n',
      'src/theme.js': 'import { useState } from "react"\nexport default function theme() { return useState("a")[0] }\n',
      'src/Themed.jsx': 'import theme from "./theme.js"\nexport const Themed = () => <p>{theme()}</p>\n',
      'src/Directive.jsx': "'use client'\nexport const Directive = () => <p>x</p>\n",
      'src/Template.jsx': 'export const Template = ({ children }) => <>{children}</>\n',
      'src/Wrapper.jsx': 'import { Template } from "./Template.jsx"\nexport const Wrapper = ({ children }) => <Template>{children}</Template>\n',
    })
    const migrator = createComponentMigrator(root, root, [], 'https://github.com/example/docs')
    const names = ['Outer', 'Themed', 'Directive', 'Wrapper']
    migrator.transform([...names.map((name) => `import { ${name} } from './src/${name}.jsx'`), '', ...names.map((name) => `<${name} />`)].join('\n'), join(root, 'index.mdx'))
    const content = (name: string) => String(migrator.files().find((file) => file.path.endsWith(`/${name}.${name === 'util' || name === 'theme' ? 'js' : 'jsx'}`))!.content)
    for (const name of ['util', 'Foo', 'Outer', 'theme', 'Themed']) expect(content(name), name).toContain("'use client';")
    for (const name of ['Template', 'Wrapper']) expect(content(name), name).not.toContain('use client')
    expect(content('Directive').match(/use client/g)).toHaveLength(1)
  })

  it('keeps a leading shebang on line 1 instead of burying it under the @ts-nocheck prologue', () => {
    const root = fixture({
      'src/Script.tsx': '#!/usr/bin/env node\nexport default function Script() { return null; }',
    })
    const warnings: Array<MigrationWarning> = []
    const migrator = createComponentMigrator(root, root, warnings, 'https://github.com/example/docs')
    migrator.transform("import Script from './src/Script.tsx'\n\n<Script />", join(root, 'index.mdx'))
    const copied = migrator.files().find((file) => file.path.endsWith('/Script.tsx'))!
    const content = String(copied.content)
    expect(content.split('\n')[0]).toBe('#!/usr/bin/env node')
    expect(content).toMatch(/^#!\/usr\/bin\/env node\n\/\/ @ts-nocheck\n/)
  })

  it('copies a component that imports @docusaurus/Link, mapping it to next/link and to= to href=', () => {
    const root = fixture({
      'components/Callout.jsx': "import Link from '@docusaurus/Link'\n\nexport default ({ children }) => <div><Link to=\"/docs/intro\">{children}</Link></div>",
    })
    const warnings: Array<MigrationWarning> = []
    const migrator = createComponentMigrator(root, root, warnings, 'https://github.com/example/docs')
    const result = migrator.transform("import Callout from './components/Callout.jsx'\n\n<Callout>Read more</Callout>", join(root, 'index.mdx'))
    expect(result.trim()).toMatch(/^<Migrated[a-f0-9]+>Read more<\/Migrated[a-f0-9]+>$/)
    const copied = migrator.files().find((file) => file.path.endsWith('/Callout.jsx'))!
    expect(copied.content).toContain("from \"next/link\"")
    expect(copied.content).not.toContain('@docusaurus/Link')
    expect(copied.content).toContain('<Link href="/docs/intro">')
    expect(copied.content).not.toContain('to="/docs/intro"')
    expect(warnings).toEqual([])
  })

  it('copies a component that imports @theme/CodeBlock and @docusaurus/BrowserOnly, using small shims', () => {
    const root = fixture({
      'components/Demo.jsx': "import CodeBlock from '@theme/CodeBlock'\nimport BrowserOnly from '@docusaurus/BrowserOnly'\n\nexport default () => (\n  <div>\n    <CodeBlock>const x = 1</CodeBlock>\n    <BrowserOnly>{() => <span>client-only</span>}</BrowserOnly>\n  </div>\n)",
    })
    const warnings: Array<MigrationWarning> = []
    const migrator = createComponentMigrator(root, root, warnings, 'https://github.com/example/docs')
    const result = migrator.transform("import Demo from './components/Demo.jsx'\n\n<Demo />", join(root, 'index.mdx'))
    expect(result.trim()).toMatch(/^<Migrated[a-f0-9]+ \/>$/)
    const copied = migrator.files().find((file) => file.path.endsWith('/Demo.jsx'))!
    expect(copied.content).not.toContain('@theme/CodeBlock')
    expect(copied.content).not.toContain('@docusaurus/BrowserOnly')
    const codeBlockShim = migrator.files().find((file) => file.path.endsWith('/docusaurus-code-block.tsx'))
    const browserOnlyShim = migrator.files().find((file) => file.path.endsWith('/docusaurus-browser-only.tsx'))
    expect(codeBlockShim?.content).toContain('<pre')
    expect(browserOnlyShim?.content).toContain("'use client'")
    expect(warnings).toEqual([])
  })

  it('reuses the same staged shim across two components that both import @theme/CodeBlock', () => {
    const root = fixture({
      'a.jsx': "import CodeBlock from '@theme/CodeBlock'\nexport default () => <CodeBlock>a</CodeBlock>",
      'b.jsx': "import CodeBlock from '@theme/CodeBlock'\nexport default () => <CodeBlock>b</CodeBlock>",
    })
    const warnings: Array<MigrationWarning> = []
    const migrator = createComponentMigrator(root, root, warnings, 'https://github.com/example/docs')
    migrator.transform("import A from './a.jsx'\nimport B from './b.jsx'\n\n<A />\n<B />", join(root, 'index.mdx'))
    const shims = migrator.files().filter((file) => file.path.endsWith('/docusaurus-code-block.tsx'))
    expect(shims).toHaveLength(1)
  })

  it('still refuses (and removes) an unrecognized Docusaurus theme import, since only a small named set is shimmed', () => {
    const root = fixture({
      'components/Translated.jsx': "import Translate from '@docusaurus/Translate'\nexport default () => <Translate>Hi</Translate>",
    })
    const warnings: Array<MigrationWarning> = []
    const migrator = createComponentMigrator(root, root, warnings, 'https://github.com/example/docs')
    const source = "import Translated from './components/Translated.jsx'\n\n<Translated />"
    const result = migrator.transform(source, join(root, 'index.mdx'))
    expect(result).toBe('\n\n<Translated />')
    expect(migrator.files()).toEqual([])
    expect(warnings[0].message).toContain('could not be copied and was removed')
  })

  it('omits global-only CSS module selectors and flags custom styles for review', () => {
    const root = fixture({
      'components/BrowserWindow.jsx': "import styles from './styles.module.css'\n\nexport default ({ children }) => <div className={styles.window}><div className={styles.content}>{children}</div></div>",
      'components/styles.module.css': '[data-theme="light"] { background: white; }\n.content { padding: 1rem; }\n:root, .window { border: 1px solid; }\n',
    })
    const warnings: Array<MigrationWarning> = []
    const migrator = createComponentMigrator(root, root, warnings, 'https://github.com/example/docs')
    migrator.transform("import BrowserWindow from './components/BrowserWindow.jsx'\n\n<BrowserWindow>x</BrowserWindow>", join(root, 'index.mdx'))
    const css = String(migrator.files().find((file) => file.path.endsWith('styles.module.css'))!.content)
    expect(css).not.toContain('[data-theme="light"]')
    expect(css).toContain('.content {')
    expect(css).not.toContain(':root')
    expect(css).toContain('.window {')
    expect(warnings.some((warning) => warning.message.includes('Site-authored CSS module') && warning.message.includes('2 global-only selector branch(es)'))).toBe(true)
  })

  it('leaves a CSS module with only pure (class-containing) selectors byte-identical', () => {
    const root = fixture({
      'components/Card.jsx': "import styles from './styles.module.css'\n\nexport default ({ children }) => <div className={styles.card}>{children}</div>",
      'components/styles.module.css': '.card { padding: 1rem; }\n.card:hover { opacity: 0.9; }\n',
    })
    const warnings: Array<MigrationWarning> = []
    const migrator = createComponentMigrator(root, root, warnings, 'https://github.com/example/docs')
    migrator.transform("import Card from './components/Card.jsx'\n\n<Card>x</Card>", join(root, 'index.mdx'))
    const css = String(migrator.files().find((file) => file.path.endsWith('styles.module.css'))!.content)
    expect(css).not.toContain(':global')
  })

  it('keeps CSS module keyframes and value exports while removing global-only classes', () => {
    const root = fixture({
      'components/Widget.jsx': "import styles from './styles.module.css'\nexport default () => <div className={styles.card} />",
      'components/styles.module.css': ':export { accent: red; }\n@keyframes pulse { from { opacity: 0; } to { opacity: 1; } }\n:global(.theme-doc-card) { color: red; }\n.card { animation: pulse 1s; }',
    })
    const warnings: Array<MigrationWarning> = []
    const migrator = createComponentMigrator(root, root, warnings, 'https://github.com/example/docs')
    migrator.transform("import Widget from './components/Widget.jsx'\n\n<Widget />", join(root, 'index.mdx'))
    const css = String(migrator.files().find((file) => file.path.endsWith('styles.module.css'))!.content)
    expect(css).toContain(':export { accent: red; }')
    expect(css).toContain('@keyframes pulse { from { opacity: 0; } to { opacity: 1; } }')
    expect(css).toContain('.card { animation: pulse 1s; }')
    expect(css).not.toContain('theme-doc-card')
    expect(warnings.some((warning) => warning.message.includes('1 global-only selector branch(es)'))).toBe(true)
  })

  it('does not report copied custom CSS when its component graph is rejected', () => {
    const root = fixture({
      'components/Widget.jsx': "import styles from './styles.module.css'\nimport Missing from 'uninstalled-widget'\nexport default () => <div className={styles.card}><Missing /></div>",
      'components/styles.module.css': ':root { color: red; }\n.card { color: blue; }',
    })
    const warnings: Array<MigrationWarning> = []
    const migrator = createComponentMigrator(root, root, warnings, 'https://github.com/example/docs')
    migrator.transform("import Widget from './components/Widget.jsx'\n\n<Widget />", join(root, 'index.mdx'))
    expect(migrator.files()).toEqual([])
    expect(warnings.some((warning) => warning.message.includes('Site-authored CSS module'))).toBe(false)
    expect(warnings.some((warning) => warning.message.includes('Site-authored component import'))).toBe(true)
  })

  it('does not touch a plain (non-module) .css file copied as a component dependency', () => {
    const root = fixture({
      'components/Widget.jsx': "import './styles.css'\n\nexport default () => <div />",
      'components/styles.css': '[data-theme="light"] { color: red; }\n',
    })
    const warnings: Array<MigrationWarning> = []
    const migrator = createComponentMigrator(root, root, warnings, 'https://github.com/example/docs')
    migrator.transform("import Widget from './components/Widget.jsx'\n\n<Widget />", join(root, 'index.mdx'))
    const css = String(migrator.files().find((file) => file.path.endsWith('/styles.css'))!.content)
    expect(css).toBe('[data-theme="light"] { color: red; }\n')
  })

  it('finds and copies an import nested inside a JSX wrapper, not just one at the top of the file (Docusaurus\' own live-code-example idiom)', () => {
    const root = fixture({ 'widget.jsx': 'export default () => <p>Widget</p>' })
    const warnings: Array<MigrationWarning> = []
    const migrator = createComponentMigrator(root, root, warnings, 'https://github.com/example/docs')
    const source = "<BrowserWindow>\nimport Widget from './widget.jsx'\n\n<Widget />\n</BrowserWindow>"
    const result = migrator.transform(source, join(root, 'index.mdx'))
    expect(result).not.toContain("import Widget from './widget.jsx'")
    expect(result).toMatch(/<Migrated[a-f0-9]+ \/>/)
    expect(migrator.files().some((file) => file.path.endsWith('/widget.jsx'))).toBe(true)
    expect(warnings).toEqual([])
  })

  it('rescues a require(\'./asset.ext\').default call inside a JSX attribute expression as a public URL', () => {
    const root = fixture({ 'assets/handout.docx': 'binary-ish content' })
    const warnings: Array<MigrationWarning> = []
    const migrator = createComponentMigrator(root, root, warnings, 'https://github.com/example/docs')
    const source = '<a target="_blank" href={require(\'./assets/handout.docx\').default}>Download</a>'
    const result = migrator.transform(source, join(root, 'index.mdx'))
    expect(result).not.toContain('require(')
    expect(result).toMatch(/^<a target="_blank" href=\{"\/migrated-[a-f0-9]+\.docx"\}>Download<\/a>$/)
    const publicFile = migrator.files().find((file) => file.path.startsWith('public/'))
    expect(publicFile?.content.toString()).toBe('binary-ish content')
  })

  it('never rewrites a require(...) call that only appears inside a fenced code example, even when it names the same asset', () => {
    const root = fixture({ 'assets/handout.docx': 'binary-ish content' })
    const warnings: Array<MigrationWarning> = []
    const migrator = createComponentMigrator(root, root, warnings, 'https://github.com/example/docs')
    const fenced = [
      '```jsx',
      '<a href={require(\'./assets/handout.docx\').default}>Download</a>',
      '```',
    ].join('\n')
    const result = migrator.transform(fenced, join(root, 'index.mdx'))
    expect(result).toBe(fenced)
    expect(migrator.files()).toEqual([])
  })

  it('neutralizes an unresolvable require(...) asset call with a warning instead of leaving a dangling reference', () => {
    const root = fixture({})
    const warnings: Array<MigrationWarning> = []
    const migrator = createComponentMigrator(root, root, warnings, 'https://github.com/example/docs')
    const source = '<a href={require(\'./missing.docx\').default}>Download</a>'
    const result = migrator.transform(source, join(root, 'index.mdx'))
    // A dangling require() would fail `next build` with "Module not found"
    // for the whole site; it is replaced with an empty string instead.
    expect(result).not.toContain('require(')
    expect(result).toBe('<a href={""}>Download</a>')
    expect(warnings[0].message).toContain('could not be resolved and was removed')
  })

  it('resolves a require(...) asset call that escapes the platform root into the repository root, mirroring a monorepo build that copies the project root up before building (Playwright: docs reference ../images at the repository root)', () => {
    const root = fixture({
      'nodejs/docusaurus.config.ts': 'export default {}',
      'images/test-agents/planner-prompt.png': 'binary-ish content',
    })
    const warnings: Array<MigrationWarning> = []
    const migrator = createComponentMigrator(join(root, 'nodejs'), root, warnings, 'https://github.com/example/docs')
    const source = '<img src={require(\'../images/test-agents/planner-prompt.png\').src} alt="planner prompt"/>'
    const result = migrator.transform(source, join(root, 'nodejs', 'docs', 'test-agents.mdx'))
    expect(result).not.toContain('require(')
    expect(result).toMatch(/^<img src=\{"\/migrated-[a-f0-9]+\.png"\} alt="planner prompt"\/>$/)
    const publicFile = migrator.files().find((file) => file.path.startsWith('public/'))
    expect(publicFile?.content.toString()).toBe('binary-ish content')
    expect(warnings).toEqual([])
  })

  it('wraps a copied SVG used as a JSX tag in an <img> component instead of importing it raw (no SVGR loader is configured)', () => {
    const root = fixture({ 'docusaurus.svg': '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0" /></svg>' })
    const warnings: Array<MigrationWarning> = []
    const migrator = createComponentMigrator(root, root, warnings, 'https://github.com/example/docs')
    const source = "import DocusaurusSvg from './docusaurus.svg'\n\n<DocusaurusSvg />"
    const result = migrator.transform(source, join(root, 'index.mdx'))
    expect(result.trim()).toMatch(/^<Migrated[a-f0-9]+ \/>$/)
    const wrapper = migrator.files().find((file) => file.path.endsWith('.svg.component.tsx'))
    expect(wrapper?.content).toContain('<img src={src}')
    expect(wrapper?.content).toContain("from \"./docusaurus.svg\"")
    expect(migrator.files().some((file) => file.path.endsWith('/docusaurus.svg'))).toBe(true)
    expect(warnings).toEqual([])
  })

  it('does not wrap a copied SVG that is only referenced in an expression (src={Logo}), not rendered as a JSX tag', () => {
    const root = fixture({ 'docusaurus.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>' })
    const warnings: Array<MigrationWarning> = []
    const migrator = createComponentMigrator(root, root, warnings, 'https://github.com/example/docs')
    const source = "import DocusaurusSvg from './docusaurus.svg'\n\n<img src={DocusaurusSvg} alt=\"\" />"
    migrator.transform(source, join(root, 'index.mdx'))
    expect(migrator.files().some((file) => file.path.endsWith('.component.tsx'))).toBe(false)
  })

  it('parses and processes an import even when the page has an HTML comment remark-mdx cannot parse on its own (Redux\'s <!-- prettier-ignore --> before a snippet import)', () => {
    const root = fixture({ 'widget.jsx': 'export default () => <p>Widget</p>' })
    const warnings: Array<MigrationWarning> = []
    const migrator = createComponentMigrator(root, root, warnings, 'https://github.com/example/docs')
    const source = "import Widget from './widget.jsx'\n\n<!-- prettier-ignore -->\n\n<Widget />"
    const result = migrator.transform(source, join(root, 'index.mdx'))
    expect(result).not.toContain("import Widget from './widget.jsx'")
    expect(result).toContain('{/* prettier-ignore */}')
    expect(result).toMatch(/<Migrated[a-f0-9]+ \/>/)
    expect(migrator.files().some((file) => file.path.endsWith('/widget.jsx'))).toBe(true)
    expect(warnings).toEqual([])
  })

  it('rejects symlinked directories even when their leaf looks ordinary', () => {
    const root = fixture({})
    const outside = fixture({ 'widget.jsx': 'export default () => <div />' })
    symlinkSync(outside, join(root, 'linked'), 'dir')
    const warnings: Array<MigrationWarning> = []
    const migrator = createComponentMigrator(root, root, warnings, 'https://github.com/example/docs')
    const source = "import Widget from './linked/widget.jsx'\n\n<Widget />"
    expect(migrator.transform(source, join(root, 'index.mdx'))).toBe('\n\n<Widget />')
    expect(migrator.files()).toEqual([])
    expect(warnings[0].message).toContain('symbolic links')
  })

  it('rescues an asset import that copyGraph cannot handle (.docx) as a public URL when it is never used as a JSX tag', () => {
    const root = fixture({ 'assets/guide.docx': 'binary-ish content' })
    const warnings: Array<MigrationWarning> = []
    const migrator = createComponentMigrator(root, root, warnings, 'https://github.com/example/docs')
    const source = "import Doc from './assets/guide.docx'\n\n<a href={Doc}>Download</a>"
    const result = migrator.transform(source, join(root, 'index.mdx'))
    expect(result).not.toContain("import Doc from './assets/guide.docx'")
    expect(result).toMatch(/^export const Doc = "\/migrated-[a-f0-9]+\.docx";\n\n<a href=\{Doc\}>Download<\/a>$/)
    const publicFile = migrator.files().find((file) => file.path.startsWith('public/'))
    expect(publicFile?.content.toString()).toBe('binary-ish content')
    expect(warnings[0].message).toContain('bound to that URL')
    // A bare `const` (no `export`) in this position is prose to a fresh MDX
    // parse, not an executable declaration — `Doc` would then be an
    // undefined free variable at render ("ReferenceError: Doc is not
    // defined"), reproduced against hasura/graphql-engine's
    // databases/overview.mdx. Compile the actual output the same way the
    // real build does and check the binding survived as real ESM, not text.
    const compiled = String(compileSync(result, { outputFormat: 'program' }))
    expect(compiled).toContain('const Doc =')
    expect(compiled).not.toContain('"const Doc =')
  })

  it('rescues an asset import bound to a lowercase local name used in an expression (Docusaurus\' own convention, e.g. a logo)', () => {
    const root = fixture({ 'static/img/docusaurus.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>' })
    const warnings: Array<MigrationWarning> = []
    const migrator = createComponentMigrator(root, root, warnings, 'https://github.com/example/docs')
    // A lowercase local name and an expression-attribute usage would each,
    // on their own, bail out of component migration before ever trying to
    // copy anything (see the checks right after this block) — an asset
    // must not hit either bail.
    const source = "import docusaurusLogo from '@site/static/img/docusaurus.svg'\n\n<img src={docusaurusLogo} alt=\"logo\" />"
    const result = migrator.transform(source, join(root, 'index.mdx'))
    expect(result).not.toContain('import docusaurusLogo')
    expect(result).toMatch(/^export const docusaurusLogo = "\/migrated-[a-f0-9]+\.svg";\n\n<img src=\{docusaurusLogo\} alt="logo" \/>$/)
    expect(migrator.files().some((file) => file.path.startsWith('public/'))).toBe(true)
  })

  it('does not rescue an asset import as a URL string when it is used as a JSX tag, since a string cannot render as a component', () => {
    const root = fixture({ 'logo.svg': '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0 L999999999999999 0" /></svg>'.repeat(1) })
    const warnings: Array<MigrationWarning> = []
    const migrator = createComponentMigrator(root, root, warnings, 'https://github.com/example/docs')
    // `./logo.svg` actually copies fine via copyGraph (it's a DATA_EXTENSIONS
    // type) unless something else fails it; force a failure with a missing
    // file instead, so the only variable under test is JSX-tag usage.
    const source = "import Logo from './missing-logo.svg'\n\n<Logo />"
    const result = migrator.transform(source, join(root, 'index.mdx'))
    expect(result).toBe('\n\n<Logo />')
    expect(migrator.files()).toEqual([])
    expect(warnings[0].message).toContain('could not be copied and was removed')
  })
  it('marks the page skipped-file when an unsupported npm import binding is referenced outside JSX', () => {
    const root = fixture({})
    const warnings: Array<MigrationWarning> = []
    const migrator = createComponentMigrator(root, root, warnings, 'https://github.com/example/docs')
    // `date-fns` is not local (doesn't start with '.' or '/') and is not an
    // installed shared/theme import; `format` is referenced inside a prop
    // expression (not bare JSX usage), so it can't be rewritten. Preserving
    // this import would fail `next build` site-wide with "Module not found".
    migrator.transform(
      "import { format } from 'date-fns'\n\n<Note label={format(new Date(), 'PP')} />",
      join(root, 'page.mdx'),
    )
    expect(warnings).toContainEqual(expect.objectContaining({
      code: 'skipped-file',
      source: 'page.mdx',
      message: expect.stringContaining("'date-fns'"),
    }))
    expect(warnings.find((warning) => warning.code === 'skipped-file')?.message).toContain('format')
  })
})

describe('propsTargetExtractedClientComponent', () => {
  it('is true when a declared name is passed as a bare prop to a Migrated<hash> tag', () => {
    const body = '<Migrated0123456789ab RenderComponent={CustomBlock} />'
    expect(propsTargetExtractedClientComponent(body, new Set(['CustomBlock']))).toBe(true)
  })

  it('is true for an inline-extracted Inline<n> tag', () => {
    const body = '<Inline0 onClick={handleClick} />'
    expect(propsTargetExtractedClientComponent(body, new Set(['handleClick']))).toBe(true)
  })

  it('is true for a Thally built-in already backed by a use-client module (CLIENT_BUILTIN_COMPONENT_TAGS)', () => {
    const body = '<Accordion RenderComponent={CustomBlock} />'
    expect(propsTargetExtractedClientComponent(body, new Set(['CustomBlock']))).toBe(true)
  })

  it('is false when the tag is neither extracted nor a confirmed client built-in, even with a matching prop', () => {
    const body = '<Card RenderComponent={CustomBlock} />'
    expect(propsTargetExtractedClientComponent(body, new Set(['CustomBlock']))).toBe(false)
  })

  it('is false when no declared name matches the prop value', () => {
    const body = '<Migrated0123456789ab RenderComponent={SomethingElse} />'
    expect(propsTargetExtractedClientComponent(body, new Set(['CustomBlock']))).toBe(false)
  })

  it('is false when declaredNames is empty', () => {
    const body = '<Migrated0123456789ab RenderComponent={CustomBlock} />'
    expect(propsTargetExtractedClientComponent(body, new Set())).toBe(false)
  })

  it('is true for an inline arrow function passed as a prop to a confirmed client built-in', () => {
    const body = '<Accordion title="t" onToggle={() => console.log(1)}>x</Accordion>'
    expect(propsTargetExtractedClientComponent(body, new Set())).toBe(true)
  })

  it('is true for an inline `function` expression passed as a prop to a confirmed client built-in', () => {
    const body = '<Accordion title="t" onToggle={function () { console.log(1) }}>x</Accordion>'
    expect(propsTargetExtractedClientComponent(body, new Set())).toBe(true)
  })

  it('is false for an inline arrow function on a tag that is neither extracted nor a confirmed client built-in', () => {
    const body = '<Card onToggle={() => console.log(1)}>x</Card>'
    expect(propsTargetExtractedClientComponent(body, new Set())).toBe(false)
  })

  it('ignores an inline arrow function shown inside a fenced code sample', () => {
    const body = '```jsx\n<Accordion onToggle={() => console.log(1)} />\n```'
    expect(propsTargetExtractedClientComponent(body, new Set())).toBe(false)
  })

  it('ignores JSX written inside a page-local export const, since remark-mdx parses it as ESM text, not JSX element nodes', () => {
    const body = 'export const Widget = () => <Accordion onToggle={() => console.log(1)} />;\n\n<Widget />'
    expect(propsTargetExtractedClientComponent(body, new Set())).toBe(false)
  })

  it('is false for a value prop that merely looks like an object, not a function', () => {
    const body = '<Accordion data={{ a: 1 }} />'
    expect(propsTargetExtractedClientComponent(body, new Set())).toBe(false)
  })

  it('is true for a function passed as children to a confirmed client built-in', () => {
    expect(propsTargetExtractedClientComponent("<Accordion title=\"t\">{() => 'x'}</Accordion>", new Set())).toBe(true)
    expect(propsTargetExtractedClientComponent('<Accordion title="t">\n{render}\n</Accordion>', new Set(['render']))).toBe(true)
  })

  it('is false for ordinary expression children and identifiers that merely start with a keyword', () => {
    expect(propsTargetExtractedClientComponent('<Accordion title="t">{items.map((item) => item)}</Accordion>', new Set())).toBe(false)
    expect(propsTargetExtractedClientComponent('<Tabs items={functionList}>x</Tabs>', new Set())).toBe(false)
    expect(propsTargetExtractedClientComponent('<Accordion title={asyncMode}>x</Accordion>', new Set())).toBe(false)
    expect(propsTargetExtractedClientComponent('<Accordion title={classNames}>x</Accordion>', new Set())).toBe(false)
  })
})

describe('hasAnyFunctionValuedProp', () => {
  it('is true for an inline function prop even on an unconfirmed tag (the broader, unconfirmed signal)', () => {
    const body = '<Card onToggle={() => console.log(1)}>x</Card>'
    expect(hasAnyFunctionValuedProp(body, new Set())).toBe(true)
  })

  it('is true for a declared-name function prop on any tag', () => {
    const body = '<Widget render={CustomBlock} />'
    expect(hasAnyFunctionValuedProp(body, new Set(['CustomBlock']))).toBe(true)
  })

  it('is false when no prop carries a function value', () => {
    const body = '<Widget title="hi" count={1} />'
    expect(hasAnyFunctionValuedProp(body, new Set())).toBe(false)
  })
})

describe('declarationsReferenceBrowserGlobal', () => {
  it('is true for a page-local inline declaration that uses document', () => {
    const body = "export function Demo() {\n  return createPortal(children, document.body)\n}\n\n<Demo />"
    expect(declarationsReferenceBrowserGlobal(body)).toBe(true)
  })

  it('is false for a declaration that never references document or window', () => {
    const body = 'export const Demo = () => <div>hi</div>\n\n<Demo />'
    expect(declarationsReferenceBrowserGlobal(body)).toBe(false)
  })

  it('is false once the declaration is extracted into a client module (no inline mdxjsEsm left)', () => {
    const body = '<Inline0 />'
    expect(declarationsReferenceBrowserGlobal(body)).toBe(false)
  })
})

describe('scaffold-provided imports are kept untouched', () => {
  it.each([
    ['next/link used only as JSX', "import Link from 'next/link'\n\n<Link href=\"/a\">A</Link>", "import Link from 'next/link'"],
    ['next/link used both as JSX and referenced from a declaration', "import Link from 'next/link'\n\nexport const Nav = () => <Link href=\"/a\">A</Link>\n\n<Nav />", "import Link from 'next/link'"],
    ['clsx used only in an expression', "import clsx from 'clsx'\n\n<div className={clsx('a', 'b')}>hi</div>", "import clsx from 'clsx'"],
    ['lucide-react icon passed as a prop', "import { Rocket } from 'lucide-react'\n\n<Card icon={Rocket}>x</Card>", "import { Rocket } from 'lucide-react'"],
    ['react-dom used in a declaration', "import { createPortal } from 'react-dom'\n\nexport const P = ({children}) => createPortal(children, document.body)\n\n<P>x</P>", "import { createPortal } from 'react-dom'"],
    ['lucide-react subpath', "import { DynamicIcon } from 'lucide-react/dynamic'\n\n<DynamicIcon name=\"x\" />", "import { DynamicIcon } from 'lucide-react/dynamic'"],
    ['clsx subpath used in an expression', "import clsx from 'clsx/lite'\n\n<div className={clsx('a')}>x</div>", "import clsx from 'clsx/lite'"],
  ])('%s', (_label, source, expectedImport) => {
    const root = fixture({})
    const warnings: Array<MigrationWarning> = []
    const migrator = createComponentMigrator(root, root, warnings, 'https://github.com/example/docs')
    const body = migrator.transform(source, join(root, 'page.mdx'))
    expect(body).toBe(source)
    expect(body).toContain(expectedImport)
    expect(migrator.files()).toEqual([])
    expect(warnings).toEqual([])
  })
})

it('treats react-dom/server as unavailable, since Next makes its string renderers throw', () => {
  const root = fixture({})
  const warnings: Array<MigrationWarning> = []
  const migrator = createComponentMigrator(root, root, warnings, 'https://github.com/example/docs')
  migrator.transform("import { renderToString } from 'react-dom/server'\n\n{renderToString(<b/>)}", join(root, 'page.mdx'))
  expect(warnings).toContainEqual(expect.objectContaining({ code: 'skipped-file', message: expect.stringContaining("'react-dom/server'") }))
})

describe('scaffold-provided imports in extracted client modules', () => {
  function extract(source: string): { page: string; clientModule: string; warnings: Array<MigrationWarning> } {
    const root = fixture({})
    const warnings: Array<MigrationWarning> = []
    const migrator = createComponentMigrator(root, root, warnings, 'https://github.com/example/docs')
    const page = migrator.transform(source, join(root, 'page.mdx'))
    const clientModule = String(migrator.files().find((file) => file.path.includes('/inline-'))?.content ?? '')
    return { page, clientModule, warnings }
  }

  it('copies a clsx import into the client module alongside a stateful inline component', () => {
    const source = "import clsx from 'clsx'\nimport { useState } from 'react'\n\n"
      + "export const T = () => { const [on, set] = useState(false); return <button className={clsx(on && 'on')} onClick={() => set(!on)}>t</button> }\n\n<T />"
    const { page, clientModule, warnings } = extract(source)
    expect(clientModule).toContain("import clsx from 'clsx'")
    expect(clientModule).toContain('export const T')
    expect(page).toContain("import clsx from 'clsx'")
    expect(warnings).toEqual([])
  })

  it('copies a next/navigation hook import into the client module', () => {
    const source = "import { usePathname } from 'next/navigation'\n\nexport const P = () => <b>{usePathname()}</b>\n\n<P />"
    const { clientModule } = extract(source)
    expect(clientModule).toContain("import { usePathname } from 'next/navigation'")
  })
})

describe('source-site @/ path aliases', () => {
  function run(source: string): { body: string; warnings: Array<MigrationWarning> } {
    const root = fixture({})
    const warnings: Array<MigrationWarning> = []
    const migrator = createComponentMigrator(root, root, warnings, 'https://github.com/example/docs')
    return { body: migrator.transform(source, join(root, 'page.mdx')), warnings }
  }

  it('drops an unresolvable @/ component import used only as JSX and replaces its usage', () => {
    const { body, warnings } = run("import Hero from '@/components/HomepageHero'\n\n<Hero />")
    expect(body).not.toContain('import Hero')
    expect(body).toContain("{/* Removed <Hero>: unsupported import '@/components/HomepageHero' */}")
    expect(warnings).toContainEqual(expect.objectContaining({ code: 'unsupported-config', message: expect.stringContaining('path alias') }))
  })

  it('excludes a page that uses an @/ import outside JSX', () => {
    const { warnings } = run("import { features } from '@/data/features'\n\n{features.length} features")
    expect(warnings).toContainEqual(expect.objectContaining({ code: 'skipped-file', message: expect.stringContaining("the path alias '@/data/features'") }))
  })
})

describe('SCAFFOLD_PROVIDED_IMPORTS drift guard', () => {
  // The starter's package.json is starter-owned: `starter-runtime-contract.mjs`
  // only syncs the `@thallylabs/core` pin into it, not this repo's root
  // dependencies. What the contract does sync byte-for-byte is the runtime
  // (FRAMEWORK_SYNC_ELIGIBLE: src/app, src/components, src/lib, ...), so a
  // package that synced runtime code imports must be installed by the starter
  // or the starter itself would not build. Both checks below are local proxies
  // for the starter's real package.json, which lives in another repository.
  it('every listed package is a root runtime dependency imported by synced runtime code', async () => {
    const { readFileSync, readdirSync } = await import('node:fs')
    const { fileURLToPath } = await import('node:url')
    const { FRAMEWORK_SYNC_ELIGIBLE } = await import('../../../../.github/scripts/starter-runtime-contract.mjs')
    const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url))
    const rootPackageJson = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))
    const dependencies = new Set(Object.keys(rootPackageJson.dependencies ?? {}))
    const runtimeDirs = ['src/app', 'src/components', 'src/lib']
    for (const dir of runtimeDirs) expect(FRAMEWORK_SYNC_ELIGIBLE).toContain(`${dir}/**`)
    const runtimeSource = runtimeDirs.flatMap((dir) => readdirSync(join(repoRoot, dir), { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name))
      .map((entry) => readFileSync(join(entry.parentPath, entry.name), 'utf8'))).join('\n')
    for (const name of SCAFFOLD_PROVIDED_IMPORTS) {
      expect(dependencies.has(name), `${name} is not in root package.json dependencies`).toBe(true)
      expect(new RegExp(`from ['"]${name}(?:/[^'"]*)?['"]`).test(runtimeSource), `${name} is not imported by synced runtime code`).toBe(true)
    }
  })
})
