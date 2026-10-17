/** Optional adapter boundary; absent on Node/self-hosts and during builds. */
import { nativeAgentExportCapability, type NativeAgentExportCapability } from './native-protocol'

/** Read the same per-request environment published by getCloudflareContext. */
export function getRequestNativeAgentExportCapability(request: Request): NativeAgentExportCapability | null {
  const context = (globalThis as Record<symbol, unknown>)[Symbol.for('__cloudflare-context__')]
  if (!context || typeof context !== 'object') return null
  return nativeAgentExportCapability(request, (context as { env?: Record<PropertyKey, unknown> }).env)
}
