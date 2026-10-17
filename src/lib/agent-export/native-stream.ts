/**
 * Native, pull-driven delivery of an already-authorized plain-data plan.
 *
 * It runs after Next has completed its empty handoff. Only one asset transfer,
 * one source chunk and at most two 64 KiB output batches are live at a time.
 * Framing writes directly into those batches instead of allocating encoded
 * buffers for every page. Its synchronous cursor also avoids per-page promise
 * continuations. This bounds payload allocations, not the host's total heap.
 */
import { createHash } from 'node:crypto'
import { agentExportApiHeader, agentExportHeader, agentExportPagePrefix, AGENT_EXPORT_PAGE_SUFFIX } from './format'
import { nativeAgentExportStringBytes, type NativeAgentExportPlan } from './native-protocol'
import type { PreparedBulkRange, PreparedBulkShard } from './prepared-contract'

export interface NativeExportAssetBinding {
  fetch(request: Request): Promise<Response>
}

interface TextPiece { kind: 'text'; value: string }
interface RangePiece { kind: 'range'; range: PreparedBulkRange }
type ExportPiece = TextPiece | RangePiece

function* exportPieces(plan: NativeAgentExportPlan): Generator<ExportPiece> {
  yield { kind: 'text', value: agentExportHeader({ name: plan.siteName, description: plan.siteDescription }, plan.origin, plan.locale) }
  for (const page of plan.pages) {
    yield { kind: 'text', value: agentExportPagePrefix(page, plan.origin) }
    for (const range of page.ranges) yield { kind: 'range', range }
    yield { kind: 'text', value: AGENT_EXPORT_PAGE_SUFFIX }
  }
  if (plan.apiMarkdown.length) {
    yield { kind: 'text', value: agentExportApiHeader(plan.origin) }
    for (const markdown of plan.apiMarkdown) yield { kind: 'text', value: `\n${markdown}\n` }
  }
}

/** Exact UTF-8 framing plus selected byte ranges for a native fixed-length body. */
export function nativeAgentExportByteLength(plan: NativeAgentExportPlan): number {
  let bytes = 0
  for (const piece of exportPieces(plan)) {
    bytes += piece.kind === 'text' ? nativeAgentExportStringBytes(piece.value) : piece.range.end - piece.range.start
  }
  if (!Number.isSafeInteger(bytes)) throw new Error('Prepared export length exceeded its integer bound.')
  return bytes
}

