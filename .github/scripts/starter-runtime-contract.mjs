/**
 * Synchronize and verify the runtime-owned portion of `thallylabs/starter`.
 *
 * Runtime files are authored only in `thally`. The starter keeps a vendored
 * snapshot so every generated site is standalone, but that snapshot must be
 * produced by this command and must match the exact runtime commit pinned by
 * `starter-release.json` byte-for-byte.
 */

import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const MANIFEST_PATH = "starter-release.json";
const EXPECTED_STARTER_REPOSITORY = "thallylabs/starter";
const EXPECTED_RUNTIME_REPOSITORY = "thallylabs/thally";
const CORE_PACKAGE_NAME = "@thallylabs/core";
const CORE_PACKAGE_PATH = "packages/core/package.json";
const STARTER_PACKAGE_PATH = "package.json";
const STARTER_LOCK_PATH = "package-lock.json";
const SHA_1 = /^[0-9a-f]{40}$/;
const STABLE_SEMVER = /^\d+\.\d+\.\d+$/;

// This is the authoritative runtime ownership boundary. The starter manifest
// carries a generated copy for update tooling, but may not broaden the set of
// files that synchronization can overwrite.
export const FRAMEWORK_SYNC_ELIGIBLE = Object.freeze([
  "BUILD-WARNINGS.md",
  "src/app/**",
  "src/cloud/**",
  "src/components/**",
  "src/config/**",
  "src/data/api-reference.ts",
  "src/data/docs.ts",
  "src/data/get-doc.ts",
  "src/data/manual-api.ts",
  "src/lib/**",
  "src/mdx/rehype.ts",
  "src/mdx/rehype.test.ts",
  "src/mdx/__tests__/test-html.ts",
  "src/mdx/remark.ts",
  "src/mdx/snippet-registry.ts",
  "src/styles/**",
  "src/test/**",
  "src/middleware.ts",
  "mdx-components.tsx",
  "tailwind.config.ts",
  "starter-release.json",
  "scripts/agent-readiness.ts",
  "scripts/build-cloudflare.mts",
  "scripts/build-embeddings.ts",
  "scripts/build-runtime-sources.mts",
  "scripts/lib/**",
  "scripts/check-cloudflare-worker-size.mts",
  "scripts/smoke-cloudflare.mts",
  "scripts/mint-reader-token.ts",
]);

// These tests intentionally inspect the public monorepo and its independently
// published packages. They remain in `thally`; the standalone starter cannot
// execute them because it has no `packages/` workspace.
const SOURCE_ONLY_PATHS = new Set([
  "src/lib/__tests__/frontmatter.test.ts",
  "src/lib/__tests__/frontmatter-parity.test.ts",
  "src/components/mdx/client-registry.test.ts",
  "src/components/mdx/steps-toc.test.tsx",
  "src/lib/__tests__/url-migration-runtime-fidelity.test.ts",
  "src/lib/openapi/__tests__/migrate-operation-slug-parity.test.ts",
  "src/lib/openapi/__tests__/migrate-withheld-operations-parity.test.ts",
  "src/lib/openapi/__tests__/publication-check-parity.test.ts",
  // Drives /api/mcp with @modelcontextprotocol/sdk, a packages/mcp dependency.
  "src/app/api/mcp/sdk-client.test.ts",
]);

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function inside(rootDirectory, projectPath) {
  invariant(
    projectPath &&
      !projectPath.startsWith("/") &&
      !projectPath.includes("\\") &&
      !projectPath.includes("\0"),
    `Unsafe runtime ownership path: ${projectPath}`,
  );
  const destination = resolve(rootDirectory, projectPath);
  const relativePath = relative(resolve(rootDirectory), destination);
  invariant(
    relativePath &&
      relativePath !== ".." &&
      !relativePath.startsWith(`..${sep}`),
    `Runtime ownership path escapes the repository: ${projectPath}`,
  );
  return destination;
}

function parseRule(rule) {
  invariant(
    typeof rule === "string",
    "Runtime ownership rules must be strings.",
  );
  if (rule.endsWith("/**")) {
    const projectPath = rule.slice(0, -3);
    invariant(
      projectPath && !projectPath.includes("*"),
      `Unsupported runtime ownership rule: ${rule}`,
    );
    return { kind: "directory", projectPath };
  }
  invariant(!rule.includes("*"), `Unsupported runtime ownership rule: ${rule}`);
  return { kind: "file", projectPath: rule };
}

