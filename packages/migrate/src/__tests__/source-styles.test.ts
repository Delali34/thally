/** A rule kept from a site's stylesheet applies inside the page content only, so it can never restyle the Thally shell around it. */

import * as cheerio from 'cheerio'
import postcss from 'postcss'
import { describe, expect, it } from 'vitest'

import { projectAuthoredStyles } from '../source-styles.js'

const SCOPE = ':where(.thally-docs-prose, [data-thally-source-page])'

// A page as the runtime renders it: the shell (top bar, sidebar, breadcrumbs, pagination, table of contents, footer) around one content
// container. Shell and content both carry classes and ids a site may reuse.
const page = `<html class="dark"><body>
<header class="thally-docs-topbar"><svg class="lucide"></svg><nav class="not-prose"><a class="ifx-box"></a></nav></header>
<aside class="thally-docs-sidebar"><nav class="lucide"><a class="ifx-box"><i class="not-prose"></i></a></nav></aside>
<main id="main-content" class="thally-docs-main">
  <div class="not-prose"><nav class="thally-docs-breadcrumbs"><svg class="lucide"></svg></nav></div>
  <article class="thally-docs-article"><div class="thally-docs-prose prose">
    <div class="ifx-box"><svg class="lucide"></svg><p>Text <a href="/">link</a></p><b class="not-prose"></b></div>
  </div><div class="not-prose"><nav class="pagination"></nav></div></article>
  <aside id="table-of-contents-content" class="thally-docs-toc"><nav></nav></aside>
  <div lang="en"><div data-thally-source-page><div class="ifx-box"><svg class="lucide"></svg></div></div></div>
</main>
<footer class="thally-docs-footer"><nav></nav></footer>
</body></html>`

/** The selectors a rule has, a rule nested in another one read as the browser reads it: `&` is the rule around it, and with no `&` it is a descendant. */
function expand(rule: postcss.Rule): Array<string> {
  let outer: postcss.Node | undefined = rule.parent
  while (outer && outer.type !== 'rule') outer = outer.parent
  if (!outer) return rule.selectors
  const around = `:is(${expand(outer as postcss.Rule).join(', ')})`
  return rule.selectors.map((selector) => selector.includes('&') ? selector.replaceAll('&', around) : `${around} ${selector}`)
}

/** How many elements of the page the rules of `css` reach inside the content container, and outside it. */
function reach(css: string): { inside: number; outside: number } {
  const $ = cheerio.load(page)
  const reached = new Set<unknown>()
  postcss.parse(css).walkRules((rule) => {
    if (rule.parent?.type === 'atrule' && /keyframes$/i.test(rule.parent.name)) return
    for (const selector of expand(rule)) for (const element of $(selector.replace(/::?[\w-]+$/, '')).toArray()) reached.add(element)
  })
  const outside = [...reached].filter((element) => $(element as never).closest('.thally-docs-prose, [data-thally-source-page]').length === 0).length
  return { inside: reached.size - outside, outside }
}

const project = (css: string, content = '<i className="ifx-a ifx-b x y" />') => projectAuthoredStyles(css, [content], [], 'src-test')
const text = (css: string) => css.replace(/\s+/g, ' ').trim()

describe('a rule a site wrote for a name Thally uses too', () => {
  const authored = '<div className="ifx-box lucide" id="table-of-contents-content"><i id="main-content" /></div>'
  const rules = [
    '.lucide { display: none !important; }',
    '.ifx-box [class~="not-prose"] { margin: 0; }',
    '.ifx-box [class*="not-prose"] { margin: 0; }',
    '#table-of-contents-content { display: none !important; }',
    '#main-content nav { display: none; }',
    '.ifx-box { color: red; }',
  ]

  it.each(rules)('%s cannot reach anything outside the page content', (rule) => {
    const { css } = project(rule, authored)
    expect(reach(css).outside).toBe(0)
  })

  it('still reaches the same markup inside the page content, and inside a custom-mode page', () => {
    // One in the content container, one in the element a custom-mode page's content is wrapped in.
    expect(reach(project(rules[0], authored).css).inside).toBe(2)
    expect(reach(project(rules[1], authored).css).inside).toBe(1)
    expect(reach(project(rules[5], authored).css).inside).toBe(2)
  })
})

