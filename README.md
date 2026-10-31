# Bounty

A UK resale and savings planning workbench. It helps one person decide whether a specific shopping trip can save money, or earn enough from resale to be worth their time, using their own budget, transport, carrying limit, storage, cash date and hourly floor. Vite, React and TypeScript serve the interface. A local Node API calculates trips and stores evidence and outcomes in SQLite. Separate workers import price evidence.

This is a single-user pilot that runs on your own computer. Nothing in it guarantees stock or a sale, and the figures it shows are estimates until a trade is reconciled in the Ledger.

## Run locally

Requires Node 24 or newer. From the project root:

```sh
npm ci
npm run worker   # import public UK observations from Open Prices
npm run dev      # API on 127.0.0.1:4174 and the app on http://127.0.0.1:5173
```

Run `npm test` and `npm run build` to verify. Other commands:

- `npm run worker:loop` repeats the Open Prices import every six hours, with retries.
- `npm run research -- <source> <query or file>` runs a credentialed lookup or a file import: `awin feed.csv`, `hobnight <barcode or text>`, `keepa <ASIN>`, `ebay <barcode or text>`, `sales sales.json`. Add `--refresh` to bypass the local cache. See [SOURCES.md](docs/SOURCES.md).

Copy `.env.example` to `.env` only if you have partner credentials. Credentials stay on the server side and never reach the browser.

## Where data lives

Everything is stored under `.data/` in the project (override with `BOUNTY_DATA_DIR`; keep a custom folder outside the project or name it `.data`). The folder is readable by your user only (mode 0700) and `desk.sqlite` is mode 0600, because it holds private notes, ledger amounts and member details. Ledger proofs are stored in `.data/proofs/` and shelf photos in `.data/report-photos/`, after location and other metadata are removed. No API route serves these files, and the dev server refuses to serve `.data/` or any SQLite file. Only a few per-browser conveniences (the profile, your stricter thresholds, the audit's pilot locality) are kept in the browser.

## Evidence classes

Bounty never pools these:

- **Retail offers**: what it costs to acquire an item (a shelf price, a feed or a catalogue). An affiliate feed or online catalogue never establishes branch stock; only a dated branch check in the right locality does.
- **Active asking prices**: what competitors hope to get. They measure resale competition and are never used as sale prices.
- **Completed sales**: what a buyer actually paid, including buyer-paid postage. Only these set a sale price, and only when they match the exact item (barcode, size, pack, model and condition). Independent sales count distinct named sellers; a listing id is not a seller.

Open Prices observations (ODbL) are kept apart from licensed feed data. Claimed previous prices and recommended retail prices from a feed are shown for comparison and never used as the cost.

## What the tabs do

- **Planner** models four illustrative Leeds offers, labelled as sample data, which can never become a buy alert. It applies your cash, transport (walking, cycling, public transport fare, car or van cost per mile, parking), carrying limit, storage, fees and stricter thresholds. Each card shows cash required before payout, fees, returns allowance, travel shared across units, parcel costs, contribution, active hours, time until payment, earnings per hour, the loss if nothing sells, the break-even sale price, access needs, when price and stock were last checked and the main uncertainty. A first purchase is capped at a trial batch and by the demand the evidence supports. Offers that fail the price band or weight limit are listed separately with the reason. "What changes if I drive?" compares the same trips by car (or by public transport if you drive), including mileage, parking, total load and trips that only work one way.
- **Goals** holds your dispatch days, storage, cash date, payout timing and monthly target, plus named goals with optional deadlines that count only cash received (payouts less costs) by their date. It compares baskets as one shopping trip under one cash limit, and shows realised earnings, household savings after trip costs, pending payouts and potential proceeds from live trips as separate figures.
- **Research** lists imported evidence by class, matches a barcoded offer to completed sales of the exact variant, lets you confirm attributes the source left blank after looking at the item, and shows the claimed, observed and sold prices side by side. It estimates a trip with category rules, the opportunity tier, the payout date and the full buy-alert checklist. The journey cost and time must be entered; a blank journey is never free.
- **Validation audit** (at the foot of Research) tracks the 30-item validation for the pilot locality (one London borough, still to be chosen). Each item is judged on the stored evidence, and anything you typed that disagrees with it is shown as a contradiction.
- **Bounties** shares a checked opportunity with local members. Distribution is capped by evidenced shelf units, sales and competing listings, and unknown competition means no distribution. Claims reserve attention, never retailer stock. Every check is re-run live: a lapsed stock check, an expired offer or an empty-shelf report stops claims at once, and members who were alerted or hold a claim get a "Don't make the trip" notice. Each member confirms their own promotion eligibility, their stricter thresholds apply to their alerts and claims, and an unproven item is limited to one trial batch per member. Members buy and own the stock and carry the risk; bounties pay no reward. Paid early access and earned reputation are shown separately, sponsored bounties are labelled, and every card warns when the locality has not been validated.
- **Ledger** reconciles each trip from receipt to sale, payout, expenses, returns and working time, against the prediction it started from. A trade counts as verified only when each receipt and each payout has its own proof attached, there is a sale, and the records reconcile. Sample predictions never count in potential proceeds or forecast accuracy, and household savings are never counted as earnings.
- **Sources** shows each source's readiness, licence, recent import runs and display permissions, plus the dated Open Prices observations with attribution.

## Opportunity rules

The agreed buying thresholds are £5 to £50 purchase price per unit, under 2 kg, at least £5 profit per unit after variable costs (including the unit's share of travel), at least a 35% return on the purchase price (compared exactly, never rounded up), several recent independent sales of the exact item, and a trial batch of three for a first purchase. You can tighten these for yourself but not loosen them, and the same stricter thresholds apply in every tab. Category rules apply on top: clothing needs a size and a returns allowance of at least 15%; food needs its packaging checked and at least 30 days left on the best-before date after the expected sale. Each opportunity is placed in one of five tiers: Priority 1, Priority 2, Watch (with the purchase price that would qualify), Review or Reject.

A buy alert needs every check to pass on positive evidence: live data, an exact match, a journey you entered, positive contribution, your hourly floor, a fresh offer, confirmed branch stock, promotion eligibility (or costing at the regular price), a known parcel cost, at least three independent completed sales in 90 days, a payout before the date you need the cash, display permission, Priority 1 or 2, and a trial-sized batch. Anything missing fails closed.

## Not built yet

- Accounts and authentication. Members, the operator and visitors are chosen on this computer, so keep the API on localhost.
- Membership billing. Paid tiers are recorded by the operator, and tier names, windows and prices are still open decisions.
- Alert delivery. Alerts and "Don't make the trip" notices are recorded in the app; nothing is sent by email or text.
- Credentialed sources. Hobnight, Keepa and eBay Browse adapters are built and checked against their published specs and live endpoints, but have not been run with real credentials. There is no automated source of completed eBay sales; they are recorded by hand. See [INTEGRATIONS.md](docs/INTEGRATIONS.md).
- Linking verified Ledger trades back to an item, so every item is still held to a trial batch.

## Documents

[Product requirements](docs/PRD.md) · [Architecture and module contracts](docs/ARCHITECTURE.md) · [Source register, credentials and import commands](docs/SOURCES.md) · [Integration verification register](docs/INTEGRATIONS.md)
