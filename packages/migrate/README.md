# `@thallylabs/migrate`

The shared migration engine used by the Thally CLI, MCP server, and Thally
Cloud. It imports documentation repositories and public documentation URLs
into one canonical bundle before any caller writes files.

`runUrlMigration` adds an evidence-bearing, resumable URL path. It accepts a
provider-neutral `captureProvider` (rendered HTML, read-only alternative states,
ordered navigation and binary assets), or uses ordinary local fetching. Hosted
callers must inject their own network-safe text/capture and binary boundaries.
No browser, model, credentials, sandbox or publishing provider is bundled here.

Default page requests advertise HTML to retain rendered content and declared
alternates. An explicit same-origin, same-route Markdown alternate shares the
article's destination; the rendered article takes precedence even when the
Markdown URL was discovered first or restored from an interrupted checkpoint.
Independent pages still report destination collisions.

Server applications should import `@thallylabs/migrate/svg-policy` for the passive
SVG validator, or `@thallylabs/migrate/url-migration` for the URL runner, renderer
and their types. These independent entries avoid tracing repository cloning and
filesystem discovery into application routes. The root entry remains compatible.

`inferUrlMigrationScope` identifies a documentation mount from same-origin declared
indexes and sidebar evidence. New URL runs infer this boundary before discovery;
an explicit `scopePath` remains authoritative. Deep article seeds do not widen a
mounted documentation tree to its marketing origin. Mintlify configuration page
IDs resolve against that mount, while ordinary HTML links keep URL semantics.

Query strings remain part of page identity. A query URL becomes an article alias
only after independent captures prove identical article, metadata, deferred source
and alternative-state content. A section query must name an observed anchor;
query-selected versions, locales and different articles remain separate pages.
The alias keeps its own capture evidence and checked section destination.

Self-contained inline SVGs become passive, hash-addressed assets. An optional
trusted `rasterizeSvg` host callback can replace rejected SVG with bounded PNG;
the engine still checks PNG MIME/signature and records the original SVG digest.
It never relaxes the SVG allowlist or supplies a browser. Hosts must enforce an
isolated, credential-free renderer with no network or page JavaScript.

Complete ARIA-linked tab panels preserve labels and source order, including
surrounding authored content. For known embedded article-source contracts, literal
missing code panels and explicit languages may be recovered only when the source
is referenced by the article and matches its headings, prose, visible examples
and tab labels. Embedded imports and expressions never execute. Unreferenced,
conflicting, incomplete or unsupported alternatives remain review blockers.

The Fumadocs adapter reads bounded JSON-only React Flight frames reachable from
the response's root record. It supports article-owned copy-source references and
literal `Tabs`/`Tab`/`Accordion` children, including loaded disclosure prose,
examples, tables and theme-specific images. It renders a fixed set of static
elements; unknown components, executable markup and unresolved references keep
their review requirement. Languages come only from explicit source declarations;
examples without that metadata remain unlabeled. Source heading IDs and known
Shiki display annotations are recognized for matching while captured code stays
unchanged. A capture provider can supply complete rendered alternatives when a
publisher does not expose a supported inert data contract.

The returned `checkpoint` is JSON-safe. `onRecord` lets a host persist a completed
page before acknowledging it; `onCheckpoint` emits bounded deltas, including
pending discoveries and checkpoint identity fields. Merge delta records by URL,
then pass the reconstructed checkpoint back to resume. Converted page and asset
hashes are checked before reuse, and `reconcile` verifies externally stored
artifacts. Capture adapters should persist raw source/state evidence before
returning an `artifactRef`. `maxCaptures` bounds a continuation; `signal` cancels
capture and returns committed progress. Failed pages retry on resume by default.

Page limits support 1–10,000 pages (default 1,000). This interface limit does not
establish that an arbitrary site can be imported completely. Every inventory
entry has an explicit outcome; pending/failed pages, missing anchors, technical
payload differences, failed asset acquisition and unsupported interactive components
make validation partial. Raster/PDF assets require matching MIME and signatures;
SVG must pass the exported `isPassiveSvg` policy: static drawing elements with
only in-document references, no scripts, external resources, styles or animations.
Rejected SVG and executable downloads are reported for review.
Responsive `picture`/`source`/`img` choices retain their descriptors, media
conditions, sizing and literal alt text. Every candidate is localized; shared
asset URLs are fetched once and identical payloads count once toward the byte
budget, including resumed journals. Complete static tab panels are preserved as
alternatives; empty/lazy panels without verified embedded source still require a capture provider. Complete local
OpenAPI operations can represent only their exact deferred API fields. A known
client-rendered request-example contract may use that registered operation to
regenerate standard language examples; the inline and sidebar slots must be uniquely owned and
captured panels must be complete. For the supported legacy selected-example
component, the selected source, title and language must agree with the exact
root-owned provider inventory. Every authored alternative, including inactive
same-language examples, is retained byte for byte in the registered specification
and rendered by the runtime generator. An unmatched or missing inventory remains
a review blocker. Ordinary language
pickers and ambiguous or unknown slots still require review. Every captured
response, including alternative states, receives the same completeness checks;
the presence of an unrelated state does not excuse a missing panel. Supported native video
and YouTube embeds retain their original public media URLs, recorded in source
warnings; videos are not downloaded. A trusted host may report an original asset
as already absent (HTTP 404/410): its absolute source URL and a warning are
preserved. Timeouts, unsafe downloads and other acquisition errors still block
validation. Observed external redirects remain navigation links; the engine does
not capture their destination sites. External sidebar entries are preserved as
portable sidebar shortcuts.
Observed locale metadata and URL prefixes are projected onto the runtime layout:
primary-language files are unprefixed and secondary-language files retain their
locale prefix. A single-language localized site uses that language as primary.
Missing primary counterparts and projected path collisions require review; the
engine does not invent translations. Fresh HTML captures also observe `html lang`; conflicting or unsupported
language evidence requires review. Capture adapters can supply `locale` when
no language is declared in HTML or identified by the scoped URL path.
The `url-evidence-v7` converter rejects earlier journals: replay retained raw
captures into a new journal rather than relabelling previously hashed pages.
Distinct observed redirect routes can retain their own sidebar titles through
noindex page metadata and portable internal redirects to the captured article.
Conflicting labels on the same route still require review. Markdown image and
link destinations are localized by source spans, including escaped query strings,
without changing matching labels, titles, or fenced examples.

`stopReason` distinguishes a resumable `capture-limit` from hard `page-limit`
or `byte-limit` outcomes. Hosts must not automatically retry a hard limit as an
unfinished capture slice. Discovery indexes drain independently of article caps.
Source validation remains independent of generated-site build/browser checks.
The CLI's programmatic `migrateDocs({ urlMigration: { ... } })` path retains
those source validation results in its migration report.