describe('the way a selector is confined', () => {
  const cases: Array<[string, string]> = [
    ['.ifx-a', `${SCOPE} .ifx-a`],
    ['.ifx-a, .ifx-b p', `${SCOPE} .ifx-a, ${SCOPE} .ifx-b p`],
    ['.ifx-a > .ifx-b + p ~ i', `${SCOPE} .ifx-a > .ifx-b + p ~ i`],
    ['.ifx-a:is(.ifx-b, p):not(.x):where(.y)', `${SCOPE} .ifx-a:is(.ifx-b, p):not(.x):where(.y)`],
    ['.ifx-a:has(> p)::before', `${SCOPE} .ifx-a:has(> p)::before`],
    ['*:not(.ifx-a) .ifx-b', `${SCOPE} *:not(.ifx-a) .ifx-b`],
    ['.dark .ifx-a', `.dark ${SCOPE} .ifx-a`],
    ['.light .ifx-a > p', `.light ${SCOPE} .ifx-a > p`],
    ['html.dark .ifx-a', `html.dark ${SCOPE} .ifx-a`],
    [':root .ifx-a', `:root ${SCOPE} .ifx-a`],
    ['body .ifx-a', `body ${SCOPE} .ifx-a`],
    ['html body.dark .ifx-a', `html body.dark ${SCOPE} .ifx-a`],
    [':is(.dark, .light) .ifx-a', `:is(.dark, .light) ${SCOPE} .ifx-a`],
    ['.ifx-a, .dark .ifx-b', `${SCOPE} .ifx-a, .dark ${SCOPE} .ifx-b`],
  ]

  it.each(cases)('%s', (selector, expected) => {
    expect(text(project(`${selector} { color: red; }`).css)).toBe(`${expected} { color: red; }`)
  })

  it('skips a selector that styles the page, or what is next to the content, instead of what is inside it', () => {
    for (const selector of ['html.ifx-a', 'body.dark.ifx-a', 'body > .ifx-a', 'html + .ifx-a', ':root > .ifx-a']) {
      const result = project(`${selector} { color: red; }`)
      expect(result.css, selector).toBe('')
      expect(result.omittedSelectors, selector).toBe(1)
    }
    const mixed = project('.ifx-a, body > .ifx-b { color: red; }')
    expect(text(mixed.css)).toBe(`${SCOPE} .ifx-a { color: red; }`)
    expect(mixed.omittedSelectors).toBe(1)
  })

  it('confines the rules inside @media, @supports, @layer and @container, and leaves @font-face as it is', () => {
    const keyframes = '@keyframes spin { from { transform: none; } to { transform: rotate(1turn); } }'
    const fontFace = '@font-face { font-family: Site; src: url(site.woff2); }'
    const css = [
      '@media (min-width: 600px) { .ifx-a { color: red; } @supports (display: grid) { .ifx-a { display: grid; } } }',
      '@layer site { .ifx-a { color: blue; } }',
      '@container (min-width: 10px) { .ifx-a, .dark .ifx-b { color: teal; } }',
      keyframes,
      fontFace,
      '.ifx-a { animation: spin 1s; }',
    ].join('\n')
    const projected = text(project(css).css)
    expect(projected).toContain(keyframes.replace('spin', 'src-test-spin'))
    expect(projected).toContain(fontFace)
    expect(projected).toContain(`@media (min-width: 600px) { ${SCOPE} .ifx-a { color: red; } @supports (display: grid) { ${SCOPE} .ifx-a { display: grid; } } }`)
    expect(projected).toContain(`@layer site { ${SCOPE} .ifx-a { color: blue; } }`)
    expect(projected).toContain(`@container (min-width: 10px) { ${SCOPE} .ifx-a, .dark ${SCOPE} .ifx-b { color: teal; } }`)
    expect(projected).toContain(`${SCOPE} .ifx-a { animation: src-test-spin 1s; }`)
  })

})

