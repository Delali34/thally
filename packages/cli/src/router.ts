/**
 * CLI argument parsing, per-command help, and option validation.
 *
 * Every native command declares the options it accepts and which of them take
 * a value, so a boolean flag can never swallow the next argument
 * (`thally agent --pr "Do X"`) and an unknown option fails before any side
 * effect runs. Help is resolved here, before the entry point checks for a
 * project or starts a build, so `thally deploy --help` can never deploy.
 *
 * Delegated commands (`init`, `migrate`, `translate`) forward their raw
 * arguments to create-thally-docs, which validates its own options. Arguments
 * after `--` are passthrough for the framework commands (`thally dev -- --port
 * 4000`) and are never interpreted as Thally options.
 */

import { PRODUCT_TAGLINE } from 'create-thally-docs/terminal'

export interface ParsedArgs {
  command: string | undefined
  /** Positional args after the command (never includes passthrough args). */
  positionals: Array<string>
  /** All raw args after the command (positionals + flags), for delegates. */
  rest: Array<string>
  /** Arguments after a literal `--`, forwarded verbatim to the framework. */
  passthrough: Array<string>
  /** Every option name present (values excluded). */
  flags: Set<string>
  getFlag(name: string): string | undefined
  hasFlag(...names: Array<string>): boolean
}

/** One documented option of a command. */
export interface CommandOption {
  /** Canonical flag plus aliases, e.g. `['--cloudflare', '--cf']`. */
  names: Array<string>
  /** Value placeholder for value-bearing options, e.g. `<ref>`. */
  value?: string
  description: string
  /** Accepted for compatibility or automation but omitted from help. */
  hidden?: boolean
}

export interface CommandInfo {
  name: string
  summary: string
  usage: string
  /** Native commands validate options; delegates forward raw arguments. */
  delegate?: boolean
  /** Whether arguments after `--` are forwarded to the framework. */
  passthrough?: boolean
  /** Maximum positional arguments; undefined means unlimited. */
  maxPositionals?: number
  options?: Array<CommandOption>
  /** Extra lines appended to the command help. */
  notes?: Array<string>
}

