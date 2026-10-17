/** CLI entry point for scaffolding, migration, validation, and translation. */

import { existsSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { logo, success, slugify, previewCommand } from './utils.js'
import {
  gatherAnswers,
  gatherMigrationPlatform,
  resolveAutoDetectedMigrationSource,
} from './prompts.js'
import { scaffold } from './scaffold.js'
import { parseGitHubRepositoryUrl, parseSourceRefFlags, type SourceRefMapping } from '@thallylabs/migrate'
import { migrateDocs } from './migrate/index.js'
import { runCheck } from './check.js'
import { runTranslateCommand } from './translate.js'
import { formatHelp, terminal } from './terminal.js'

// Both src/ and dist/ sit one level below the package root, so the published
// package metadata is the single source of truth for version discovery.
const packageMetadata = createRequire(import.meta.url)('../package.json') as {
  version: string
}

const args = process.argv.slice(2)
const flags = args.filter((a) => a.startsWith('-'))
const versionArguments = new Set(['--version', '-v', '-V', 'version'])
const valueFlags = new Set([
  '--api-key',
  '--branch',
  '--docs-dir',
  '--into',
  '--locale',
  '--max-pages',
  '--model',
  '--pages',
  '--platform',
  '--source-ref',
])

const commandFlags = {
  scaffold: new Set(['--help', '-h', '--yes', '-y', '--install', '--no-install', '--verbose']),
  migrate: new Set([
    '--help',
    '-h',
    '--api-key',
    '--branch',
    '--docs-dir',
    '--into',
    '--max-pages',
    '--platform',
    '--skip-validation',
    '--source-ref',
    '--verbose',
    '--yes',
    '-y',
  ]),
  check: new Set(['--help', '-h', '--fix', '--ci', '--external', '--drift']),
  translate: new Set([
    '--help',
    '-h',
    '--api-key',
    '--force',
    '--locale',
    '--model',
    '--pages',
    '--yes',
    '-y',
  ]),
} as const

const mainHelp = `
Usage:
  create-thally-docs [project-dir] [options]
  create-thally-docs <command> [arguments] [options]

Commands:
  migrate <source> [output-dir]  Import an existing documentation project
  check [project-dir]            Validate content and navigation
  translate [project-dir]        Translate documentation into another locale

Scaffold options:
  -y, --yes       Accept defaults and skip interactive prompts
  --install       Install project dependencies (the default)
  --no-install    Skip dependency installation
  --verbose       Show detailed installation and Git output
  -h, --help      Show this help
  -v, -V, --version  Show the installed version

Run create-thally-docs <command> --help for command-specific options.
`

const commandHelp = {
  migrate: `
Usage:
  create-thally-docs migrate <github-or-docs-url> [output-dir] [options]

Options:
  --into <dir>         Migrate into an existing Thally project
  --branch <name>      Override the detected Git branch
  --docs-dir <path>    Override the detected documentation directory
  --max-pages <count>  Limit a public URL crawl to 1-10000 pages (default: 1000)
  --platform <name>    Use mintlify, docusaurus, fern, or auto
  --source-ref <owner/repo>=<path>
                       Import a Mintlify sourceRef repository under <path> (repeatable)
  --skip-validation   Import only; explicitly skip content and build verification
  --verbose           Show detailed installation, build, and Git output
  --api-key <key>      Anthropic API key for non-Markdown conversion
  -y, --yes            Skip interactive prompts
  -h, --help           Show this help
`,
  check: `
Usage:
  create-thally-docs check [project-dir] [options]

Options:
  --fix       Add orphan pages to navigation when possible
  --ci        Use CI-oriented validation behavior
  --external  Also check external links (public hosts only; warnings, never errors)
  --drift     Check documentation provenance and freshness
  -h, --help  Show this help
`,
  translate: `
Usage:
  create-thally-docs translate [project-dir] --locale <code> [options]

Options:
  --locale <code>  Target locale code (required)
  --pages <ids>    Translate only the comma-separated page IDs
  --force          Overwrite existing translations
  --api-key <key>  Anthropic API key (defaults to ANTHROPIC_API_KEY)
  --model <id>     Claude model to use
  -y, --yes        Skip the confirmation prompt
  -h, --help       Show this help
`,
} as const

// Build positionals by skipping values consumed by named flags (e.g. --locale es)
const positional: Array<string> = []
for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith('-')) {
    // Only named value flags consume the next token. Boolean flags such as
    // --yes and --install can safely appear before the project directory.
    if (valueFlags.has(args[i]) && i + 1 < args.length && !args[i + 1].startsWith('-')) {
      i++
    }
  } else {
    positional.push(args[i])
  }
}