Repository migration includes dedicated Mintlify and Docusaurus adapters.
Mintlify repositories are located inside monorepos automatically. Their
`docs.json`/`mint.json` page and group trees are projected without flattening
authored nesting or order. The adapter supports tabs, dropdowns, products,
versions, languages, and reusable `$ref` navigation files; it also preserves
dropdown presentation, collection descriptions and icons, explicit default
versions, page route casing, redirects, local snippets, static assets,
compatible page frontmatter, site identity, and OpenAPI configuration.
A page with no `description`, other than one that names an API operation, gets
one from its first paragraph, which keeps it for search and metadata but marks it
`descriptionPlacement: body`, so the runtime does not print the same sentence under
the title and again in the body; an authored description is shown under the title as
written. (Docusaurus and Fern pages are always marked `body`.)
Analytics come across too: docs.json `integrations` and legacy mint.json
`analytics` for GA4, Google Tag Manager, PostHog, and Plausible are validated
and written to `docs.json` `integrations` (`integrations` wins per provider when
both exist). Invalid values are skipped with a warning, and every other
Mintlify provider (Amplitude, Mixpanel, Segment, and so on) is listed once in a
warning instead of being dropped silently. For public Mintlify
sites, the URL adapter reads the structured configuration embedded in the
rendered application before falling back to DOM link inference. A navigation
entry's `tag` label and `boost` search weight have no Thally counterpart: one
warning for each says how many entries had it.

A group with a `root` page and a `directory` of `card` or `accordion` (set on
the group or inherited from a group above it; `none` turns it off) ends its root
page with the group's pages as cards, as Mintlify's page directory does: the
group's own pages first, in order, then each nested group, as a label with its
cards (a group nested deeper becomes one card that gives its page count). A
hidden or access-restricted page is left out and named in a warning, and
`accordion` is shown as cards with a warning.

An `openapi` (or `asyncapi`) reference is resolved wherever Mintlify allows
it — the top-level `api.openapi`, or on any individual
tab/anchor/dropdown/product/version, e.g. `navigation.tabs[].openapi` — and
binds to that exact tab, not only the first one found. An `openapi` item inside
a tab `menu` (string or `{ source, directory }`) becomes its own API tab named
`<Tab>: <Item>`, so its endpoints appear in the sidebar; when it is the tab's
only content it binds to the tab itself. The item's `icon` and `hidden` carry
onto that tab, and a `directory` output folder is not used (a warning says so:
endpoint pages are generated under `/api/`). An item Thally cannot represent
produces a warning naming it. A top-level `api.openapi` that no navigation entry
lists and that pages name in their `openapi:` frontmatter (a bare `GET /x` names
it only when it is the site's one spec) gets no API tab, because Mintlify
publishes just those pages: the spec is bound to a hidden tab (`OpenAPI: <spec>`)
of its own that the pages' endpoints resolve against. It never binds to an
existing tab whose label merely contains "API" or is the same as its own (an
authored tab named `OpenAPI: <spec>` is an ordinary tab), and no other spec ever
takes that tab over (one that cannot share a tab is left out with a warning, never
swapped in for the first). A spec no page names keeps its API tab. Specs that share a file name across folders are
kept as separate files in `openapi/`. A remote `https://` spec is not
downloaded by `migrateRepository`; the bundle lists it and warns, and
`hydrateRemoteApiSpecs` (which `create-thally-docs migrate` runs after the
conversion) downloads it from a public host, up to 25 MB once decompressed (it
asks for gzip), saves it as `.json` or `.yaml` by its content rather than its
URL, and binds it to its tab. A download is abandoned after 30 seconds without
data or 5 minutes in all (one clock for the whole redirect chain, the DNS lookup
of every hop included, so a stalled lookup cannot hold it past the limit),
however slowly the bytes arrive. A download that fails leaves a warning naming the URL. An `http://` spec is never
imported. Missing local specs also produce warnings
instead of silently dropping that API tab's reference. AsyncAPI has no Thally
renderer, so it always produces a clear warning naming the spec instead of
disappearing.

`METHOD /path` entries (`"POST /v2/keys.createKey"`) under a container that
binds an `openapi` spec become pages of the site (see the next paragraph) or,
where that is not possible, `api.groups` on the tab that spec binds to:
nested groups, icons and authored order are kept, and page entries stay in the
tab's own groups (a group that mixes pages and operations is split, so the
sidebar lists the API groups after the page groups). Operations written
straight under a tab form a group named after the tab, at their place among the
tab's own groups (each uninterrupted run is its own group, so authored order is
kept). Hidden groups (and containers under one), groups under access-restricted
containers, and groups left empty are left out. Groups nest at most 32 levels
deep, as the renderer follows no deeper: operations below that are not migrated,
and one warning says so. With `navigation.languages`, only the default language's
containers contribute groups; operation entries under another language are
reported, since its API tab is the default language's.
When several containers bind one spec to the same tab (one API tab per product,
say), their groups are concatenated in order and an operation already listed
earlier in that tab is dropped (the method is compared without case, the path
exactly), unless one of those containers lists no operation (Mintlify generated
every operation there), in which case the tab gets no `api.groups` and keeps the
generated, tag-grouped navigation. A container whose operations are all hidden or
access-restricted adds no groups but still counts as listing operations; when
every container bound to a tab is like that, the tab gets `navigation: false`
(the source sidebar showed none of those operations, so no generated list is
added). Operations dropped only for nesting too deep are Thally's limit, not the
author's choice: such a container counts as listing nothing, so the tab keeps
the generated navigation. Groups with the same title are not folded together. With `api.groups`
the authored list is the tab's navigation, so `navigation: false` is not
written. Operation entries with no `openapi` container above them, and every one in a
site imported by URL, cannot be placed: one warning says they were not added to the API navigation, and the
operations still have their pages. This is separate from a `directory`'s flat
operation list, which still only drives the endpoint redirects.