// The single coherent command surface. The user authors content + config; the
// framework (Next.js) is a hidden runtime invoked by these commands.
export const COMMANDS: Array<CommandInfo> = [
  {
    name: 'init',
    summary: 'Create a new documentation site',
    usage: 'thally init [dir] [--yes] [--no-install] [--verbose]',
    delegate: true,
  },
  {
    name: 'dev',
    summary: 'Preview your site locally',
    usage: 'thally dev [-- <server options>]',
    passthrough: true,
    maxPositionals: 0,
    notes: ['Options after -- go to the dev server, e.g. thally dev -- --port 4000'],
  },
  {
    name: 'build',
    summary: 'Build the production site',
    usage: 'thally build [-- <build options>]',
    passthrough: true,
    maxPositionals: 0,
  },
  {
    name: 'start',
    summary: 'Serve the built production site',
    usage: 'thally start [-- <server options>]',
    passthrough: true,
    maxPositionals: 0,
  },
  {
    name: 'deploy',
    summary: 'Build and deploy to a live URL',
    usage: 'thally deploy [--prod] [--cloudflare]',
    maxPositionals: 0,
    options: [
      { names: ['--prod', '--production'], description: 'Deploy to production (Vercel); previews are the default' },
      { names: ['--cloudflare', '--cf'], description: 'Deploy to Cloudflare Workers instead of Vercel' },
    ],
  },
  {
    name: 'check',
    summary: 'Check content and agent readiness',
    usage: 'thally check [dir] [--agents] [--fix] [--ci] [--drift] [--external]',
    maxPositionals: 1,
    options: [
      { names: ['--agents'], description: 'Also run the Agent Readiness Score' },
      { names: ['--min'], value: '<score>', description: 'Minimum Agent Readiness Score with --agents' },
      { names: ['--fix'], description: 'Add orphan pages to navigation when possible' },
      { names: ['--ci'], description: 'Print GitHub annotations and a compact summary' },
      { names: ['--drift'], description: 'Flag pages that are stale against their sources' },
      { names: ['--external'], description: 'Also check external links (network; public hosts only)' },
    ],
  },
  {
    name: 'new',
    summary: 'Create a page and add it to navigation',
    usage: 'thally new <page-id> [--title "..."] [--description "..."]',
    maxPositionals: 1,
    options: [
      { names: ['--title'], value: '<text>', description: 'Page title (defaults to the page id)' },
      { names: ['--description'], value: '<text>', description: 'Frontmatter description' },
    ],
  },
  {
    name: 'migrate',
    summary: 'Migrate a docs repository or public site',
    usage: 'thally migrate <github-or-docs-url> [dir] [--platform <mintlify|docusaurus|fern|auto>] [--verbose]',
    delegate: true,
  },
  {
    name: 'translate',
    summary: 'Translate content into a locale',
    usage: 'thally translate --locale <code>',
    delegate: true,
  },
  {
    name: 'mcp',
    summary: 'Start the Model Context Protocol server (stdio)',
    usage: 'thally mcp',
    delegate: true,
    notes: ['Configure an MCP client to run it as a stdio server: npx -y @thallylabs/cli mcp'],
  },
  {
    name: 'agent',
    summary: 'Draft updates from product changes for review',
    usage: 'thally agent "<instruction>" [--diff <ref>] [--from-pr <url>] [--context-file <path>] [--dry-run] [--pr]',
    options: [
      { names: ['--diff'], value: '<ref>', description: 'Use a git diff against <ref> as context' },
      { names: ['--from-pr'], value: '<url>', description: 'Use a product pull request as context (needs gh)' },
      { names: ['--context-file'], value: '<path>', description: 'Use a prepared context file' },
      { names: ['--dry-run'], description: 'Preview the edits and discard them' },
      { names: ['--pr'], description: 'Open a pull request with the edits' },
      { names: ['--repo'], value: '<owner/repo>', description: 'Docs repository for "thally agent init"' },
      { names: ['--requester'], value: '<login>', description: 'Attribute the request', hidden: true },
      { names: ['--result-file'], value: '<path>', description: 'Write a machine-readable result', hidden: true },
      { names: ['--write-policy-file'], value: '<path>', description: 'Restrict writable paths', hidden: true },
      { names: ['--require-changes'], description: 'Fail when no changes are produced', hidden: true },
    ],
    notes: ['Run "thally agent init --repo <owner/repo>" to scaffold the docs-repo workflow.'],
  },
  {
    name: 'track',
    summary: 'Turn merged product PRs into docs PRs',
    usage: 'thally track <add|list|test|setup> [owner/repo] [--branch <base>] [--paths <globs>] [--pr <n>]',
    maxPositionals: 2,
    options: [
      { names: ['--branch'], value: '<base>', description: 'Base branch to watch (add)' },
      { names: ['--paths'], value: '<globs>', description: 'Comma-separated path globs (add)' },
      { names: ['--tab'], value: '<tab>', description: 'Output tab for generated pages (add)' },
      { names: ['--group'], value: '<group>', description: 'Output group for generated pages (add)' },
      { names: ['--pr'], value: '<n>', description: 'Pull request number to preview (test)' },
      { names: ['--repo'], value: '<owner/repo>', description: 'Docs repository to dispatch to (setup)' },
      { names: ['--write'], description: 'Write the sender workflow files (setup)' },
    ],
  },
  {
    name: 'starter',
    summary: 'Review or apply a site runtime update',
    usage: 'thally starter update [--apply] [--require-complete]',
    maxPositionals: 1,
    options: [
      { names: ['--apply'], description: 'Apply the reviewed update (dry run by default)' },
      { names: ['--require-complete'], description: 'Require complete transactional framework and configuration updates' },
    ],
  },
]

const HELP_FLAGS = new Set(['--help', '-h'])

/** Look up a command, treating `create` as the historical alias of `init`. */
export function findCommand(name: string | undefined): CommandInfo | undefined {
  const canonical = name === 'create' ? 'init' : name
  return COMMANDS.find((command) => command.name === canonical)
}

