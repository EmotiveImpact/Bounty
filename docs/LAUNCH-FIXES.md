# Launch correctness review and fixes

10 November 2026. PR #32 is stacked on [PR #31](https://github.com/EmotiveImpact/Bounty/pull/31). Neither is merged or deployed. Main was inspected at `f88a857c0f236af956215b22cfcaa4c699b14053`; the follow-up baseline is PR #31 at `676a8481928e4e3995a87dce92c3404f0405e57f`.

All tests use synthetic accounts, receipts, SQLite files and disposable PostgreSQL. No live customer data, Neon credentials, email service or production deployment was accessed.

## Corrected behaviour

| Finding | Controlled evidence | Correction |
| --- | --- | --- |
| Admin UI before role lookup | Code review found the initial browser role defaulted to operator | Default to no Admin access until the server confirms the role; hide operator-only research controls from members; refresh the role after mailbox verification |
| Private operator reads | Signed-out permissions/evidence requests returned 200; permissions included a seeded private note | Evidence, permissions, checks and audit reads require an authenticated operator |
| Operator impersonation through URL | PR #31 returned 200 for signed-out `GET /api/bounties?viewer=operator` | Hosted viewer identity comes from the session; a query parameter cannot select another role or scout |
| Unverified operator email | PR #31 returned 200 from `/api/sources` after an unverified signup using an allowlisted address | Admin requires a configured email and verified mailbox ownership; changing email removes verification |
| Private scout data and alerts | PR #31 returned 200 for signed-out member alerts and exposed seller name, alert areas, profile, rules and paid status in the member list | Alerts require their owner or an operator; other users receive only public community fields |
| Outstanding reset links | A reset link still worked after changing the password | Password changes revoke all outstanding tokens and sessions; email changes revoke old verification/reset tokens; credential operations share a PostgreSQL transaction and lock |
| Per-instance rate budgets | Two account service instances sent six reset emails against a three-per-hour limit | PostgreSQL atomically shares reset and password budgets; refused requests do not roll back the budget |
| Account/snapshot split | The earlier safety fix refused email changes and deletion; plan changes also crossed stores | Account rows, sessions/tokens, linked profiles, personal files and the snapshot commit use the same request transaction. Email change, deletion and plan changes now work. Failure rolls all of them back |
| Caught SQL error before COMMIT | Native lab injects a failed token insert caught by signup; PostgreSQL can answer COMMIT with a ROLLBACK command tag | Only an actual COMMIT acknowledgement releases success or cookies |
| Decimal comma misread | Mobile `4,50` became 45,000 pence (£450) | Mobile purchases and web Money accept strict British currency syntax and reject ambiguous decimal commas, exponent notation and extra precision |
| Incomplete mobile purchase | Trip creation succeeded before a refused receipt left an empty trip | A single endpoint records trip, receipt and retry identifier in one SQLite transaction |
| Duplicate purchase on retry | Native lab deliberately loses the COMMIT acknowledgement, then retries through a fresh API instance | The persisted purchase identifier returns the existing record; changed payload with the same identifier is refused |
| Sample purchase contamination | The old phone payload recorded an illustrative £10 as real Stock and Money | Both phone entry points preserve the sample marker; sample price starts blank and the member must enter and confirm the actual purchase. The endpoint requires actual-purchase confirmation |
| Plan area limits | A downgrade kept excess areas; no plan permitted unlimited areas | Downgrade/cancellation trims saved areas and subsequent edits enforce the chosen plan's allowance |
| Misleading email message | Settings used provider configuration rather than delivery result to claim an email was sent | Settings distinguishes sent, requested and failed. Deferred mail is attempted only after commit; it is never reported as confirmed delivery |
| London date boundary | UTC date differed from the London day after midnight during summer | Money uses the London date when clearing expired cash deadlines |
| CLI imports outside persistence | Hosted imports wrote a disk cache independently of snapshot restore | CLI imports use separate temporary caches and the same versioned durable commit; no shared API file handles |
| Initial restore overwriting local records | Synthetic initial local receipt with an empty remote store | Refuse replacement by an empty remote snapshot. When a non-empty remote snapshot replaces an initial local cache, retain that initial copy beside the cache for review |
| Legacy shared records hidden by member routing | Old shared ledger stayed on disk while per-member screens appeared empty | Admin can inspect counts and download the retained records and proof metadata. Ownership is not guessed and no records are automatically reassigned |

## Transaction design

`account-transaction.mjs` uses a request-owned Neon Client connection, AsyncLocalStorage and a PostgreSQL advisory transaction lock. Nested account methods use that same connection. The keeper buffers the HTTP response, executes the handler, checkpoints SQLite, performs the existing atomic snapshot compare-and-swap and awaits PostgreSQL COMMIT before releasing the response. A refused handler rolls back account changes and invalidates local handles. A snapshot conflict rolls back the associated account changes too.

