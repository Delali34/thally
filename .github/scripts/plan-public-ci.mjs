/**
 * Keep broad tests for every runtime, contract, dependency, or unknown change.
 * Only known prose and static image files use content validation; every plan
 * still builds the managed artifact so authored MDX is compiled and packaged.
 */
import { appendFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

/** Return a fail-closed plan from the complete changed-path set. */
export function createPublicCiPlan(paths) {
  const content = paths.length > 0 && paths.every((path) =>
    /^src\/content\/.+\.mdx?$/.test(path) ||
    /^public\/.+\.(?:avif|gif|ico|jpe?g|png|svg|webp)$/.test(path) ||
    /^(?:README|CHANGELOG)\.md$/.test(path));
  return { full: !content, mode: content ? "content" : "full", changedCount: paths.length };
}

/** An unavailable or malformed comparison must never select the cheap path. */
export function changedPaths(baseSha, run = execFileSync) {
  if (!/^[a-f0-9]{40}$/i.test(baseSha)) return [];
  try {
    return run("git", ["diff", "--name-only", "--no-renames", "-z", `${baseSha}...HEAD`],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).split("\0").filter(Boolean);
  } catch { return []; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const plan = createPublicCiPlan(changedPaths(process.argv[2] ?? ""));
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `full=${plan.full}\nmode=${plan.mode}\n`);
  process.stdout.write(`${JSON.stringify(plan)}\n`);
}