/**
 * Parse command arguments. Option values are recognized only for options the
 * command declares as value-bearing; `rest` keeps the raw sequence for
 * delegates. Validation is separate (see `resolveInvocation`).
 */
export function parseArgs(argv: Array<string>, spec: CommandInfo | undefined = findCommand(argv[0])): ParsedArgs {
  const command = argv[0] && !argv[0].startsWith('-') ? argv[0] : undefined
  const rest = command ? argv.slice(1) : argv.slice()
  const valueOptions = new Map<string, string>()
  for (const option of spec?.options ?? []) {
    if (option.value) for (const alias of option.names) valueOptions.set(alias, option.names[0])
  }

  const positionals: Array<string> = []
  const passthrough: Array<string> = []
  const flags = new Set<string>()
  const values = new Map<string, string>()
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i]
    if (token === '--' && !spec?.delegate) {
      passthrough.push(...rest.slice(i + 1))
      break
    }
    if (token.startsWith('-') && token !== '-') {
      const separator = token.indexOf('=')
      const name = separator > 2 ? token.slice(0, separator) : token
      flags.add(name)
      const canonical = valueOptions.get(name)
      if (separator > 2) {
        values.set(canonical ?? name, token.slice(separator + 1))
      } else if (canonical && i + 1 < rest.length && !rest[i + 1].startsWith('--')) {
        values.set(canonical, rest[i + 1])
        i += 1
      }
    } else {
      positionals.push(token)
    }
  }

  const canonicalName = (name: string) => valueOptions.get(name) ?? name
  return {
    command,
    positionals,
    rest,
    passthrough,
    flags,
    getFlag(name) {
      return values.get(canonicalName(name))
    },
    hasFlag(...names) {
      return names.some((name) => flags.has(name))
    },
  }
}

/** Result of routing argv: show help, fail with a message, or run a command. */
export type Invocation =
  | { kind: 'help'; text: string }
  | { kind: 'error'; message: string; usage?: string }
  | { kind: 'run'; command: CommandInfo; args: ParsedArgs }

function optionLabel(option: CommandOption): string {
  return `${option.names.join(', ')}${option.value ? ` ${option.value}` : ''}`
}

/** Plain help for one command; never includes hidden automation options. */
export function commandHelpText(command: CommandInfo): string {
  const visible = (command.options ?? []).filter((option) => !option.hidden)
  const lines = ['', `  ${command.summary}`, '', `  Usage: ${command.usage}`, '']
  if (visible.length > 0) {
    const pad = Math.max(...visible.map((option) => optionLabel(option).length), '-h, --help'.length)
    lines.push('  Options:')
    for (const option of visible) lines.push(`    ${optionLabel(option).padEnd(pad)}  ${option.description}`)
    lines.push(`    ${'-h, --help'.padEnd(pad)}  Show this help`)
    lines.push('')
  }
  for (const note of command.notes ?? []) lines.push(`  ${note}`)
  if (command.notes?.length) lines.push('')
  return lines.join('\n')
}

function validateOptions(command: CommandInfo, rest: Array<string>): string | null {
  const declared = new Map<string, CommandOption>()
  for (const option of command.options ?? []) for (const alias of option.names) declared.set(alias, option)
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i]
    if (token === '--') {
      if (command.passthrough) return null
      return `"thally ${command.name}" does not accept arguments after --.`
    }
    if (!token.startsWith('-') || token === '-') continue
    const separator = token.indexOf('=')
    const name = separator > 2 ? token.slice(0, separator) : token
    const option = declared.get(name)
    if (!option) {
      const hint = command.passthrough
        ? ` To pass options to the framework, put them after --: thally ${command.name} -- ${rest.slice(i).join(' ')}`
        : ''
      return `Unknown option "${name}" for "thally ${command.name}".${hint}`
    }
    if (!option.value) {
      if (separator > 2) return `Option "${name}" does not take a value.`
      continue
    }
    if (separator > 2) {
      if (!token.slice(separator + 1)) return `Option "${name}" needs a value: ${optionLabel(option)}.`
      continue
    }
    const value = rest[i + 1]
    if (value === undefined || value.startsWith('--')) {
      return `Option "${name}" needs a value: ${optionLabel(option)}.`
    }
    i += 1
  }
  return null
}

