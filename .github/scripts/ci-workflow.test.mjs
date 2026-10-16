/** Structural regression tests for the single-pass public CI workflow. */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { parse } from "yaml";

const workflow = parse(readFileSync(".github/workflows/ci.yml", "utf8"));

test("CI verifies candidates without repeating on protected-branch pushes", () => {
  assert.deepEqual(workflow.on.pull_request.branches, ["main"]);
  assert.equal(workflow.on.merge_group, null);
  assert.equal(workflow.on.workflow_dispatch, null);
  assert.equal(workflow.on.push, undefined);
});

test("content validation shares the existing checkout and installation", () => {
  const steps = workflow.jobs.verify.steps;
  assert.equal(
    steps.filter((step) => step.name === "Install dependencies").length,
    1,
  );
  assert.ok(steps.some((step) => step.name === "Check authored content"));
});


test("path planning preserves managed build and contract gates for every candidate", () => {
  const steps = workflow.jobs.verify.steps;
  const plan = steps.find((step) => step.id === "plan");
  assert.match(plan.env.BASE_SHA, /pull_request\.base\.sha \|\| github\.event\.merge_group\.base_sha/);
  assert.equal(steps.find((step) => step.name === "Test").if, "steps.plan.outputs.full == 'true'");
  for (const name of ["Build workspace packages", "Check authored content", "Test release handoff boundary", "Build and enforce managed Worker size"]) {
    assert.equal(steps.find((step) => step.name === name).if, undefined, name);
  }
});

test("package compilation reuse is local to this job and never restores package artifacts", () => {
  assert.equal(workflow.jobs.verify.env.THALLY_CI_PACKAGE_BUILD_PROOF, "true");
  assert.ok(workflow.jobs.verify.steps.every((step) => !/download-artifact|actions\/cache/.test(step.uses ?? "")));
});
