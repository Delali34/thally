/**
 * Provider-neutral, JSON-safe migration journal. Captures are inert evidence;
 * hosts own network restrictions, browser sessions and durable artifact storage.
 */
import type { MigrationBundle, MigrationFetchResponse, MigrationFetcher, MigrationPage, MigrationPlatform } from './types.js'

export interface MigrationNavigationOccurrence {
  label: string
  url?: string
  children?: Array<MigrationNavigationOccurrence>
}

export interface MigrationCaptureState {
  id: string
  /** Human-readable name of a tab/disclosure alternative, never executable code. */
  label: string
  response: MigrationFetchResponse
}

export interface MigrationCapturedAsset {
  url: string
  contentType: string
  content: Uint8Array
}

export interface MigrationCapture extends MigrationFetchResponse {
  /** Capture adapters expand only safe read-only states; no forms or API actions. */
  states?: Array<MigrationCaptureState>
  navigation?: Array<MigrationNavigationOccurrence>
  assets?: Array<MigrationCapturedAsset>
  locale?: string
  version?: string
  /** Durable evidence reference supplied by the host; no embedded credentials. */
  artifactRef?: string
}

export interface MigrationCaptureProvider {
  capture(request: { url: URL; signal?: AbortSignal }): Promise<MigrationCapture>
}

export interface MigrationEvidence {
  sha256: string
  byteLength?: number
  finalUrl: string
  contentType: string
  artifactRef?: string
  states: Array<{ id: string; label: string; sha256: string; code?: Array<string> }>
  /** Exact decoded technical payloads, including whitespace and trailing newlines. */
  code: Array<string>
  anchors: Array<string>
  links: Array<string>
}

export interface MigrationJournalAsset {
  url: string
  path: string
  contentType: string
  sha256: string
  /** Base64 keeps checkpoints portable through JSON persistence. */
  base64: string
}

export interface UrlMigrationRecord {
  url: string
  discoveredBy: Array<string>
  outcome: 'pending' | 'imported' | 'excluded' | 'failed' | 'alias'
  reason?: string
  aliasOf?: string
  evidence?: MigrationEvidence
  page?: MigrationPage
  pageSha256?: string
  assets?: Array<MigrationJournalAsset>
  version?: string
  issues?: Array<UrlMigrationIssue>
}

export interface UrlMigrationCheckpoint {
  schemaVersion: 1
  converterVersion: string
  sourceUrl: string
  scopePath: string
  captureVersion: string
  records: Array<UrlMigrationRecord>
  navigation: Array<MigrationNavigationOccurrence>
}

export interface UrlMigrationCheckpointDelta {
  schemaVersion: 1
  converterVersion: string
  scopePath: string
  captureVersion: string
  sourceUrl: string
  /** Changed records only, replace by URL. Commit evidence before acknowledging. */
  records: Array<UrlMigrationRecord>
  navigation?: Array<MigrationNavigationOccurrence>
}

export interface UrlMigrationIssue {
  code: 'missing-page' | 'missing-anchor' | 'code-mismatch' | 'asset-failed' | 'unsafe-content' | 'unsupported-component' | 'navigation-missing' | 'collision'
  source: string
  message: string
}

export interface UrlMigrationValidation {
  status: 'passed' | 'partial' | 'cancelled'
  issues: Array<UrlMigrationIssue>
  counts: Record<UrlMigrationRecord['outcome'], number>
}

export interface UrlMigrationRun {
  bundle: MigrationBundle
  checkpoint: UrlMigrationCheckpoint
  validation: UrlMigrationValidation
  /** Hosts resume bounded slices but must review hard scope/budget limits. */
  stopReason?: 'capture-limit' | 'page-limit' | 'byte-limit' | 'cancelled' | 'complete'
}

export interface UrlMigrationRunOptions {
  sourceUrl: string
  platform?: MigrationPlatform
  /** Exact selected path boundary; defaults to the submitted URL directory. */
  scopePath?: string
  maxPages?: number
  concurrency?: number
  batchSize?: number
  maxTotalBytes?: number
  fetcher?: MigrationFetcher
  /** Hosts that inject text fetching must also inject their safe binary boundary. */
  assetFetcher?: (url: URL, signal?: AbortSignal) => Promise<MigrationCapturedAsset>
  captureProvider?: MigrationCaptureProvider
  /** Change this when browser/extraction policy changes; prevents stale reuse. */
  captureVersion?: string
  checkpoint?: UrlMigrationCheckpoint
  signal?: AbortSignal
  /** Stop after this many captures and return a resumable partial result. */
  maxCaptures?: number
  /** Retry transient failures by default; imported records still require hashes. */
  retryFailed?: boolean
  /** Reconcile durable artifacts; false requeues a previously committed record. */
  reconcile?: (record: UrlMigrationRecord) => Promise<boolean>
  /** Bounded deltas avoid serializing the whole inventory after every page. */
  onCheckpoint?: (delta: UrlMigrationCheckpointDelta) => Promise<void>
  /** Stream evidence/output to durable storage before a record is committed. */
  onRecord?: (record: UrlMigrationRecord) => Promise<void>
}
