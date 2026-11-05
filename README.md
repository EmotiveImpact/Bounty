# Bounty

Bounty helps UK resellers find items in shops that sell for more than they cost, and work out whether a trip to buy them is worth it after fees, postage and travel. It is for casual flippers and full-time resellers alike.

The live demo is at https://bounty-nu.vercel.app and deploys from `main`. Nothing in it guarantees stock or a sale; the figures are estimates, and the sample deals are made up and labelled as such.

## What is where

This is a monorepo: one repository holding every part of Bounty.

| Folder | What it is |
| --- | --- |
| `apps/web/` | The website: React, TypeScript and Vite. Screens in `src/`, pictures and fonts in `public/`. |
| `apps/server/` | The API and the price importers: plain Node, SQLite locally, Neon for sign-in. Tests sit beside the code as `*.test.mjs`. |
| `apps/mobile/` | The Expo phone app (being started). |
| `packages/shared/` | Code both apps will share, such as the money maths and buying rules. Empty for now. |
| `api/` | The one small file Vercel needs to run the server online. |
| `e2e/` | Browser tests that start the server and the website together. |
| `docs/` | Product requirements, how it works, architecture, sources, hosting. Start at [docs/README.md](docs/README.md). |

AI assistants: read [CLAUDE.md](CLAUDE.md) first.

## Run it on your computer

Needs Node 24 or newer.

```sh
npm ci
npm run worker   # import public UK prices from Open Prices
npm run dev      # API on 127.0.0.1:4174, website on http://127.0.0.1:5173
```

| Command | What it does |
| --- | --- |
| `npm test` | Server tests. |
| `npm run build` | Type-checks and builds the website into `apps/web/dist`. |
| `npm run e2e` | Browser tests in Chromium at 390 and 1280 px. Uses a Playwright found on `NODE_PATH`; skipped with a note when there is none. |
| `npm run worker:loop` | Repeats the Open Prices import every six hours. |
| `npm run research -- <source> <query or file>` | A credentialed lookup or file import. See [docs/SOURCES.md](docs/SOURCES.md). |

Copy `.env.example` to `.env` only if you have partner credentials. Credentials stay on the server and never reach the browser. Local data is kept in `.data/` (see [docs/HOW-IT-WORKS.md](docs/HOW-IT-WORKS.md)).

## Putting it online

The website and API run on Vercel (`vercel.json`, `api/`). A small always-on server for data that lasts can run on Railway (`Dockerfile`, `railway.json`). See [docs/DEPLOY.md](docs/DEPLOY.md).