/** Consume protected physical bytes without ever emitting unselected ranges. */
export function nativeAgentExportStream(
  plan: NativeAgentExportPlan,
  assets: NativeExportAssetBinding,
  signal: AbortSignal,
): ReadableStream<Uint8Array> {
  let pieces: Iterator<ExportPiece> | null = exportPieces(plan)
  let shards: ReadonlyArray<PreparedBulkShard> = plan.shards
  const encoder = new TextEncoder()
  let piece: ExportPiece | null = null
  let text = ''
  let textPosition = 0
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null
  let shardIndex = -1
  let shardSize = 0
  let source: Uint8Array = new Uint8Array(0)
  let sourcePosition = 0
  let sourceOffset = 0
  let hash = createHash('sha256')
  // Keep one batch behind the producer. Fixed-length native transports can
  // otherwise report success before a late EOF/hash failure is discovered.
  let pendingOutput: Uint8Array | null = null
  let isVerified = false
  let isStopped = false
  let onAbort: (() => void) | undefined

  const stop = (): void => {
    if (isStopped) return
    isStopped = true
    if (onAbort) signal.removeEventListener('abort', onAbort)
    pieces?.return?.()
    pieces = null
    piece = null
    pendingOutput = null
    text = ''
    source = new Uint8Array(0)
    shards = []
    const activeReader = reader
    reader = null
    // Cancel returns promptly even while a transfer/read is settling. The
    // post-await stop check prevents another asset or page being started.
    void activeReader?.cancel().catch(() => undefined)
  }

  const readChunk = async (): Promise<boolean> => {
    if (!reader) return false
    const part = await reader.read()
    if (isStopped) return false
    if (part.done) {
      const expected = shards[shardIndex]
      if (shardSize !== expected.bytes || hash.digest('hex') !== expected.sha256) throw new Error('Prepared export asset integrity mismatch.')
      reader.releaseLock()
      reader = null
      return false
    }
    shardSize += part.value.byteLength
    if (shardSize > shards[shardIndex].bytes) throw new Error('Prepared export asset exceeded its declared length.')
    hash.update(part.value)
    sourceOffset += source.length
    source = part.value
    sourcePosition = 0
    return true
  }

  const finishShard = async (): Promise<void> => {
    while (!isStopped && reader) await readChunk()
    source = new Uint8Array(0)
    sourcePosition = sourceOffset = 0
  }

  const openShard = async (index: number): Promise<void> => {
    if (index === shardIndex) return
    await finishShard()
    if (isStopped) return
    if (index < shardIndex) throw new Error('Prepared export order changed during delivery.')
    const expected = shards[index]
    const response = await assets.fetch(new Request(`https://assets.internal/_thally/content/${expected.path}`, { signal, headers: { 'Accept-Encoding': 'identity' } }))
    if (isStopped) { await response.body?.cancel(); return }
    if (response.status !== 200 || !response.body || ![null, 'identity'].includes(response.headers.get('content-encoding'))) {
      await response.body?.cancel()
      throw new Error(`Prepared export asset unavailable (${response.status}).`)
    }
    shardIndex = index
    shardSize = 0
    hash = createHash('sha256')
    reader = response.body.getReader()
  }

  return new ReadableStream<Uint8Array>({
    start(controller) {
      onAbort = () => { stop(); controller.error(new DOMException('Aborted', 'AbortError')) }
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    },
    async pull(controller) {
      if (isStopped) return
      if (isVerified) {
        if (pendingOutput) controller.enqueue(pendingOutput)
        stop()
        controller.close()
        return
      }
      try {
        for (;;) {
          const output = new Uint8Array(64 * 1024)
          let used = 0
          while (!isStopped && used < output.length) {
            if (!piece) {
              const next = pieces!.next()
              if (next.done) {
                await finishShard()
                if (isStopped) return
                isVerified = true
                if (pendingOutput) {
                  controller.enqueue(pendingOutput)
                  pendingOutput = used ? output.subarray(0, used) : null
                  if (pendingOutput) return
                } else if (used) controller.enqueue(output.subarray(0, used))
                stop()
                controller.close()
                return
              }
              piece = next.value
              if (piece.kind === 'text') { text = piece.value; textPosition = 0 }
            }
            if (piece.kind === 'text') {
              const encoded = encoder.encodeInto(text.slice(textPosition), output.subarray(used))
              textPosition += encoded.read
              used += encoded.written
              if (textPosition === text.length) { piece = null; text = '' }
              else if (encoded.read === 0 && encoded.written === 0) {
                // A UTF-8 scalar needs up to four bytes. Flush the nonempty
                // partial batch and retry it in fresh space, preserving the
                // encoder's UTF-16 cursor and lone-surrogate replacement rules.
                if (used === 0) throw new Error('UTF-8 scalar could not fit a native export batch.')
                break
              }
              continue
            }
            const range = piece.range
            if (range.shard !== shardIndex) { await openShard(range.shard); if (isStopped) return }
            if (sourceOffset + sourcePosition < range.start) {
              sourcePosition = Math.min(source.length, range.start - sourceOffset)
            }
            if (sourceOffset + sourcePosition >= range.end) { piece = null; continue }
            if (sourcePosition === source.length) {
              if (!(await readChunk())) {
                if (isStopped) return
                throw new Error('Prepared export range exceeded its source asset.')
              }
              continue
            }
            const count = Math.min(source.length - sourcePosition, range.end - sourceOffset - sourcePosition, output.length - used)
            output.set(source.subarray(sourcePosition, sourcePosition + count), used)
            sourcePosition += count
            used += count
          }
          if (isStopped) return
          const previousOutput = pendingOutput
          pendingOutput = output.subarray(0, used)
          if (previousOutput) {
            controller.enqueue(previousOutput)
            return
          }
          // First pull fills the lookahead too; subsequent pulls release only
          // the preceding batch. The final batch stays private until EOF checks.
        }
      } catch (error) {
        if (!isStopped) { stop(); controller.error(error) }
      }
    },
    cancel: stop,
  }, { highWaterMark: 0 })
}
