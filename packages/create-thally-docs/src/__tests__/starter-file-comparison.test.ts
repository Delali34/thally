/** CRLF checkout conversion must not hide edits or bypass exact write guards. */
import { describe, expect, it } from 'vitest'
import { areStarterFileContentsEquivalent } from '../starter-file-comparison.js'
import { resolveManualReviewMutations } from '../starter-manual-review.js'

const bytes = (value: string) => Buffer.from(value)

describe('starter text equivalence', () => {
  it.each(['next.config.ts', 'eslint.config.mjs', '.gitignore', '.gitattributes'])('recognizes unchanged CRLF %s', path => {
    expect(areStarterFileContentsEquivalent(path, bytes('old\r\n'), bytes('old\n'))).toBe(true)
    const result = resolveManualReviewMutations([path], new Map([[path, bytes('old\r\n')]]), new Map([[path, bytes('old\n')]]), new Map([[path, bytes('new\n')]]))
    expect(result.conflicts).toEqual([])
    expect(result.writeFiles.get(path)).toEqual(bytes('new\n'))
  })

  it('keeps substantive manual configuration edits as conflicts', () => {
    const path = 'next.config.ts'
    const result = resolveManualReviewMutations([path], new Map([[path, bytes('owner edit\r\n')]]), new Map([[path, bytes('old\n')]]), new Map([[path, bytes('new\n')]]))
    expect(result.conflicts).toEqual([{ path, fields: [] }])
    expect(result.writeFiles.size).toBe(0)
  })

  it('never normalizes unknown files, binary data, invalid UTF-8 or lone CR', () => {
    expect(areStarterFileContentsEquivalent('image.png', bytes('old\r\n'), bytes('old\n'))).toBe(false)
    expect(areStarterFileContentsEquivalent('next.config.ts', bytes('old\0\r\n'), bytes('old\0\n'))).toBe(false)
    expect(areStarterFileContentsEquivalent('next.config.ts', Buffer.from([255,13,10]), Buffer.from([255,10]))).toBe(false)
    expect(areStarterFileContentsEquivalent('next.config.ts', bytes('old\r'), bytes('old\n'))).toBe(false)
  })
})
