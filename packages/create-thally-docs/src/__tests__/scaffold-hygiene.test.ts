/** Regression coverage for immutable starter extraction and personalization. */

import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { create as createTar } from 'tar'

import {
  STARTER_ARCHIVE_ROOT,
  STARTER_COMMIT_SHA,
  STARTER_REPOSITORY,
  downloadStarter,
  validateStarterArchiveEntry,
} from '../download.js'
import {
  disableLoopbackSiteUrl,
  personalizeStarter,
  updateEnvExample,
  pruneMissingSiteLinks,
  updateSiteConfig,
} from '../customize.js'
import { resetTrackingConfig, writeTrackingConfig } from '../docs-json.js'
import {
  STABLE_SCAFFOLD_RELEASE,
  SUPPORTED_SCAFFOLD_RELEASES,
  isStableScaffoldRelease,
  type ScaffoldRelease,
  type StarterReleaseManifest,
} from '../release.js'
import { starterManifestSha256 } from '../starter-sync.js'

const directories: string[] = []

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix))
  directories.push(directory)
  return directory
}

function writeStarterFixture(directory: string): void {
  mkdirSync(join(directory, 'src', 'content'), { recursive: true })
  mkdirSync(join(directory, 'src', 'data'), { recursive: true })
  mkdirSync(join(directory, 'src', 'lib'), { recursive: true })
  writeFileSync(
    join(directory, 'docs.json'),
    `${JSON.stringify({
      theme: 'default',
      ai: { provider: 'managed', chat: true },
      navbar: {
        primary: { label: 'Get started', href: '/quickstart' },
        links: [
          { label: 'Support', href: 'https://support.example.com' },
          { label: 'GitHub', href: 'https://github.com/thallylabs/starter', type: 'github' },
        ],
      },
      tabs: [
        {
          tab: 'Get started',
          groups: [{ group: 'Start here', pages: ['introduction', 'quickstart'] }],
        },
      ],
    }, null, 2)}\n`,
  )
  writeFileSync(
    join(directory, 'src', 'data', 'site.ts'),
    `const brandPreset: BrandPresetKey = 'primary'
export const siteConfig = {
  name: 'Your product',
  description:
    'Documentation for your product.',
  repoUrl: 'https://github.com/thallylabs/starter',
  links: [
    { label: 'Get started', href: '/quickstart' },
    { label: 'Support', href: 'https://github.com/thallylabs/starter/issues/new' },
    { label: 'GitHub', href: 'https://github.com/thallylabs/starter' },
  ],
}
`,
  )
  writeFileSync(
    join(directory, 'package.json'),
    `${JSON.stringify({
      name: 'thally-starter',
      scripts: { build: 'next build' },
      dependencies: { next: '16.2.10' },
    }, null, 2)}\n`,
  )
  writeFileSync(
    join(directory, 'package-lock.json'),
    `${JSON.stringify({
      name: 'thally-starter',
      lockfileVersion: 3,
      packages: { '': { name: 'thally-starter', version: '0.1.0' } },
    }, null, 2)}\n`,
  )
  writeFileSync(join(directory, 'wrangler.jsonc'), '{\n  "name": "thally-starter"\n}\n')
  writeFileSync(join(directory, '.env.example'), 'ANTHROPIC_API_KEY=\n')
  writeFileSync(join(directory, 'README.md'), '# Canonical starter\n')
  writeFileSync(
    join(directory, 'src', 'content', 'introduction.mdx'),
    '---\ntitle: Introduction\n---\n\nCanonical authored copy.\n',
  )
  writeFileSync(
    join(directory, 'src', 'lib', 'runtime.ts'),
    'export const runtimeVersion = 2\n',
  )
}

afterEach(() => {
  vi.restoreAllMocks()
  while (directories.length > 0) {
    rmSync(directories.pop()!, { recursive: true, force: true })
  }
})

