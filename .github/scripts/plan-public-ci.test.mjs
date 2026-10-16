/** Regression coverage for the conservative public CI path policy. */
import assert from "node:assert/strict";
import test from "node:test";
import { changedPaths, createPublicCiPlan } from "./plan-public-ci.mjs";

test("only known prose and static images may omit broad unit tests", () => {
  assert.equal(createPublicCiPlan(["src/content/guides/start.mdx", "public/logo.svg", "README.md"]).full, false);
});
test("runtime, executable content, contracts, dependencies, and unknowns retain full tests", () => {
  for (const path of ["src/content/example.ts", "src/app/page.tsx", "src/lib/cloud-bridge/types.ts",
    "packages/cli/src/index.ts", "docs.json", "openapi.yaml", "package.json", "package-lock.json",
    "public/embed.js", "scripts/build-packages.mjs", ".github/workflows/ci.yml", "schema.json", "unknown.txt"]) {
    assert.equal(createPublicCiPlan(["README.md", path]).full, true, path);
  }
});
test("manual, missing, and unavailable comparisons use full validation", () => {
  assert.equal(createPublicCiPlan([]).full, true);
  assert.deepEqual(changedPaths("not-a-sha"), []);
  assert.deepEqual(changedPaths("0".repeat(40)), []);
});


test("runtime-to-content renames retain both sides of the impact comparison", () => {
  const paths = changedPaths("a".repeat(40), (command, arguments_) => {
    assert.equal(command, "git");
    assert.ok(arguments_.includes("--no-renames"));
    assert.ok(arguments_.includes("-z"));
    return "src/lib/runtime.ts\0src/content/runtime.mdx\0";
  });
  assert.deepEqual(paths, ["src/lib/runtime.ts", "src/content/runtime.mdx"]);
  assert.equal(createPublicCiPlan(paths).full, true);
});