function readManifest(starterDirectory, { allowOwnershipDrift = false } = {}) {
  const manifestPath = inside(starterDirectory, MANIFEST_PATH);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  invariant(
    manifest.schemaVersion === 1,
    "Unsupported starter release schema.",
  );
  invariant(
    manifest.repository === EXPECTED_STARTER_REPOSITORY,
    "Unexpected starter repository.",
  );
  invariant(
    manifest.runtime?.repository === EXPECTED_RUNTIME_REPOSITORY,
    "Unexpected runtime repository.",
  );
  invariant(
    Array.isArray(manifest.ownership?.frameworkSyncEligible),
    "starter-release.json is missing frameworkSyncEligible.",
  );
  for (const rawRule of manifest.ownership.frameworkSyncEligible) {
    const rule = parseRule(rawRule);
    inside(starterDirectory, rule.projectPath);
  }
  if (!allowOwnershipDrift) {
    invariant(
      JSON.stringify(manifest.ownership.frameworkSyncEligible) ===
        JSON.stringify(FRAMEWORK_SYNC_ELIGIBLE),
      "starter-release.json runtime ownership does not match the canonical contract.",
    );
  }
  return { manifest, manifestPath };
}

function gitValue(runtimeDirectory, format) {
  return execFileSync(
    "git",
    ["-C", runtimeDirectory, "show", "-s", `--format=${format}`, "HEAD"],
    {
      encoding: "utf8",
    },
  ).trim();
}

function runtimeIdentity(runtimeDirectory) {
  const commitSha = gitValue(runtimeDirectory, "%H");
  const treeSha = gitValue(runtimeDirectory, "%T");
  invariant(
    SHA_1.test(commitSha) && SHA_1.test(treeSha),
    "Runtime checkout has an invalid Git identity.",
  );
  return { commitSha, treeSha };
}

function runtimeCoreIdentity(runtimeDirectory) {
  const packagePath = inside(runtimeDirectory, CORE_PACKAGE_PATH);
  const manifest = JSON.parse(readFileSync(packagePath, "utf8"));
  invariant(
    manifest.name === CORE_PACKAGE_NAME && STABLE_SEMVER.test(manifest.version),
    `${CORE_PACKAGE_PATH} has an invalid publishable identity.`,
  );
  return { version: manifest.version, constraint: `^${manifest.version}` };
}

function readStarterPackage(starterDirectory) {
  const packagePath = inside(starterDirectory, STARTER_PACKAGE_PATH);
  const manifest = JSON.parse(readFileSync(packagePath, "utf8"));
  invariant(
    manifest.dependencies && typeof manifest.dependencies === "object",
    `${STARTER_PACKAGE_PATH} is missing dependencies.`,
  );
  return { manifest, packagePath };
}

function readStarterLock(starterDirectory) {
  const lockPath = inside(starterDirectory, STARTER_LOCK_PATH);
  const manifest = JSON.parse(readFileSync(lockPath, "utf8"));
  invariant(
    manifest.packages && typeof manifest.packages === "object",
    `${STARTER_LOCK_PATH} is missing package entries.`,
  );
  return manifest;
}

function assertCleanRuntimeCheckout(runtimeDirectory) {
  const status = execFileSync(
    "git",
    ["-C", runtimeDirectory, "status", "--porcelain", "--untracked-files=all"],
    { encoding: "utf8" },
  ).trim();
  invariant(
    !status,
    "Refusing to generate starter from a dirty runtime checkout.",
  );
}

function assertNoSymlinks(candidate, label) {
  if (!existsSync(candidate)) return;
  const stats = lstatSync(candidate);
  invariant(!stats.isSymbolicLink(), `${label} contains a symbolic link.`);
  if (!stats.isDirectory()) return;
  for (const entry of readdirSync(candidate)) {
    assertNoSymlinks(resolve(candidate, entry), label);
  }
}

function assertNoSymlinkAncestors(rootDirectory, projectPath) {
  const segments = projectPath.split("/");
  let candidate = resolve(rootDirectory);
  for (const segment of segments.slice(0, -1)) {
    candidate = resolve(candidate, segment);
    if (!existsSync(candidate)) return;
    const stats = lstatSync(candidate);
    invariant(
      !stats.isSymbolicLink(),
      `${projectPath} has a symbolic-link ancestor.`,
    );
    invariant(
      stats.isDirectory(),
      `${projectPath} has a non-directory ancestor.`,
    );
  }
}

