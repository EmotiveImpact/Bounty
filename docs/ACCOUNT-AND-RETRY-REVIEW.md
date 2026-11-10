# Account sessions and ledger retries

PR #34 builds on draft PR #33 (parent `a6c501da48984869027285aa31d850336e20e700`). All work uses isolated synthetic records. Nothing has been merged, deployed or run against customer data. Automatic deployment of this branch is disabled.

## Confirmed failures and corrections

| Finding | Evidence | Correction |
| --- | --- | --- |
| Retrying web trip or entry creation duplicates Stock/Money records after a lost response | Four regression cases fail on the pinned parent. Eight simultaneous HTTP retries create eight trips. Reopening a synthetic SQLite database and retrying creates another trip. | Store a request identifier, canonical payload hash and resulting row ID in the same SQLite transaction as the write. These travel in the same durable snapshot. Identical retries return the original ID; changed payloads return 409. Tombstones prevent deleted entries being silently recreated. |
| Mobile session lookup can resurrect a previous member after sign-out | Original provider executed with deterministic hooks and deferred fake API responses. | Session generation checks ignore outdated reads; overlapping account changes are rejected. Foreground checks cannot race cookie-changing requests. |
| Failed mobile session check retains private identity | Original provider executed with an unavailable fake account API. | A failed check removes private identity and shows a reconnect/retry screen. Account-ID keys remount screens and menus after identity changes. Failed sign-out remains an explicit error. |
| Stock amount field silently accepts malformed comma prices | The old form removes every comma before converting pounds; `1,2` becomes £12. | Use the existing strict pounds parser in Stock, full ledger records and trip completion. Browser regression covers rejection without a record being created. |
| Proof upload failure says the already-recorded entry was not saved | The entry and optional proof are separate requests; the previous catch displayed “Not saved”. | Explain that the entry exists and the proof failed. Same-form retry uses the existing entry ID through server deduplication. |
| Truncated receipt files and symbolic links are accepted by filename alone | Two controlled synthetic tests fail on the pinned parent. A partial PDF is acknowledged, and a linked file can have its target permissions changed. | Verify an existing regular file through a no-follow descriptor, checking size and SHA-256 before accepting it. Preserve suspect bytes and refuse the upload. |
| Tiny input chunks escape byte-only memory accounting | Each chunk retains an array entry and promise callback regardless of byte size. Synthetic tiny/empty chunk tests exercise the new bound. | Cap chunks at 4,096 per request in addition to existing byte, count and time limits. Release reservations on rejection; normal subsequent requests work. |

## Verification

- `npm test`: 674 passed, zero failed/skipped, including four new ledger, two proof-storage, seven mobile session and one fragmented-body regression.
- `node tools/account-retry-before.mjs`: four ledger failures, two proof-storage failures and two mobile provider state failures reproduced on pinned PR #33. The script expects those failures, uses a temporary checkout, and makes no external API requests.
- Native PostgreSQL lab: seven passed, including interrupted saves, stale concurrent snapshots, lost commit acknowledgements, lock timeouts and database restart.
- Web TypeScript and Vite build passed. Existing bundle-size warning remains.
- Mobile Expo 58 lint, TypeScript and isolated web export passed. Export API points to loopback port 9.
- Browser regressions added for lost trip/entry acknowledgements, distinct subsequent entries, malformed prices and a failed proof followed by retry, at 390 and 1280 px. Remote CI result will be recorded before completion.

## Behaviour and limits

Request IDs are per explicit form submission, retained across retries in the still-open form and changed after confirmed success for a new record. Server deduplication survives process restarts. All shipped web trip/entry creation paths now supply IDs, including Planner, Research and multi-item trip completion. The mobile atomic purchase endpoint already has its separate persisted request IDs.

Older clients omitting a request ID remain compatible and do not gain retry protection. Closing/reloading a form discards its in-memory intent, so manually re-entering a transaction is a new save. Changed details after an uncertain save are refused if the first save committed; the member must check Stock. Optional proofs and multi-item trip completion remain separate transactions: an interrupted group can be partial, but retrying the same open form does not duplicate completed rows. A durable cross-reload submission queue and atomic batch completion remain follow-up work.

Mobile provider state and navigation wiring were checked locally; native iOS/Android cookie, AppState, navigation and reconnection acceptance still require real devices. Same-account successful foreground checks preserve drafts. A failed check deliberately removes mounted private screens and their unsaved in-memory drafts. AppState callbacks do not guarantee the OS application-switcher snapshot is obscured.

Request chunk caps bound per-request object overhead; they are not distributed denial-of-service protection. Invitation guessing, rotating-address abuse and deliberate password-budget exhaustion still need an edge/trusted-client strategy. Arbitrary forwarded-IP headers must not be trusted. Hosted firewall/rate-limit configuration, repository/hosting MFA and access review, isolated Neon staging acceptance and backup restoration drills remain unverified and require separately proposed actions and approval before any deployment or live change.

The new SQLite request table is additive. No existing accounts, receipts, Stock or Money rows are rewritten or deleted. Review PRs in order #31, #32, #33, #34. No PR is approved for deployment merely because synthetic tests pass.

Proof verification refuses existing partial/corrupt files instead of silently accepting or overwriting them. Recovery of a suspect real receipt needs a reviewed action with a backup. This is not a claim of atomic local-filesystem publication or a physical power-loss test; the hosted durability boundary remains the acknowledged Neon transaction.
