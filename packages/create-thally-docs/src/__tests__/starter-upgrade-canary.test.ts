/** Real SDK canaries reject broken provenance and preserve owner customizations. */
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ScaffoldRelease } from '../release.js';
import { verifyScaffoldUpgrades } from '../starter-upgrade-canary.js';

const temporary: string[] = [];
afterEach(() => { for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function fixture(version: number): { root: string; release: ScaffoldRelease } {
  const root = mkdtempSync(join(tmpdir(), 'scaffold-canary-test-'));
  temporary.push(root);
  const runtime = { repository: 'thallylabs/thally', commitSha: String(version).repeat(40), treeSha: 'a'.repeat(40) };
  const manifest = `${JSON.stringify({ schemaVersion: 1, starterVersion: version, repository: 'thallylabs/starter', defaultBranch: 'main', runtime, packages: { '@thallylabs/core': `^0.2.${version}` }, ownership: { frameworkSyncEligible: ['src/lib/**'], userOwnedNeverOverwrite: ['src/content/**', 'docs.json', 'src/data/site.ts'], manualReview: ['package.json', 'package-lock.json'] } }, null, 2)}\n`;
  mkdirSync(join(root, 'src/lib'), { recursive: true });
  mkdirSync(join(root, 'src/data'), { recursive: true });
  writeFileSync(join(root, 'starter-release.json'), manifest);
  writeFileSync(join(root, 'src/lib/runtime.ts'), `export const runtime = ${version};\n`);
  writeFileSync(join(root, 'src/data/site.ts'), 'export const site = "owner";\n');
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'starter', dependencies: { '@thallylabs/core': `^0.2.${version}` } }));
  writeFileSync(join(root, 'package-lock.json'), JSON.stringify({ name: 'starter', lockfileVersion: 3, packages: { '': { name: 'starter', dependencies: { '@thallylabs/core': `^0.2.${version}` } }, 'node_modules/@thallylabs/core': { version: `0.2.${version}` } } }));
  const sha = String(version + 3).repeat(40);
  const release: ScaffoldRelease = { schemaVersion: 1, id: `fixture-${version}`, starterVersion: version, source: { repository: 'thallylabs/starter', commitSha: sha, treeSha: 'b'.repeat(40), archiveUrl: `https://codeload.github.com/thallylabs/starter/tar.gz/${sha}`, manifestPath: 'starter-release.json', manifestSha256: createHash('sha256').update(manifest).digest('hex') }, runtime: { ...runtime, contentSource: 'assets', identityContractVersion: 1 } };
  return { root, release };
}

describe('historical scaffold upgrade canary', () => {
  it('completely upgrades newest and oldest bases without changing the candidate', async () => {
    const oldest = fixture(1), current = fixture(2), target = fixture(3);
    const original = readFileSync(join(target.root, 'starter-release.json'));
    const checked = await verifyScaffoldUpgrades({ target: target.release, candidateDirectory: target.root, current: current.release, releases: [current.release, oldest.release], download: async (directory, release) => cpSync(release.id === current.release.id ? current.root : oldest.root, directory, { recursive: true }) });
    expect(checked).toEqual([current.release.id, oldest.release.id]);
    expect(readFileSync(join(target.root, 'starter-release.json'))).toEqual(original);
  });

  it('checks current stable even when the candidate keeps the same default record', async () => {
    const oldest = fixture(1), target = fixture(2);
    const checked = await verifyScaffoldUpgrades({ target: target.release, candidateDirectory: target.root, current: target.release, releases: [oldest.release], download: async directory => cpSync(oldest.root, directory, { recursive: true }) });
    expect(checked).toEqual([target.release.id, oldest.release.id]);
  });

  it('fails closed when an immutable historical archive is missing', async () => {
    const old = fixture(1), target = fixture(2);
    await expect(verifyScaffoldUpgrades({ target: target.release, candidateDirectory: target.root, current: old.release, releases: [old.release], download: async () => { throw new Error('Missing immutable archive'); } })).rejects.toThrow('Missing immutable archive');
  });

  it('rejects tampered historical manifests before an upgrade can be trusted', async () => {
    const old = fixture(1), target = fixture(2);
    await expect(verifyScaffoldUpgrades({ target: target.release, candidateDirectory: target.root, current: old.release, releases: [old.release], download: async directory => { cpSync(old.root, directory, { recursive: true }); writeFileSync(join(directory, 'starter-release.json'), '{}'); } })).rejects.toThrow(/manifest/);
  });

  it('rejects a missing framework file against the trusted historical baseline', async () => {
    const old = fixture(1), target = fixture(2);
    let downloads = 0;
    await expect(verifyScaffoldUpgrades({ target: target.release, candidateDirectory: target.root, current: old.release, releases: [old.release], download: async directory => {
      cpSync(old.root, directory, { recursive: true });
      if (downloads++ === 0) rmSync(join(directory, 'src/lib/runtime.ts'));
    } })).rejects.toThrow(/Historical upgrade conflicts/);
  });

  it('rejects noncanonical archive URLs without contacting them', async () => {
    const old = fixture(1), target = fixture(2);
    old.release.source.archiveUrl = 'https://attacker.example/starter.tar.gz';
    await expect(verifyScaffoldUpgrades({ target: target.release, candidateDirectory: target.root, current: old.release, releases: [old.release] })).rejects.toThrow('immutable canonical');
  });
});