describe('a selector with alternatives', () => {
  const authored = '<div className="ifx-box lucide not-prose" />'
  const outside = [
    ':is(.ifx-box, :root) .lucide',
    ':where(:root, .ifx-box) > .lucide',
    ':is(.ifx-box, html, body) ~ .not-prose',
    '.ifx-box:is(:root, html) .lucide',
    '.ifx-box:has(~ .not-prose, :root) .lucide',
    '.ifx-box :is(:root, html, body, .ifx-box) .lucide',
    '.ifx-box ~ :is(.not-prose, :root)',
    ':is(.dark, .ifx-box) .lucide',
    ':is(.light, .ifx-box) ~ .not-prose',
    ':is(html, .ifx-box) + .not-prose',
    ':not(:root) .ifx-box .lucide',
  ]

  it.each(outside)('%s cannot reach anything outside the page content', (selector) => {
    expect(reach(project(`${selector} { display: none; }`, authored).css).outside).toBe(0)
  })

  it('skips a leading :is() or :where() that is the page for some alternatives and the content for others', () => {
    for (const selector of [':is(.dark, .ifx-box) .lucide', ':where(html, .ifx-box) > .lucide', ':is(.light, :root, .ifx-box) ~ .lucide']) {
      const result = project(`${selector} { display: none; }`, authored)
      expect(result.css, selector).toBe('')
      expect(result.omittedSelectors, selector).toBe(1)
    }
  })

  it('keeps a leading :is() that is the page for every alternative, in any case', () => {
    expect(text(project(':is(.dark, :ROOT, HTML) .ifx-box { color: red; }', authored).css)).toBe(`:is(.dark, :ROOT, HTML) ${SCOPE} .ifx-box { color: red; }`)
    expect(text(project(':ROOT .ifx-box { color: red; }', authored).css)).toBe(`:ROOT ${SCOPE} .ifx-box { color: red; }`)
  })
})

describe('CSS nesting', () => {
  const authored = '<div className="ifx-a ifx-b lucide not-prose" />'
  const bypasses = [
    // `&` inside :is() beside an alternative that is the page root.
    '.ifx-a { :is(&, :root) .lucide { display: none !important; } }',
    // The rule moves its custom properties onto the container, and the nested rule stays where `.dark` is.
    '.dark { --site-color: red; & ~ .not-prose { display: none !important; } }\n.ifx-a { color: var(--site-color); }',
    '.ifx-a { & ~ .not-prose { display: none; } }',
    '.ifx-a { @media (min-width: 1px) { :is(&, html) .lucide { display: none; } } }',
    '.ifx-a { .ifx-b { :root & .lucide { display: none; } } }',
    ':root { --site-color: red; .not-prose { display: none; } }\n.ifx-a { color: var(--site-color); }',
  ]

  it.each(bypasses)('%s cannot reach anything outside the page content', (css) => {
    expect(reach(project(css, authored).css).outside).toBe(0)
  })

  it('leaves out a rule nested in another and counts it, however deep', () => {
    const result = project('.ifx-a { color: red; &:hover { color: blue; } .ifx-b { color: teal; & > i { color: gold; } } }')
    expect(text(result.css)).toBe(`${SCOPE} .ifx-a { color: red }`)
    expect(result.omittedNestedRules).toBe(3)
    expect(project('.ifx-a { color: red; }').omittedNestedRules).toBe(0)
  })

  it('leaves out a rule nested in a theme block, and what only it read', () => {
    const result = project('.dark { --site-color: red; --ifx-x: blue; & ~ .not-prose { color: var(--ifx-x); } }\n.ifx-a { color: var(--site-color); }')
    expect(text(result.css)).toBe(`.dark ${SCOPE} { --site-color: red } ${SCOPE} .ifx-a { color: var(--site-color); }`)
    expect(result.omittedNestedRules).toBe(1)
    expect(result.skippedVariables).toEqual(['--ifx-x'])
  })

  it('leaves out a condition nested in a theme block, which may only declare custom properties a kept rule reads', () => {
    const result = project('.dark { --site-color: red; @media (min-width: 1px) { background: red; --ifx-x: blue; } }\n.ifx-a { color: var(--site-color); }')
    expect(text(result.css)).toBe(`.dark ${SCOPE} { --site-color: red } ${SCOPE} .ifx-a { color: var(--site-color); }`)
    expect(result.omittedNestedRules).toBe(1)
  })

  it('keeps a media or supports condition written inside a kept rule, which only changes that rule', () => {
    const css = '.ifx-a { color: red; @media (min-width: 600px) { color: blue; } @supports (display: grid) { @media print { display: grid; } } }'
    expect(text(project(css).css)).toBe(`${SCOPE} .ifx-a { color: red; @media (min-width: 600px) { color: blue; } @supports (display: grid) { @media print { display: grid; } } }`)
    expect(reach(project(css).css).outside).toBe(0)
  })

  it('skips a selector that uses & outside a rule, which stands for the page there', () => {
    for (const selector of ['& .ifx-a', ':is(&, .ifx-b) .ifx-a', '.ifx-a:not(&)']) {
      const result = project(`${selector} { color: red; }`)
      expect(result.css, selector).toBe('')
      expect(result.omittedSelectors, selector).toBe(1)
    }
  })
})

