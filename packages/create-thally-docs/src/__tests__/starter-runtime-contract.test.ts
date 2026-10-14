/** Runtime-to-starter synchronization contract coverage. */

import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// This workflow bootstrap intentionally stays dependency-free JavaScript so
// GitHub Actions can run it before npm install.
// @ts-expect-error -- the checked-in .mjs module has no declaration file.
import {
  FRAMEWORK_SYNC_ELIGIBLE,
  checkStarterRuntimeContract,
  syncStarterRuntimeContract,
} from "../../../../.github/scripts/starter-runtime-contract.mjs";

const temporaryDirectories: Array<string> = [];

function temporaryDirectory(name: string): string {
  const directory = mkdtempSync(join(tmpdir(), `${name}-`));
  temporaryDirectories.push(directory);
  return directory;
}

function write(root: string, path: string, content: string): void {
  const destination = join(root, path);
  mkdirSync(join(destination, ".."), { recursive: true });
  writeFileSync(destination, content, "utf8");
}

function writeCoreLock(
  starterDirectory: string,
  core: { version: string; constraint: string },
): void {
  write(
    starterDirectory,
    "package-lock.json",
    `${JSON.stringify(
      {
        lockfileVersion: 3,
        packages: {
          "": { dependencies: { "@thallylabs/core": core.constraint } },
          "node_modules/@thallylabs/core": { version: core.version },
        },
      },
      null,
      2,
    )}\n`,
  );
}

function createRuntime(): {
  directory: string;
  commitSha: string;
  treeSha: string;
} {
  const directory = temporaryDirectory("thally-runtime-contract");
  write(directory, "BUILD-WARNINGS.md", "# Build warning register\n");
  write(directory, "src/components/top-bar.tsx", "export const height = 56\n");
  write(directory, "src/lib/runtime.ts", "export const runtime = true\n");
  write(
    directory,
    "packages/core/package.json",
    `${JSON.stringify({ name: "@thallylabs/core", version: "0.2.3" }, null, 2)}\n`,
  );
  write(
    directory,
    "src/lib/__tests__/frontmatter-parity.test.ts",
    "import '../../../packages/core'\n",
  );
  write(
    directory,
    "src/components/mdx/client-registry.test.ts",
    "import '../../../packages/migrate/src/components.js'\n",
  );
  execFileSync("git", ["init", "-q"], { cwd: directory });
  execFileSync("git", ["add", "."], { cwd: directory });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-qm",
      "runtime",
    ],
    { cwd: directory },
  );
  return {
    directory,
    commitSha: execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: directory,
      encoding: "utf8",
    }).trim(),
    treeSha: execFileSync("git", ["rev-parse", "HEAD^{tree}"], {
      cwd: directory,
      encoding: "utf8",
    }).trim(),
  };
}

function createStarter(
  runtime: ReturnType<typeof createRuntime>,
  rules?: Array<string>,
): string {
  const directory = temporaryDirectory("thally-starter-contract");
  write(directory, "src/components/top-bar.tsx", "export const height = 48\n");
  write(directory, "src/components/removed.tsx", "stale\n");
  write(
    directory,
    "src/lib/__tests__/frontmatter-parity.test.ts",
    "import '../../../packages/core'\n",
  );
  write(
    directory,
    "src/components/mdx/client-registry.test.ts",
    "import '../../../packages/migrate/src/components.js'\n",
  );
  write(
    directory,
    "package.json",
    `${JSON.stringify({ dependencies: { "@thallylabs/core": "^0.2.2" } }, null, 2)}\n`,
  );
  writeCoreLock(directory, { version: "0.2.2", constraint: "^0.2.2" });
  write(
    directory,
    "starter-release.json",
    `${JSON.stringify(
      {
        schemaVersion: 1,
        starterVersion: 1,
        repository: "thallylabs/starter",
        defaultBranch: "main",
        runtime: {
          repository: "thallylabs/thally",
          commitSha: "0".repeat(40),
          treeSha: "1".repeat(40),
        },
        packages: { "@thallylabs/core": "^0.2.2" },
        ownership: {
          frameworkSyncEligible: rules ?? FRAMEWORK_SYNC_ELIGIBLE,
          userOwnedNeverOverwrite: ["src/content/**"],
          manualReview: [],
        },
      },
      null,
      2,
    )}\n`,
  );
  return directory;
}

// Directories that are only partly synchronized: a runtime module added here
// and imported by synced code must be eligible, or generated sites fail to
// build. Files the starter owns are listed explicitly.
const STARTER_OWNED = new Set(["src/data/site.ts", "src/mdx/custom-components.tsx"]);