describe('stable starter release', () => {
  it('pins the dedicated starter repository and derives its immutable URL', () => {
    expect(STARTER_REPOSITORY).toBe('thallylabs/starter')
    expect(STARTER_COMMIT_SHA).toBe(STABLE_SCAFFOLD_RELEASE.source.commitSha)
    expect(STABLE_SCAFFOLD_RELEASE.source.archiveUrl).toBe(
      `https://codeload.github.com/thallylabs/starter/tar.gz/${STARTER_COMMIT_SHA}`,
    )
    expect(STABLE_SCAFFOLD_RELEASE.source.treeSha).toBeTruthy()
    // Retained v2 and lean v3 releases share the same immutable identity contract.
    expect([2, 3]).toContain(STABLE_SCAFFOLD_RELEASE.starterVersion)
    expect(isStableScaffoldRelease(structuredClone(STABLE_SCAFFOLD_RELEASE))).toBe(true)
    expect(SUPPORTED_SCAFFOLD_RELEASES.some(({ starterVersion }) => starterVersion === 2)).toBe(true)
    // The retained chain grows by one supported record per promotion, so assert its
    // invariants instead of a literal snapshot: the stable record leads,
    // versions never increase along the update-base chain, and the frozen v1
    // base anchors the tail so v1 sites can always compute a three-way update.
    expect(SUPPORTED_SCAFFOLD_RELEASES[0]).toEqual(STABLE_SCAFFOLD_RELEASE)
    const chainVersions = SUPPORTED_SCAFFOLD_RELEASES.map(
      ({ starterVersion }) => starterVersion,
    )
    for (let index = 1; index < chainVersions.length; index += 1) {
      expect(chainVersions[index]).toBeLessThanOrEqual(chainVersions[index - 1])
    }
    const chainIds = SUPPORTED_SCAFFOLD_RELEASES.map(({ id }) => id)
    expect(new Set(chainIds).size).toBe(chainIds.length)
    expect(SUPPORTED_SCAFFOLD_RELEASES.at(-1)?.starterVersion).toBe(1)
    expect(SUPPORTED_SCAFFOLD_RELEASES.at(-1)?.source.commitSha).toBe(
      'd5fef9167ea81f12a861deec5515a78a0f756781',
    )
  })

  it('accepts every safe file in the whole repository tree', () => {
    expect(() =>
      validateStarterArchiveEntry(STARTER_ARCHIVE_ROOT, {
        type: 'Directory',
        size: 0,
      }),
    ).not.toThrow()
    expect(() =>
      validateStarterArchiveEntry(
        `${STARTER_ARCHIVE_ROOT}/.github/workflows/ci.yml`,
        { type: 'File', size: 512 },
      ),
    ).not.toThrow()
    expect(() =>
      validateStarterArchiveEntry(`${STARTER_ARCHIVE_ROOT}/README.md`, {
        type: 'File',
        size: 128,
      }),
    ).not.toThrow()
  })

  it('rejects traversal, foreign roots, links, and oversized files', () => {
    const file = { type: 'File', size: 10 }
    expect(() =>
      validateStarterArchiveEntry(`${STARTER_ARCHIVE_ROOT}/../package.json`, file),
    ).toThrow('unsafe path')
    expect(() =>
      validateStarterArchiveEntry('another-root/package.json', file),
    ).toThrow('unsafe path')
    expect(() =>
      validateStarterArchiveEntry(`${STARTER_ARCHIVE_ROOT}\\package.json`, file),
    ).toThrow('unsafe path')
    expect(() =>
      validateStarterArchiveEntry(`${STARTER_ARCHIVE_ROOT}/linked`, {
        type: 'SymbolicLink',
        size: 0,
      }),
    ).toThrow('unsupported entry type')
    expect(() =>
      validateStarterArchiveEntry(`${STARTER_ARCHIVE_ROOT}/large.bin`, {
        type: 'File',
        size: 33 * 1024 * 1024,
      }),
    ).toThrow('oversized file')
  })

  it('extracts the complete pinned tree without an exclusion policy', async () => {
    const archiveDirectory = temporaryDirectory('thally-starter-archive-')
    const archiveRoot = join(archiveDirectory, STARTER_ARCHIVE_ROOT)
    mkdirSync(join(archiveRoot, '.github', 'workflows'), { recursive: true })
    writeFileSync(join(archiveRoot, 'README.md'), '# Exact starter\n')
    writeFileSync(
      join(archiveRoot, 'package.json'),
      `${JSON.stringify({
        name: 'thally-starter',
        devDependencies: { '@thallylabs/cli': '0.7.0' },
      })}\n`,
    )
    writeFileSync(
      join(archiveRoot, '.github', 'workflows', 'ci.yml'),
      'name: CI\n',
    )
    const manifest: StarterReleaseManifest = {
      schemaVersion: 1,
      starterVersion: STABLE_SCAFFOLD_RELEASE.starterVersion,
      repository: STABLE_SCAFFOLD_RELEASE.source.repository,
      defaultBranch: 'main',
      runtime: {
        repository: STABLE_SCAFFOLD_RELEASE.runtime.repository,
        commitSha: STABLE_SCAFFOLD_RELEASE.runtime.commitSha,
        treeSha: STABLE_SCAFFOLD_RELEASE.runtime.treeSha,
      },
      packages: { '@thallylabs/cli': '0.7.0' },
      ownership: {
        frameworkSyncEligible: ['src/app/**'],
        userOwnedNeverOverwrite: ['docs.json'],
        manualReview: [],
      },
    }
    const manifestSource = `${JSON.stringify(manifest, null, 2)}\n`
    writeFileSync(
      join(archiveRoot, STABLE_SCAFFOLD_RELEASE.source.manifestPath),
      manifestSource,
    )
    const testRelease: ScaffoldRelease = {
      ...STABLE_SCAFFOLD_RELEASE,
      source: {
        ...STABLE_SCAFFOLD_RELEASE.source,
        manifestSha256: starterManifestSha256(manifestSource),
      },
    }
    const archivePath = join(archiveDirectory, 'starter.tar.gz')
    await createTar(
      { cwd: archiveDirectory, file: archivePath, gzip: true },
      [STARTER_ARCHIVE_ROOT],
    )
    const archive = readFileSync(archivePath)
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(archive, {
        status: 200,
        headers: { 'content-length': String(archive.byteLength) },
      }),
    )
    const target = temporaryDirectory('thally-starter-target-')

    await downloadStarter(target, 'Acme Docs', testRelease)

    expect(readFileSync(join(target, 'README.md'), 'utf8')).toBe('# Exact starter\n')
    expect(
      readFileSync(join(target, '.github', 'workflows', 'ci.yml'), 'utf8'),
    ).toBe('name: CI\n')
    expect(globalThis.fetch).toHaveBeenCalledWith(
      testRelease.source.archiveUrl,
      expect.objectContaining({ cache: 'no-store' }),
    )
  })
})

