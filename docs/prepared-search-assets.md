# Prepared search content contract

Managed full builds use the public canonical MDX parser and
`@thallylabs/core/search`'s `projectSearchContent` to emit content-only search
records. This avoids reading and parsing every MDX file on the first search.
The filesystem backend and ordinary canonical document reads remain available.
This contract does not raise hosting CPU, memory, or subrequest limits.

The public build owns parsing and projection. A publisher may copy immutable
prepared assets and update raw source hashes; it must not implement another
MDX parser. All derived files live beneath the existing protected
`/_thally/content/` namespace. Direct HTTP requests to that namespace return
404, including when a shard contains reader-restricted content.

The version-1 content manifest remains backward compatible. New fields are
optional:

```json
{
  "version": 1,
  "files": {
    "src/content/guide.mdx": {
      "modifiedAtMs": 123,
      "sha256": "<lowercase SHA-256 of exact raw UTF-8 file bytes>",
      "searchShard": 0
    }
  },
  "search": {
    "version": 1,
    "shards": [
      {
        "path": "search/0000.json",
        "sha256": "<lowercase SHA-256 of exact shard UTF-8 bytes>",
        "bytes": 1234
      }
    ]
  }
}
```

Each shard has this envelope:

```json
{
  "version": 1,
  "format": "thally-search-content-v1",
  "records": {
    "src/content/guide.mdx": {
      "sha256": "<exact raw source SHA-256>",
      "content": {
        "headings": "Introduction · Usage",
        "body": "Canonical agent-visible prose, at most 4000 JS characters.",
        "sections": [{"id": "usage", "title": "Usage", "text": "At most 2000 JS characters per section."}]
      }
    }
  }
}
```

Increment `PREPARED_SEARCH_FORMAT` when canonical parsing or projection semantics
change. Readers reject unknown versions, invalid schemas, mismatched byte counts
or hashes, and unsafe descriptor paths. Shards use ordinal paths matching their
descriptor-array index, contain at most 1 MiB each, and number at most 256.
An oversized individual record is left unprepared rather than truncated further.
An empty prepared corpus omits the descriptor.

Current manifest membership and the exact selected physical source SHA must
match before a record is used. Locale candidates use the same precedence as
ordinary document reads. Current anonymous reader access, publication state,
version, translation eligibility, title, description, keywords, and href are
resolved by the ordinary runtime listing; prepared records supply none of them.

On content-only upsert, hash the actual new bytes, remove the changed entry's
`searchShard`, and preserve the top-level descriptor and unchanged entries.
Remove deleted entries from membership. A full content replacement must either
carry a newly verified prepared tree or omit the descriptor and all old
affinities. Missing, stale, incompatible, or corrupt derived data uses canonical
parsing. Consequently a large replacement without preparation is not a promise
of cold-search capacity; a full build prepares the new corpus.

Transient transfer failures reject the corpus build and clear failed attempts;
they must not silently omit pages or pin a partial index. Prepared reads share
the ordinary four transfer slots per Cloudflare invocation through body consumption
and hash verification. Non-Cloudflare hosts retain one shared four-slot queue.
Queues never transfer a promise resolver between Worker invocations; immutable
settled cache values remain release-scoped.
Bodies are bounded before JSON parsing. Pending work coalesces per immutable
release; settled decoded shards use a 128-entry, approximately 16 MiB retained
payload cache. Those are cache ownership limits, not guarantees about total
isolate heap or concurrent request capacity.