function getFlagValue(flag: string): string | undefined {
  const idx = args.indexOf(flag)
  if (idx !== -1 && idx + 1 < args.length && !args[idx + 1].startsWith('-')) {
    return args[idx + 1]
  }
  return undefined
}

function resolveCommand(subcommand: string | undefined): keyof typeof commandFlags {
  if (subcommand === 'migrate' || subcommand === 'check' || subcommand === 'translate') {
    return subcommand
  }
  return 'scaffold'
}

/** Print help before command execution so informational calls never open prompts. */
function printHelp(command: keyof typeof commandFlags): void {
  console.log(formatHelp(command === 'scaffold' ? mainHelp : commandHelp[command]))
}

/** Reject unsupported options instead of silently falling through to a command. */
function validateFlags(command: keyof typeof commandFlags): void {
  const unknownFlag = flags.find((flag) => !commandFlags[command].has(flag))
  if (!unknownFlag) return

  const helpCommand = command === 'scaffold' ? '' : ` ${command}`
  throw new Error(`Unknown option "${unknownFlag}". Run create-thally-docs${helpCommand} --help for usage.`)
}

async function runMigrateCommand(): Promise<void> {
  let sourceUrl = positional[1]
  if (!sourceUrl) {
    console.error('\n  ❌ Source URL is required.')
    console.error('     Usage: create-thally-docs migrate <github-or-docs-url> [output-dir] [options]')
    console.error('     Example: create-thally-docs migrate https://docs.example.com my-docs')
    process.exit(1)
  }

  let source: URL
  try {
    source = new URL(sourceUrl)
    if (!['http:', 'https:'].includes(source.protocol)) throw new Error('Only HTTP and HTTPS sources are supported.')
    if (source.hostname.toLowerCase() === 'github.com') parseGitHubRepositoryUrl(sourceUrl)
  } catch (err) {
    console.error(`\n  ❌ ${err instanceof Error ? err.message : err}`)
    process.exit(1)
  }

  const branch = getFlagValue('--branch')
  const docsDir = getFlagValue('--docs-dir')
  const yes = flags.includes('--yes') || flags.includes('-y')
  terminal.intro('migrate', packageMetadata.version, 'Bring your docs to Thally. Built for people and AI tools.')
  const platformFlag = getFlagValue('--platform')
  const platform = await gatherMigrationPlatform(platformFlag, yes)
  if (platform === undefined) {
    const shouldPromptForSource = platformFlag === undefined && !yes && Boolean(process.stdin.isTTY)
    sourceUrl = await resolveAutoDetectedMigrationSource(sourceUrl, shouldPromptForSource)
    source = new URL(sourceUrl)
  }

  // API key is optional — only needed for non-Markdown files
  const apiKey = getFlagValue('--api-key') ?? process.env.ANTHROPIC_API_KEY

  // Parse --into flag
  const intoDir = getFlagValue('--into')
  const isInto = Boolean(intoDir)

  // Determine the project directory after the source guard so accepting a
  // repository suggestion also gives the generated project its repository name.
  let projectDir: string
  if (intoDir) {
    projectDir = resolve(intoDir)
  } else if (positional[2]) {
    projectDir = resolve(positional[2])
  } else {
    const sourceName = source.hostname.toLowerCase() === 'github.com'
      ? parseGitHubRepositoryUrl(sourceUrl).repo
      : source.pathname.split('/').filter(Boolean).at(-1) ?? source.hostname.split('.')[0]
    projectDir = resolve(`${slugify(sourceName)}-docs`)
  }

  const maxPagesValue = getFlagValue('--max-pages')
  const maxPages = maxPagesValue ? Number(maxPagesValue) : undefined
  if (maxPages !== undefined && (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 10_000)) {
    console.error('\n  ❌ --max-pages must be an integer between 1 and 10000.')
    process.exit(1)
  }
  terminal.detail('Source', `${source.origin}${source.pathname}`)
  terminal.detail('Output', projectDir)
  if (branch) terminal.detail('Branch', branch)
  if (docsDir) terminal.detail('Docs dir', docsDir)
  terminal.detail('Platform', platform ?? 'auto-detect')

  let sourceRefs: Array<SourceRefMapping>
  try {
    const sourceRefValues = args.flatMap((arg, index) => {
      if (arg !== '--source-ref') return []
      const value = args[index + 1]
      if (value === undefined || value.startsWith('-')) throw new Error('--source-ref needs a value such as owner/repo=client-sdks/typescript.')
      return [value]
    })
    sourceRefs = parseSourceRefFlags(sourceRefValues)
  } catch (err) {
    console.error(`\n  ❌ ${err instanceof Error ? err.message : err}`)
    process.exit(1)
  }

  const result = await migrateDocs({
    sourceUrl,
    projectDir,
    into: isInto,
    apiKey,
    branch,
    docsDir,
    maxPages,
    platform,
    yes,
    skipValidation: flags.includes('--skip-validation'),
    sourceRefs,
  })
  terminal.section('Migration summary', [
    `${result.pagesWritten} pages · ${result.assetsWritten} assets · ${result.platform}`,
    `Content: ${result.validation.content} · Build: ${result.validation.build}`,
    `${result.warnings.length} migration warning(s)`,
  ])
  terminal.detail('Output', result.projectDir)
  terminal.detail('Report', result.reportPath)
  const isVerified = result.validation.content === 'passed' && result.validation.build === 'passed'
  terminal.outro(isVerified ? 'Migration verified. Review any warnings before publishing.' : 'Import saved. Validation is incomplete; review the migration report.')
  terminal.nextAction('Preview locally', previewCommand(result.projectDir, !existsSync(resolve(result.projectDir, 'node_modules'))))
  if (result.validation.content === 'failed' || result.validation.build === 'failed') process.exitCode = 1
}

