/** Public entry point for Thally's shared repository and live-site migration engine. */

export {
  cloneGitHubRepository,
  detectRepositoryDocsDir,
  detectRepositoryPlatform,
  gitmodulePaths,
  migrateRepository,
  parseGitHubRepositoryUrl,
} from './repository.js'
export { addMintlifyDirectoryRedirects, buildNavigationFromPages, projectMintlifyNavigation, pruneMissingNavigationPages, readMintlifyConfig } from './navigation.js'
export { importSourceRef, parseSourceRefFlags, SOURCE_REF_MAX_BYTES, SOURCE_REF_MAX_FILES, SOURCE_REF_MAX_REPOSITORY_KB, sourceRefOversizeReason } from './source-refs.js'
export type { SourceRefImport, SourceRefMapping } from './source-refs.js'
export { projectFernNavigation, readFernConfig } from './fern.js'
export { normalizeMdx, parseMarkdownPage } from './mdx.js'
export { projectMintlifyIntegrations, validateIntegrations } from './analytics.js'
export { mergeMigrationConfig, renderMigrationFiles } from './render.js'
export { defaultMigrationFetcher, migrateUrl, validateMigrationUrl } from './url.js'
export { classifyMigrationResponse, runUrlMigration, validateUrlMigration } from './url-run.js'
export { isPassiveSvg } from './svg-policy.js'
export type {
  MigrationCapture, MigrationCaptureProvider, MigrationCapturedAsset, MigrationCaptureState,
  MigrationEvidence, MigrationJournalAsset, MigrationNavigationOccurrence,
  UrlMigrationCheckpoint, UrlMigrationCheckpointDelta, UrlMigrationIssue,
  UrlMigrationRecord, UrlMigrationRun, UrlMigrationRunOptions, UrlMigrationValidation,
} from './url-run-types.js'
export { hydrateRemoteApiSpecs } from './remote-api.js'
export type {
  GitHubRepositorySource,
  RepositoryMigrationOptions,
} from './repository.js'
export type { UrlMigrationOptions } from './url.js'
export type {
  MigrationAsset,
  MigrationBundle,
  MigrationDocsConfig,
  MigrationFetcher,
  MigrationFetchRequest,
  MigrationFetchResponse,
  MigrationNavigationGroup,
  MigrationNavigationTab,
  MigrationPage,
  MigrationPlatform,
  MigrationWarning,
  RenderedMigrationFile,
} from './types.js'
