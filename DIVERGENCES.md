# API reference handoff — implementation differences

The October 21, 2026 handoff is implemented in the public documentation runtime.
These differences adapt its prototype to existing production data and services:

- **Environment selection:** Try it lists the operation's configured OpenAPI
  servers. The runtime has no sandbox backend or verified Sandbox/Live environment
  classification. The UI names the actual target and explains that requests can
  change data; it never claims a real server is a disposable sandbox.
- **Responses:** Try it uses the existing bounded request relay and displays
  actual upstream status, headers, duration and body. It does not fabricate the
  prototype's slug-dependent 201/400/401 responses or `x-thally-env` header.
- **Authentication:** Explicitly required header parameters receive required-field
  validation. Existing security-scheme controls and alternative authentication
  behavior are retained; the upstream API validates credentials. Credentials remain
  masked and are scoped to origin, spec, operation, server and scheme in
  sessionStorage, rather than the prototype's shared key.
- **Navigation and content:** Existing configured tab labels, order, OpenAPI tag
  groups and authored content are preserved. The API section is generated only
  when configured. Response tabs use documented statuses; authored language menus
  offer the samples actually provided by the author. Generated requests offer
  cURL, Node.js, Python, Go, Ruby, PHP and the existing Java generator.
- **Assistant actions:** Generated request cards ask the supplied language-specific
  explanation question without forwarding edited request values. Live modal code
  has copy controls; credentials are never included in an assistant prompt.

Starter generation remains governed by the existing immutable-release workflow:
canonical synchronization requires a clean, committed runtime source. Candidate
source changes do not alter the published scaffold or upgrade existing sites.