describe('starter owner personalization', () => {
  it('changes documented owner fields and preserves authored/runtime files', () => {
    const directory = temporaryDirectory('thally-starter-personalize-')
    writeStarterFixture(directory)
    const readmeBefore = readFileSync(join(directory, 'README.md'), 'utf8')
    const contentBefore = readFileSync(
      join(directory, 'src', 'content', 'introduction.mdx'),
      'utf8',
    )
    const runtimeBefore = readFileSync(
      join(directory, 'src', 'lib', 'runtime.ts'),
      'utf8',
    )

    personalizeStarter(directory, {
      projectName: "Acme's Docs",
      packageName: 'acme-docs',
      description: 'Documentation for Acme.',
      brandPreset: 'secondary',
      repoUrl: 'https://github.com/acme/docs',
      enableAiChat: false,
      i18nLocales: [
        { code: 'es', label: 'Español' },
        { code: 'ES', label: 'Duplicate' },
        { code: 'fr', label: 'Français' },
      ],
    })
    updateEnvExample(directory)

    const docs = JSON.parse(readFileSync(join(directory, 'docs.json'), 'utf8'))
    expect(docs.theme).toBe('default')
    expect(docs.tabs[0].groups).toEqual([
      { group: 'Start here', pages: ['introduction', 'quickstart'] },
    ])
    expect(docs.ai).toEqual({ provider: 'managed', chat: false })
    expect(docs.i18n.locales).toEqual([
      { code: 'en', label: 'English' },
      { code: 'es', label: 'Español' },
      { code: 'fr', label: 'Français' },
    ])
    expect(docs.navbar.primary).toEqual({
      label: 'Get started',
      href: '/quickstart',
    })
    expect(docs.navbar.links).toEqual([
      { label: 'Support', href: 'https://support.example.com' },
      { label: 'GitHub', href: 'https://github.com/acme/docs', type: 'github' },
    ])

    const site = readFileSync(join(directory, 'src', 'data', 'site.ts'), 'utf8')
    expect(site).toContain("name: 'Acme\\'s Docs'")
    expect(site).toContain("'Documentation for Acme.'")
    expect(site).toContain("const brandPreset: BrandPresetKey = 'secondary'")
    expect(site).toContain("repoUrl: 'https://github.com/acme/docs'")

    const packageJson = JSON.parse(
      readFileSync(join(directory, 'package.json'), 'utf8'),
    )
    const lock = JSON.parse(
      readFileSync(join(directory, 'package-lock.json'), 'utf8'),
    )
    expect(packageJson.name).toBe('acme-docs')
    expect(packageJson.dependencies).toEqual({ next: '16.2.10' })
    expect(packageJson.scripts).toEqual({ build: 'next build' })
    expect(lock.name).toBe('acme-docs')
    expect(lock.packages[''].name).toBe('acme-docs')
    expect(readFileSync(join(directory, 'wrangler.jsonc'), 'utf8')).toContain(
      '"name": "acme-docs"',
    )
    expect(readFileSync(join(directory, '.env.local'), 'utf8')).toBe(
      'ANTHROPIC_API_KEY=\n',
    )
    expect(readFileSync(join(directory, 'README.md'), 'utf8')).toBe(readmeBefore)
    expect(
      readFileSync(join(directory, 'src', 'content', 'introduction.mdx'), 'utf8'),
    ).toBe(contentBefore)
    expect(
      readFileSync(join(directory, 'src', 'lib', 'runtime.ts'), 'utf8'),
    ).toBe(runtimeBefore)
  })

  it('never copies a loopback site URL into .env.local', () => {
    const directory = temporaryDirectory('thally-starter-env-')
    writeFileSync(
      join(directory, '.env.example'),
      '# Site URL\nTHALLY_SITE_URL=http://localhost:3040\nNEXT_PUBLIC_SITE_URL="http://127.0.0.1:3000/"\n# ANTHROPIC_API_KEY=\n',
    )
    updateEnvExample(directory)
    expect(readFileSync(join(directory, '.env.local'), 'utf8')).toBe(
      '# Site URL\n# THALLY_SITE_URL=http://localhost:3040\n# NEXT_PUBLIC_SITE_URL="http://127.0.0.1:3000/"\n# ANTHROPIC_API_KEY=\n',
    )
  })

  it('keeps public site URLs and look-alike hosts untouched', () => {
    const source = 'THALLY_SITE_URL=https://docs.example.com\nTHALLY_SITE_URL=https://localhost.example.com\n'
    expect(disableLoopbackSiteUrl(source)).toBe(source)
  })

  it('removes starter repository links when the owner has no repository yet', () => {
    const directory = temporaryDirectory('thally-starter-no-repo-')
    writeStarterFixture(directory)

    personalizeStarter(directory, {
      projectName: 'Acme Docs',
      packageName: 'acme-docs',
      description: 'Acme documentation.',
      brandPreset: 'primary',
      repoUrl: '',
      enableAiChat: true,
    })

    const docs = JSON.parse(readFileSync(join(directory, 'docs.json'), 'utf8'))
    expect(docs.navbar.links).toEqual([
      { label: 'Support', href: 'https://support.example.com' },
    ])
    const site = readFileSync(join(directory, 'src', 'data', 'site.ts'), 'utf8')
    expect(site).not.toContain("label: 'GitHub'")
    expect(site).not.toContain("label: 'Support'")
    expect(site).toContain("repoUrl: ''")
  })

  it('fails closed when the pinned starter loses a required owner field', () => {
    const directory = temporaryDirectory('thally-starter-drift-')
    writeStarterFixture(directory)
    writeFileSync(
      join(directory, 'src', 'data', 'site.ts'),
      "export const siteConfig = { name: 'Your product' }\n",
    )

    expect(() =>
      personalizeStarter(directory, {
        projectName: 'Acme Docs',
        packageName: 'acme-docs',
        description: 'Acme documentation.',
        brandPreset: 'primary',
        repoUrl: '',
        enableAiChat: true,
      }),
    ).toThrow('missing owner field site.description')
  })

  it('maps migrated Mintlify theme colors onto the chosen brand preset only', () => {
    const directory = temporaryDirectory('thally-starter-colors-')
    mkdirSync(join(directory, 'src', 'data'), { recursive: true })
    writeFileSync(
      join(directory, 'src', 'data', 'site.ts'),
      `const brandPresets = {
  primary: {
    light: {
      accent: '#007852',
      ring: '#007852',
      accentForeground: '#ffffff',
      sidebarActiveText: '#007852',
    },
    dark: {
      accent: '#BAE43E',
      ring: '#BAE43E',
      accentForeground: '#000000',
      sidebarActiveText: '#BAE43E',
    },
  },
  secondary: {
    light: {
      accent: '#8B5CF6',
      ring: '#8B5CF6',
      accentForeground: '#ffffff',
      sidebarActiveText: '#8B5CF6',
    },
    dark: {
      accent: '#C084FC',
      ring: '#C084FC',
      accentForeground: '#000000',
      sidebarActiveText: '#C084FC',
    },
  },
}
const brandPreset: BrandPresetKey = 'primary'
export const siteConfig = {
  name: 'Your product',
  description:
    'Documentation for your product.',
  repoUrl: '',
}
`,
    )

    // Mintlify's own schema (which `colors` here follows) inverts light/dark:
    // `light` paints dark mode, `dark` paints light mode.
    updateSiteConfig(directory, 'Acme Docs', 'Acme documentation.', 'primary', '', {
      primary: '#16A34A',
      light: '#07C983',
      dark: '#15803D',
    })

    const site = readFileSync(join(directory, 'src', 'data', 'site.ts'), 'utf8')
    // `colors.dark` (`#15803D`) paints light mode; `colors.light` (`#07C983`) paints dark mode.
    expect(site).toContain("light: {\n      accent: '#15803D',\n      ring: '#15803D',\n      accentForeground: '#ffffff',\n      sidebarActiveText: '#15803D',\n    },")
    expect(site).toContain("dark: {\n      accent: '#07C983',\n      ring: '#07C983',\n      accentForeground: '#000000',\n      sidebarActiveText: '#07C983',\n    },")
    // The unselected preset keeps its own accents untouched.
    expect(site).toContain("accent: '#8B5CF6'")
    expect(site).toContain("accent: '#C084FC'")
  })

  it('drops starter links to pages a migration did not bring along', () => {
    const directory = temporaryDirectory('thally-starter-links-')
    mkdirSync(join(directory, 'src', 'data'), { recursive: true })
    writeFileSync(
      join(directory, 'src', 'data', 'site.ts'),
      `export const siteConfig = {
  links: [
    { label: 'Get started', href: '/quickstart' },
    { label: 'Support', href: 'https://example.com/issues/new' },
    { label: 'Changelog', href: '/changelog' },
  ],
}
`,
    )

    pruneMissingSiteLinks(directory, new Set(['quickstart']))

    const site = readFileSync(join(directory, 'src', 'data', 'site.ts'), 'utf8')
    expect(site).toContain("{ label: 'Get started', href: '/quickstart' },")
    expect(site).toContain('https://example.com/issues/new')
    expect(site).not.toContain('/changelog')
  })

  it('rejects a malformed accent color and keeps the preset default', () => {
    const directory = temporaryDirectory('thally-starter-colors-invalid-')
    mkdirSync(join(directory, 'src', 'data'), { recursive: true })
    writeFileSync(
      join(directory, 'src', 'data', 'site.ts'),
      `const brandPresets = {
  primary: {
    light: {
      accent: '#007852',
    },
    dark: {
      accent: '#BAE43E',
    },
  },
}
const brandPreset: BrandPresetKey = 'primary'
export const siteConfig = {
  name: 'Your product',
  description:
    'Documentation for your product.',
  repoUrl: '',
}
`,
    )

    updateSiteConfig(directory, 'Acme Docs', 'Acme documentation.', 'primary', '', {
      dark: "javascript:alert(1)//",
    })

    const site = readFileSync(join(directory, 'src', 'data', 'site.ts'), 'utf8')
    expect(site).toContain("accent: '#007852'")
  })

  it('rejects 5- and 7-digit hex colors as invalid CSS hex lengths', () => {
    const directory = temporaryDirectory('thally-starter-colors-badlen-')
    mkdirSync(join(directory, 'src', 'data'), { recursive: true })
    writeFileSync(
      join(directory, 'src', 'data', 'site.ts'),
      `const brandPresets = {
  primary: {
    light: {
      accent: '#007852',
    },
    dark: {
      accent: '#BAE43E',
    },
  },
}
const brandPreset: BrandPresetKey = 'primary'
export const siteConfig = {
  name: 'Your product',
  description:
    'Documentation for your product.',
  repoUrl: '',
}
`,
    )

    updateSiteConfig(directory, 'Acme Docs', 'Acme documentation.', 'primary', '', {
      dark: '#12345',
      light: '#1234567',
    })

    const site = readFileSync(join(directory, 'src', 'data', 'site.ts'), 'utf8')
    expect(site).toContain("accent: '#007852'")
    expect(site).toContain("accent: '#BAE43E'")
  })

  it('handles a 4-digit hex shorthand, ignoring its alpha nibble for contrast', () => {
    const directory = temporaryDirectory('thally-starter-colors-4digit-')
    mkdirSync(join(directory, 'src', 'data'), { recursive: true })
    writeFileSync(
      join(directory, 'src', 'data', 'site.ts'),
      `const brandPresets = {
  primary: {
    light: {
      accent: '#007852',
      ring: '#007852',
      accentForeground: '#ffffff',
      sidebarActiveText: '#007852',
    },
    dark: {
      accent: '#BAE43E',
      ring: '#BAE43E',
      accentForeground: '#000000',
      sidebarActiveText: '#BAE43E',
    },
  },
}
const brandPreset: BrandPresetKey = 'primary'
export const siteConfig = {
  name: 'Your product',
  description:
    'Documentation for your product.',
  repoUrl: '',
}
`,
    )

    // `#000f` shorthand expands to `#000000` (black), ignoring the trailing
    // alpha nibble; contrastForeground must pick white text for it.
    updateSiteConfig(directory, 'Acme Docs', 'Acme documentation.', 'primary', '', {
      dark: '#000f',
    })

    const site = readFileSync(join(directory, 'src', 'data', 'site.ts'), 'utf8')
    expect(site).toContain("light: {\n      accent: '#000f',\n      ring: '#000f',\n      accentForeground: '#ffffff',\n      sidebarActiveText: '#000f',\n    },")
  })
})

describe('Thally Track remains owner opt-in', () => {
  it('removes starter tracking and writes only explicitly selected repositories', () => {
    const directory = temporaryDirectory('thally-starter-track-')
    writeStarterFixture(directory)
    const docsPath = join(directory, 'docs.json')
    const docs = JSON.parse(readFileSync(docsPath, 'utf8'))
    docs.tracking = {
      repos: [{ owner: 'thallylabs', repo: 'starter', branch: 'main' }],
    }
    writeFileSync(docsPath, JSON.stringify(docs))

    resetTrackingConfig(directory)
    writeTrackingConfig(directory, [
      { owner: 'acme', repo: 'api' },
      { owner: 'acme', repo: 'web' },
    ])

    const result = JSON.parse(readFileSync(docsPath, 'utf8'))
    expect(result.tracking.repos).toEqual([
      { owner: 'acme', repo: 'api', branch: 'main' },
      { owner: 'acme', repo: 'web', branch: 'main' },
    ])
    expect(existsSync(join(directory, 'src', 'content', 'introduction.mdx'))).toBe(true)
  })
})
