# Security boundary review

PR #33 builds on the unmerged PRs #31 and #32. Reviewed parent: `5e33fd0e79ff5c313415ec8976d340a28720d4c7`. This is a direct source audit and isolated regression work, not a completed hosted scanner run or a production penetration test. The hosted scanner and its capability preflight were unavailable.

No merge, deployment, live customer records, production probing or account changes were performed. Automatic Vercel deployment is disabled for all three repair branches. These changes do not protect a running deployment until an explicitly approved rollout.

## Findings and corrections

| Finding | Severity and evidence | Correction and verification |
| --- | --- | --- |
| Slow POST owns the global write lock before its body arrives | High availability risk. Reproduced on the parent: a partial loopback request entered the account transaction and blocked an unrelated read. | `request-intake.mjs` buffers the complete body before entering the snapshot queue. Ten-second total intake deadline, 7 MiB per body, 16 MiB combined buffered data and 32 pending requests per instance. Existing tighter route limits still apply. Regression proves unrelated reads continue; slow, oversized, interrupted and capacity-exhausting requests release their reservation. |
| Database lock waits have no application limit | Availability hardening. No production lock exhaustion claimed. | Request transactions set a five-second lock timeout and fifteen-second statement/idle transaction timeouts. Failures roll back through the existing durable-response boundary. Native PostgreSQL durability tests remain passing. |
| Failed web sign-out is displayed as success | High on a shared device. Source confirmed; browser reproduction and corrected-path results are recorded in CI. The previous UI ignored network errors and HTTP failures. | Only a successful server response completes sign-out. Failed requests retain the identity and display an explicit warning that the session may still be active. |
| Private browser state and drafts survive account changes | High on a shared device. Source confirmed; browser reproduction and corrected-path results are recorded in CI. | Session lookup gates private screen mounting. Identity changes reload the document, dropping private component and plan-cache state. Drafts use the immutable account ID, hashed into a storage namespace. Guest drafts stay in memory. Tab/focus/visibility/history restoration recheck the session. Same-account checks hide, rather than unmount, the screen so unsaved forms survive. |
| Custom private folders can be served by the development server | High confidentiality risk when a development server is reachable. Reproduced with a synthetic receipt in a custom folder under the Vite root: the parent returned HTTP 200. | Vite denies the configured data directory and its resolved path. Corrected tests return HTTP 403 for raw, import and normal file requests while the app still opens. This is a development-server finding, not evidence of a live Vercel receipt leak. |
| Confirmation-email sending has no shared budget | Moderate abuse risk. Direct calls can issue unlimited messages/tokens on the parent. | Three confirmation emails per address per hour, using the existing shared durable rate store. The explicit resend route returns 429 instead of hiding the limit; synthetic two-instance tests confirm the limit and recovery. No real emails sent. |
| Vulnerable dependencies | Registry audit identified one moderate root advisory and ten mobile dependency findings propagated from two moderate advisories. | CSV parser updated to 7.0.3. Mobile overrides target affected glob versions at 14.0.2 and minimatch versions at 11.0.1 without downgrading Expo 58. Both complete dependency audits now report zero known findings. Lint, TypeScript and isolated Expo web export pass. Native packaging/device acceptance remains a gate. |
| Ambiguous CSV headers | Data-integrity hardening. Duplicate price columns previously allowed a later value to replace an earlier one. | Reject duplicate and prototype-related column names. Existing imports pass. The parser's prototype-replacement regression passes. The published exploit requires grouped duplicate columns, which Bounty did not enable; application-level exploitation is not claimed. |
| Missing browser framing restrictions | Defence in depth, not a demonstrated intrusion. | Proposed Vercel headers deny framing and plugins, restrict base URLs and referrer information, and mark content nosniff. This is a limited CSP, not a complete script-execution policy. Headers are not deployed. |

## Test evidence

Local synthetic checks on this branch:

- `npm test`: 659 passed, zero failed/skipped.
- `npm run build`: passed. Existing large-bundle notice remains.
- Native PostgreSQL lab: six passed, including concurrent sessions, killed backend, lost commit acknowledgement and process restart.
- Mobile Expo 58 lint, TypeScript and web export: passed. Export used loopback port 9 as its API URL and did not contact production.
- Root and mobile `npm audit --json`: zero known findings on 10 November 2026, including development dependencies.
- Parent reproduction: partial network body incorrectly entered the transaction; custom-folder receipt request returned 200. The corrected regression tests pass.
- Browser suite and pinned-parent browser reproduction run in the PR's GitHub Actions checks. Local Chromium cannot launch in this environment; no local browser pass is claimed. CI must be green at the exact reviewed commit before approval.

The parent browser reproduction creates a temporary checkout of the pinned parent, copies only the synthetic session test/harness, and expects all three known regressions to fail. The main browser suite must then pass on the proposed source. These expected parent failures are evidence, not waived failures in the corrected suite.

## Boundaries examined

Reviewed session creation/revocation, password/reset/verification paths, shared rate limits, operator and cross-member authorisation, personal SQLite selection, durable account/snapshot commit, upload size/type/path handling, fixed upstream request targets, React HTML rendering and browser storage. Existing tests cover unauthorised operator reads, member impersonation attempts, private-record isolation, CSRF/origin/Host checks, malformed uploads, stale versions and interrupted persistence.

Receipt uploads use restricted formats, magic-byte checks, bounded sizes and hash-derived filenames. They are not a malware-scanning service. PDF content is retained unchanged and no receipt-download route is currently exposed. Do not introduce public file serving or document execution without a separate review.

## Remaining release and operational risks

1. Obtain explicit approval for an isolated Neon/Vercel staging acceptance run, then test cold starts, actual proxy/cookie behaviour, duplicate retries, concurrent instances and the configured time/size limits with synthetic records. A slow 5 MiB photo may now need a retry on poor mobile connections.
2. Validate native iPhone/Android packaging, cookie persistence, logout/account switching, background/resume and camera journeys. The mobile dependency overrides passed static checks and web bundling, not a signed native release.
3. Existing unscoped browser drafts are preserved but hidden on hosted accounts because ownership is unknown. Confirm a member-led migration/export path before rollout. Never assign them automatically. Scoped browser storage is UI isolation, not encryption against someone with browser-profile or same-origin script access.
4. Review live hosting access, GitHub/Vercel/Neon administrator MFA, least-privilege database credentials, preview isolation, audit logs and secret rotation separately. Nothing in this source review establishes whether a deployment has been compromised.
5. Edge request/rate limits, signup/invite abuse controls, account storage quotas, dependency monitoring, backup/restore drills and incident alerting still need operational acceptance. Per-instance request limits do not stop a distributed denial-of-service attack. Account password limits can also be abused to temporarily lock out a known address.
6. A stricter script CSP needs a browser compatibility test covering barcode WebAssembly, workers and external images. This PR's framing policy does not claim complete XSS prevention.
7. Full snapshots and a global write lock remain a pilot scalability constraint. A planned move to row-level transactional storage and object storage needs a reviewed migration with verified backups and ownership mapping.

No finite review proves there are no bugs or that infiltration is impossible. Merge and deployment remain separate, explicitly approved actions.

## Dependency sources

- CSV parser: https://github.com/advisories/GHSA-8cw4-87c7-c6xx
- glob: https://github.com/advisories/GHSA-3g3m-2fjr-6pw4
- minimatch: https://github.com/advisories/GHSA-g3hv-75wg-m249
- Expo 58: https://docs.expo.dev/versions/v58.0.0/