async function runScaffoldCommand(): Promise<void> {
  const useDefaults = flags.includes('--yes') || flags.includes('-y') || !process.stdin.isTTY
  const installPreference = flags.includes('--install')
    ? true
    : flags.includes('--no-install')
      ? false
      : undefined
  const dirArg = positional[0]

  // Early validation when dir is passed via positional arg
  if (dirArg) {
    const resolved = resolve(dirArg)
    if (existsSync(resolved) && readdirSync(resolved).length > 0) {
      console.error(`\n  ❌ Directory "${resolved}" already exists and is not empty.`)
      process.exit(1)
    }
  }

  const answers = await gatherAnswers(dirArg, useDefaults, installPreference)

  const result = await scaffold({
    projectDir: answers.projectDir,
    projectName: answers.projectName,
    description: answers.description,
    brandPreset: answers.brandPreset,
    repoUrl: answers.repoUrl,
    doInstall: answers.doInstall,
    continueOnInstallFailure: true,
    i18nLocales: answers.i18nLocales,
    trackRepos: answers.trackRepos,
  })

  success(result.projectDir, answers.projectName, result.dependenciesInstalled)
  // Installation was requested but failed: the project exists, but automation
  // must not mistake it for a ready-to-run checkout.
  if (answers.doInstall && !result.dependenciesInstalled) process.exitCode = 1
}

async function runCheckCommand(): Promise<void> {
  const projectDir = resolve(positional[1] ?? '.')
  const exitCode = await runCheck(projectDir, {
    fix: flags.includes('--fix'),
    ci: flags.includes('--ci'),
    external: flags.includes('--external'),
    drift: flags.includes('--drift'),
  })
  process.exit(exitCode)
}

async function runTranslateSubcommand(): Promise<void> {
  const locale = getFlagValue('--locale')
  if (!locale) {
    console.error('\n  ❌ --locale is required.')
    console.error('     Usage: create-thally-docs translate --locale es [--pages page1,page2] [--force] [--api-key key]')
    process.exit(1)
  }

  const pagesArg = getFlagValue('--pages')
  const pages = pagesArg ? pagesArg.split(',').map((p) => p.trim()).filter(Boolean) : undefined
  const force = flags.includes('--force')
  const apiKey = getFlagValue('--api-key') ?? process.env.ANTHROPIC_API_KEY
  const model = getFlagValue('--model') ?? 'claude-sonnet-4-6'
  const yes = flags.includes('--yes') || flags.includes('-y')
  const projectDir = resolve(positional[1] ?? '.')

  terminal.intro('translate', packageMetadata.version, 'Make your docs available in another language.')

  await runTranslateCommand(locale, pages, force, apiKey, model, yes, projectDir)
}

async function main(): Promise<void> {
  if (args.length === 1 && versionArguments.has(args[0])) {
    console.log(packageMetadata.version)
    return
  }

  const subcommand = positional[0]
  const command = resolveCommand(subcommand)

  if (flags.includes('--help') || flags.includes('-h')) {
    printHelp(command)
    return
  }

  validateFlags(command)

  if (subcommand === 'migrate') {
    await runMigrateCommand()
  } else if (subcommand === 'check') {
    await runCheckCommand()
  } else if (subcommand === 'translate') {
    await runTranslateSubcommand()
  } else {
    logo(packageMetadata.version)
    await runScaffoldCommand()
  }
}

main().catch((err: Error) => {
  terminal.error(err.message)
  process.exit((err as Error & { exitCode?: number }).exitCode ?? 1)
})
