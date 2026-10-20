/**
 * Create a customer-owned project from the immutable starter release. Progress
 * wraps each operation without changing the starter contents or owner fields.
 */

import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { downloadStarter } from './download.js'
import { resetTrackingConfig, writeTrackingConfig } from './docs-json.js'
import {
  personalizeStarter,
  updateEnvExample,
} from './customize.js'
import { slugify, installDeps, initGit, type PackageManager } from './utils.js'
import { terminal } from './terminal.js'

export {
  STARTER_ARCHIVE_ROOT,
  STARTER_COMMIT_SHA,
  STARTER_REPOSITORY,
  validateStarterArchiveEntry,
} from './download.js'
export { STABLE_SCAFFOLD_RELEASE } from './release.js'

export interface ScaffoldOptions {
  projectDir: string
  projectName: string
  description: string
  brandPreset: string
  repoUrl: string
  doInstall: boolean
  /** Explicitly select npm, pnpm, or Yarn; otherwise infer the invoking manager. */
  packageManager?: PackageManager
  /**
   * Report a failed install and still finish the project (Git setup included)
   * instead of throwing. Interactive creation opts in; library callers keep
   * the historical fail-fast contract.
   */
  continueOnInstallFailure?: boolean
  enableAiChat?: boolean
  i18nLocales?: Array<{ code: string; label: string }>
  /** Repos to pre-register for Thally Track (opt-in). Empty/undefined = Track off. */
  trackRepos?: Array<{ owner: string; repo: string }>
  /** Source theme accent color(s) to apply over the chosen brand preset. */
  colors?: { primary?: string; light?: string; dark?: string }
}

export interface ScaffoldResult {
  projectDir: string
  /** False when installation was skipped or failed; the project is still usable. */
  dependenciesInstalled: boolean
}

/** Download, personalize, and optionally install a new documentation project. */
export async function scaffold(options: ScaffoldOptions): Promise<ScaffoldResult> {
  const {
    projectDir,
    projectName,
    description,
    brandPreset,
    repoUrl,
    doInstall,
    continueOnInstallFailure = false,
    enableAiChat = true,
    i18nLocales,
    trackRepos,
    colors,
  } = options

  const targetDir = resolve(projectDir)

  // Validate target directory
  if (existsSync(targetDir) && readdirSync(targetDir).length > 0) {
    throw new Error(`Directory "${targetDir}" already exists and is not empty.`)
  }

  // Create the target directory
  mkdirSync(targetDir, { recursive: true })

  const slug = slugify(projectName)

  // 1. Extract the complete tree from the exact promoted starter commit.
  await terminal.step('Downloading starter', () =>
    downloadStarter(targetDir, projectName, undefined, { announce: false }),
    'Starter downloaded',
  )

  // 2. Change only the documented owner fields. Runtime code, authored pages,
  // navigation, dependencies, CI, and repository policy stay exactly as the
  // immutable starter release shipped them.
  await terminal.step('Configuring project', () => {
    personalizeStarter(targetDir, {
      projectName,
      packageName: slug,
      description,
      brandPreset,
      repoUrl,
      enableAiChat,
      i18nLocales,
      colors,
    })

    // Track is opt-in: remove starter repositories before applying owner choices.
    resetTrackingConfig(targetDir)
    if (trackRepos?.length) writeTrackingConfig(targetDir, trackRepos)
    updateEnvExample(targetDir)
  }, 'Project configured')

  if (trackRepos?.length) {
    const list = trackRepos.map((r) => `${r.owner}/${r.repo}`).join(', ')
    terminal.info(`Thally Track enabled — watching ${list} (branch main, all files; refine in docs.json).`)
    terminal.info('To finish wiring it: `thally track setup` (pick a trigger) + `thally agent init`,')
    terminal.info('then add your ANTHROPIC_API_KEY. See /guides/thally-track.')
  }

  // 4. Install dependencies. When the caller opts in, a failed install
  // (offline, registry outage) does not leave a half-initialized project: it
  // is reported, Git setup still runs, and the caller prints the recovery.
  let dependenciesInstalled = false
  if (doInstall) {
    try {
      await installDeps(targetDir, options.packageManager)
      dependenciesInstalled = true
    } catch (error) {
      const exitCode = (error as { exitCode?: number }).exitCode
      if (!continueOnInstallFailure || exitCode === 130 || exitCode === 143) throw error
      terminal.warn('Dependency installation failed. The project was created; use the recovery command above to finish.')
    }
  }

  // 5. Initialize git
  await initGit(targetDir)

  return { projectDir: targetDir, dependenciesInstalled }
}