function listFiles(rootDirectory, projectPath) {
  const absolute = inside(rootDirectory, projectPath);
  if (!existsSync(absolute)) return [];
  const stats = lstatSync(absolute);
  invariant(
    !stats.isSymbolicLink(),
    `${projectPath} contains a symbolic link.`,
  );
  if (stats.isFile()) return [projectPath];
  invariant(
    stats.isDirectory(),
    `${projectPath} has an unsupported file type.`,
  );
  return readdirSync(absolute, { withFileTypes: true })
    .flatMap((entry) => {
      const child = `${projectPath}/${entry.name}`;
      invariant(!entry.isSymbolicLink(), `${child} contains a symbolic link.`);
      return entry.isDirectory() ? listFiles(rootDirectory, child) : [child];
    })
    .sort();
}

function fileMode(filePath) {
  return statSync(filePath).mode & 0o111;
}

function isSourceOnlyPath(projectPath) {
  return SOURCE_ONLY_PATHS.has(projectPath);
}

function comparePath(starterDirectory, runtimeDirectory, projectPath) {
  const starterPath = inside(starterDirectory, projectPath);
  const runtimePath = inside(runtimeDirectory, projectPath);
  if (!existsSync(runtimePath))
    return existsSync(starterPath)
      ? [`${projectPath} exists only in starter`]
      : [];
  if (!existsSync(starterPath))
    return [`${projectPath} is missing from starter`];
  const starterStats = lstatSync(starterPath);
  const runtimeStats = lstatSync(runtimePath);
  if (starterStats.isSymbolicLink() || runtimeStats.isSymbolicLink()) {
    return [`${projectPath} must not be a symbolic link`];
  }
  if (starterStats.isDirectory() !== runtimeStats.isDirectory()) {
    return [`${projectPath} has a different file type`];
  }
  if (runtimeStats.isDirectory()) return [];
  const differences = [];
  if (!readFileSync(starterPath).equals(readFileSync(runtimePath)))
    differences.push(`${projectPath} bytes differ`);
  if (fileMode(starterPath) !== fileMode(runtimePath))
    differences.push(`${projectPath} executable mode differs`);
  return differences;
}

function ownedPaths(starterDirectory, runtimeDirectory, rules) {
  const paths = new Set();
  for (const rawRule of rules) {
    const rule = parseRule(rawRule);
    if (rule.projectPath === MANIFEST_PATH) continue;
    inside(starterDirectory, rule.projectPath);
    inside(runtimeDirectory, rule.projectPath);
    if (rule.kind === "file") {
      paths.add(rule.projectPath);
      continue;
    }
    for (const projectPath of listFiles(starterDirectory, rule.projectPath))
      paths.add(projectPath);
    for (const projectPath of listFiles(runtimeDirectory, rule.projectPath))
      paths.add(projectPath);
  }
  return [...paths].sort();
}

