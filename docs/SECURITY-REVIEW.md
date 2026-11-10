# Security review in progress

This branch builds on PR #32. Scope: account takeover, cross-member access, request isolation, uploads, browser boundaries, dependencies and deployment configuration.

Only isolated synthetic tests are authorised. No production probing, live customer records, merge or deployment. Each confirmed finding needs source evidence, a regression test, a correction and explicit verification limits. This is a direct source audit; the hosted security scanner and its capability preflight are unavailable in this session.

Status: review and controlled reproduction in progress. Findings and coverage will be recorded here. Automatic Vercel deployment is disabled for this branch.