Mintlify serves one generated page per operation a navigation container lists,
at `/<directory>/<first tag>/<title>` (`directory` is the reference's
`{ source, directory }` folder, `api-reference` when it is a plain string; an
untagged operation has no tag folder).
Each such operation becomes an MDX page at that path under `src/content`, so it
keeps its URL, sidebar entry, eyebrow and previous/next links. Its frontmatter is
the summary as `title` (else `<Method> <words of the path>`, never the operation id), the first
sentence of the description as `description` (the title when there is none), and
`openapi: "<spec file> METHOD /path"`; the body is empty. `descriptionPlacement: operation`
keeps that short summary for search and metadata while the runtime renders the
full operation description as Markdown, including every paragraph and warning.
The tab that listed the
operations is an ordinary page tab, kept where it was among its siblings and
labelled as they are (`Product: API reference`), whose groups are the authored
ones, nesting and order kept, each operation replaced by its page. Tabs that were
separate in the source are never merged, even when they share a spec. The spec
is bound once per spec file in a hidden tab (`OpenAPI: <spec>`, the same as for a
spec only a page names), which is what the pages' `openapi:` frontmatter resolves
against; the renderer serves no `/api/` page, sitemap entry or search record for it. A remote spec's pages
and tab are made by `hydrateRemoteApiSpecs` once it is downloaded; a download
that fails leaves no tab and no page, as before. An operation the spec withholds
(`x-hidden`, `x-excluded`) gets no page, nor does one listed only under a
`hidden` group or an access-restricted container (such groups are left out of
the tab, as above). Of two operations with the same tag and
summary the first listed keeps the URL and one warning names the others; an
authored page at that URL keeps it. Nothing is redirected from these URLs and a
link to one stays as written; a link to a tag folder or to an address under the
directory that matches no page goes to a page, and a folder of pages with no page
of its own opens on its first page, as in any other navigation. The operations
fall back to `api.groups` on an API tab, as described above, when the containers
that share a tab disagree on the directory, the directory cannot be a folder name,
the spec has none of the listed operations, or the tab is bound to another spec.
A reference that lists no operation (Mintlify generated every endpoint) is not
affected. Operations whose path item is a local `$ref` are read as the renderer
reads them (hidden or excluded on any level of the reference withholds them).

