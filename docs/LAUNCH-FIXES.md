# Launch correctness work in progress

This branch builds on PR #31. It is isolated from production and must not be merged or deployed without Edem approving the exact proposed actions.

## Assigned scope

- Operator-only access to private research and audit data.
- Password/reset-token security and shared rate limits.
- Atomic, repeat-safe purchases and strict currency parsing.
- Prevent illustrative phone prices becoming real purchases.
- Safe recovery of legacy shared records with explicit ownership mapping.
- Complete account/snapshot transactions so email changes and deletion can work safely.
- Correct verification-email messages, London dates and downgraded alert limits.
- Continue reviewing related code and add failure-driven regression coverage.

Status: implementation and further review in progress. Test results and remaining release blockers will be added as work is verified. Live credentials, physical devices and deployment are outside the current tests. Automatic Vercel deployment is disabled for this branch.
