/** Frontmatter references retain their authored spelling without backtracking on untrusted inputs. */
import { createContext, Script } from 'node:vm'

import { describe, expect, it } from 'vitest'

import { splitOpenApiRef } from '../openapi-ref.js'

describe('OpenAPI page reference parsing', () => {
  it.each([
    ['GET /users', { operation: 'GET /users' }],
    ['  "GET\t/users"  ', { operation: 'GET\t/users' }],
    ['"my specs/api.yaml"\tPoSt\n/users?active=true', { specRef: 'my specs/api.yaml', operation: 'PoSt\n/users?active=true' }],
    ["'my specs/api.yaml' WebHook\tuser.created", { specRef: 'my specs/api.yaml', operation: 'WebHook\tuser.created' }],
    ['CUSTOM /users with spaces', { operation: 'CUSTOM /users with spaces' }],
    ['GET /x GET /y', { specRef: 'GET /x', operation: 'GET /y' }],
    ['GET /x webhook name', { specRef: 'GET /x', operation: 'webhook name' }],
    ['spec\nGET /users', { specRef: 'spec', operation: 'GET /users' }],
    ['spec\nname GET /users', null],
    ['GET /users\nextra', null],
    ['webhook /invalid', { operation: 'webhook /invalid' }],
    ['webhook invalid name', null],
    ['GET users', null],
    ['', null],
  ] as const)('preserves reference semantics for %j', (raw, expected) => {
    expect(splitOpenApiRef(raw)).toEqual(expected)
  })

  it('bounds rejected whitespace/prefix inputs and accepts long authored refs under a watchdog', () => {
    // A Vitest timeout cannot stop synchronous regex work; the VM watchdog can.
    // Only the linear parser sees these large hostile strings.
    const context = createContext({ parse: splitOpenApiRef })
    const script = new Script('result = parse(raw)')
    for (const raw of ['a' + ' '.repeat(250_000) + '!', 'a /' + 'a a /'.repeat(50_000) + '\nrejected']) {
      Object.assign(context, { raw })
      script.runInContext(context, { timeout: 1000 })
      expect(context.result).toBeNull()
    }
    const spec = 'my spec/'.repeat(25_000) + 'api.yaml'
    Object.assign(context, { raw: `${spec}\tPATCH /users` })
    script.runInContext(context, { timeout: 1000 })
    expect(context.result).toEqual({ specRef: spec, operation: 'PATCH /users' })
  })
})
