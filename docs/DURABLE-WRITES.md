# Durable writes and recovery review

Prepared 10 November 2026. This is an isolated implementation and synthetic test report, not a deployment approval. No customer accounts, receipts, Stock or Money records were read or changed. No Neon connection string was used.

## Baseline and confirmed failures

Main was inspected at `f88a857c0f236af956215b22cfcaa4c699b14053`, after PRs #30, #26 and #28. Its `keep.mjs` still contained the reported post-response save, swallowed save/version errors and cached failed restore. Later main changes had not fixed them.

The old store also uploaded and deleted files *before* its version compare-and-swap. Rejecting the version bump could not undo those writes. Restore fetched version, file list and individual files in separate statements, so those reads had no common database snapshot.

| Scenario | Controlled baseline evidence | Corrected behaviour and evidence |
| --- | --- | --- |
| Paused save | HTTP 201 arrived while persistence was held at a barrier | No response is released until commit returns; loopback HTTP regression |
| Unavailable storage | HTTP 201 followed by an empty goal list in a fresh instance | HTTP 503; failed local edit is discarded; later requests recover |
| Lost purchase | Real ledger receipt-entry route returned 201, but the entry was absent after restart | HTTP 503; established trip and entries remain unchanged |
| Failed version lookup | Request continued and returned 201 despite the injected lookup error | Handler is not called; 503; later request can restore and proceed |
| First restore fails | The same instance repeatedly awaited the rejected startup promise | Next request retries restore; separate API startup retry test covers connection/setup failures |
| Stale writer | Native PostgreSQL with the old store: rejected version bump left the loser's file in place | Losing transaction changes no uploads, deletions or version; 409 through the HTTP layer |
| Interrupted multi-file save | Native PostgreSQL with the old store: new database bytes and old receipt bytes remained at the old version | Injected PostgreSQL trigger failure and deliberate backend termination both roll back every file and version |
| Concurrent requests | Additional coverage beyond the original sequential tests | One-instance requests/readers queue; two instances get one 201 and one 409; reload and deliberate retry preserve both accepted changes |
| Database row-lock race | Not previously covered | Two native PostgreSQL sessions: loser waits on the version row, rechecks the predicate after the winner commits and returns no version; no file changes |
| Lost acknowledgement after commit | Additional coverage | 503 with `save_not_confirmed`; next request restores the committed record exactly once; the server does not replay the mutation |
| Corrupt/unsafe restore | Additional coverage | Decompression/path failure leaves the old cache files intact; later valid restore succeeds |
| Member isolation and restart | Additional coverage | Two synthetic members' separate Money goals, Stock trip/entry and uploaded PDF receipt bytes survive a fresh instance |
| PostgreSQL process restart | Additional coverage | Committed snapshot and existing receipt survive shutdown/restart; interrupted changes do not appear |

The five HTTP regressions were run against the pinned old module and all failed for the expected safety assertions, including the lost purchase. The native lab also executes the pinned old store to demonstrate the stale overwrite and mixed-file interruption.

## Transaction and response boundary

`postgresKeepStore.commit(expectedVersion, puts, drops)` sends one PostgreSQL statement. Its `advanced` CTE updates the singleton version row only if the expected version matches. Both file upserts and deletions depend on the returned row. PostgreSQL executes this as one transaction. An error rolls back the version and every file operation. A stale writer gets no returned row and performs no file changes.

`store.snapshot()` reads the version and every compressed file in one statement snapshot. The existing `bounty_keep` and `bounty_keep_files` tables and compressed file format are retained. Initialisation uses `CREATE TABLE IF NOT EXISTS` and inserts the singleton at version zero only if absent. Existing versions/files are not reset or migrated. The tests include an existing version 41 snapshot and a legacy version-zero store with files.

The keeper serialises *all* access to an instance's cache, including reads and imports. It captures the API's JSON status, headers, cookies and body, checkpoints the SQLite databases, commits changed files atomically, then publishes the response. It does not wait for HTTP `finish` and try to report an error afterwards. The response adapter supports the API's current `setHeader`, `writeHead`, `end` contract; adding streaming responses requires a separate design. Buffered responses have a 16 MiB limit.

A refused handler, thrown handler, failed checkpoint, commit error or conflict invalidates the in-memory handles. No later request can save that failed local mutation. Restore downloads and validates the complete snapshot into a sibling temporary directory before closing handles or swapping directories. A failed download/decode preserves the prior cache. Failed startup/restore promises can be retried.

Detached imports are removed from durable mode. `freshPrices(..., { wait: null })` keeps the import and refresh under the request's cache lock until completion. External mutations must use `keeper.change(fn)`, which refreshes first and owns the queue through mutation and commit. The old mutate-then-`changed()` notification API is removed; there are no remaining production callers.

## Account behaviour and ambiguous outcomes

