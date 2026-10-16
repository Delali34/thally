/**
 * URL-only server entry: no repository cloning/scanning entrypoints. Keep this
 * independently bundled so file tracers cannot follow the broad CLI module.
 */
export { classifyMigrationResponse, runUrlMigration, validateUrlMigration } from './url-run.js'
export { renderMigrationFiles } from './render.js'
export type {
  MigrationCapture, MigrationCaptureProvider, MigrationCapturedAsset, MigrationCaptureState,
  MigrationEvidence, MigrationJournalAsset, MigrationNavigationOccurrence,
  UrlMigrationCheckpoint, UrlMigrationCheckpointDelta, UrlMigrationIssue,
  UrlMigrationRecord, UrlMigrationRun, UrlMigrationRunOptions, UrlMigrationValidation,
} from './url-run-types.js'
export type {
  MigrationAsset, MigrationBundle, MigrationDocsConfig, MigrationFetcher,
  MigrationFetchRequest, MigrationFetchResponse, MigrationNavigationGroup,
  MigrationNavigationTab, MigrationPage, MigrationPlatform, MigrationWarning,
  RenderedMigrationFile,
} from './types.js'