describe('the theme blocks of a stylesheet', () => {
  const css = ':root { --ifx-a: red; --thally-background: 0 0% 0%; }\n.dark { --ifx-a: blue; }\nhtml.dark { --ifx-b: green; }\n.ifx-a { color: var(--ifx-a); background: hsl(var(--thally-background)); border-color: var(--ifx-b); }'

  it('declare their custom properties on the content container, so they reach the content and nothing else', () => {
    const projected = text(project(css).css)
    expect(projected).toContain(`:root ${SCOPE} { --ifx-a: red; --thally-background: 0 0% 0%; }`)
    expect(projected).toContain(`.dark ${SCOPE} { --ifx-a: blue; }`)
    expect(projected).toContain(`html.dark ${SCOPE} { --ifx-b: green; }`)
    expect(reach(project(css).css).outside).toBe(0)
  })

  it('give the container its dark values under a dark page only', () => {
    const dark = project(css).css.match(/\.dark :where\([^)]*\)/)![0]
    const $ = cheerio.load(page)
    expect($(dark).toArray().map((element) => $(element).attr('class') ?? 'data-thally-source-page')).toEqual(['thally-docs-prose prose', 'data-thally-source-page'])
    expect(cheerio.load(page.replace('<html class="dark">', '<html>'))(dark).length).toBe(0)
  })
})