The existing compressed file format and account IDs are retained. Schema additions are additive: a shared rate-budget table and per-member purchase request identifiers. No destructive customer migration is part of this branch. `BOUNTY_KEEP_DATA=off` now refuses authenticated hosting rather than silently disabling record durability.

Rate budgets execute outside the request transaction so a wrong password still consumes an attempt after the request rolls back. A successful password confirmation clears its budget. The account advisory lock also covers standalone credential operations. Other snapshot writers still have the version gate; the lock does not replace compare-and-swap.

Mail is an external side effect. It runs after commit, with a ten-second request timeout. A crash after commit can prevent delivery; the user can request another link. No raw reset token is added to a persistent outbox. The UI says requested in this case, never delivered. Mail delivery and the database are not claimed to be one distributed transaction.

## Verification

- `npm test`: **649 passed**, no failures or skips.
- `npm run build`: passed; the existing bundle-size warning remains.
- Mobile `npm run lint` and `tsc --noEmit`: passed with the locked Expo 58 dependencies.
- Native PostgreSQL 18.6 lab: **five scenarios passed, six node:test results including the parent**. It covers the original stale-writer and interrupted-save reproductions, independent server-session row locks, killed backends, full PostgreSQL restart, account/snapshot rollback and recovery, lost COMMIT acknowledgement with purchase retry, shared password budgets and a swallowed SQL failure.
- New HTTP tests cover operator/private-read denial, verified operator identity, profile ownership, alert limits, atomic purchase validation, concurrent retries and database reopen.
- New unit tests cover nested transaction boundaries, deferred email, an explicit ROLLBACK command tag, failed actions and CLI import recovery.
- The new operator-view and no-plan-area tests were run before their fixes and failed with HTTP 200/201 instead of refusal. A separate synthetic PR #31 checkout confirmed the four privacy/privilege failures above.
- [GitHub run 42801030660](https://github.com/EmotiveImpact/Bounty/actions/runs/42801030660) passed all checks at `5a944a10548a116b8dbb5f080521d36980c441fe`, including all 16 browser tests. A further browser regression now checks that pending or ordinary-member role lookup cannot expose Admin. Check the latest PR run for that added test. Local Chromium remains unavailable because this environment denies its singleton socket.

Run the native lab using the command in [DURABLE-WRITES.md](DURABLE-WRITES.md). It always creates a disposable loopback PostgreSQL cluster and never reads a production connection string. The PR workflow also runs mobile lint/type checks without deployment credentials.

## Remaining release blockers and limits

This is not a claim that the entire product is perfect or ready for paying customers.

1. **Neon/Vercel and real devices:** native PostgreSQL verifies transaction semantics, but Neon WebSocket transport, Vercel freezes/timeouts, production-sized snapshots, physical iPhone/Android flows and actual mail delivery still require isolated staging acceptance.
2. **Cutover:** old snapshot writers must be drained before the new protocol is used. Existing previews, scheduled workers and old deployments must not write through the old code. Rolling back to old code while writes remain enabled is unsafe. Cross-instance account operations are serialised, so load and timeout testing matters.
3. **Existing records:** no live-data reconciliation has occurred. Legacy ownership remains unresolved. Admin export contains records and proof metadata, not proof-file binaries. A reviewed ownership map, preserved backups and explicit approval are required before copying legacy records into accounts. Initial local backups are retained, not automatically merged or uploaded.
4. **Operator verification:** existing allowlisted operators must have legitimately verified mailboxes. Review onboarding/recovery on staging before cutover, especially if email is currently disabled. This branch does not silently mark existing accounts verified.
5. **Other retries:** the mobile purchase endpoint is idempotent. Other manual ledger edits and account requests are not claimed to be universally replay-safe after a lost acknowledgement. Their error messages ask the user to check existing records; handlers are never automatically replayed.
6. **Product integrations:** payments remain deliberately switched off. Push/chat delivery, commercial feed entitlements and public legal/release content have not been proven complete by this work. Those require their own acceptance evidence.
7. **Scale:** whole-folder snapshots, compression, synchronous imports and the global account transaction lock suit a controlled pilot, not an untested high-volume launch. The build still warns about the existing web bundle size.

## Approval boundary

No merge, deployment, production access change or customer-data operation is authorised by this report. Automatic Vercel deployment is disabled for both development branches. A later proposal must name the exact reviewed commits, target Vercel project and Neon branch, backup/recovery evidence, writer-drain steps, staging checks, cutover and rollback procedure. Obtain Edem's explicit approval for those exact actions first.
