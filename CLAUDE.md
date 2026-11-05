# Working on Bounty

Bounty is a UK reseller app: find items in shops that sell for more than they cost, then decide whether the trip is worth it. The owner is Edem, who is not a developer.

## Rules from Edem

- Ask before building, merging or deploying. Show a plan or mock first and wait for a clear yes.
- Never delete files without listing them and getting a yes. Prefer moving old things aside.
- British English. No em dashes, few en dashes. This applies to UI copy, docs, commits and replies.
- Write replies in plain words. Name what a thing does ("Keepa, Amazon price history"), not its variable name.
- Made-up figures must always be labelled as examples. Never let sample data look like a real deal.
- Travel and other trip costs are an added layer on a deal. They never hide, block or reorder a find.
- Keep usage low: few parallel threads or agents unless asked.

## Layout

- `apps/web/` website (React 19, TypeScript, Vite 7). The current shell is `src/proto/App.tsx`; `src/main.tsx` mounts it. Build new screens from the kit in `src/ui/kit.tsx` (Radix based, windows not drawers).
- `apps/server/` Node API (`api.mjs`, routes in `app.mjs` and `routes-*.mjs`), storage in `db.mjs` (node:sqlite), sign-in in `accounts.mjs` (Neon). Tests are `*.test.mjs` beside the code. Sample data: `catalog.mjs`, `sample-deals.mjs`, `sample-tips.mjs`; remove for launch.
- `apps/mobile/` Expo phone app. `packages/shared/` for code both apps use.
- `api/index.mjs` the Vercel function; it imports from `apps/server/`.
- `e2e/` browser tests; `e2e/harness.mjs` starts both apps on free ports.
- `docs/` the master copy of product documents. Index: `docs/README.md`. Known leftovers: `docs/STALE.md`.

The root `package.json` holds every dependency and script for the web and server apps. The mobile app has its own `package.json`.

## Commands

The container's default Node is 22; Bounty needs 24:

```sh
export PATH=/opt/node24/bin:$PATH
npm ci
npm test          # server tests, must all pass
npm run build     # tsc + vite build into apps/web/dist
npm run dev       # API 127.0.0.1:4174 and website 127.0.0.1:5173
NODE_PATH=/opt/node-tools/node_modules npm run e2e   # browser tests (see docs/STALE.md)
```

After merging CSS, check the braces balance and look at `vite preview` at 1440 px: an unclosed media query once hid the whole desktop layout while dev mode looked fine.

## Pull requests

- Branch from `main`; the live demo (bounty-nu.vercel.app) deploys from `main`.
- Vercel preview links sit behind Vercel sign-in, so show Edem screenshots or the live link after merge.
- Edem has ChatGPT review pushes, looking for anything that could send someone on a wasted trip or overstate earnings. Put technical detail (ids, test counts) in the PR description, not in replies to Edem.

## Outside the repo

The claude.ai project Library (`/mnt/project-files/` in cloud sessions) holds images, logos, mock-ups and research notes. Its `README.md` is the map.