describe("partially synchronized runtime directories", () => {
  it("lists every non-test module as sync-eligible or starter-owned", () => {
    const root = resolve(__dirname, "../../../..");
    const covered = (path: string) =>
      (FRAMEWORK_SYNC_ELIGIBLE as Array<string>).some((rule) =>
        rule.endsWith("/**") ? path.startsWith(rule.slice(0, -2)) : rule === path,
      );
    const unlisted: Array<string> = [];
    for (const directory of ["src/data", "src/mdx"]) {
      for (const name of readdirSync(join(root, directory))) {
        const path = `${directory}/${name}`;
        if (!/\.tsx?$/.test(name) || /\.test\.tsx?$/.test(name)) continue;
        if (!covered(path) && !STARTER_OWNED.has(path)) unlisted.push(path);
      }
    }
    expect(unlisted).toEqual([]);
  });
});

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("starter runtime contract", () => {
  it("detects provenance, changed files, missing files, and stale files", () => {
    const runtime = createRuntime();
    const starterDirectory = createStarter(runtime);

    const result = checkStarterRuntimeContract({
      starterDirectory,
      runtimeDirectory: runtime.directory,
    });

    expect(result.differences).toEqual(
      expect.arrayContaining([
        expect.stringContaining("starter-release.json pins"),
        "src/components/removed.tsx exists only in starter",
        "src/components/top-bar.tsx bytes differ",
        "src/lib/runtime.ts is missing from starter",
        "BUILD-WARNINGS.md is missing from starter",
        "src/lib/__tests__/frontmatter-parity.test.ts is source-only but exists in starter",
        "src/components/mdx/client-registry.test.ts is source-only but exists in starter",
      ]),
    );
  });

  it("generates a byte-identical snapshot and exact runtime pin", () => {
    const runtime = createRuntime();
    const starterDirectory = createStarter(runtime);

    syncStarterRuntimeContract({
      starterDirectory,
      runtimeDirectory: runtime.directory,
      refreshLockfile: writeCoreLock,
    });

    expect(
      checkStarterRuntimeContract({
        starterDirectory,
        runtimeDirectory: runtime.directory,
      }).differences,
    ).toEqual([]);
    expect(
      readFileSync(
        join(starterDirectory, "src/components/top-bar.tsx"),
        "utf8",
      ),
    ).toBe("export const height = 56\n");
    expect(readFileSync(join(starterDirectory, "BUILD-WARNINGS.md"), "utf8")).toBe(
      "# Build warning register\n",
    );
    expect(() =>
      readFileSync(
        join(starterDirectory, "src/lib/__tests__/frontmatter-parity.test.ts"),
        "utf8",
      ),
    ).toThrow();
    expect(() =>
      readFileSync(
        join(starterDirectory, "src/components/mdx/client-registry.test.ts"),
        "utf8",
      ),
    ).toThrow();
    const manifest = JSON.parse(
      readFileSync(join(starterDirectory, "starter-release.json"), "utf8"),
    );
    expect(manifest.runtime).toEqual({
      repository: "thallylabs/thally",
      commitSha: runtime.commitSha,
      treeSha: runtime.treeSha,
    });
    expect(manifest.packages).toEqual({ "@thallylabs/core": "^0.2.3" });
    expect(
      JSON.parse(readFileSync(join(starterDirectory, "package.json"), "utf8"))
        .dependencies["@thallylabs/core"],
    ).toBe("^0.2.3");
    const lock = JSON.parse(
      readFileSync(join(starterDirectory, "package-lock.json"), "utf8"),
    );
    expect(lock.packages[""].dependencies["@thallylabs/core"]).toBe("^0.2.3");
    expect(lock.packages["node_modules/@thallylabs/core"].version).toBe(
      "0.2.3",
    );
  });

  it("rejects a stale dependency lock even when package metadata is current", () => {
    const runtime = createRuntime();
    const starterDirectory = createStarter(runtime);
    syncStarterRuntimeContract({
      starterDirectory,
      runtimeDirectory: runtime.directory,
      refreshLockfile: writeCoreLock,
    });
    writeCoreLock(starterDirectory, {
      version: "0.2.2",
      constraint: "^0.2.3",
    });

    expect(
      checkStarterRuntimeContract({
        starterDirectory,
        runtimeDirectory: runtime.directory,
      }).differences,
    ).toContain(
      "package-lock.json resolves @thallylabs/core 0.2.2, expected 0.2.3",
    );
  });

  it("rejects ownership rules that can escape or ambiguously expand", () => {
    const runtime = createRuntime();
    const starterDirectory = createStarter(runtime, ["../**"]);

    expect(() =>
      checkStarterRuntimeContract({
        starterDirectory,
        runtimeDirectory: runtime.directory,
      }),
    ).toThrow("escapes the repository");
  });

  it("rejects a safe but unauthorized expansion of runtime ownership", () => {
    const runtime = createRuntime();
    const starterDirectory = createStarter(runtime, [
      ...FRAMEWORK_SYNC_ELIGIBLE,
      "src/content/**",
    ]);

    expect(() =>
      checkStarterRuntimeContract({
        starterDirectory,
        runtimeDirectory: runtime.directory,
      }),
    ).toThrow("canonical contract");
  });

  it("refuses to snapshot uncommitted runtime files", () => {
    const runtime = createRuntime();
    const starterDirectory = createStarter(runtime);
    write(
      runtime.directory,
      "src/lib/uncommitted.ts",
      "export const dirty = true\n",
    );

    expect(() =>
      syncStarterRuntimeContract({
        starterDirectory,
        runtimeDirectory: runtime.directory,
      }),
    ).toThrow("dirty runtime checkout");
  });

  it("refuses to write through a symbolic-link ancestor", () => {
    const runtime = createRuntime();
    const starterDirectory = createStarter(runtime);
    const externalDirectory = temporaryDirectory("thally-external");
    rmSync(join(starterDirectory, "src"), { force: true, recursive: true });
    symlinkSync(externalDirectory, join(starterDirectory, "src"));

    expect(() =>
      syncStarterRuntimeContract({
        starterDirectory,
        runtimeDirectory: runtime.directory,
      }),
    ).toThrow("symbolic-link ancestor");
  });
});


