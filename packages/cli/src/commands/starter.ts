/**
 * CLI surface for ownership-aware starter updates.
 *
 * The package-level updater owns release resolution and filesystem safety. The
 * CLI deliberately adds no mutation policy: dry-run is the default and the
 * explicit `--apply` flag is the confirmation boundary.
 */

import {
  updateStarterProject,
  type StarterUpdateResult,
} from 'create-thally-docs/starter-update'

import type { ParsedArgs } from '../router.js'

function formatPaths(label: string, paths: readonly string[]): string[] {
  if (paths.length === 0) return []
  return [`  ${label}:`, ...paths.map((path) => `    - ${path}`)]
}

/** Render the complete review surface before an update can be applied. */
export function formatStarterUpdateResult(result: StarterUpdateResult): string {
  if (result.isUpToDate) {
    return `\n  Starter release ${result.targetRelease.starterVersion} is already current.\n\n`
  }
  const lines = [
    '',
    `  Starter ${result.previousRelease.starterVersion} → ${result.targetRelease.starterVersion}`,
    `  ${result.plan.copyPaths.length} copy/update · ${result.plan.deletePaths.length} delete · ${result.plan.conflictPaths.length} conflict · ${result.plan.manualReviewPaths.length} manual review`,
    '',
    ...(result.recoveredProvenance ? ['  Verified published framework baseline; canonical provenance will advance.', ''] : []),
    ...formatPaths('Copy/update', result.plan.copyPaths),
    ...formatPaths('Merged configuration', result.resolvedManualPaths ?? []),
    ...(result.manualConflicts ?? []).flatMap((conflict) => conflict.fields.map((field) => `    - ${conflict.path}${field}`)),
    ...formatPaths('Delete', result.plan.deletePaths),
    ...formatPaths('Conflicts', result.plan.conflictPaths),
    ...formatPaths('Manual review', result.plan.manualReviewPaths),
    '',
  ]
  if (result.applied) {
    lines.push('  Starter update applied and provenance advanced.', '')
  } else if (result.plan.conflictPaths.length > 0) {
    lines.push('  Dry run only. Resolve conflicts before applying.', '')
  } else {
    lines.push('  Dry run only. Review the plan, then run "thally starter update --apply".', '')
  }
  return lines.join('\n')
}

/** Run `thally starter update`; all other starter subcommands fail closed. */
export async function runStarterCommand(args: ParsedArgs): Promise<number> {
  const allowedFlags = new Set(['--apply', '--require-complete', '--help', '-h'])
  if ([...args.flags].some((flag) => !allowedFlags.has(flag))) {
    throw new Error('Unknown starter update option.')
  }
  const subcommand = args.positionals[0]
  if (subcommand !== 'update' || args.hasFlag('--help', '-h')) {
    process.stdout.write('\n  Usage: thally starter update [--apply] [--require-complete]\n\n')
    return subcommand && subcommand !== 'update' ? 1 : 0
  }
  const apply = args.hasFlag('--apply')
  const result = await updateStarterProject({
    targetDir: process.cwd(),
    apply,
    confirmed: apply,
  })
  process.stdout.write(formatStarterUpdateResult(result))
  return result.plan.conflictPaths.length > 0 ? 1 : 0
}