/**
 * Route raw argv to help, an error, or a runnable command without side effects.
 * Help always wins over execution, including for delegates that have no help
 * of their own (`mcp` would otherwise start a stdio server and wait).
 */
export function resolveInvocation(argv: Array<string>, version?: string): Invocation {
  const first = argv[0]
  if (first === undefined || HELP_FLAGS.has(first)) return { kind: 'help', text: helpText(version) }
  if (first === 'help') {
    const topic = argv[1] ? findCommand(argv[1]) : undefined
    if (argv[1] && !topic) return { kind: 'error', message: `Unknown command: ${argv[1]}`, usage: helpText(version) }
    return { kind: 'help', text: topic ? commandHelpText(topic) : helpText(version) }
  }
  if (first.startsWith('-')) {
    return { kind: 'error', message: `Unknown option "${first}". Run "thally --help" for usage.` }
  }

  const command = findCommand(first)
  if (!command) return { kind: 'error', message: `Unknown command: ${first}`, usage: helpText(version) }

  const rest = argv.slice(1)
  const separator = rest.indexOf('--')
  const ownArgs = separator === -1 || command.delegate ? rest : rest.slice(0, separator)
  const wantsHelp = ownArgs.some((token) => HELP_FLAGS.has(token))

  if (command.delegate) {
    // create-thally-docs prints its own side-effect-free help; the MCP server
    // has none, so its usage is printed here instead of starting the server.
    if (wantsHelp && command.name === 'mcp') return { kind: 'help', text: commandHelpText(command) }
    return { kind: 'run', command, args: parseArgs(argv, command) }
  }

  if (wantsHelp) return { kind: 'help', text: commandHelpText(command) }

  const optionError = validateOptions(command, rest)
  if (optionError) return { kind: 'error', message: optionError, usage: commandHelpText(command) }

  const args = parseArgs(argv, command)
  if (command.maxPositionals !== undefined && args.positionals.length > command.maxPositionals) {
    const extra = args.positionals[command.maxPositionals]
    const hint = command.passthrough ? ` To pass it to the framework, use: thally ${command.name} -- ${extra}` : ''
    return {
      kind: 'error',
      message: `Unexpected argument "${extra}" for "thally ${command.name}".${hint}`,
      usage: commandHelpText(command),
    }
  }
  return { kind: 'run', command, args }
}

/** Build plain help; terminal styling is applied only at the output boundary. */
export function helpText(version?: string): string {
  const groups = [
    { title: 'Create and write', commands: ['init', 'new', 'migrate', 'translate'] },
    { title: 'Preview and publish', commands: ['dev', 'build', 'start', 'deploy', 'check', 'starter'] },
    { title: 'Keep knowledge current', commands: ['agent', 'track', 'mcp'] },
  ]
  const lines = [
    '',
    `  thally${version ? ` v${version}` : ''}`,
    `  ${PRODUCT_TAGLINE}`,
    '',
    '  Usage: thally <command> [options]',
    '',
  ]
  const pad = Math.max(...COMMANDS.map((command) => command.name.length))
  for (const group of groups) {
    lines.push(`  ${group.title}:`)
    for (const name of group.commands) {
      const command = COMMANDS.find((candidate) => candidate.name === name)!
      lines.push(`    ${command.name.padEnd(pad)}  ${command.summary}`)
    }
    lines.push('')
  }
  lines.push('  Options:')
  lines.push('    --help       Show help (also: thally <command> --help)')
  lines.push('    --version    Print the installed version')
  lines.push('    --verbose    Show subprocess logs for init and migrate')
  lines.push('')
  lines.push('  Start a site:  thally init my-docs')
  lines.push('  Add a page:    thally new guides/getting-started')
  lines.push('  Migrate docs:  thally migrate <url> --platform <mintlify|docusaurus|fern|auto>')
  lines.push('')
  return lines.join('\n')
}
