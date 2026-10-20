/** Public monorepo integration suites must never enter standalone snapshots. */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { FRAMEWORK_SYNC_ELIGIBLE, checkStarterRuntimeContract, isSourceOnlyPath } from "./starter-runtime-contract.mjs";

test("rejects monorepo integration tests already present in a standalone snapshot", () => {
  const runtimeDirectory = fileURLToPath(new URL("../../", import.meta.url));
  const starterDirectory = mkdtempSync(join(tmpdir(), "thally-starter-source-only-"));
  const sourceOnly = [
    "src/components/mdx/steps-toc.test.tsx",
    "src/lib/__tests__/url-migration-runtime-fidelity.test.ts",
    "src/lib/openapi/__tests__/migrate-withheld-operations-parity.test.ts",
  ];
  const write = (path, value) => {
    const destination = join(starterDirectory, path);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, typeof value === "string" ? value : JSON.stringify(value));
  };
  try {
    const { version } = JSON.parse(readFileSync(join(runtimeDirectory, "packages/core/package.json"), "utf8"));
    const dependencies = { "@thallylabs/core": `^${version}` };
    write("starter-release.json", {
      schemaVersion: 1,
      repository: "thallylabs/starter",
      runtime: { repository: "thallylabs/thally" },
      ownership: { frameworkSyncEligible: FRAMEWORK_SYNC_ELIGIBLE },
      packages: dependencies,
    });
    write("package.json", { dependencies });
    write("package-lock.json", { packages: { "": { dependencies }, "node_modules/@thallylabs/core": { version } } });
    for (const path of sourceOnly) write(path, "stale integration test");
    const { differences } = checkStarterRuntimeContract({ starterDirectory, runtimeDirectory });
    assert.deepEqual(
      differences.filter((difference) => difference.includes("is source-only" )).sort(),
      sourceOnly.map((path) => `${path} is source-only but exists in starter`).sort(),
    );
  } finally {
    rmSync(starterDirectory, { recursive: true, force: true });
  }
});

// Test coverage stays with the engine, including new suites added in the future.
test("excludes every framework test and fixture without excluding runtime modules", () => {
  for (const path of ["src/app/route.test.ts", "src/components/card.spec.tsx", "src/lib/__tests__/helper.ts", "src/lib/__fixtures__/doc.mdx", "src/test/server-only.ts", "scripts/lib/build.test.mts"]) {
    assert.equal(isSourceOnlyPath(path), true, path);
  }
  for (const path of ["src/lib/testing.ts", "src/lib/runtime.ts", "scripts/build-runtime-sources.mts"]) {
    assert.equal(isSourceOnlyPath(path), false, path);
  }
});