describe('a registered custom property (@property)', () => {
  const registration = (name: string) => `@property ${name} { syntax: "<color>"; inherits: false; initial-value: red; }`

  it('is left out when no kept rule reads it, as it would change the shell\'s own custom property of that name', () => {
    const result = project(`${registration('--docs-bg')}\n.ifx-a { color: red; }`)
    expect(text(result.css)).toBe(`${SCOPE} .ifx-a { color: red; }`)
    expect(result.skippedProperties).toEqual(['--docs-bg'])
  })

  it('is left out when a kept rule reads it but the site has no custom properties of that prefix of its own', () => {
    const css = `:root { --ifx-a: red; }\n${registration('--docs-bg')}\n${registration('--glow')}\n${registration('--ifx-angle')}\n.ifx-a { background: var(--docs-bg); color: var(--glow); outline-color: var(--ifx-angle); }`
    const result = project(css)
    expect(result.skippedProperties).toEqual(['--docs-bg', '--glow'])
    expect(text(result.css)).not.toContain('--docs-bg {')
    expect(text(result.css)).not.toContain('--glow {')
    expect(text(result.css)).toContain(`@property --ifx-angle { syntax: "<color>"; inherits: false; initial-value: red; }`)
  })

  it('is kept when a kept rule reads it and the site\'s own theme block declares properties with the same prefix', () => {
    const css = `:root { --ifx-glow: red; }\n.dark { --ifx-glow: blue; }\n${registration('--ifx-glow')}\n.ifx-a { color: var(--ifx-glow); }`
    const result = project(css)
    expect(text(result.css)).toContain(`@property --ifx-glow { syntax: "<color>"; inherits: false; initial-value: red; }`)
    expect(result.skippedProperties).toEqual([])
  })

  it('is left out when only a theme property no rule reads reads it', () => {
    const result = project(`:root { --ifx-a: var(--ifx-glow); --ifx-glow: red; }\n${registration('--ifx-glow')}\n.ifx-a { color: red; }`)
    expect(result.skippedProperties).toEqual(['--ifx-glow'])
  })
})

describe('the layers of a stylesheet (@layer)', () => {
  it('keeps the statement that orders them, whatever else is left out', () => {
    const css = '@layer hidden, visible;\n@layer visible { .ifx-a { color: red; } }\n@layer hidden { .ifx-a { color: blue; } }'
    const projected = text(project(css).css)
    expect(projected.startsWith('@layer hidden, visible;')).toBe(true)
    expect(projected).toContain(`@layer visible { ${SCOPE} .ifx-a { color: red; } } @layer hidden { ${SCOPE} .ifx-a { color: blue; } }`)
  })

  it('keeps a layer whose rules were all left out, and a statement inside a condition', () => {
    const css = '@layer base { #navbar { color: red; } }\n@media (min-width: 1px) { @layer late, later; }\n@layer theme { .ifx-a { color: red; } }\n@layer base { .ifx-a { color: blue; } }\n@layer { }'
    const projected = text(project(css).css)
    expect(projected).toContain('@layer base { }')
    expect(projected).toContain('@media (min-width: 1px) { @layer late, later; }')
    expect(projected.indexOf('@layer base { }')).toBeLessThan(projected.indexOf('@layer theme'))
    expect(projected).toContain(`@layer base { ${SCOPE} .ifx-a { color: blue; } }`)
  })

  it('reads an at-rule name in any case', () => {
    expect(text(project('@LAYER a, b;\n@FONT-FACE { font-family: Site; src: url(site.woff2); }').css)).toBe('@LAYER a, b; @FONT-FACE { font-family: Site; src: url(site.woff2); }')
  })

  it('still removes a condition that is left with nothing in it', () => {
    expect(project('@media (min-width: 1px) { #navbar { color: red; } }').css).toBe('')
  })
})

