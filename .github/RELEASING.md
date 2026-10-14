# Release the public runtime and starter

The normal production path has one operator action. After runtime or starter
changes are merged, run **Full release** from the `thally` Actions page, or run:

```bash
npm run release:full
```

The workflow resolves the current runtime `main`, synchronizes the standalone
starter, waits for its CI, merges the generated snapshot, creates and verifies
the immutable release record, publishes the scaffold packages through npm
trusted publishing, and waits for the managed scaffold promotion to complete.
A failed phase stops the controller and leaves its pull request or workflow
run visible for diagnosis. Re-running the controller is safe; already-stable
inputs are a successful no-op.

Before a candidate record PR is opened, the shared updater must upgrade the
outgoing stable scaffold and the oldest retained scaffold to the candidate.
The gate verifies framework and package parity, exact provenance, and owner
content preservation using immutable archives without executing their code.
The package verification job repeats this check before packing and attestation,
so manual recovery and directly reviewed record changes also fail before npm
publication when existing projects cannot upgrade safely.

The separate **Sync Thally runtime**, **Promote release**, and **Publish
packages** dispatches remain break-glass recovery tools.

## One-time coordinator setup

Create a GitHub App named `Thally Release Coordinator` and install it on the
repositories the release touches. Grant these repository permissions and
nothing else:

- Actions: read and write
- Contents: read and write
- Metadata: read-only
- Pull requests: read and write
- Issues: read and write (the release-record label only)

Generate one private key. Then configure the no-review `release-control`
environment in `thally` and `starter`, restricted to the `main` branch. Each
job mints a token narrowed to only the permissions it needs; the controller
cannot write source, and destination PR jobs cannot dispatch other workflows.
The branch restriction is the security boundary: workflow revisions on feature
branches cannot receive the App key. The workflow-dispatch click itself is the
release authorization.

```bash
export RELEASE_APP_CLIENT_ID='<github-app-client-id>'
export RELEASE_APP_KEY_FILE='/absolute/path/to/release-coordinator.private-key.pem'
export RELEASE_APP_ACTOR='thally-release-coordinator[bot]'

for repo in thally starter; do
  gh api --method PUT \
    "repos/thallylabs/$repo/environments/release-control" \
    --input - <<'JSON'
{"deployment_branch_policy":{"protected_branches":false,"custom_branch_policies":true}}
JSON

  if ! gh api \
    "repos/thallylabs/$repo/environments/release-control/deployment-branch-policies" \
    --jq '.branch_policies[] | select(.name == "main") | .id' | grep -q .; then
    gh api --method POST \
      "repos/thallylabs/$repo/environments/release-control/deployment-branch-policies" \
      -f name=main -f type=branch
  fi

  gh variable set RELEASE_COORDINATOR_CLIENT_ID \
    --repo "thallylabs/$repo" \
    --env release-control \
    --body "$RELEASE_APP_CLIENT_ID"

  gh secret set RELEASE_COORDINATOR_PRIVATE_KEY \
    --repo "thallylabs/$repo" \
    --env release-control \
    < "$RELEASE_APP_KEY_FILE"

  gh variable set RELEASE_COORDINATOR_ACTOR \
    --repo "thallylabs/$repo" \
    --env release-control \
    --body "$RELEASE_APP_ACTOR"
done
```

Keep npm trusted publishing bound to the existing `npm-production` environment.
Do not add npm or cross-repository PATs. The verified package workflow mints a
short-lived Actions-only token to hand the immutable release locator to the
managed scaffold promotion.
