/**
 * Credential-free promotion canary for complete historical scaffold upgrades.
 * Only immutable canonical archives become fixtures; customer repositories and
 * live state are never touched. Owner bytes and complete target runtime parity
 * must survive the real shared updater before a candidate may become stable.
 */
import { createHash } from 'node:crypto';
import { cpSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { downloadStarter } from './download.js';
import { STABLE_SCAFFOLD_RELEASE, SUPPORTED_SCAFFOLD_RELEASES, type ScaffoldRelease } from './release.js';
import { classifyStarterPath, mergeStarterOwnershipContracts, readStarterReleaseManifest } from './starter-sync.js';
import { updateStarterProject, type StarterUpdateDownload } from './starter-update.js';

/** Immutable candidate and trusted historical baselines used by release gates. */
export interface UpgradeCanaryOptions {
  target: ScaffoldRelease;
  candidateDirectory: string;
  releases?: readonly ScaffoldRelease[];
  current?: ScaffoldRelease;
  download?: StarterUpdateDownload;
}

function files(root: string, prefix = ''): Map<string, Buffer> {
  const result = new Map<string, Buffer>();
  for (const entry of readdirSync(join(root, prefix))) {
    const path = prefix ? `${prefix}/${entry}` : entry;
    const stat = lstatSync(join(root, path));
    if (stat.isSymbolicLink()) throw new Error('Canary archives cannot contain symbolic links.');
    if (stat.isDirectory()) for (const [key, bytes] of files(root, path)) result.set(key, bytes);
    else if (stat.isFile()) result.set(path, readFileSync(join(root, path)));
    else throw new Error('Canary archives must contain only regular files.');
  }
  return result;
}

/** Reject noncanonical sources before any gate downloads an archive. */
export function assertCanonicalScaffoldUpgradeRelease(release: ScaffoldRelease): void {
  if (release.source.repository !== 'thallylabs/starter' || release.runtime.repository !== 'thallylabs/thally' ||
      !/^[a-f0-9]{40}$/.test(release.source.commitSha) ||
      !/^[a-f0-9]{40}$/.test(release.source.treeSha) ||
      !/^[a-f0-9]{40}$/.test(release.runtime.commitSha) ||
      !/^[a-f0-9]{40}$/.test(release.runtime.treeSha) ||
      !/^[a-f0-9]{64}$/.test(release.source.manifestSha256) ||
      release.source.archiveUrl !== `https://codeload.github.com/thallylabs/starter/tar.gz/${release.source.commitSha}`) {
    throw new Error('Historical upgrade canaries require immutable canonical releases.');
  }
}

/** Run the current and oldest retained bases through the real complete updater. */
export async function verifyScaffoldUpgrades(options: UpgradeCanaryOptions): Promise<string[]> {
  const { target } = options;
  assertCanonicalScaffoldUpgradeRelease(target);
  const targetManifest = readStarterReleaseManifest(options.candidateDirectory, target);
  const targetFiles = files(options.candidateDirectory);
  const history = [...(options.releases ?? SUPPORTED_SCAFFOLD_RELEASES)]
    .filter(release => release.source.manifestSha256 !== target.source.manifestSha256);
  if (!history.length) throw new Error('Historical upgrade canary has no retained baseline.');
  const current = options.current ?? STABLE_SCAFFOLD_RELEASE;
  const bases = [current, history.at(-1)!].filter((release, index, all) => all.findIndex(other => other.source.manifestSha256 === release.source.manifestSha256) === index);
  const catalog = [target, ...bases, ...history].filter((release, index, all) => all.findIndex(other => other.source.manifestSha256 === release.source.manifestSha256) === index);
  catalog.forEach(assertCanonicalScaffoldUpgradeRelease);
  const workspace = mkdtempSync(join(tmpdir(), 'thally-upgrade-canary-'));
  const snapshots = new Map<string, string>();
  const download: StarterUpdateDownload = async (destination, release) => {
    if (!catalog.some(known => known.id === release.id && known.source.manifestSha256 === release.source.manifestSha256)) throw new Error('Canary requested an uncatalogued release.');
    if (release.source.manifestSha256 === target.source.manifestSha256) cpSync(options.candidateDirectory, destination, { recursive: true });
    else if (options.download) await options.download(destination, release);
    else {
      let snapshot = snapshots.get(release.source.manifestSha256);
      if (!snapshot) {
        snapshot = join(workspace, 'archives', release.source.manifestSha256);
        mkdirSync(snapshot, { recursive: true });
        await downloadStarter(snapshot, undefined, release, { announce: false });
        readStarterReleaseManifest(snapshot, release);
        files(snapshot);
        snapshots.set(release.source.manifestSha256, snapshot);
      }
      cpSync(snapshot, destination, { recursive: true });
    }
    readStarterReleaseManifest(destination, release);
    files(destination);
  };
  try {
    for (const [index, base] of bases.entries()) {
      const customer = join(workspace, String(index));
      mkdirSync(customer);
      await download(customer, base);
      const oldManifest = readStarterReleaseManifest(customer, base);
      const ownership = mergeStarterOwnershipContracts(oldManifest.ownership, targetManifest.ownership);
      for (const [path, bytes] of [
        ['src/content/__upgrade-canary.mdx', Buffer.from('---\ntitle: Upgrade canary\ndescription: Owner preservation\n---\nOwner content.\n')],
        ['docs.json', Buffer.from('{"name":"Customer upgrade canary","navigation":[]}\n')],
      ] as const) {
        if (classifyStarterPath(path, ownership) !== 'protected') throw new Error(`Canary owner path is not protected: ${path}`);
        mkdirSync(dirname(join(customer, path)), { recursive: true });
        writeFileSync(join(customer, path), bytes);
      }
      const packagePath = join(customer, 'package.json');
      const packageJson = JSON.parse(readFileSync(packagePath, 'utf8'));
      packageJson.name = 'customer-upgrade-canary';
      writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
      const before = files(customer);
      const plan = await updateStarterProject({ targetDir: customer, targetRelease: target, releases: catalog, download });
      if (plan.plan.conflictPaths.length) throw new Error(`Historical upgrade conflicts: ${base.id}`);
      await updateStarterProject({ targetDir: customer, targetRelease: target, releases: catalog, download, apply: true, confirmed: true });
      const after = files(customer);
      for (const [path, bytes] of before) if (path !== target.source.manifestPath && classifyStarterPath(path, ownership) === 'protected' && !after.get(path)?.equals(bytes)) throw new Error(`Upgrade changed owner bytes: ${path}`);
      for (const path of new Set([...targetFiles.keys(), ...after.keys()])) if (classifyStarterPath(path, ownership) === 'syncable' && (!targetFiles.has(path) || !after.has(path) || !targetFiles.get(path)!.equals(after.get(path)!))) throw new Error(`Upgrade runtime differs from candidate: ${path}`);
      if (JSON.parse(readFileSync(packagePath, 'utf8')).name !== 'customer-upgrade-canary') throw new Error('Upgrade lost independent package customization.');
      // Compare every package field other than the independently owned name;
      // an updater leaving dependencies or the lockfile stale must fail here.
      for (const path of ['package.json', 'package-lock.json']) {
        const actual = JSON.parse(readFileSync(join(customer, path), 'utf8'));
        const expected = JSON.parse(readFileSync(join(options.candidateDirectory, path), 'utf8'));
        delete actual.name; delete expected.name;
        if (actual.packages?.['']) delete actual.packages[''].name;
        if (expected.packages?.['']) delete expected.packages[''].name;
        if (!isDeepStrictEqual(actual, expected)) throw new Error(`Upgrade package inputs differ from candidate: ${path}`);
      }
      const hash = createHash('sha256').update(readFileSync(join(customer, target.source.manifestPath))).digest('hex');
      if (hash !== target.source.manifestSha256) throw new Error('Upgrade did not advance exact target provenance.');
    }
    return bases.map(base => base.id);
  } finally { rmSync(workspace, { recursive: true, force: true }); }
}