/** Exercise the actual CLI boundary: exported fixture generation is internal. */
describe("canonical generator CLI destination", () => {
  function invoke(command: "sync" | "check", origin?: string, repository?: string, nested = false) {
    const runtime = createRuntime();
    const starter = createStarter(runtime);
    if (origin !== undefined) {
      execFileSync("git", ["init", "-q"], { cwd: starter });
      if (origin) execFileSync("git", ["remote", "add", "origin", origin], { cwd: starter });
    }
    // Accepted destinations reach this independent safety check, without
    // installing packages or modifying any framework/provenance bytes.
    write(runtime.directory, "dirty-marker", "dirty\n");
    const before = readFileSync(join(starter, "starter-release.json"), "utf8");
    const env = { ...process.env };
    delete env.GITHUB_ACTIONS;
    delete env.GITHUB_REPOSITORY;
    if (repository) {
      env.GITHUB_ACTIONS = "true";
      env.GITHUB_REPOSITORY = repository;
    }
    const result = spawnSync(process.execPath, [
      resolve(".github/scripts/starter-runtime-contract.mjs"), command,
      "--starter-dir", nested ? join(starter, "src") : starter,
      "--runtime-dir", runtime.directory,
    ], { env, encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(readFileSync(join(starter, "starter-release.json"), "utf8")).toBe(before);
    expect(readFileSync(join(starter, "src/components/top-bar.tsx"), "utf8")).toContain("48");
    return result.stderr;
  }

  it("rejects an old customer workflow before snapshot mutation", () => {
    expect(invoke("sync", "https://github.com/thallylabs/starter.git", "customer/docs"))
      .toContain("restricted to thallylabs/starter");
  });

  it.each([
    "https://github.com/customer/docs.git",
    "git@github.com:customer/docs.git",
    "https://github.com/thallylabs/starter-imposter.git",
    "https://github.com.attacker.example/thallylabs/starter.git",
    "https://attacker.example/thallylabs/starter.git",
  ])("rejects noncanonical origin %s", origin => {
    expect(invoke("sync", origin)).toContain("restricted to thallylabs/starter");
  });

  it.each([
    "https://github.com/thallylabs/starter.git",
    "git@github.com:thallylabs/starter.git",
    "ssh://git@github.com/thallylabs/starter.git",
  ])("accepts the exact canonical origin %s without mutation", origin => {
    expect(invoke("sync", origin)).toContain("dirty runtime checkout");
  });

  it("accepts canonical Actions generation while retaining runtime validation", () => {
    expect(invoke("sync", "https://github.com/thallylabs/starter.git", "thallylabs/starter"))
      .toContain("dirty runtime checkout");
  });

  it("rejects Git-backed targets without an origin", () => {
    expect(invoke("sync", "")).toContain("restricted to thallylabs/starter");
  });

  it("rejects nested targets even inside the canonical repository", () => {
    expect(invoke("sync", "https://github.com/thallylabs/starter.git", undefined, true))
      .toContain("restricted to thallylabs/starter");
  });

  it("permits plain local fixture trees while retaining runtime validation", () => {
    expect(invoke("sync")).toContain("dirty runtime checkout");
  });

  it("keeps read-only checks available to customer workflows", () => {
    expect(invoke("check", "https://github.com/customer/docs.git", "customer/docs"))
      .not.toContain("restricted to thallylabs/starter");
  });
});
