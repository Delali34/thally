/**
 * A stylesheet's rules for the classes a copied component builds, and the theme variables those rules read, come across with it, every
 * one confined to the page content container.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { compileSync } from '@mdx-js/mdx'
import { Window } from 'happy-dom'
import { describe, expect, it } from 'vitest'

import { migrateRepository } from '../index.js'

// The shape of Infisical's docs: design tokens on `:root` and `.dark`, `.ifx-*` rules for classes a snippet component builds at run
// time, and rules for Mintlify's own markup that the Thally shell does not take.
const stylesheet = `
* { border-radius: 0 !important; }

:root {
  --ifx-surface: #fbfbfa;
  --ifx-line: rgb(var(--gray-200, 223 223 223) / 0.7);
  --ifx-card-bg: var(--ifx-surface);
  --ifx-card-line: var(--ifx-line);
  --ifx-green: #56a600;
  --ifx-cat-secrets: var(--ifx-green);
  --ifx-cat-pam: #dc2626;
  --ifx-unused: #123456;
  --docs-bg: #ff0000;
  --thally-background: 0 0% 0%;
  background-color: pink;
}

.dark {
  --ifx-surface: #101114;
  --ifx-line: rgb(255 255 255 / 0.1);
  --ifx-green: #9ee067;
  --ifx-cat-pam: #ff8a85;
  --ds-accent: #ffffff;
}

#content-area div.card { background-color: var(--ifx-card-bg); border-color: var(--ifx-unused); }
.nav-tabs-item { color: var(--ifx-green); }

.ifx-catalog { display: grid; gap: 12px; }
.ifx-card { border: 1px solid var(--ifx-card-line); background: var(--ifx-card-bg); }
.ifx-card--secrets { border-top-color: var(--ifx-cat-secrets); }
.dark .ifx-card--pam { border-top-color: var(--ifx-cat-pam); }
.ifx-card__title { font-weight: 600; }
.ifx-tag--new { text-transform: uppercase; }
.ifx-never-built { color: red; }
.title { margin: 0; }
.ifx-tile { padding: 8px; }
.ifx-tile--wide { grid-column: span 2; }
.ifx-tile:hover .ifx-tile__icon { opacity: 1; }
.ifx-lane--dim, .ifx-lane--focus { opacity: 0.4; }
.ifx-lane--hidden { display: none; }
.ifx-card__title [data-as="p"] { margin: 0; }
.ifx-card__title ul + [data-as="p"], .ifx-card__title ol + [data-as="p"] { margin-top: 4px; }
.ifx-card__title[data-as="h3"] { font-size: 1rem; }
.ifx-card__title [data-as] { color: red; }
`

const catalog = [
  'const cx = (...names) => names.filter(Boolean).join(" ")',
  'const heading = "title"',
  'const stateClass = (base, on) => (on ? `${base} ${base}--focus` : `${base} ${base}--dim`)',
  'export const Catalog = ({ kinds }) => (',
  '  <div className="ifx-catalog">',
  '    {kinds.map((kind) => (',
  '      <a key={kind} className={`ifx-card ifx-card--${kind}`}>',
  '        <h3 className={cx("ifx-card__title")}>{kind}</h3>',
  '      </a>',
  '    ))}',
  '    <span className={"ifx-tag--" + "new"} />',
  '    <b className={`ifx-tile${kinds.length > 1 ? " ifx-tile--wide" : ""}`}><i className="ifx-tile__icon" /></b>',
  '    <u className={stateClass("ifx-lane", kinds.length > 1)} />',
  '  </div>',
  ')',
  '',
].join('\n')

function migrate(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), 'thally-migrate-component-styles-'))
  const all = {
    'docs.json': JSON.stringify({ $schema: 'https://mintlify.com/docs.json', navigation: { pages: ['index'] } }),
    'index.mdx': '---\ntitle: Home\n---\n\nimport { Catalog } from "/snippets/catalog.jsx"\n\n<Catalog kinds={["secrets", "pam"]} />\n',
    'snippets/catalog.jsx': catalog,
    'style.css': stylesheet,
    ...files,
  }
  for (const [path, body] of Object.entries(all)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), body)
  }
  const bundle = migrateRepository({ repositoryDir: root, sourceUrl: 'https://github.com/acme/docs' })
  const href = bundle.docsConfig.stylesheets?.[0]
  return {
    css: bundle.assets.find((asset) => `/${asset.path}` === href)?.content.toString() ?? '',
    warnings: bundle.warnings.filter((warning) => warning.source === 'style.css').map((warning) => warning.message),
    bundle,
  }
}

const rules = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, ' ')

describe('stylesheet rules for the classes a copied component builds', () => {
  it('keeps the rules for a class the component spells out, builds from a template or joins from parts', () => {
    const { css } = migrate({})
    const text = rules(css)
    expect(text).toContain('.ifx-catalog {')
    expect(text).toContain('.ifx-card {')
    expect(text).toContain('.ifx-card--secrets {')
    expect(text).toContain('.dark :where(.thally-docs-prose, [data-thally-source-page]) .ifx-card--pam {')
    expect(text).toContain('.ifx-card__title {')
    expect(text).toContain('.ifx-tag--new {')
    // A name a value follows (`ifx-tile${...}`), and a modifier added to a name held in a variable (`${base}--dim`).
    expect(text).toContain('.ifx-tile {')
    expect(text).toContain('.ifx-tile--wide {')
    expect(text).toContain('.ifx-tile:hover .ifx-tile__icon {')
    expect(text).toContain(':where(.thally-docs-prose, [data-thally-source-page]) .ifx-lane--dim, :where(.thally-docs-prose, [data-thally-source-page]) .ifx-lane--focus {')
    expect(text).not.toContain('.ifx-lane--hidden')
    expect(text).not.toContain('.ifx-never-built')
  })

  it('does not take a bare word from a string as a class', () => {
    // "title" is a string the component holds, but not a class name it builds: `.title` would restyle every page that has one.
    expect(rules(migrate({}).css)).not.toContain('.title')
  })

  it('skips Mintlify platform selectors and the global reset', () => {
    const text = rules(migrate({}).css)
    expect(text).not.toContain('#content-area')
    expect(text).not.toContain('.nav-tabs-item')
    expect(text).not.toMatch(/\*\s*\{/)
  })
})

describe('theme custom properties on :root and .dark', () => {
  it('keeps those some kept rule reads, directly or through another variable, in both themes', () => {
    const text = rules(migrate({}).css)
    const root = /:root :where\(\.thally-docs-prose, \[data-thally-source-page\]\) \{([^}]*)\}/.exec(text)?.[1] ?? ''
    const dark = /\.dark :where\(\.thally-docs-prose, \[data-thally-source-page\]\) \{([^}]*)\}/.exec(text)?.[1] ?? ''
    for (const name of ['--ifx-surface', '--ifx-line', '--ifx-card-bg', '--ifx-card-line', '--ifx-green', '--ifx-cat-secrets', '--ifx-cat-pam']) expect(root, name).toContain(`${name}:`)
    for (const name of ['--ifx-surface', '--ifx-line', '--ifx-green', '--ifx-cat-pam']) expect(dark, name).toContain(`${name}:`)
  })

  it('drops a variable no kept rule reads, and what else the block sets', () => {
    const text = rules(migrate({}).css)
    expect(text).not.toContain('--ifx-unused')
    expect(text).not.toContain('--docs-bg')
    expect(text).not.toContain('--thally-background')
    expect(text).not.toContain('--ds-accent')
    expect(text).not.toContain('background-color: pink')
  })

  it('says plainly what it skipped', () => {
    const { warnings } = migrate({})
    const text = warnings.join('\n')
    expect(text).toMatch(/--ifx-unused, --docs-bg, --thally-background, --ds-accent \(no imported rule uses them\)/)
    expect(text).toMatch(/1 other declaration/)
  })

  it('imports no theme block at all when nothing kept reads a variable', () => {
    const { css } = migrate({ 'snippets/catalog.jsx': 'export const Catalog = () => <div className="ifx-catalog" />', 'style.css': stylesheet.replace(/var\(--[\w-]+\)/g, 'red') })
    expect(css).toContain('.ifx-catalog')
    expect(css).not.toMatch(/:root|--ifx/)
  })
})

describe('a paragraph selector written for Mintlify\'s [data-as] marker', () => {
  it('names the element the marker stands for, so no combinator is left dangling', () => {
    const text = rules(migrate({}).css)
    expect(text).toContain(':where(.thally-docs-prose, [data-thally-source-page]) .ifx-card__title p:not([class]) {')
    expect(text).toContain(':where(.thally-docs-prose, [data-thally-source-page]) .ifx-card__title ul + p:not([class]), :where(.thally-docs-prose, [data-thally-source-page]) .ifx-card__title ol + p:not([class]) {')
    expect(text).toContain('.ifx-card__title {')
    expect(text).not.toMatch(/data-as|[+>~] ?[,{]|\s,/)
    // `[data-as]` with no element named has nothing to stand for: the rule is skipped, not applied to the whole ancestor.
    expect(text).not.toContain('color: red')
  })

  it('stands for a Markdown paragraph, not for a paragraph a component renders with a class', () => {
    // Mintlify marks the paragraphs MDX makes. Thally renders those as a plain `<p>`; a paragraph a site component draws carries its
    // own class, and the rule written for Markdown text must not reach it.
    const component = 'export const Picker = () => (\n  <div className="ifx-avsp__body">\n    <p className="ifx-avsp__step-desc">A step</p>\n  </div>\n)\n'
    const { css } = migrate({
      'snippets/catalog.jsx': component,
      'index.mdx': '---\ntitle: Home\n---\n\nimport { Picker } from "/snippets/catalog.jsx"\n\n<Picker />\n',
      'style.css': '.ifx-avsp__body [data-as="p"] { margin: 0 }\n.ifx-avsp__step-desc { margin: 4px 0 }',
    })
    const rule = /(:where\([^)]*\) \.ifx-avsp__body [^{]*)\{/.exec(rules(css))?.[1]?.trim()
    expect(rule).toBeDefined()
    const { document } = new Window()
    document.body.innerHTML = '<div data-thally-source-page><div class="ifx-avsp__body"><p class="ifx-avsp__step-desc">A step</p><p>Markdown text</p></div></div>'
    const matched = [...document.querySelectorAll(rule as string)].map((element) => element.textContent)
    expect(matched).toEqual(['Markdown text'])
  })
})

describe('a class a template builds from a value', () => {
  const component = (...classNames: Array<string>) => `export const Box = ({ x, size, kind }) => (\n  <div>\n${classNames.map((name) => `    <i className={${name}} />`).join('\n')}\n  </div>\n)\n`
  const run = (names: Array<string>, css: string) => rules(migrate({ 'snippets/catalog.jsx': component(...names), 'style.css': css }).css)

  it('admits no rule for a bare prefix with no family boundary, however short', () => {
    // `s${size}` builds `s1`, `s2`: it says nothing about `.sticky`, which the Thally sidebar uses.
    const text = run(['`s${size}`', '`btn${x}`'], '.sticky { display: none !important; }\n.s1 { color: red; }\n.btn-primary { color: blue; }\n.btnLarge { color: teal; }\n.btn { color: pink; }')
    expect(text).toBe('')
  })

  it('admits the rules of a family only at a boundary long enough to name one', () => {
    const css = '.btn-primary { color: blue; }\n.btnLarge { color: teal; }\n.a-b { color: red; }\n.ifx_row_cells { color: green; }\n.ifx-grid--wide { color: gold; }'
    const text = run(['`btn-${x}`', '`a-${x}`', '`ifx_row_${x}`', '`ifx-grid--${kind}`'], css)
    expect(text).toContain('.btn-primary {')
    expect(text).toContain('.ifx_row_cells {')
    expect(text).toContain('.ifx-grid--wide {')
    expect(text).not.toMatch(/btnLarge|\.a-b/)
  })

  it('counts a name a value follows as that name only, when it reads as a name', () => {
    const text = run(['`ifx-card${x}`'], '.ifx-card { color: blue; }\n.ifx-card-title { color: teal; }\n.ifx-cardinal { color: red; }\n.ifx-card--wide { color: gold; }')
    expect(text).toContain('.ifx-card {')
    expect(text).not.toMatch(/ifx-card-title|ifx-cardinal|ifx-card--wide/)
  })
})

describe('a variable the Thally runtime uses too', () => {
  it('is declared on the page content container only, so it cannot change the shell', () => {
    const { css } = migrate({ 'snippets/catalog.jsx': 'export const Catalog = () => <div className="ifx-catalog" />', 'style.css': ':root { --thally-background: 0 0% 0%; --docs-line: red; }\n.dark { --docs-line: blue; }\n.ifx-catalog { background: hsl(var(--thally-background)); border-color: var(--docs-line); }' })
    const text = rules(css)
    expect(text).toContain(':root :where(.thally-docs-prose, [data-thally-source-page]) { --thally-background: 0 0% 0%; --docs-line: red; }')
    expect(text).toContain('.dark :where(.thally-docs-prose, [data-thally-source-page]) { --docs-line: blue; }')
  })
})

describe('a page in custom mode', () => {
  const custom = (body: string) => `---\ntitle: Landing\nmode: custom\n---\n\n${body}\n`
  const files = { 'snippets/catalog.jsx': 'export const Catalog = () => <div className="ifx-catalog" />' }
  const indexBody = (bundle: ReturnType<typeof migrate>['bundle']) => bundle.pages[0].body

  it('has its content wrapped in the element the kept rules are also confined to, since Thally renders it with no container', () => {
    const { css, bundle, warnings } = migrate({
      'index.mdx': custom('import { PROMPT } from "/snippets/prompt.js"\n\n<div className="ifx-catalog">{PROMPT}</div>\n\nSome text.'),
      'snippets/prompt.js': 'export const PROMPT = "Hello"\n',
    })
    expect(rules(css)).toContain(':where(.thally-docs-prose, [data-thally-source-page]) .ifx-catalog {')
    // The imports stay where they were, above the wrapper.
    expect(indexBody(bundle)).toMatch(/^import \{ PROMPT [^\n]*\n+<div data-thally-source-page>\n\n<div className="ifx-catalog">\{PROMPT\}<\/div>\n\nSome text\.\n\n<\/div>\n$/)
    expect(warnings.join('\n')).not.toContain('mode: custom')
    expect(() => compileSync(indexBody(bundle), { format: 'mdx' })).not.toThrow()
  })

  it('is left as it was, with a warning, when an export follows its content', () => {
    const { bundle, warnings } = migrate({ ...files, 'index.mdx': custom('<div className="ifx-catalog" />\n\nexport const later = 1\n\n<b>{later}</b>') })
    expect(indexBody(bundle)).not.toContain('data-thally-source-page')
    expect(warnings.join('\n')).toMatch(/1 page uses `mode: custom`.*could not be given.*do not apply there/)
  })

  it('leaves a page in any other mode, and a site with no kept rule, as they were', () => {
    expect(indexBody(migrate({}).bundle)).not.toContain('data-thally-source-page')
    const none = migrate({ ...files, 'index.mdx': custom('<div className="plain" />'), 'style.css': '.mintlify-x { color: red; }' })
    expect(indexBody(none.bundle)).not.toContain('data-thally-source-page')
  })
})