An authored page that names an operation (`openapi: post /links`) or a webhook
(`openapi: webhook link.created`, read from the spec's `webhooks`) and sets neither
a `title` nor a leading heading is titled by that operation, as Mintlify titles it:
the summary, else the operation id, else `METHOD /path` (`POST link.created` for a
webhook), where its file name would otherwise give it "Create" for `links/create.mdx`. A page that names its spec reads
that spec; a bare reference reads the first spec that publishes the operation, so
when a site has a remote spec, `hydrateRemoteApiSpecs` titles these pages once every
spec is bound. A page whose operation no spec publishes (a remote spec that failed to
download, say) keeps its file name title. `sidebarTitle` still becomes
`navTitle`, and an authored title always wins.
The renderer tries the first visible API tab's spec first for a bare
`openapi: "METHOD /path"` page; when converting a tab to pages stops its spec being
that one, each bare reference to an operation the converted spec defines is
written with that spec's path in front, so it still renders the same operation.
A spec a tab rejects (Thally binds one API spec per tab) has no binding, so no
reference is moved to it.

Mintlify `styling.eyebrows: "breadcrumbs"` becomes `eyebrow: "path"` (the full
group path above the page title); `"section"` or no setting writes nothing.
Mintlify sources also get `smartQuotes: true`, because Mintlify renders straight
quotes in prose as curly ones; the setting leaves code, heading ids, Markdown and
`llms.txt` as written.

Thally leaves out the sidebar heading of a group named after its tab or dropdown, because
the collection already names it. Mintlify keeps that heading, so a source with such a group
(an `API reference` dropdown whose first group is also `API reference`) gets
`navigation.groupHeadings: "all"`. A source without one gets nothing.

Page `openapi:` frontmatter with a spec prefix
(`openapi: "specs/openapi-b.yaml GET /widgets/{id}"`) is rewritten to where the
spec lands in the output (`/openapi-b.yaml GET /widgets/{id}`). As in Mintlify,
the prefix may name the spec by path, by file name, or by file name without its
extension (`v3-openapi GET /tasks`); a name that fits more than one spec is kept
and reported with its candidates. A declared spec that a published page names
but that cannot be its tab's spec is bound through a hidden tab, so the page
still renders its endpoint. A prefix naming
a spec that was not migrated is kept and reported. Manual API pages keep their
`api:` and `authMethod:` frontmatter, and `api.mdx.server` / `api.mdx.auth` map
into `docs.json`; invalid values are dropped with a warning.

In-content links to auto-generated API operation pages are rewritten to the
matching Thally `/api/...` route. A link under a known API section that matches
no operation points to that section's overview page instead, and one warning
lists the affected links (up to ten). A link to an address the site answers
itself (a guide authored inside an API directory, trailing slash or `/index` or
not, or the source of an authored redirect) is never rewritten. A spec that
Mintlify mounted under a `directory` also gets a redirect from each endpoint URL
that directory served (not the operations a container lists, which are pages at
those URLs), to the matching endpoint page, and never to an operation the
published spec withholds with `x-hidden` or `x-excluded`. A remote spec gets every directory
each of its tabs mounted it under, limited to the operations the navigation
listed under a directory when it listed any. A local spec gets one directory
per tab (the first) and every operation of the spec. When directories nest
(`reference` and `reference/v2`), an address belongs to the longest directory it
lies under, whether the specs are local or remote: the shorter one never
rewrites a link to it or redirects it. When a site has a remote spec, links and
endpoint redirects under every directory are generated by
`hydrateRemoteApiSpecs` once all specs are bound (a tab's position decides the
id its spec is served under), so they stay as authored until then. A remote
directory whose download failed still owns the addresses under it: they stay as
authored, never rewritten or redirected. A link under any
directory reaches only that directory's own endpoint URLs; a link under none is
redirected by its last two segments (tag and title, as they appear in that URL) only when exactly one
published operation across every spec carries them, to the id its spec is
served under. A Mintlify default version's pages also get a redirect from their
address without the version segment, since the original site serves them both
ways.

An endpoint URL Mintlify generates is `<directory>/<first tag>/<title>`: the
title is the summary, else `<Method> <words of the path>` (the operation id is
never used), an untagged operation has no tag folder, and an operation whose URL
repeats an earlier one's gets `-1`, `-2` and so on after it, in the order the
spec lists them. A navigation container (a group, tab or other) that names a
spec without listing any of its operations had every one of them generated, under
`api-reference` when it names no `directory`, so such a spec is mounted there
too; the top-level `api` setting generates nothing.

Redirects are checked once, after every platform and step has added its own.
Next.js applies a redirect before it looks for a page and compares a source
without regard to a trailing slash, so a redirect whose source is a page of the
migrated site would hide that page, and two redirects that send a visit back to
each other never settle. Each such redirect is left out, and a warning
lists the first ten of each kind; the earlier redirect of a loop is kept. A
generated redirect (a version alias, an endpoint URL) for an address that
already serves a page is left out without a warning, since the page is still
reachable there. These checks ignore letter case, because a site can run on
`next start`, which matches a redirect source without regard to case, or on the
Cloudflare build, which matches it exactly, and a redirect must be safe on
both. So `/Guide` to `/guide` is left out when `guide` is a page (it would loop
and hide the page where case is ignored), `/a` to `/B` together with `/b` to
`/A` is a loop whose second redirect is left out, and a generated redirect
whose address differs from a page only in case is never created. When letter
case alone is the conflict, the warning names each redirect left out (the
first ten), says that its address differs only in letter case from a page or
another redirect, and says to add it back to `docs.json` if your host matches
URLs case-sensitively. Next.js reads a redirect source as a route pattern, so one
whose address has a `+ ? ( ) [ ] { }` character (a `directory` such as
`sdk/c++`) would fail the build; every redirect from authored config, a local
spec or a downloaded spec is left out instead, and one warning lists the first
ten of them. A source that ends in a catch-all `/:name*` also matches the path
without that segment, so when that path is a page of the site, or is where the
redirect itself goes (`/docs/sdks/typescript/:path*` to `/docs/sdks/typescript`),
the redirect would send the page to itself. Its source is rewritten to
`/:name+`, which keeps redirecting every deeper path and leaves the page alone.
For `/:name*` that path is the root `/`, which the site answers with its
introduction page or with a redirect of its own, so such a catch-all
(`/:path*` to `https://example.com/docs`) becomes `/:path+` in either case.

A Mintlify page whose frontmatter `url` is a web address is a link in the
source sidebar. It is imported as a page that is kept out of the sitemap, stays
in the navigation, and has a redirect from its path to that address. That
redirect is added after the checks above, because hiding the page is its
purpose; a `url` that is not an `http(s)` address is ignored. The home page
(`index.mdx` or `introduction.mdx`) is served at `/` and at `/introduction`, so
both redirect, and the redirect from `/` replaces the generated one to the first
page. A redirect for `/` that the source site wrote stays, and a warning says so.

An authored redirect (Mintlify and Fern `redirects`, Docusaurus
`plugin-client-redirects`) starts at a path on the site and ends at another
path on it or at an absolute `http(s)` address, which is kept exactly as written
(`/docs/examples` to `https://github.com/dubinc/examples`). A destination that
starts with `//`, uses another scheme such as `javascript:` or `data:`, or holds
a backslash, whitespace, a control character, credentials or a bracketed IPv6
host is left out for safety, and one warning lists the first ten sources skipped.
Only the path of a destination is checked as route syntax: its query is kept as
written (`https://example.com/?next=https://other.com`), and so is a fragment
unless it holds a character Next.js reads as route syntax (`: * + ? ( ) { }`). An
address whose host name, once its percent escapes are read, is not a valid one
(letters, digits, hyphens, underscores and dots, then an optional port) is left out with a
warning, since Next.js fails when it follows such a redirect. A `:name` in a
destination that the source does not define is kept as text (its colon is written
`%3A`), because Next.js fails when it has no value for it; a wildcard
(`:name*`, `:name+`) the source does not have, or a wildcard of the source that
the destination writes without its `*` or `+`, is left out with a warning. A
redirect that still cannot be carried (a `:` inside a path segment such as
`Category:Foo`, a `*` anywhere but as the whole last segment, or such a fragment)
is left out with a warning that names that reason.
A Mintlify source or destination written without its leading slash
(`features/extract-beta`) is read as the path it names, as Mintlify's own site
does, and one warning lists the first ten redirects given a slash; one starting
with `./` or `../`, a source with a scheme, or a destination with a scheme other
than `http:` or `https:` is left out like any other unsafe value. Fern
and Docusaurus ask for a rooted path, so theirs are not read that way.
A Mintlify or Fern redirect that does not set `permanent` is permanent (308), the
default both platforms document, so search engines move to the new address;
`permanent: false` stays temporary (307), and so do the route aliases, endpoint
URLs and page links the migrator adds itself.

A repository is limited to 5,000 documentation files and, separately, 5,000
asset files. Past that, files are kept in navigation order with the default
version first, then pages not listed in navigation, and one warning counts and
names (the first three of) the pages left out and suggests `--docs-dir` to
migrate a smaller part of the repository. Scanning itself stops after 100,000
files with its own warning. An asset is not copied when it is over 25 MB and no
page uses it, over 100 MB when a page does, or when the copied assets would pass
500 MB in total; one warning per reason gives the count, the first five paths,
and the next step (copy them into `public/` manually). The budget is spent in
order: the root stylesheet, the site's own scripts and fonts, and the files
`docs.json` names (logo, favicon, background; a bare `logo.svg` counts like
`/logo.svg`) first, then the assets pages use, then the rest, so a full budget
never costs the site its branding. Cloudflare, including Thally Cloud, serves a
static file only up to 25 MiB (26,214,400 bytes), so a copied asset over that
size gets its own warning: a Cloudflare deploy fails until it is made smaller
(for example, an animated GIF converted to a video) or hosted elsewhere.

Headings written with an explicit `{#custom-id}` become a preceding
`<a id="custom-id"></a>` anchor and keep their text, so links to that id still
work and the page still compiles as MDX.

Migrated specs are written to `openapi/`, never `public/`, because the host
serves `public/` as-is and would publish operations marked `x-excluded` or
`x-hidden`. Migrating into an existing site does not delete anything: an
older copy of a spec already in `public/` stays publicly downloadable. The
migration warns and lists such files, and `thally check` keeps flagging them;
delete them manually.

Docusaurus sidebars are parsed as bounded, data-only JSON5—never executed—and
preserve explicit categories, autogenerated slices, document IDs/slugs,
positions, generated indexes, admonitions, tabs, and `static/` assets where
supported. Every `@docusaurus/plugin-content-docs` instance declared in
`docusaurus.config` (not just the default one) is imported as its own tab,
routed under its `routeBasePath`; a `path` is resolved the way Docusaurus
itself resolves it (relative to the detected project root), with a fallback
to the repository root for monorepos that build by copying the project
root's contents up into the repository root before generating the site
(Playwright's own `nodejs/` is one real example) — a `path` still not found
under either root is reported with a warning naming the plugin instance
instead of being silently dropped. The same repository-root fallback applies
to `@site/...` aliases, relative component imports, and relative asset
`require()` calls in copied components; a `require()` that still can't be
resolved is replaced with an empty string (a broken image, not a build
failure) and warned about instead of left dangling. `@docusaurus/plugin-client-redirects`
rules are imported whether declared inline in `docusaurus.config` or in a
separate module it imports (a named export, e.g. `redirects.ts`); a `from`
may be a single path or an array of paths. Its `createRedirects` function
computes redirects dynamically and can't be evaluated statically, so its
presence is reported with a warning instead of being silently ignored. A
static `--ifm-color-primary` accent color in the classic theme's `customCss`
file is imported the same way Mintlify's and Fern's theme colors are.
Versioned docs under `versioned_docs/` and translated docs under
`i18n/<locale>/docusaurus-plugin-content-docs/` are imported with their
navigation, including locale-prefixed routes such as `/fr/...`. Each version
and locale keeps its own route tree; sidebar entries without source documents
are reported.
Docusaurus heading ID comments such as `{/* #custom-id */}` become explicit
HTML anchors so links to those headings keep working after migration. Links
using Docusaurus' implicit heading slugs also get explicit aliases when the
linked heading or option-table field can be matched uniquely. Repeated option
fields use the nearest preceding row when all local references agree;
otherwise ambiguous anchors remain warnings.
Longer fenced code examples keep nested shorter fences inert. An archived
admonition missing its closing delimiter is closed before the next top-level
heading (or at the end of the page) so its remaining content stays importable.
Docusaurus `mdx-code-block` wrappers are opened as live MDX when the resulting
page compiles and its special fences contain no module declarations. Pages
whose fragments still need Docusaurus theme imports or remark plugins remain
fenced and are retained.
Directories and files whose names start with `_`, and `__tests__` directories,
are skipped, as Docusaurus does not treat them as documents. Pages with `unlisted`
set stay routable but are left out of navigation. Partial imports of `toc`,
`frontMatter`, `metadata` and `assets` are bound to values the page can use
instead of failing. `<Admonition>` becomes a callout like the colon fence, and
`<ThemedImage>` keeps its light image.

Fern repositories are located by their `fern/docs.yml` + `fern/fern.config.json`
pair. `docs.yml` is parsed as bounded YAML—never executed—and preserves tabs,
nested sections (including `slug`/`skip-slug`), navbar links, redirects, the
default Fern version's navigation, and theme accent colors. Only pages
referenced from `docs.yml` are imported, matching Fern's own publishing model.
Versioned `folder:` entries expand the Markdown files they contain, even when
the folder or an individual page is outside `fern/` but still inside the
checkout. An explicit empty tab `slug` keeps pages at the site root; a folder
title changes its navigation label without changing its directory-based URL.
Internal links are adjusted for the site's domain path, selected version, and
source-file routes. Links to sections not imported into Thally stay on the
published Fern site and produce a migration warning, so the generated site can
build while the remaining content is moved separately.
`<Markdown src="...">` includes are inlined from the referenced file when it is
inside the repository.
Every `api:` section's OpenAPI document is resolved from its own
`generators.yml` (`api.specs[].openapi`, or the legacy `api:` string) and
imported into its own tab — a docs.yml with several API sections (e.g. a REST
API and a WebSocket API in separate tabs) gets a spec per tab, not just the
first. The per-API `fern/apis/<name>/` layout is checked first, keyed by the
node's `api-name` (the folder name) rather than `api` (its display title in
the nav) — the two are commonly different. The project-root `generators.yml`
is used only when the node has no `api-name` or the repo has no `fern/apis/`
folder. `openapi:` is conventionally relative to `generators.yml`'s own
directory rather than the Fern root, so it commonly resolves outside the API
folder (or outside `fern/` entirely, e.g. `../../../openapi.yaml`); the spec
is still found as long as it stays inside the repository checkout, and a path
that escapes the checkout is reported with a warning naming it, instead of
the API being silently dropped. A Fern Definition (a non-OpenAPI API with no
document to attach), an AsyncAPI/OpenRPC-only `api:` section (Thally has no
renderer for either), and an `api:` section for which no spec could be
resolved at all, are each reported as a warning naming the API instead of the
tab being silently dropped, as is `changelog`, which has no equivalent Thally
field yet.

A section/page/tab's explicit `slug` is used as literal Fern routing text
(e.g. `slug: baml_client`, matching a `baml_client/` folder) even when
Thally's own route still hyphenates it for consistency (`baml-client`); an
in-body link written against that literal, unslugified form — which Fern's
own file-path-based routing tolerates — gets a redirect to the route Thally
actually serves, instead of 404ing after migration.

KaTeX-style `$$...$$` math (block or inline) has no Thally renderer yet.
Rather than crashing the MDX compiler and silently excluding the whole page,
a block becomes a fenced ```` ```math ```` code block and an inline span
becomes an inline code span — both preserve the original math text — with a
warning.

A `products:` docs.yml (Fern's multi-product/product-switcher layout, as on
buildwithfern.com/learn) imports every product: each product's own
`navigation:`/`tabs:` becomes a top-level Thally tab named by its
`display-name`, routed under its `slug` (or a slugified display-name), with
its pages read from that product's own directory. Local component imports
from Fern MDX pages (`../../components/...`, resolved against the Fern
project root) are migrated the same way Mintlify and Docusaurus components
are — see "Mintlify compatibility" below.

## Mintlify `sourceRef` repositories

A Mintlify navigation node `{"sourceRef": "owner/repo"}` mounts the docs of another
repository. Mintlify does not document where that mount lives, so it cannot be
derived from `docs.json`; supply it with a repeatable flag:

```bash
create-thally-docs migrate https://github.com/OpenRouterTeam/docs my-docs \
  --source-ref OpenRouterTeam/typescript-sdk=client-sdks/typescript
```

Without a mapping the node is skipped with a warning that names the flag.

- The repository must be on github.com. Its docs root is the directory holding a
  Mintlify `docs.json` (`docs/` first, then the repository root); without one the
  mapping is skipped with a warning.
- Every `.md`/`.mdx` file under that root is imported (orphans included) through the
  same pipeline as the main site, under `<mount-path>/...`. Assets are copied under
  `public/<mount-path>/...`. The node is replaced by the referenced `docs.json`
  navigation with page paths prefixed by the mount path; tabs become groups, and the
  parent group keeps its label and icon.
- Root-absolute links inside those pages (`/models/x`, `/images/x.png`) are prefixed
  with the mount path (sub-site semantics: Mintlify's behavior here is not
  documented, so this is an assumption). Relative links work as-is.
- Pages, navigation, assets and the referenced repository's custom components are
  imported. Its components are bundled with the main site's under `src/mdx/migrated/`
  and registered in `src/mdx/custom-components.tsx`; their content-hashed names cannot
  clash with the main site's. Branding, colors, redirects, OpenAPI specs and
  access-restricted pages of the referenced repository are ignored (one warning says
  so). Access-restricted pages and the files only they use are withheld from the site
  and are not saved anywhere (the main site saves its own under `migration-quarantine/`;
  a referenced repository's are discarded), so recover them from that repository if
  needed.
- Safety limits per referenced repository, fixed constants: 5,000 files and 50 MB under
  the docs root. Over a limit the whole repository is refused, never imported
  partially. Symlinks and dot-directories are removed before import, and a docs
  directory that resolves outside the clone is refused. A repository GitHub reports as
  larger than 200 MB is refused before cloning (if the GitHub API is unreachable the
  clone proceeds and the limits above still apply), its submodules are not fetched,
  and a `docs.json` over 1 MB is ignored. `repo` must match `owner/repo`; the mount
  path must be a relative lowercase slug path (no `..`, no leading slash), must not
  start with a name the site itself uses (`api`, `admin`, `_next`, `public`,
  `llms.txt`, `sitemap.xml`, ...), must not collide with an existing page or directory
  of the main site, and mappings must not overlap.
- A mapping that matches no `sourceRef` in the navigation is reported and imports
  nothing. `migration-report.json` lists each imported repository with its page count
  under `sourceRefs`.

## Mintlify compatibility

Repository imports preserve named/default local JSX and TSX components and
their bounded, static local dependency graph in `src/mdx/migrated/`. Components
are registered through the customer-owned `src/mdx/custom-components.tsx`;
existing object-literal registries are merged rather than replaced. Repeated
imports of the same registry are idempotent. Registry shapes that cannot be
merged safely stop materialization with an actionable error.
Component output is namespaced by repository and documentation root, so
separate imports can preserve components with identical source filenames.

The importer creates a root redirect to the first available page in source
navigation when no root introduction exists, while retaining a separate custom
homepage and explicit redirects. Locale tags and recognized locale-prefixed
sections are normalized without discarding original URL redirects.
Mintlify's generated `param-*` links for settings headings and named fields
become explicit anchors in migrated MDX.

Simple interactive HTML blocks in MDX are extracted into client components.
For a copied client component that receives a simple page-authored JSX callback,
the importer moves the callback into a client wrapper and keeps the page. If
the callback cannot be moved safely, it keeps the page and the control's child
content as a passive fallback, with a warning identifying the control. A
function the page imports from a copied module and passes as a prop to such a
component (`badges={badgesFor}`) is imported by a client adapter instead, so
the page never hands a function across the server boundary, however the module
exports it (`export default format`, `export { format as f }`); an export that
cannot be classified without running the module is moved too, since importing
plain data inside a client module is just as safe (a `let` or `var` is one, as a later
assignment may change it: only a `const` literal stays on the page). A tag gets one
adapter for all of its function props, a page-authored callback and imported
functions alike, so none is left crossing from the page; that holds for a
component the page also uses as a value (`C={Widget}`), which keeps a real import
instead of an alias. A client component gets the adapter for either kind of
function. A copied server component keeps receiving an imported function from the
page, as authored, and gets one for a page-authored callback only when it can run
once wrapped: an async one (`export default async function Widget`) is left as
authored, since wrapped it would be an async client component. A function prop
that a later spread or a later prop of the same name overrides is never moved
(the adapter would put it over them), and neither is a function passed as
`children` (the adapter hands the component its own children): a page-authored
callback then stays passive, and an imported function stays on the page, each
with a warning. A stateful local
snippet component is kept as a client component instead of flattening away its
hooks and state.
A component a page declares itself (`export const Counter = () => ...`) that
calls a React hook is moved into its own `'use client'` module, together with
every page-local component, helper and constant it uses (a sibling it renders,
a dependency that is itself stateful, a value only reached through a prop),
in source order and under their original names. The imports that moved code
needs move with it. What the page still renders stays reachable: a server-safe
dependency the page also uses is kept in the page and copied, while a
client-only one is imported from the module. A page-local name always wins
over a same-named built-in. If any dependency cannot run in a client module
(server-only APIs such as `process` or `await`, an undeclared name, a package
the migration removed, a dynamic `import()`), the component is left where it
is and a warning names it and the blocker.
`<Snippet file="...">` accepts the documented `snippets/`-relative path as well
as a `/snippets/...` or page-relative one. A multi-line snippet keeps the
indentation of the tag it replaces on every line (aligned with the item text
after a list marker), so a list or block stays inside its `<Step>` or list item;
lines inside a JS expression, and every line of a fenced code block, are left as
written so a template literal and the code keep their text. The string props a snippet is called with are its variables, as on
Mintlify: `{mode === "x" && ...}` and `props.mode` in the snippet read the
value of `<Snippet mode="x" />` at each use, so the content a prop selects is
kept. A prop binds only where its name is a free variable, which a scope
analysis of the expression decides (`eslint-scope`): a name the snippet declares
itself (a top-level `export const mode`, a function or an import, or a parameter,
`var`, block, loop, `catch` clause or class around the use) is that declaration's,
never the prop's, while a default parameter (`(x = mode) => { var mode }`) still
reads the outer name. That includes `props` itself (`props.mode` binds only where
the snippet does not declare `props`, and a callback parameter named `props`
shields only its own uses of it). A property key, a member name after a dot, a
label (`mode: for (...)`, `break mode`) and the name of a class member (method,
field, accessor, `#private`) are names, not uses, and are never replaced; a
computed key (`[mode]`) is a use.
A bare `{mode}` follows the same rules, so a callback parameter or a declaration
of that name keeps its own value there too; it becomes the value as text in a
Markdown snippet and `{"value"}` in a JSX one; `{children}` becomes the children as
written in text and as the child of an element inside an expression
(`{mode === "x" && <Note>{children}</Note>}`) alike. A `{name}` inside a fenced code
block is never replaced, and a fence closes only as CommonMark closes it (the same
character, at least as long, nothing after it), so a three-backtick block inside a
four-backtick one stays code. An outer code fence that contains a
same-length nested fence is widened so the inner fence no longer closes it, and
a bare placeholder tag in prose (`<Feature> requires a plan`) that would stop
the page compiling is escaped as text rather than losing the page.
The Mintlify `search-bar-entry` click trigger is mapped to Thally's search
shortcut. Markdown mixed inside interactive JSX and computed imports are
reported for manual review; unsupported source is
preserved, not replaced with empty stubs. An external package's JSX usage is
dropped and replaced with a safe fallback (with a warning); if that package's
binding is instead referenced outside JSX (an expression, a prop, or an
inline declaration) the import can't be rewritten the same way, so the whole
page is excluded — instead of shipping with an import `next build` can't
resolve — and pruned from navigation, with a warning naming the page, the
package, and the binding. A local/relative component import is fully owned by
the migration instead: the whole file (and its own local dependency graph) is
copied, keeping every binding's original name, so it makes no difference
whether a binding is used as a bare JSX tag or only referenced elsewhere (an
enum passed into a sibling component's prop, a member tag, a wrapping
declaration, ...) — the page is excluded only when the copy itself genuinely
fails (a missing file, a computed/dynamic dependency, a cycle, or a budget
overrun), with a warning naming the page and the component. Packages the starter already installs (`next`,
`react-dom`, `clsx`, `lucide-react`, `tailwind-merge`, and their subpaths) are
kept as-is (except `react-dom/server`, whose string renderers throw under
Next) and copied into any extracted client module. A source site's own
`@/…` path aliases are treated like an unavailable package. A page that
passes a page-authored function into a client component needs the client
wrapper described above; unsupported callback shapes retain their content
with a warning. An unconfirmed target is warned for review.
Other relative imports of a copied file are handled the same way: a namespace
import (`import * as X from './comp.jsx'`) and a dynamic `import('./comp.jsx')`
point at the copied module, and a relative side-effect import
(`import './styles.css'`) is removed with a warning, like one from an npm
package. A page is excluded only when the relative target is not copied (for
example a Next.js `./metadata` module, or an `export ... from` re-export), with
a single warning naming it. An MDX expression that names an identifier the page
never defines (`{missing}`) is removed with a warning, since it would throw at
render; define the name or escape the braces as `\{ \}` to keep the text.
A value import from a local snippet (`import { FEE, fee } from
'/snippets/c.mdx'`) is inlined when each name is a static value (string,
number, boolean, `null`, or an object/array of those) or a self-contained
function. Inlined functions may only use pure built-ins (`Math`, `JSON`,
`String`, `Number`, `Boolean`, `Array`, `Date`, `Intl`, `parseInt`,
`parseFloat`, `isNaN`, `isFinite`, `encodeURIComponent` and
`decodeURIComponent`) and may not reach
`Function`, constructors, `globalThis`, `fetch` or other globals; anything else
is not inlined. A name the snippet does not export, or one that cannot be
inlined, is bound to `undefined` (as Mintlify does for a missing export) with a
warning, while the other names of the same import are still inlined. A snippet
import that resolves outside the repository through a symlink is refused, and a
snippet whose frontmatter cannot be read is not inlined (left as a comment with
a warning). Mintlify `sourceRef` navigation nodes have no Thally equivalent and
are reported rather than migrated.
File paths cannot escape the repository checkout; symlinks and oversized
graphs are rejected. This is compatibility analysis, **not a code sandbox**:
imported JavaScript executes when the developer builds or runs the resulting
site.

A copied Mintlify `.jsx` snippet that uses the implicit `MintlifyComponents`
global (`const { Card } = MintlifyComponents`, Mintlify's own no-import
convention for its built-ins) gets that binding provided automatically,
reusing Thally's own built-in MDX component registry — the same way an
implicit `React`/hook global is already provided.

A copied component is prepended with `// @ts-nocheck`: the source
platform's own build never ran `next build`'s full `tsc --noEmit` type
check, so loose types, ambient globals (`window.ethereum`), and implicit
`any` parameters that were fine there would otherwise fail the migrated
build. A locally-owned wrapper component whose own body imports a known
YouTube-embed package (e.g. a custom `LiteYouTube` wrapping
`react-lite-youtube-embed`) gets the same working `<iframe>` fallback as a
page that imports that package directly, instead of losing the embed to the
generic unknown-component fallback.

### Access-restricted pages

Restricted Mintlify pages migrate as real pages with normalized access
frontmatter that the Thally runtime enforces (see `/guides/authenticated-docs`):

- Frontmatter `groups` becomes a list of trimmed group names (`groups: admin`
  and `groups: "a, b"` become lists); `public` becomes a boolean (`"false"`,
  `no`, `off`, `0` are `false`; `true`/`"true"` is `true`). Empty `groups`
  restricts nothing.
- Rules on navigation containers (a group, tab, version, dropdown, anchor,
  language, or `menu` item) are pushed down into the frontmatter of every page
  below them, because the runtime reads access only from pages: container
  `groups` (a list of strings) and `public: false` restrict, and Mintlify's
  group-level `public: true` opens pages that name no groups of their own.
  Pages stay in navigation where they were.
- Rules combine to the strictest: nested and page group lists intersect,
  `public: false` anywhere wins, and a page listed under both an open and a
  restricted container gets the restricted rule.

A page whose rules cannot be carried over safely fails closed instead: a
malformed value (`public: maybe`, `groups: [1]`), group lists that share no
group, or frontmatter that declares `groups`/`public` but cannot be parsed or
read. Such a page is not written to `src/content`, is removed from navigation,
and its original is written unchanged to `migration-quarantine/<original path>`
at the project root, which no runtime reader walks; `create-thally-docs` adds
that folder to `.gitignore`. Each quarantined page gets a `gated-page` warning.

Fern and Docusaurus have no runtime access mapping in Thally, so their restricted
pages fail closed in the same way: they are quarantined (not written to
`src/content`, removed from navigation, original saved under
`migration-quarantine/`) and never inlined into other pages. Fern signals:
frontmatter `viewers` (any non-empty value) or `authed`, `<If roles>` or
`<If viewers>` content in a page, and `viewers` in `docs.yml` on pages, sections,
tabs, products, versions and api nodes; the specs of a restricted api node are
withheld too. Docusaurus: a `draft` page, where any value other than unset,
`false` or `"false"` counts as a draft; the check is skipped for files under `_`
directories and `__tests__`, which Docusaurus does not publish as documents. Links
from other pages to a quarantined page are left as authored and will fail
`thally check`.

Fern migration stops with an explicit error if cyclic navigation, excessive
nesting, or the node budget prevents complete access classification. It emits
no pages, assets, or API specs, because an unvisited branch could restrict a
file also listed under a public node. Simplify the source navigation and retry.

Assets are copied to `public/` only when a published page, the site configuration,
copied styles or a migrated component names them by their exact normalized path;
a restricted page's text never makes an asset public. On a site that withholds
anything, an asset nothing published names that way, one named only by a bare file
name or in a different letter case, one built at runtime, and one that shares its
public path with another file are saved under `migration-quarantine/assets/`
instead, with a warning listing them so they can be copied back by hand. On every
platform a page over 2 MB is not inlined, OpenAPI spec reads are capped at 50 MB,
and a path that resolves outside the repository through a symlink is refused.

What a restricted page uses must not leak through surfaces that are not access
controlled: it is never inlined into another page (a `gated-page` warning names
the importer), images and other assets used only by restricted pages are not
copied to `public/` (they are saved under `migration-quarantine/assets/`), and
OpenAPI operations documented only on restricted pages are withheld from the
published spec. One `gated-page` summary counts the restricted pages and notes
that Thally hides them from everyone until reader authentication is configured
in `docs.json` `auth`; no `auth` block is generated, because Mintlify's
dashboard settings cannot be read from a repository. When any page sets
`public: true` (which implies the source site required sign-in for everything
else), one more `gated-page` warning says every unrestricted page will be
public until `auth` is configured.

### Site-wide scripts, styles, fonts, and settings

Mintlify serves every `.css` and `.js` file in the content directory on every
page. Those files are copied to `public/` (tooling config such as
`*.config.js`, `tailwind.*`, `postcss.*`, plus `dist`/`build`/`coverage`
output, dot-directories, and `node_modules` are not) under the normal asset
size limits. Scripts are added to `docs.json` `customScripts` (URL-encoded),
except modules that pages import as components, which are copied as components
instead. Thally loads a local stylesheet that `docs.json` lists under
`stylesheets`, but the migrator does not list the `.css` files it copies, since
their rules likely target Mintlify's DOM: each is preserved with a warning that it
is not applied. Fonts named by
`fonts.source` (top level, `heading`, `body`) that are local `.woff`, `.woff2`,
`.ttf`, or `.otf` files are copied. Thally's `fonts` setting loads Google Fonts
by family only, so a font with a `source` of its own is not written to it (the
page would ask Google for a family it does not have, and fail): the site keeps its
default font, and one warning per font says so and how to use the copied file (an
`@font-face` rule in a stylesheet in `public/` that `docs.json` lists under
`stylesheets`, then `--font-heading` or `--font-sans`). A `source` that is a
Google Fonts address (`fonts.googleapis.com`, `fonts.gstatic.com`) still loads by
family. Remote font URLs are not downloaded, and unsafe or missing paths are
warned about.

The root `style.css` is the exception to that: it is projected, and the
projection is listed under `stylesheets`. It keeps the rules for markup the
migrated site authors (a class or id in a page, a script, or a copied component,
including a class a component builds from a template or a family name of at
least three characters) and skips those for Mintlify's own markup, the global
reset and utility classes. Every rule it keeps is confined to the page content,
so an imported stylesheet can never restyle the navbar, sidebar, table of
contents, breadcrumbs, pagination, search or footer, whatever its classes, ids and
variables are named. The content is the element the Thally runtime renders a
page's content in (`.thally-docs-prose`), and `.x p` becomes
`:where(.thally-docs-prose) .x p`; a leading `html`, `body`, `:root`, `.dark` or
`.light` stays above it (`.dark :where(.thally-docs-prose) .x p`). A selector
for the page itself (`html.x`, `body > .x`) is skipped, and so is one that starts
with an `:is()` or `:where()` of which only some alternatives are the page
(`:is(.dark, .x) .y`). `:root` and `.dark`
blocks keep only the custom properties a kept rule reads, directly or through
another kept property, and declare them on that element, so they reach the
content and nothing around it; any other declaration in those blocks is left
out. A rule nested inside another rule (CSS nesting) is skipped, since a nested
selector is read relative to the rule around it; write it as a separate rule to
keep it. A `@media` or `@supports` written inside a rule is kept, except inside a
`:root` or `.dark` block, which takes custom properties and nothing else. A
`@property` registration applies to the whole page, so it is kept only when a
kept rule reads the property and the site's own `:root` or `.dark` block declares
properties with the same prefix (`--ifx-` in `--ifx-glow`), which shows the name
is the site's and not the shell's; any other is left out and named in a warning.
Every `@layer` is kept, even an empty one or a bare `@layer a, b;`, since
the order of the layers decides which rule wins. A keyframes name is global to the page, so a site's `spin` would replace
the runtime's: each `@keyframes` is kept under a prefix of the site's own
(`src-<id>-spin`, the id being that of the stylesheet's directory in
`public/migrated/`), and the `animation` and `animation-name` declarations (and
custom properties) that name it follow. `@font-face` is kept as written, and so
is a `@counter-style` or `@font-palette-values` that a kept rule names (as it
is, with whatever it names in turn). Any other at-rule that holds no style rule,
such as `@page`, an unreferenced `@counter-style` or a stray `@namespace`, is
left out. A warning counts the selectors and at-rules that were skipped. Thally renders a page in `mode: custom` with no such element, so the
migration wraps that page's content (everything after its imports and exports)
in `<div data-thally-source-page>`, and every rule is confined to that as well
(`:where(.thally-docs-prose, [data-thally-source-page])`). A custom page that
cannot take the wrapper (an export follows its content) is left as it was, and a
warning says how many there are.

Legacy `mint.json` `topbarLinks` and `topbarCtaButton` (including
`type: github`) map to `navbar.links` and `navbar.primary`; `docs.json`
`navbar` fields win, with a warning. `appearance.default`, `appearance.strict`
(`showToggle: false`), and legacy `modeToggle.default` / `isHidden` map to
`appearance`; invalid values are skipped with a warning. Mintlify sources set
`markdown.enabled: true`, matching Mintlify's default Markdown mirrors.

## Branding

Docusaurus custom CSS projects Infima palette, typography, header spacing,
announcement styling, and local Prism colors into a portable stylesheet.
For Sass or Tailwind expressions, provide locally compiled
`build/assets/css/styles.*.css`; unresolved expressions produce a migration
warning. Configuration and theme modules are read as static data.

Remote Fern `global-theme` references fall back to local overrides and base
Thally tokens with a structured warning. The NVIDIA theme uses `#76B900`
when no local accent is configured. No remote theme assets are fetched.
Authored section expansion defaults are retained on desktop and mobile.

A source site's logo, favicon, and theme accent color(s) are extracted where
each platform's config exposes them (Mintlify's `colors`, Fern's
`colors.accent-primary`, Docusaurus's classic theme `customCss`). A valid
accent color is wired into the scaffolded project's `brandPreset` the same
way `create-thally-docs`'s own `--colors` flag does. Logo and favicon files
are copied into `public/`, but Thally's site configuration has no static
field for them — branding is managed from the admin dashboard at runtime —
so each site gets one warning naming the copied files and pointing at the
dashboard's branding settings instead of leaving the loss silent.

## Cloning a GitHub repository

`cloneGitHubRepository` retries a transient network-class failure with
backoff, and each underlying git process (the clone, and any submodule
fetch) is killed and treated as a retryable failure if it stalls, meaning
git prints no progress for 2 minutes (a large repository that is still
downloading is never cut off; an hour is the absolute ceiling for one git
process). The allowed silence is configurable via
`THALLY_MIGRATE_CLONE_TIMEOUT_MS` (milliseconds) for an unusually slow link.
The clone neutralizes the `filter.lfs.*`
smudge/clean/process filter driver for that one process only (via
`GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_n`/`GIT_CONFIG_VALUE_n`, never the user's
global git config), so a repository that uses Git LFS still clones even when
the host has no `git-lfs` binary installed — including a host where
`filter.lfs.*` is still registered globally from a previous install,
pointing at a command that no longer exists; an asset that's still a Git
LFS pointer file afterward (not its real content) is skipped, and one
warning lists those files, instead of copying them as if they were the real
files. Submodules are
initialized one at a time, best-effort,
after a successful clone — a submodule that can't be fetched (private,
deleted, network trouble) is named in a warning instead of failing the
whole migration.

`migrateUrl({ sourceUrl, openapiUrl })` accepts an explicit HTTPS OpenAPI URL,
using the same bounded specification fetch boundary as repository imports.
A single publisher-linked `openapi.json` or `openapi.yaml` can also be discovered.
Crawled endpoint pages with a unique tag/title route become interactive while
retaining their prose; generated API navigation lists only unrepresented operations.
This HTTP adapter never reads local paths. Trusted local CLI imports use a separate
bounded snapshot before calling the existing repository converter.
