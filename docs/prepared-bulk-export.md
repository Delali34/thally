# Prepared full-document exports

Managed asset builds prepare `/llms-full.txt` Markdown alongside the canonical
search projection. One call to the public structured-content parser supplies
both forms. The Markdown contains complete agent-visible document content,
including technical payloads, rather than the shorter search text.

The protected index lives at `/_thally/content/bulk/descriptor.json`:

```json
{
  "version": 1,
  "format": "thally-agent-bulk-v1",
  "sourceRevision": "<SHA-256 of sorted [physical path, raw source SHA] lines>",
  "shards": [
    { "path": "bulk/0000.txt", "bytes": 1234, "sha256": "<raw shard SHA-256>" }
  ],
  "records": {
    "src/content/introduction.mdx": {
      "sha256": "<raw authored source SHA-256>",
      "ranges": [{ "shard": 0, "start": 0, "end": 1234 }]
    }
  }
}
```

Each shard is at most 16 MiB; there are at most 256 shards. A larger individual
document spans shards without truncation. Empty Markdown has no ranges. The
index is bounded to 8 MiB and 100,000 physical records. It includes every
current MDX source, including translations and private pages, within the same
HTTP-blocked namespace as raw managed content. Neither the index nor shards
are public download endpoints.

The request still runs the ordinary reader-authentication, current-version,
publication, hidden/noindex, translation and API-operation rules. Prepared
records supply only bytes. Current titles, descriptions, URLs and site identity
come from the existing listing and configuration. Default sidebar order is
preserved even for translated exports, matching the endpoint's existing
behavior. Request metadata never enters a shared authorized-plan cache.

The reader checks the complete current source revision and physical-file SHA
membership before admitting a plan. Physical selection uses the same primary,
locale and `index.mdx` precedence as the document loader. Unsupported index
versions, missing legacy assets and absent native capabilities retain the old
renderer. A valid prepared release whose request navigation order or handoff
metadata budget is incompatible returns an actionable 503 instead of starting
an unbounded export. Rebuild with matching `docs.json`; individual documents
remain available through `llms.txt`.

Cloudflare builds wrap the unmodified OpenNext entry and retain its named
exports. The same GET authorizes a fresh in-process Symbol capability and
returns a marked empty response. The wrapper requires both acceptance and the
successful marker, finishes that response, then streams only authorized byte
ranges outside Next. No HTTP header can grant this capability. Headers retain
the original reader cache policy, language and security settings; placeholder
length, encoding and ETag are removed.

The native stream verifies every selected shard's declared size and SHA before
releasing its final output batch. A `FixedLengthStream` preserves detection of
truncation after headers have been sent. It holds at most two 64 KiB output
batches plus the current source chunk; this payload bound is not a claim about
total isolate heap. Cancellation stops future reads without waiting for a
pending adapter cancellation to settle.

A host that supports content-only publication must treat a release containing
this index as requiring a full build for subsequent content or configuration
changes. Preserving the old index across changed sources invalidates its
revision and cannot preserve the prepared capacity path. Thally Cloud records
the exact observed descriptor SHA in private release metadata and routes those
updates through its normal full builder; it does not duplicate the parser.
