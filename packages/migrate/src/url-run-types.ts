/**
 * Provider-neutral, JSON-safe migration journal. Captures are inert evidence;
 * hosts own network restrictions, browser sessions and durable artifact storage.
 */
import type { MigrationBundle, MigrationFetchResponse, MigrationFetcher, MigrationPage, MigrationPlatform } from './types.js'

export interface MigrationNavigationOccurrence {
  label: string
  /** Structured source roles retain top-level tabs separately from sidebar groups. */
  kind?: 'tab' | 'group' | 'page'
  /** Authored collection switchers retain their dropdown presentation. */
  presentation?: 'dropdown'
  /** A localized collection never merges with a same-named collection in another language. */
  locale?: string
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
  /** A trusted fetch boundary proved the original asset is already absent. */
  unavailable?: { status: 404 | 410 }
  /** Original SVG digest when a trusted host supplied an inert PNG rendering. */
  derivedFromSha256?: string
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
  /** Exact observed canonical/article equality proof; never inferred from query names. */
  articleIdentity?: { canonicalUrl: string; articleSha256: string; sectionAnchor?: string }
}

export interface MigrationJournalAsset {
  url: string
  path: string
  contentType: string
  sha256: string
  /** Base64 keeps checkpoints portable through JSON persistence. */
  base64: string
  /** Binds an optional trusted SVG rasterization to the original source bytes. */
  derivedFromSha256?: string
}

export interface UrlMigrationRecord {
  url: string
  discoveredBy: Array<string>
  outcome: 'pending' | 'imported' | 'excluded' | 'failed' | 'alias'
  reason?: string
  aliasOf?: string
  /** A proven query section is projected to its captured article anchor. */
  aliasAnchor?: string
  /** Observed redirect destination; external pages are links, never captured articles. */
  redirectTo?: string
  /** Publisher-declared Markdown representation of this exact same-origin article. */
  representationOf?: string
  /** Complete inert API schema observed at a declared same-route Markdown representation. */
  apiSpecification?: { path: string; sha256: string; document: Record<string, unknown> }
  evidence?: MigrationEvidence
  page?: MigrationPage
  pageSha256?: string
  assets?: Array<MigrationJournalAsset>
  /** Proven source defects are retained for review without hiding import failures. */
  warnings?: Array<UrlMigrationIssue>
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
  code: 'missing-page' | 'missing-anchor' | 'source-link-warning' | 'source-asset-warning' | 'code-mismatch' | 'asset-failed' | 'unsafe-content' | 'unsupported-component' | 'navigation-missing' | 'collision'
  source: string
  message: string
}

export interface UrlMigrationValidation {
  status: 'passed' | 'partial' | 'cancelled'
  issues: Array<UrlMigrationIssue>
  /** Proven source defects are reported separately from import-caused fidelity failures. */
  warnings?: Array<UrlMigrationIssue>
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
  /** Optional trusted, offline SVG renderer. Unsupported SVG stays rejected by default. */
  rasterizeSvg?: (asset: MigrationCapturedAsset, signal?: AbortSignal) => Promise<MigrationCapturedAsset>
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