PR #32 completes the common account/snapshot transaction and re-enables email changes, deletion and plan changes. Account rows, tokens and sessions use the same request-owned PostgreSQL connection as the snapshot commit. Only a COMMIT command acknowledgement releases success or cookies. Account failures and snapshot conflicts roll back together. See [LAUNCH-FIXES.md](LAUNCH-FIXES.md) for the design, additional tests and remaining acceptance work.

A connection can fail after the server commits but before the caller receives its acknowledgement. `503 save_not_confirmed` means the outcome is unconfirmed. The mobile purchase endpoint now persists a request identifier and can safely return the existing purchase on retry. Other operations still require checking current records before manually retrying; the server never automatically replays handlers.

Email is attempted after commit and is described as requested, not confirmed delivered. A crash can prevent delivery, and the member can request another link. Authenticated hosting cannot disable snapshots with `BOUNTY_KEEP_DATA=off`.

## Verification

PR #31 results on Node 24.22.1 (the current follow-up results are in [LAUNCH-FIXES.md](LAUNCH-FIXES.md)):

- `npm test`: 631 passed, no failures or skips. Includes six SQL tests using embedded PGlite, fifteen HTTP/cache durability regressions, existing persistence tests, import completion and API startup recovery.
- `npm run build`: passed. Existing large-chunk warning remains.
- Native PostgreSQL 18.6 lab: four scenarios passed (five node:test results including the parent). Includes actual independent server connections, a row-lock wait, backend termination and database process restart.
- `git diff --check`: passed.
- Browser suite: attempted, but not locally verified. The bundled Playwright browser was absent, its download failed, and system Chromium could not create its process-singleton Unix socket (`Operation not permitted`). All 16 browser cases were blocked at browser launch, not assertion failures. The PR workflow installs Chromium on the GitHub runner and runs the suite there.

Run the normal checks:

```sh
npm ci --ignore-scripts
npm test
npm run build
```

Run the optional native lab (downloads a disposable PostgreSQL executable; never uses `DATABASE_URL`):

```sh
npm install --prefix /tmp/bounty-pg-lab --no-save --ignore-scripts embedded-postgres@18.6.0-beta.19
BOUNTY_PG_LAB_MODULE=/tmp/bounty-pg-lab/node_modules/embedded-postgres/dist/index.js node --test tools/keep-postgres-lab.mjs
```

The lab binds only to `127.0.0.1`, uses temporary synthetic data and removes its own cluster afterwards. Run as an ordinary user. It does not create system accounts. It requires git history containing the baseline commit for the old-code reproduction.

Re-run the five expected failures against the old implementation without changing the checkout:

```sh
git show f88a857c0f236af956215b22cfcaa4c699b14053:apps/server/keep.mjs > /tmp/bounty-legacy-keep.mjs
BOUNTY_KEEP_TEST_MODULE=file:///tmp/bounty-legacy-keep.mjs node --test --test-name-pattern='durability: (no HTTP|unavailable storage|a failed version|the same instance|a purchase entry)' apps/server/keep.regression.test.mjs
```

`.github/workflows/durable-snapshots.yml` runs server tests, build, the native PostgreSQL lab and browser tests on pull requests, with read-only repository permissions and no production secrets. `vercel.json` disables automatic deployment of `fix/durable-snapshot-recovery` before its first push.

## Outstanding deployment risks and approval gate

This PR is reviewable, not approved to merge or deploy. In particular:

1. **No mixed old/new writers.** Old deployed instances can still write files without the atomic gate. All legacy writers, previews and workers using the same tables must be drained or denied write access before a future cutover. Changing main alone is not a safe rolling deployment. Rolling back to the old implementation while writes are enabled is unsafe.
2. **Existing damage is unknown.** No live data was inspected. This patch cannot reconstruct records already lost by the old implementation or prove an existing snapshot is coherent. Preserve backups and any recoverable local caches before attempting reconciliation.
3. **Neon/Vercel acceptance remains unverified.** Native PostgreSQL validates SQL and locking, but not Neon's HTTP transport, service limits, Vercel termination/freeze behaviour or production-sized snapshots. Aggregate snapshot reads, gzip CPU/memory, response size and whole-folder write contention need a disposable Neon database and a separately authorised staging deployment.
4. **Latency changes.** Reads now queue behind writes/imports. Durable-mode imports no longer detach after 20 seconds. An import exceeding Vercel's 60-second function budget can fail the request without acknowledging it. A separately designed import worker and relational storage are longer-term options.
5. **Account and operator acceptance.** PR #32 supplies the shared transaction, but transport and failure acceptance must run on isolated Neon/Vercel staging. Existing operators must verify mailbox ownership. Email delivery remains an external side effect.
6. **Browsers and CI.** Check the actual PR run before merge. The local browser suite was environment-blocked; a checked-in workflow is not itself evidence that CI passed.

No production action is requested or taken by this report. A later approval request must identify the exact reviewed commit, affected Vercel project/deployments and Neon branch, backup/recovery evidence, the proposed write-pause and legacy-writer drain, staging tests, cutover and rollback steps. Obtain Edem's explicit approval for those concrete actions before merging, deploying, changing production access or touching customer data.
