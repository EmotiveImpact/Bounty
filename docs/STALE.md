# Leftovers to sort out

Old parts found during the 4 November 2026 tidy-up. Nothing here has been deleted; each needs a yes from Edem first.

| What | Why it is stale | Suggested fix |
| --- | --- | --- |
| Browser tests in `e2e/` | They drive the old tab bar, which the new app shell replaced on 2 November 2026, so they fail on `main` (the smoke test fails with "expected the app's tabs"). | Rewrite them against the current screens (Deals, Tips, Scan, Stock, Money). |
| `apps/web/src/Deals.tsx` and `Deals.css` | The old Deals screen is no longer shown. Other screens still import its `Deal` type and `savedExtras` helper from it. | Move the shared type and helper out, then remove the old screen. Open PR #20 already trims most of it. |
| Older screens beside `src/proto/` (`Planner`, `Goals`, `Research`, `Bounties`, `Ledger`, `Sources`, `Audit`) | Some are still used inside the new shell, some only partly. The `proto` folder name is left from when the new shell was a prototype. | Once the open PRs settle, move the current screens into `src/screens/` and remove what is unused. |
| `docs/HOW-IT-WORKS.md`, "What the tabs do" | Written for the earlier tab layout. | Rewrite per current screen. |
| `docs/HOW-IT-WORKS.md`, "Not built yet" | Says accounts are not built, but sign-in with Neon was added on 2 November 2026. | Update the list. |
| `apps/web/public/campaign.jpg` | No longer used by the app. Open PR #19 removes it. | Let PR #19 remove it. |
| Sample data (`apps/server/catalog.mjs` offers, `sample-deals.mjs`, `sample-tips.mjs`, `apps/web/src/proto/examples.ts`, `apps/web/public/products/`) | Made-up items and photos for development. | Keep for now; remove before launch. |
