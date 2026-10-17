/** Pending transfer ownership follows the adapter request, never its shared binding. */
import { afterEach, describe, expect, it } from 'vitest'
import { getContentAssetRequestContext } from '@/lib/content-source/runtime'

const symbol = Symbol.for('__cloudflare-context__')
const original = Object.getOwnPropertyDescriptor(globalThis, symbol)
afterEach(() => {
  if (original) Object.defineProperty(globalThis, symbol, original)
  else Reflect.deleteProperty(globalThis, symbol)
})

describe('asset invocation identity', () => {
  it('uses distinct ExecutionContexts even when environment and binding are shared', () => {
    const env = { ASSETS: {} }
    let current: object = { env, ctx: {} }
    Object.defineProperty(globalThis, symbol, { configurable: true, get: () => current })
    const first = getContentAssetRequestContext()
    expect(first).toBe((current as { ctx: object }).ctx)
    current = { env, ctx: {} }
    expect(getContentAssetRequestContext()).not.toBe(first)
    expect(getContentAssetRequestContext()).not.toBe(env)
  })

  it('uses the request wrapper when a host omits ctx rather than a global queue', () => {
    const request = { env: { ASSETS: {} } }
    Object.defineProperty(globalThis, symbol, { configurable: true, value: request })
    expect(getContentAssetRequestContext()).toBe(request)
  })

  it('has no invocation identity outside a Cloudflare request', () => {
    Object.defineProperty(globalThis, symbol, { configurable: true, value: undefined })
    expect(getContentAssetRequestContext()).toBeNull()
  })
})
