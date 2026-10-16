/** Candidate tokenization and literal encoding must agree with browser image semantics. */
import { describe, expect, it } from 'vitest'
import { migrationImageCandidates, migrationImageAttribute } from '../url-images.js'

describe('responsive image policy', () => {
  const base = new URL('https://docs.test/docs/guide')
  it('preserves width/density descriptors and commas inside URL tokens', () => {
    expect(migrationImageCandidates('/a,b.png 400w, ../large.png 800w', base)).toEqual([
      { url: 'https://docs.test/a,b.png', descriptor: '400w' },
      { url: 'https://docs.test/large.png', descriptor: '800w' },
    ])
    expect(migrationImageCandidates('/a.png, /b.png 2x', base).map((candidate) => candidate.descriptor)).toEqual(['', '2x'])
  })
  it.each(['javascript:alert(1) 1x', 'data:image/svg+xml,x 1x', 'https://user:secret@docs.test/a.png 1x', '/a.png 0x', '/a.png 1w 2x'])('rejects active or invalid candidates: %s', (value) => {
    expect(() => migrationImageCandidates(value, base)).toThrow()
  })
  it('encodes expression delimiters as literal attribute bytes', () => {
    expect(migrationImageAttribute('{x}" onload="run()')).toBe('&#123;x&#125;&quot; onload=&quot;run()')
  })
})