/** Check that starter runtime files and provenance match one exact runtime checkout. */
export function checkStarterRuntimeContract({
  starterDirectory,
  runtimeDirectory,
}) {
  const starterRoot = resolve(starterDirectory);
  const runtimeRoot = resolve(runtimeDirectory);
  const { manifest } = readManifest(starterRoot);
  const identity = runtimeIdentity(runtimeRoot);
  const expectedCore = runtimeCoreIdentity(runtimeRoot);
  const { manifest: starterPackage } = readStarterPackage(starterRoot);
  const starterLock = readStarterLock(starterRoot);
  const differences = [];
  if (manifest.runtime.commitSha !== identity.commitSha) {
    differences.push(
      `starter-release.json pins ${manifest.runtime.commitSha}, expected ${identity.commitSha}`,
    );
  }
  if (manifest.runtime.treeSha !== identity.treeSha) {
    differences.push(
      `starter-release.json pins tree ${manifest.runtime.treeSha}, expected ${identity.treeSha}`,
    );
  }
  if (manifest.packages?.[CORE_PACKAGE_NAME] !== expectedCore.constraint) {
    differences.push(
      `starter-release.json pins ${CORE_PACKAGE_NAME} ${manifest.packages?.[CORE_PACKAGE_NAME] ?? "nothing"}, expected ${expectedCore.constraint}`,
    );
  }
  if (
    starterPackage.dependencies[CORE_PACKAGE_NAME] !== expectedCore.constraint
  ) {
    differences.push(
      `${STARTER_PACKAGE_PATH} pins ${CORE_PACKAGE_NAME} ${starterPackage.dependencies[CORE_PACKAGE_NAME] ?? "nothing"}, expected ${expectedCore.constraint}`,
    );
  }
  if (
    starterLock.packages[""]?.dependencies?.[CORE_PACKAGE_NAME] !==
    expectedCore.constraint
  ) {
    differences.push(
      `${STARTER_LOCK_PATH} root pins ${CORE_PACKAGE_NAME} ${starterLock.packages[""]?.dependencies?.[CORE_PACKAGE_NAME] ?? "nothing"}, expected ${expectedCore.constraint}`,
    );
  }
  if (
    starterLock.packages[`node_modules/${CORE_PACKAGE_NAME}`]?.version !==
    expectedCore.version
  ) {
    differences.push(
      `${STARTER_LOCK_PATH} resolves ${CORE_PACKAGE_NAME} ${starterLock.packages[`node_modules/${CORE_PACKAGE_NAME}`]?.version ?? "nothing"}, expected ${expectedCore.version}`,
    );
  }
  for (const projectPath of ownedPaths(
    starterRoot,
    runtimeRoot,
    manifest.ownership.frameworkSyncEligible,
  )) {
    if (isSourceOnlyPath(projectPath)) {
      if (existsSync(inside(starterRoot, projectPath))) {
        differences.push(`${projectPath} is source-only but exists in starter`);
      }
      continue;
    }
    differences.push(...comparePath(starterRoot, runtimeRoot, projectPath));
  }
  return { differences, identity };
}

/** Replace starter's generated runtime snapshot and update its immutable pin. */
export function syncStarterRuntimeContract({
  starterDirectory,
  runtimeDirectory,
  refreshLockfile = refreshStarterLockfile,
}) {
  const starterRoot = resolve(starterDirectory);
  const runtimeRoot = resolve(runtimeDirectory);
  assertCleanRuntimeCheckout(runtimeRoot);
  const { manifest, manifestPath } = readManifest(starterRoot, {
    allowOwnershipDrift: true,
  });
  const expectedCore = runtimeCoreIdentity(runtimeRoot);
  const { manifest: starterPackage, packagePath: starterPackagePath } =
    readStarterPackage(starterRoot);
  manifest.ownership.frameworkSyncEligible = [...FRAMEWORK_SYNC_ELIGIBLE];
  const identity = runtimeIdentity(runtimeRoot);
  const rules = FRAMEWORK_SYNC_ELIGIBLE.map(parseRule);

  for (const rule of rules) {
    if (rule.projectPath === MANIFEST_PATH) continue;
    const source = inside(runtimeRoot, rule.projectPath);
    const destination = inside(starterRoot, rule.projectPath);
    assertNoSymlinks(source, rule.projectPath);
    assertNoSymlinkAncestors(starterRoot, rule.projectPath);
    rmSync(destination, { force: true, recursive: true });
    if (isSourceOnlyPath(rule.projectPath)) continue;
    if (!existsSync(source)) continue;
    const stats = lstatSync(source);
    if (stats.isDirectory()) {
      mkdirSync(destination, { recursive: true });
      for (const projectPath of listFiles(runtimeRoot, rule.projectPath)) {
        if (isSourceOnlyPath(projectPath)) continue;
        const sourceFile = inside(runtimeRoot, projectPath);
        const destinationFile = inside(starterRoot, projectPath);
        mkdirSync(dirname(destinationFile), { recursive: true });
        copyFileSync(sourceFile, destinationFile);
        chmodSync(destinationFile, statSync(sourceFile).mode);
      }
    } else {
      mkdirSync(dirname(destination), { recursive: true });
      copyFileSync(source, destination);
      chmodSync(destination, stats.mode);
    }
  }

  manifest.runtime = {
    repository: EXPECTED_RUNTIME_REPOSITORY,
    commitSha: identity.commitSha,
    treeSha: identity.treeSha,
  };
  manifest.packages = {
    ...manifest.packages,
    [CORE_PACKAGE_NAME]: expectedCore.constraint,
  };
  starterPackage.dependencies[CORE_PACKAGE_NAME] = expectedCore.constraint;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  writeFileSync(
    starterPackagePath,
    `${JSON.stringify(starterPackage, null, 2)}\n`,
    "utf8",
  );
  refreshLockfile(starterRoot, expectedCore);

  const result = checkStarterRuntimeContract({
    starterDirectory: starterRoot,
    runtimeDirectory: runtimeRoot,
  });
  invariant(
    result.differences.length === 0,
    `Runtime synchronization failed:\n${result.differences.join("\n")}`,
  );
  return result;
}

