/** Safe structural three-way merges for owner-reviewed starter configuration.
 * Arrays and overlapping edits stay atomic; JSON pointers report conflicts. */
import { isDeepStrictEqual } from "node:util";

/** File-level and JSON-pointer conflict details without customer file contents. */
export interface StarterManualConflict { path: string; fields: string[] }

/** Complete resolved writes and deletions, or conflicts requiring owner review. */
export interface ManualReviewMutations {
  writeFiles: Map<string, Buffer>;
  deletePaths: Array<string>;
  conflicts: Array<StarterManualConflict>;
}

const STRUCTURED_MANUAL_REVIEW_PATHS = new Set([
  "package.json",
  "package-lock.json",
]);
const MISSING_JSON_VALUE = Symbol("missing-json-value");

type JsonValue =
  | null
  | boolean
  | number
  | string
  | Array<JsonValue>
  | { [key: string]: JsonValue };
type JsonMergeValue = JsonValue | typeof MISSING_JSON_VALUE;

interface JsonMergeResult {
  value: JsonMergeValue;
  conflicts: Array<string>;
}

function hasSameBytes(left: Buffer | undefined, right: Buffer | undefined) {
  if (!left || !right) return left === right;
  return left.equals(right);
}

function isJsonObject(
  value: JsonMergeValue,
): value is { [key: string]: JsonValue } {
  return (
    value !== MISSING_JSON_VALUE &&
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value)
  );
}

function escapeJsonPointerSegment(segment: string): string {
  return segment.replaceAll("~", "~0").replaceAll("/", "~1");
}

function childJsonPointer(pointer: string, segment: string): string {
  return `${pointer}/${escapeJsonPointerSegment(segment)}`;
}

function sameJsonValue(left: JsonMergeValue, right: JsonMergeValue): boolean {
  if (left === MISSING_JSON_VALUE || right === MISSING_JSON_VALUE) {
    return left === right;
  }
  return isDeepStrictEqual(left, right);
}

/**
 * Three-way merge JSON values while treating arrays as atomic values.
 *
 * Package manifests are maps whose independently edited keys can merge safely.
 * Arrays retain ordinary three-way semantics because combining two reordered
 * dependency lists would invent an order that neither side reviewed.
 */
function mergeJsonValue(
  previous: JsonMergeValue,
  downstream: JsonMergeValue,
  target: JsonMergeValue,
  pointer = "",
): JsonMergeResult {
  if (sameJsonValue(downstream, target)) {
    return { value: downstream, conflicts: [] };
  }
  if (sameJsonValue(previous, target)) {
    return { value: downstream, conflicts: [] };
  }
  if (sameJsonValue(previous, downstream)) {
    return { value: target, conflicts: [] };
  }

  if (
    isJsonObject(previous) &&
    isJsonObject(downstream) &&
    isJsonObject(target)
  ) {
    const keys = Array.from(
      new Set([
        ...Object.keys(downstream),
        ...Object.keys(target),
        ...Object.keys(previous),
      ]),
    );
    const entries: Array<[string, JsonValue]> = [];
    const conflicts: Array<string> = [];

    for (const key of keys) {
      const merged = mergeJsonValue(
        Object.hasOwn(previous, key) ? previous[key] : MISSING_JSON_VALUE,
        Object.hasOwn(downstream, key) ? downstream[key] : MISSING_JSON_VALUE,
        Object.hasOwn(target, key) ? target[key] : MISSING_JSON_VALUE,
        childJsonPointer(pointer, key),
      );
      conflicts.push(...merged.conflicts);
      if (merged.value !== MISSING_JSON_VALUE) {
        entries.push([key, merged.value]);
      }
    }

    return { value: Object.fromEntries(entries), conflicts };
  }

  return { value: downstream, conflicts: [pointer || "/"] };
}

function mergeStructuredManualReviewFile(input: {
  previous: Buffer;
  downstream: Buffer;
  target: Buffer;
}): { content?: Buffer; conflicts: Array<string> } {
  try {
    const previous = JSON.parse(input.previous.toString("utf8")) as JsonValue;
    const downstream = JSON.parse(
      input.downstream.toString("utf8"),
    ) as JsonValue;
    const target = JSON.parse(input.target.toString("utf8")) as JsonValue;
    const merged = mergeJsonValue(previous, downstream, target);
    if (merged.conflicts.length > 0 || merged.value === MISSING_JSON_VALUE) {
      return { conflicts: merged.conflicts };
    }
    return {
      content: Buffer.from(`${JSON.stringify(merged.value, null, 2)}\n`),
      conflicts: [],
    };
  } catch {
    // Invalid JSON is owner-authored state. Never rewrite it based on a
    // partially parsed document; report the file for explicit review.
    return { conflicts: ["/"] };
  }
}

/**
 * Resolve manual-review files without silently overwriting downstream work.
 *
 * Package manifests and lockfiles sit outside the hidden runtime ownership
 * surface. Their object keys have independent ownership, so non-overlapping
 * JSON edits merge structurally: a customer package name survives while a
 * framework dependency advances. Same-field edits and every unstructured
 * manual-review file remain fail-closed.
 */
export function resolveManualReviewMutations(
  paths: readonly string[],
  downstreamFiles: ReadonlyMap<string, Buffer>,
  previousReleaseFiles: ReadonlyMap<string, Buffer>,
  targetReleaseFiles: ReadonlyMap<string, Buffer>,
): ManualReviewMutations {
  const mutations: ManualReviewMutations = {
    writeFiles: new Map(),
    deletePaths: [],
    conflicts: [],
  };

  for (const path of paths) {
    const downstream = downstreamFiles.get(path);
    const previous = previousReleaseFiles.get(path);
    const target = targetReleaseFiles.get(path);

    if (hasSameBytes(previous, target) || hasSameBytes(downstream, target)) {
      continue;
    }
    if (hasSameBytes(downstream, previous)) {
      if (target) mutations.writeFiles.set(path, target);
      else mutations.deletePaths.push(path);
      continue;
    }

    if (
      STRUCTURED_MANUAL_REVIEW_PATHS.has(path) &&
      downstream &&
      previous &&
      target
    ) {
      const merged = mergeStructuredManualReviewFile({
        previous,
        downstream,
        target,
      });
      if (merged.content) {
        if (!hasSameBytes(downstream, merged.content)) {
          mutations.writeFiles.set(path, merged.content);
        }
        continue;
      }
      mutations.conflicts.push({ path, fields: merged.conflicts });
      continue;
    }

    mutations.conflicts.push({ path, fields: [] });
  }

  return mutations;
}

