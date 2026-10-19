/** Every passive publisher adapter shares one fail-closed Flight value decoder. */
import { describe, expect, it } from 'vitest'
import { resolveMigrationFlightValue } from '../url-flight-content.js'

function document(records: Array<[string, unknown]> = [], texts: Array<[string, string]> = []) {
  return { records: new Map(records), texts: new Map(texts), modules: new Map<string, string>(), sources: [] }
}

describe('passive Flight transport values', () => {
  it('distinguishes legitimate undefined and escaped text from missing references', () => {
    const source = document([], [['a', '$missing']])
    expect(resolveMigrationFlightValue(source, undefined)).toEqual({ resolved: true, value: undefined })
    expect(resolveMigrationFlightValue(source, '$undefined')).toEqual({ resolved: true, value: undefined })
    expect(resolveMigrationFlightValue(source, '$$99')).toEqual({ resolved: true, value: '$99' })
    expect(resolveMigrationFlightValue(source, '$a')).toEqual({ resolved: true, value: '$missing' })
    expect(resolveMigrationFlightValue(source, '$99').resolved).toBe(false)
  })

  it('rejects cyclic and excessively deep reference chains', () => {
    expect(resolveMigrationFlightValue(document([['a', '$b'], ['b', '$a']]), '$a').resolved).toBe(false)
    const chain: Array<[string, unknown]> = Array.from({ length: 40 }, (_, index) => [index.toString(16), `$${(index + 1).toString(16)}`])
    expect(resolveMigrationFlightValue(document(chain), '$0').resolved).toBe(false)
  })

  it('resolves only owned data properties and typed React tuple props', () => {
    const source = document([['a', ['$', '$L1', null, { children: { label: 'Literal label' } }]], ['b', { title: 'Owned' }], ['c', ['not-an-element', null, null, { title: 'Wrong' }]]])
    expect(resolveMigrationFlightValue(source, '$a:props:children:label')).toEqual({ resolved: true, value: 'Literal label' })
    expect(resolveMigrationFlightValue(source, '$b:title')).toEqual({ resolved: true, value: 'Owned' })
    expect(resolveMigrationFlightValue(source, '$b:constructor').resolved).toBe(false)
    expect(resolveMigrationFlightValue(source, '$a:props:absent').resolved).toBe(false)
    expect(resolveMigrationFlightValue(source, '$c:props:title').resolved).toBe(false)
  })
})