describe('keyframes names', () => {
  const frames = (name: string) => `@keyframes ${name} { from { opacity: 0; } to { opacity: 1; } }`

  it('are given the site\'s prefix, and so are the animations that name them', () => {
    const css = `${frames('spin')}\n${frames('fade-in')}\n.ifx-a { animation: spin 1s linear infinite; }\n.ifx-b { animation: 2s ease-in fade-in, 1s spin; animation-name: fade-in, spin; }`
    const projected = text(project(css).css)
    expect(projected).toContain(`@keyframes src-test-spin { from { opacity: 0; } to { opacity: 1; } }`)
    expect(projected).toContain(`@keyframes src-test-fade-in { from { opacity: 0; } to { opacity: 1; } }`)
    expect(projected).toContain(`${SCOPE} .ifx-a { animation: src-test-spin 1s linear infinite; }`)
    expect(projected).toContain(`${SCOPE} .ifx-b { animation: 2s ease-in src-test-fade-in, 1s src-test-spin; animation-name: src-test-fade-in, src-test-spin; }`)
  })

  it('are matched as whole words: a longer name, a function and its arguments, and other properties are left alone', () => {
    const css = `${frames('spin')}\n${frames('end')}\n.ifx-a { animation: spinner 1s, spin-slow 1s, end 1s steps(4, end), spin 1s cubic-bezier(0, 0, 1, 1); transition: spin 1s; font-family: spin; content: "spin"; }`
    expect(text(project(css).css)).toContain(`${SCOPE} .ifx-a { animation: spinner 1s, spin-slow 1s, src-test-end 1s steps(4, end), src-test-spin 1s cubic-bezier(0, 0, 1, 1); transition: spin 1s; font-family: spin; content: "spin"; }`)
  })

  it('are renamed in a quoted name, a prefixed at-rule, a condition and a custom property', () => {
    const css = `@media (min-width: 1px) { ${frames('spin')} }\n@-webkit-keyframes "my spin" { to { opacity: 1; } }\n.ifx-a { -webkit-animation: "my spin" 1s; animation-name: 'spin'; --ifx-anim: spin 1s; animation: var(--ifx-anim); }`
    const projected = text(project(css).css)
    expect(projected).toContain('@media (min-width: 1px) { @keyframes src-test-spin {')
    expect(projected).toContain('@-webkit-keyframes "src-test-my spin" {')
    expect(projected).toContain(`${SCOPE} .ifx-a { -webkit-animation: "src-test-my spin" 1s; animation-name: 'src-test-spin'; --ifx-anim: src-test-spin 1s; animation: var(--ifx-anim); }`)
  })

  it('cannot replace a keyframes rule the Thally runtime defines', () => {
    const projected = project(`${frames('spin')}\n.ifx-a { animation: spin 1s; }`).css
    expect([...projected.matchAll(/@keyframes\s+([^\s{]+)/g)].map((match) => match[1])).not.toContain('spin')
  })
})

describe('the definitions a kept rule names (@counter-style, @font-palette-values)', () => {
  const counter = (name: string, body = 'system: cyclic; symbols: "a" "b"; suffix: " ";') => `@counter-style ${name} { ${body} }`
  const palette = (name: string) => `@font-palette-values ${name} { font-family: Site; base-palette: 1; }`

  it('are kept when a kept rule names them, so the reference does not point at nothing', () => {
    const css = `${counter('ifx-roman')}\n${palette('--ifx-pal')}\n.ifx-a li { list-style: ifx-roman inside; }\n.ifx-a b { font-palette: --ifx-pal; }`
    const result = project(css)
    expect(text(result.css)).toContain('@counter-style ifx-roman { system: cyclic; symbols: "a" "b"; suffix: " "; }')
    expect(text(result.css)).toContain('@font-palette-values --ifx-pal { font-family: Site; base-palette: 1; }')
    expect(result.omittedAtRules).toEqual([])
  })

  it('are kept when a kept rule names them through counter(), and when another kept definition does', () => {
    const css = `${counter('ifx-a-style', 'system: extends ifx-b-style; suffix: ") ";')}\n${counter('ifx-b-style')}\n${counter('ifx-c-style')}\n.ifx-a li::marker { content: counter(item, ifx-a-style); }`
    const result = project(css)
    expect(text(result.css)).toContain('@counter-style ifx-a-style {')
    expect(text(result.css)).toContain('@counter-style ifx-b-style {')
    expect(text(result.css)).not.toContain('ifx-c-style')
    expect(result.omittedAtRules).toEqual(['@counter-style ifx-c-style'])
  })

  it('are left out and counted when no kept rule names them', () => {
    const css = `${counter('ifx-roman')}\n${palette('--ifx-pal')}\n.ifx-a { color: red; }\n#navbar { list-style: ifx-roman; font-palette: --ifx-pal; }`
    const result = project(css)
    expect(text(result.css)).toBe(`${SCOPE} .ifx-a { color: red; }`)
    expect(result.omittedAtRules).toEqual(['@counter-style ifx-roman', '@font-palette-values --ifx-pal'])
  })

  it('are not the only at-rules left out: any other that holds no style rule is counted, apart from @charset', () => {
    const css = '@charset "utf-8";\n@page { margin: 1cm; }\n@view-transition { navigation: auto; }\n@namespace svg url(http://www.w3.org/2000/svg);\n@media print { #navbar { color: red; } }\n.ifx-a { color: red; }'
    const result = project(css)
    expect(text(result.css)).toBe(`${SCOPE} .ifx-a { color: red; }`)
    expect(result.omittedAtRules).toEqual(['@page', '@view-transition', '@namespace svg url(http://www.w3.org/2000/svg)'])
  })
})

describe('a stylesheet with thousands of references to follow', { timeout: 60_000 }, () => {
  // A site's stylesheet can be large and every name in it may lead to the next, so the work has to grow with its size, not with its square.
  // How long a run takes depends on the machine, so each test compares two sizes of the same input instead: four times the input takes about
  // four times as long when the work is linear and about sixteen times as long when it is quadratic. That is counted in the processor time
  // the run uses, which a busy machine does not stretch the way it stretches the time on the clock.
  const SMALL = 1000
  const LARGER_BY = 4
  const LARGE = SMALL * LARGER_BY
  const REPEATS = 9
  const MOST_LINEAR_GROWTH = 9
  const processorMs = (): number => { const { user, system } = process.cpuUsage(); return (user + system) / 1000 }
  /**
   * How many times longer the work `prepare` returns takes for `LARGER_BY` times `size` than for `size`. The input is built outside the
   * timing, each size is taken at its fastest of several runs after one to warm up, and the runs alternate so a slow patch meets both sizes.
   */
  const growth = <T,>(prepare: (size: number) => () => T, size: number): { result: T; ratio: number } => {
    const [small, large] = [prepare(size), prepare(size * LARGER_BY)]
    const time = (work: () => T): { result: T; ms: number } => {
      const start = processorMs()
      const result = work()
      return { result, ms: processorMs() - start }
    }
    time(small)
    let [fastestSmall, fastestLarge] = [Infinity, Infinity]
    let result!: T
    for (let repeat = 0; repeat < REPEATS; repeat++) {
      fastestSmall = Math.min(fastestSmall, time(small).ms)
      const run = time(large)
      fastestLarge = Math.min(fastestLarge, run.ms)
      result = run.result
    }
    return { result, ratio: fastestLarge / fastestSmall }
  }

  it('follows a chain of custom properties declared in the opposite order to the one they are read in', () => {
    const chain = (count: number) => Array.from({ length: count }, (_, i) => `--ifx-${count - 1 - i}: ${i === 0 ? 'red' : `var(--ifx-${count - i})`};`).join(' ')
    const css = (count: number) => `:root { ${chain(count)} --ifx-unread: blue; }\n.ifx-a { color: var(--ifx-0); }`
    const small = project(css(3))
    expect(text(small.css)).toBe(`:root ${SCOPE} { --ifx-2: red; --ifx-1: var(--ifx-2); --ifx-0: var(--ifx-1); } ${SCOPE} .ifx-a { color: var(--ifx-0); }`)
    expect(small.skippedVariables).toEqual(['--ifx-unread'])

    const { result, ratio } = growth((count) => { const input = css(count); return () => project(input) }, SMALL)
    expect(result.css.match(/--ifx-\d+:/g)).toHaveLength(LARGE)
    expect(result.skippedVariables).toEqual(['--ifx-unread'])
    expect(ratio).toBeLessThan(MOST_LINEAR_GROWTH)
  })

  it('reads a custom property that names itself, or one that names another that names it, once', () => {
    const result = project(':root { --ifx-a: var(--ifx-b); --ifx-b: var(--ifx-a); --ifx-c: var(--ifx-c); --ifx-d: var(--ifx-a); }\n.ifx-a { color: var(--ifx-a); border-color: var(--ifx-c); }')
    expect(text(result.css)).toBe(`:root ${SCOPE} { --ifx-a: var(--ifx-b); --ifx-b: var(--ifx-a); --ifx-c: var(--ifx-c); } ${SCOPE} .ifx-a { color: var(--ifx-a); border-color: var(--ifx-c); }`)
    expect(result.skippedVariables).toEqual(['--ifx-d'])
  })

  it('follows a chain of counter styles that each extend the next, declared in the opposite order', () => {
    const chain = (count: number) => Array.from({ length: count }, (_, i) => `@counter-style ifx-c${count - 1 - i} { system: extends ifx-c${count - i}; }`).join('\n')
    const css = (count: number) => `${chain(count)}\n.ifx-a li { list-style: ifx-c0; }`
    const small = project(css(3))
    expect(text(small.css)).toBe(`@counter-style ifx-c2 { system: extends ifx-c3; } @counter-style ifx-c1 { system: extends ifx-c2; } @counter-style ifx-c0 { system: extends ifx-c1; } ${SCOPE} .ifx-a li { list-style: ifx-c0; }`)

    const { result, ratio } = growth((count) => { const input = css(count); return () => project(input) }, SMALL)
    expect(result.css.match(/@counter-style/g)).toHaveLength(LARGE)
    expect(result.omittedAtRules).toEqual([])
    expect(ratio).toBeLessThan(MOST_LINEAR_GROWTH)
  })

  it('checks thousands of registered custom properties against thousands the theme blocks declare', () => {
    const names = (prefix: string, count: number) => Array.from({ length: count }, (_, i) => `${prefix}${i}`)
    const foreign = names('--zz-p', 20)
    // Eight theme properties to each registered one, and the one that shares its first word with the registered ones comes last: found only by passing every other.
    const css = (count: number) => {
      const [theme, own] = [names('--aaa-v', count * 8), names('--ifx-p', count)]
      return `:root { ${theme.map((name) => `${name}: red;`).join(' ')} --ifx-x: red; }\n.ifx-a { --ifx-all: ${[...theme, '--ifx-x', ...own, ...foreign].map((name) => `var(${name})`).join(' ')}; }\n${[...own, ...foreign].map((name) => `@property ${name} { syntax: "*"; inherits: false; }`).join('\n')}`
    }
    const { result, ratio } = growth((count) => { const input = css(count); return () => project(input) }, SMALL)
    // The registered properties that share their first word with one the site's theme declares stay, and the others are left out.
    expect(result.css.match(/@property --ifx-p/g)).toHaveLength(LARGE)
    expect(result.skippedProperties).toEqual(foreign)
    expect(ratio).toBeLessThan(MOST_LINEAR_GROWTH)
  })

  it('matches thousands of class names against thousands of families and modifiers', () => {
    // One template: each `ifx-cardN-${kind}` names a family of classes, and each `${base}--mN` a modifier. There are five of each to a selector.
    const prepare = (selectors: number) => {
      const modules = [`export const classes = \`${Array.from({ length: selectors * 5 }, (_, i) => `ifx-card${i}-\${kind} \${base}--m${i}`).join(' ')}\``]
      const css = Array.from({ length: selectors }, (_, i) => `.ifx-card${i}-wide { color: red; } .zzz${i}--m${i} { color: red; }`).join('\n') + '\n.zzz { color: red; }'
      return () => projectAuthoredStyles(css, [], modules, 'src-test')
    }
    const { result, ratio } = growth(prepare, SMALL)
    expect(result.css.match(/\.ifx-card\d+-wide/g)).toHaveLength(LARGE)
    expect(result.css.match(/\.zzz\d+--m\d+/g)).toHaveLength(LARGE)
    expect(result.omittedSelectors).toBe(1)
    expect(ratio).toBeLessThan(MOST_LINEAR_GROWTH)
  })
})