function refreshStarterLockfile(starterDirectory) {
  execFileSync(
    "npm",
    [
      "install",
      "--package-lock-only",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
    ],
    { cwd: resolve(starterDirectory), stdio: "inherit" },
  );
}

function readCliArguments(argv) {
  const [command, ...rest] = argv;
  invariant(
    command === "check" || command === "sync",
    "Usage: starter-runtime-contract.mjs <check|sync> --starter-dir <path> --runtime-dir <path>",
  );
  const values = {};
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index];
    const value = rest[index + 1];
    invariant(
      (key === "--starter-dir" || key === "--runtime-dir") && value,
      "Invalid runtime contract arguments.",
    );
    values[key.slice(2)] = value;
  }
  invariant(
    values["starter-dir"] && values["runtime-dir"],
    "Both --starter-dir and --runtime-dir are required.",
  );
  return {
    command,
    starterDirectory: values["starter-dir"],
    runtimeDirectory: values["runtime-dir"],
  };
}

/** Resolve only GitHub HTTPS/SSH origins; lookalike hosts and paths fail closed. */
function isCanonicalStarterOrigin(origin) {
  const scp = /^git@github\.com:([^?#]+)$/i.exec(origin);
  let repositoryPath;
  if (scp) {
    repositoryPath = scp[1];
  } else {
    let url;
    try {
      url = new URL(origin);
    } catch {
      return false;
    }
    if (
      !["https:", "ssh:"].includes(url.protocol) ||
      url.hostname.toLowerCase() !== "github.com" ||
      url.port || url.search || url.hash ||
      (url.protocol === "ssh:" && url.username !== "git")
    ) return false;
    repositoryPath = url.pathname.slice(1);
  }
  return repositoryPath.replace(/\/$/, "").replace(/\.git$/i, "").toLowerCase() === EXPECTED_STARTER_REPOSITORY;
}

/**
 * Customer copies must use promoted releases, not the destructive generator.
 * This CLI guard also protects older copied workflows fetching current public
 * code. Internal programmatic generation remains available for verified fixtures.
 */
function assertCanonicalSyncTarget(starterDirectory) {
  const message = "Runtime snapshot generation is restricted to thallylabs/starter. Customer repositories must use thally starter update.";
  if (process.env.GITHUB_ACTIONS === "true" || process.env.GITHUB_REPOSITORY) {
    invariant(process.env.GITHUB_REPOSITORY === EXPECTED_STARTER_REPOSITORY, message);
  }
  const target = realpathSync(resolve(starterDirectory));
  let topLevel;
  try {
    topLevel = execFileSync("git", ["-C", target, "rev-parse", "--show-toplevel"], {
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    // Plain temporary trees support local fixture generation. A broken Git
    // checkout or unavailable Git executable must never masquerade as one.
    invariant(String(error.stderr ?? "").includes("not a git repository"), message);
    for (let parent = target; ; parent = dirname(parent)) {
      invariant(!existsSync(resolve(parent, ".git")), message);
      if (dirname(parent) === parent) break;
    }
    invariant(process.env.GITHUB_ACTIONS !== "true" && !process.env.GITHUB_REPOSITORY, message);
    return;
  }
  invariant(realpathSync(topLevel) === target, message);
  let origin;
  try {
    origin = execFileSync("git", ["-C", target, "remote", "get-url", "origin"], {
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    throw new Error(message);
  }
  invariant(isCanonicalStarterOrigin(origin), message);
}

async function main() {
  const input = readCliArguments(process.argv.slice(2));
  if (input.command === "sync") {
    assertCanonicalSyncTarget(input.starterDirectory);
    syncStarterRuntimeContract(input);
    console.info("Synchronized starter runtime snapshot.");
    return;
  }
  const result = checkStarterRuntimeContract(input);
  if (result.differences.length > 0) {
    throw new Error(
      `Starter runtime snapshot is out of sync:\n- ${result.differences.join("\n- ")}`,
    );
  }
  console.info(
    `Starter runtime snapshot matches ${result.identity.commitSha}.`,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
