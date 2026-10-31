# Bounty

A UK resale planning workbench. Vite, React and TypeScript serve the interface. A local Node API calculates ranked trips and stores outcomes in SQLite. A separate worker imports public price observations.

## Run locally

Requires Node 24 or newer. From the project root:

```sh
npm ci
npm run worker
npm run dev
```

Open the local address printed by Vite (normally http://127.0.0.1:5173). The API listens on 127.0.0.1:4174. Run the worker again to refresh. Run `npm test` and `npm run build` for verification.

## What the screens mean

- **Planner** models three illustrative Leeds offers. Adjust capital, travel expense, transport, carrying weight, quantity and hourly target. Quantities reserve postage and packaging cash. Each card models an alternative trip, not a combined portfolio. Profit assumes all units sell. Sale prices, handling times, stock limits and fees are examples, not live eBay evidence.
- **Observations** shows one page of dated GBP observations from the UK imported from [Open Prices](https://prices.openfoodfacts.org/) under the [ODbL](https://opendatacommons.org/licenses/odbl/1-0/). Refreshes upsert by source ID. These records are historical retail evidence, not verified stock or resale recommendations.
- **Ledger** records user-entered total receipts, total costs and active minutes. It calculates realised contribution and hourly earnings. Entries are self-reported and shared within this single local workspace.

The local database is stored in `.data/` (override with BOUNTY_DATA_DIR). Profiles are saved in the browser. This pilot has no multi-user authentication, hosted scheduler or verified paid-provider access. Keep it local. A production release needs authenticated data isolation, licensed sold evidence, freshness and stock checks, and calibrated fees and postage.

## Requirements and sources
[Product requirements](docs/PRD.md) · [Feature backlog](docs/FEATURES.md) · [Source register, credentials and import commands](docs/SOURCES.md)

Open **Research** to inspect source readiness and imported retail, asking-price and manually recorded sales evidence. Use **Observations** for the separate Open Prices dataset. Optional adapters require your authorised feeds and credentials. Run `npm run worker:loop` for recurring public imports while the local process is running.
