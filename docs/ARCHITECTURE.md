# Bounty architecture and module contracts

This is the working contract between modules. Money is integer pence and time is minutes everywhere on the server; the client converts pounds at the edge. Dates are ISO 8601 in UTC (`YYYY-MM-DD` for calendar dates).

## Evidence classes

Defined in `server/contract.mjs` and never pooled:

| Kind                      | Meaning                                   | Used for                          |
| ------------------------- | ----------------------------------------- | --------------------------------- |
| `Retail offer`            | Price to acquire (shelf, feed, catalogue) | Acquisition cost                  |
| `Amazon offer history`    | Keepa Amazon-as-seller price series       | Research context only             |
| `Active asking price`     | A competitor's live listing               | Resale competition only           |
| `Reported completed sale` | Realised total including buyer postage    | The sold sample and sale estimate |

Open Prices observations (ODbL) live in the `observations` table, apart from licensed feed rows in `research`. An Open Prices observation with a barcode may be chosen as an acquisition offer (provider `openprices`, source id = Open Prices price id), but it is never copied into `research`.

An affiliate feed or online catalogue never establishes branch stock. Local stock is confirmed only by a dated availability check for the same barcode, retailer and locality (recorded through the check route, or written when the operator verifies a member's stock report). An unverified stock report or a validation audit item does not confirm stock, and a check that found none on the shelf counts against the trip.

## Layout

| Area                              | Server files                                                                                       | Client files                                |
| --------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| Shared foundations                | `contract.mjs`, `http.mjs`, `app.mjs`, `api.mjs`, `db.mjs`, `trip.mjs`, `alerts.mjs`, `opportunity.mjs`, `metadata.mjs`, `test-support.mjs` | `main.tsx`, `api.ts`, `style.css`           |
| Sources and ingestion             | `sources.mjs`, `evidence.mjs`, `worker.mjs`, `research.mjs`, `loop.mjs`, `routes-evidence.mjs`        | `Sources.tsx`                               |
| Matching, estimate, validation    | `matching.mjs`, `estimate.mjs`, `audit.mjs`, `routes-research.mjs`                                    | `Research.tsx`, `ResearchCalculator.tsx`, `Audit.tsx` |
| Planner, goals and baskets        | `catalog.mjs`, `goals.mjs`, `routes-plan.mjs`                                                         | `Planner.tsx`, `Goals.tsx`                  |
| Bounties and membership           | `bounties.mjs`, `routes-bounties.mjs`                                                                 | `Bounties.tsx`                              |
| Ledger and private proofs         | `ledger.mjs`, `proofs.mjs`, `routes-ledger.mjs`                                                       | `Ledger.tsx`                                |

`db.mjs` opens SQLite and calls `schema(db)` on `evidence`, `audit`, `goals`, `bounties` and `ledger`. Each `schema` is idempotent and migrates older local databases in place. Modules take `db` as a parameter and never import `db.mjs`, so tests run against an in-memory database built with `memoryDb(schema)` from `test-support.mjs`.

The API, the import worker and the loop can open the same file at once. `openDb` sets a 5 second busy timeout before switching to WAL, and runs every `schema` inside one `BEGIN IMMEDIATE` transaction, so a second process waits for the first rather than failing or adding a column twice. `transaction(db, fn)` joins an open transaction instead of nesting.

The data folder (`.data/` or `BOUNTY_DATA_DIR`) is created with mode 0700 and `desk.sqlite` with mode 0600, because it holds private notes, ledger amounts and member details. Ledger proofs (`proofs/`) and shelf photos (`report-photos/`) are stored under the same folder, mode 0600. No API route serves them, and `vite.config.js` denies `.data/` and SQLite files to the dev server, so they are not reachable over HTTP while `npm run dev` runs. Keep a custom `BOUNTY_DATA_DIR` outside the project, or name it `.data`.

## HTTP

`app.mjs` mounts every `routes-*.mjs`. A route module exports `routes(db)` returning `[method, pattern, handler, options?]`. Patterns use `:name` segments. Handlers receive `{ req, url, params, body }` and return JSON or `reply(status, value)`; client errors throw via `fail(message, status)`. `options.limit` raises the JSON body limit (default 64 KB).

The API answers only requests whose Host header is exactly `127.0.0.1`, `localhost` or `[::1]` (with any port), so a rebound domain or a numeric lookalike such as `0x7f.1` is refused. Writes are refused when the Origin is anything other than `scheme://` one of those hosts with an optional port (parsed as strictly as the Host header, so `null`, `evil-localhost` and numeric lookalikes are refused) or `Sec-Fetch-Site` is `cross-site`, and they need the media type `application/json` itself (a parameter that merely mentions JSON is refused), which a cross-site form cannot send without a preflight. The body limit counts bytes, and the body is decoded once, so a character split across network chunks is kept intact. `isoDate` rejects impossible dates with a 400. Responses are JSON, `no-store` and `nosniff`; unexpected errors return a 500 without details. It listens on 127.0.0.1 only.

## Trip economics (`server/trip.mjs`)

`journey({ mode, miles, fare, perMile, extra, minutes })` gives the cost and minutes of one return journey. `tripEconomics(input)` returns `units, sold, proceeds, costs{stock, packaging, postage, fees, returns, travel}, totalCosts, contribution, unitContribution, cashRequired, journeyPerUnit, activeMinutes, activeHours, hourly, unsoldLoss, breakEvenSale, allSellAssumed`. The journey is shared across units once. `cashRequired` is the cash that leaves before any payout. `unsoldLoss` is the loss if nothing sells. `lowerMedian(values)` is the cautious sale estimate.

## Buy-alert gate (`server/alerts.mjs`)

`evaluateAlert(input)` returns `{ eligible, reasons, checks }`. Every check must pass on positive evidence: live evidence, exact match, positive contribution, hourly floor, every required cost and time entered (`missingInputs` must be an empty list; a blank is never zero), the journey entered (`journeyKnown`), fresh offer (observed within 7 days and not in the future), confirmed branch stock, the latest branch check found stock, promotion eligibility (or costing at the regular price), known parcel cost, at least three independent completed sales in 90 days from distinct named sellers, a known time to sell (and, when a cash date is set, an expected payout on or before it, where 0 days is a real cash date), display permission, the buying thresholds (Priority 1 or 2), a trial batch of at most three units for an unproven item, and demand: no more units than `demandUnits` (the sales rate over `sellWindowWeeks`, 2, less competing listings; unknown fails). Planner fixtures always fail the first check.

`daysToSellAll` and `demandUnits` in `opportunity.mjs` are the shared helpers for the last unit's sale and for demand, and `londonDate(now)` in `http.mjs` is the shared "today" (UK date) for payout, cash-date and deadline counts.

The cash date is met by money received, so the input carries `payoutDays`: days from the decision to the expected payout, from `goals.payoutDate` (days to sell, then the next dispatch day, delivery and the marketplace payout delay). With a cash date and no payout estimate the check fails.

## Opportunity rules (`server/opportunity.mjs`)

`OPPORTUNITY_RULES` holds the agreed buying thresholds: £5 to £50 purchase price per unit, under 2 kg, at least £5 profit per unit after variable costs (including the unit's share of travel) and at least a 35% return on the purchase price, with a trial batch of three. `effectiveRules(overrides)` lets a member tighten these but never loosen them. `classifyOpportunity(input)` returns one of five tiers with reasons:

| Tier       | Meaning                                                                                        |
| ---------- | ---------------------------------------------------------------------------------------------- |
| Reject     | Fails a hard filter (price band, weight, or no purchase price would meet the thresholds)       |
| Review     | Evidence missing or uncertain (no exact match, too few sales, stale offer, sample data)        |
| Watch      | Evidence is fine but profit or return falls short; `targetPrice` is the price that would pass |
| Priority 2 | Passes, but stock is unconfirmed, demand weaker or pressure higher or unknown                 |
| Priority 1 | Passes with strong sold evidence, confirmed stock, quick sale and low pressure                |

Tests on the return use `meetsReturn(unitProfit, unitCost, minReturn)`, which compares in whole pence, so 34.95% fails a 35% minimum. `returnOnCost` is rounded down to three decimals for display, never up. `targetPrice` uses the same integer arithmetic.

Further inputs move an opportunity to Review rather than letting it reach Priority 2: `availability: "out_of_stock"` (the latest branch check found none), `promotionUnconfirmed` (the cost depends on a promotion the member has not confirmed and the regular price is unknown) and any `categoryFailures`. `categoryFailures` is required; when a caller leaves it out the tier is Review with "Category rules were not checked".

Category rules (`CATEGORY_RULES`, still to be confirmed by Edem) apply on top of the thresholds. Clothing needs a size, because demand and sales are size-specific, and a returns allowance of at least 15% (`categoryReturnsRate` applies the floor). Food needs its packaging checked as sealed, undamaged and fit to post, and at least 30 days left on the best-before date after the expected sale. `categoryChecks(input)` returns the failures and fails closed when a value is missing.

`MEMBERSHIP_TIERS` lists the early access tiers as data (names, release offsets and earned-point thresholds are still open decisions). `accessTier()` takes the earlier of a member's current paid tier and the tier their earned reputation unlocks, returning both so paid and earned status are shown separately.

## Uploaded images (`server/metadata.mjs`)

`stripMetadata(buffer, mediaType)` rebuilds an image from an allowlist of the parts needed to display it, so shelf photos and receipt pictures never keep location data. For JPEG it keeps the frame, tables and scans (following progressive files scan by scan), a JFIF header, an ICC colour profile and the Adobe colour flag; it drops Exif, XMP, MPF, maker notes, comments and every other application segment, and discards everything after the end-of-image marker, where motion photos keep their video and MPF files their secondary images. For PNG it keeps image and colour chunks only and stops at IEND. A file without a scan or an end marker is refused. PDFs pass through unchanged and the caller says so. Stored files are private, as described under Layout.

## Cross-module contracts

### `estimateFromEvidence(db, request)` in `server/estimate.mjs`

Request:

```js
{
  offer: { provider, sourceId },          // research row or provider "openprices"
  sales: [{ provider, sourceId }],        // sales the operator confirmed as the exact variant
  units: 1,
  costs: { postage, packaging, feeRate, feeFixed, returnsRate,
           journeyCost, journeyMinutes, overheadMinutes, handlingMinutes },
  hourlyFloor: 1200,                      // pence per hour
  promotionEligible: false,
  cashNeededDays: null, cashNeededBy: null, // days, or a YYYY-MM-DD date; the date wins
  locality: "London",                     // a branch check counts only for this locality
  now: "2026-10-31T12:00:00Z",            // the HTTP route always uses the server clock
  weightKg: 0.9,                          // kg per unit; missing rejects the opportunity
  rules: { minUnitProfit: 800 }           // optional member thresholds; only stricter values apply
}
```

Result: `{ offer, sample: { used, excluded: [{ row, reason }], count, independent, lowerMedian, newest, oldest, daysToSell }, competition: { activeListings, lowestAsking, sellers }, match, economics, alert }` where `match` is `"exact" | "research" | "none"`, `economics` is a `tripEconomics` result or `null` when no sale qualifies, and `alert` is an `evaluateAlert` result. Active listings are reported under `competition` and never enter `sample`. `opportunity` is the `classifyOpportunity` result (tier, reasons, unitProfit, returnOnCost, targetPrice, meetsThresholds, trialUnits) plus unitPrice, weightKg, salesPerWeek, resaleWeeksOfSupply, sourcingPressure (null at research time, so Priority 2 at best) and provenItem (false until verified trades are linked). `thresholds` is `{ rules, defaults, tightened, ignored }`. The alert's meetsThresholds, units and trialUnits come from the classification and the effective rules.

#### Additions after the review round

`estimateFromEvidence(db, request, { now })` keeps every field listed above; the changes are additive.

Request additions:

| Field | Meaning |
| --- | --- |
| `costs.journeyCost`, `costs.journeyMinutes` | Must be entered. 0 is accepted when it is sent, for example when walking. A blank one is never a free or instant trip: the gate gets `contribution: null` (cost blank) and `hourly: null` (cost or time blank), a `journey` check fails, the tier goes to Review (unless a hard filter rejects) and the warnings say which is missing. |
| `offerAttributes` | `{ size?, pack?, model?, condition? }` the operator confirmed after looking at the item. Each must be recognised by the matching normalisers (`normaliseSize`, `normalisePack`, `normaliseModel`, `normaliseCondition`) or the request is a 400. A value fills only an attribute the source left blank; it never replaces a stored value (a disagreement is reported in `offerAttributes.ignored` and as a warning). This is how an imported Awin, Hobnight or Open Prices offer, which never stores a pack (and Open Prices never a model), can reach an exact match. Nothing is written to the database: the confirmation travels with the request, so a bounty draft keeps it. |
| `category` | `"general" \| "clothing" \| "food"`. Missing means the offer's `suggestedCategory` (a clear clothing or food word in the title, otherwise general). |
| `packagingChecked`, `bestBefore` | Food checks, passed to `categoryChecks`. |
| `rules` | Unchanged, but only own keys are accepted: `toString`, `constructor` or `__proto__` give 400. |

Behaviour:

- Returns allowance is `categoryReturnsRate(category, costs.returnsRate)`; `categoryChecks(...)` is always passed to `classifyOpportunity` as `categoryFailures` (an array, `[]` when the item passes), with the offer's size after operator attributes and the sold sample's days to sell.
- `classifyOpportunity` also gets `availability` (the latest branch check: a check that found none is Review) and `promotionUnconfirmed` (a promotion or loyalty price, eligibility not confirmed, no regular price known: Review).
- Payout: `payoutSchedule` uses `goals.payoutDate` with start = the decision date (the trip is assumed to be today and each unit listed the same day), the sold sample's days to sell, and the saved goals (`getGoals(db)`, or `DEFAULT_GOALS` when the goals table is absent) for dispatch days, delivery days and payout delay. `payoutDays` (whole days from now to the start of the payout date, counted the same way as `cashNeededDays`) goes to `evaluateAlert`, so the cash date is met only by a payout on or before it.
- Sample data: `sampleData` is true when the offer or any used sale is a sample record; the gate's evidence class is then sample.

Response additions: `sampleData`, `payout { start, sold, dispatch, delivered, date, note, days, goals { daysToSell, dispatchDays, deliveryDays, payoutDelayDays, saved }, cashNeededBy, cashNeededDays, timing { status, daysLate, note } }`, `prices { claimed { evidenceClass, kind, price, observed, basis }, observed { points, count, lowest, highest, oldest, newest, amazon {...} }, sold { count, lowerMedian, lowest, highest, oldest, newest, exactNotInSample } }` (each with `evidenceClass`; retail points come from Retail offers and per-item Open Prices observations of the same GTIN, Amazon offer history is listed apart as context only), `category { id, name, chosen, suggestion, rule, returnsRate, returnsRaised, failures, packagingChecked, bestBefore }`, `journey { known, missing, costKnown, minutesKnown }`, `offerAttributes { applied, ignored }`. The offer gains `suggestedCategory`, `attributeSource` (`source`, `operator`, `assumed` or null per attribute) and `operatorConfirmed`.

The alert carries the `journey` check from `evaluateAlert` (input `journeyKnown`), so `alert.eligible` stays the single gate bounties read. `withJourneyCheck` adds it only when a gate without that check is used.

Routes: `GET /api/research/candidates` accepts `size`, `pack`, `model` and `condition` query values as operator-confirmed attributes (same rules as `offerAttributes`; the result includes `offerAttributes`). `GET /api/research/rules` adds `categories` (`CATEGORY_RULES`).

Client (`src/ResearchCalculator.tsx`): journey fields are marked required and a blank one is shown as "not entered" beside every figure that depends on it; offer attributes the source left blank can be confirmed (applied only once the confirmation box is ticked, and shown as "you confirmed"); category choice with the rules and any failures; three prices side by side (the claimed column is headed "Recommended retail price" for an RRP); time until payment, with a cash date from Goals filling an empty one; the locality starts blank and is flagged until entered, because a branch check counts only in the locality stated for the trip. A blank model can be confirmed as "no model number", sent as `offerAttributes { model: "none" }`, which matches only sales that state no model. Wherever independent sellers are shown, `sample.withoutSeller` is shown beside them ("N sales with no seller name are not counted as independent"). "Add to validation audit" hands over `sales`, `weightKg` and `estimateInputs` (the request without offer, sales, locality, promotionEligible and weightKg) so the audit rebuilds the estimate on screen. Stricter thresholds use `loadMemberRules`/`saveMemberRules` from `src/api.ts`, shared with the Planner, and the default units never exceed the member's trial batch. Every input change takes a new sequence number, so a late estimate response never replaces a newer validation error or result; an estimate for older inputs is shown as updating and cannot be tracked, drafted or sent to the audit. A tracked trip sends `predicted.sample` and `payoutBy`, and a sample trip's label ends "(sample)".

Claimed price (`prices.claimed`): the Awin previous price (`was_price`, kind `previous`) first, then the Awin recommended retail price (`rrp_price`, kind `rrp`), then a source regular price above the offer price (kind `regular`). Was and RRP prices are read into the offer as `wasPrice` and `rrpPrice` only; they never become `regularPrice`, so they never set the cost. The stock warning is `stock.reason` from `stockStatus`.

#### Second review round

- Required inputs: `REQUIRED_INPUTS` names the costs and times that must be entered (parcel cost, packaging cost, return journey cost, journey time, handling time). Each blank one is listed in `missingInputs`, passed to the gate's `inputs-entered` check, so the tier is Review and no alert can pass; 0 counts only when typed. While a money input is blank the gate gets `contribution: null`, and while any input is blank `hourly: null`. Research leaves a blank cost out of the figures, says so beside them, and never shows profit or return as passing.
- Demand: `demandFor({ rate, competition, lookup })` gives `{ units, salesPerWeek, competingListings, sellWindowWeeks, note }`, and the gate's `demand` check needs the planned units within it. `competingListings` is the count of listings seen in the last 7 days, 0 only when a current asking-price lookup found none, and otherwise null (unknown, which fails the check and keeps a bounty's cap at 0). `resaleWeeksOfSupply` uses the same count. Both `competition()` calls pass `{ now, lookup }`, with the lookup read from the asking-price cache (`askingLookup`).
- Payout: `payoutSchedule` starts from today in UK time (`londonDate`), counts whole calendar days and dates the last unit's sale with `daysToSellAll`, so several units at a slow sales rate are not assumed to sell as fast as one. With more than one unit and an unknown sales rate there is no payout date and a cash-date check fails. The result adds `units`, `unitPayouts`, `cashDate` and `unitsByCashDate` ("K of N units expected to have paid out by <date>").
- Category: `categoryDecision(suggestion, requested, reason)` returns `{ chosen, suggested, applied, reason, warning, dropped, basis }`. A choice looser than the suggestion (General for an item whose title, source or quantity suggests clothing or food) keeps the suggested rules unless `categoryReason` is given, and always warns, naming what was dropped. Open Prices observations and food quantities (g, kg, ml, l, cl, oz) suggest Food. The result's `category` carries these fields; bounties store and show them.
- Sample data: `isSampleRecord` also matches retailers or merchants whose name starts with "Example".
- Result additions: `missingInputs`, `demand`, `access` (`{ needs, carryKg, carrySource }`, the PRD access-need labels; request `carryKg` is the member's carry limit), `checked` (`{ price, stock, locality }`) and `mainUncertainty` (one plain sentence: sample data, no sales, expired offer, missing inputs, out of stock, stock not confirmed, competition unknown, few sales, otherwise the buyer price).
- Client: every date goes through `dateTime()` in UK time; the Research draft is kept in sessionStorage (`bounty-research-draft`, every field's shape checked), so following a link to Sources or Goals, or reloading, keeps the estimate in progress; the tab's error boundary clears the draft if Research crashes.

### Matching, sources and the validation audit

#### `matching.mjs` (pure)

- Non-text input: `clean`, `normaliseBarcode` and every normaliser return null for anything other than a string or a finite number (a number barcode must be a safe non-negative integer). Nothing calls String() on an object.
- Placeholders ("n/a", "-", "unknown", "tbc", ...) mean "not stated" for size and model.
- `NO_MODEL = "none"`: an explicit "no model number". "None", "No model", "no model number", "Not applicable" and "Model: none" all normalise to it. Feeds never produce it (`feedModel` drops it), so it only comes from the operator: a manual offer or sale, or `offerAttributes.model` in an estimate request.
- `compare(offer, candidate)`: exact needs equal valid barcodes and size, pack, model and condition stated on both and equal. NO_MODEL on the offer also covers a candidate that states no model (null or a placeholder); the exact result then carries a second reason, "No model number: confirmed for the offer, and the sale states none". A model stated on the candidate against NO_MODEL differs. NO_MODEL on the candidate alone does not cover an unstated offer model.
- `sellerName(value)`: the seller name, or null for no seller and for "listing:<id>" (the manual importer's listing-id-only form).
- `INDEPENDENCE_RULE`: "Independent sellers are distinct named sellers. Sales with no seller name, including those recorded only by listing id, are not counted as independent."
- `soldSample(...)`: `independent` = distinct `sellerName` values among used sales. New fields: `withoutSeller` (used sales with no seller name) and `independenceRule`. `competition` uses `sellerName` too.
- `competition(offer, rows, { now, maxAgeDays = 7, lookup })` counts only active asking-price listings with the offer's barcode seen within `ASKING_MAX_AGE_DAYS` (7, the same window as a shelf price). When the newest listing or lookup is older, the counts are null (unknown, which keeps a bounty's cap at 0) with the note "Competing listings last checked <date>: run an asking-price lookup before sharing"; older listings mixed with current ones are reported as not counted. It returns `{ activeListings, sellers, lowestAsking, lowestAskingIncludesShipping, olderListings, checkedAt, maxAgeDays, note }`.

#### `sources.mjs`

- `textOf` underlies `clean`, `gtin` and `redact`: strings, finite numbers and bigints only.
- `feedModel(value)`: a feed model, or null for placeholders and no-model forms.
- `structuredPack(value)`: an integer 1 to 10000 as text, else null.
- Pack and model are stored only from structured fields. Keepa: `pack` from `packageQuantity`, `model` from `model`. Awin: `model` from `model_number`, `mpn` or `product_model`; there is no pack column in the standard feed. Hobnight: size only. eBay summaries and Open Prices: neither (Open Prices quantity is free text).
- Awin rows now carry `was_price` (`product_price_old`, the merchant's previous price) and `rrp_price` (`rrp_price`), in positive integer pence or null, via `claimedPence`. They are stored in the research table's `was_price` and `rrp_price` columns, as claims for display that never become the cost.
- `sold()` still rejects a total of 0 or less. A listing id given without a seller name is kept as "listing:<id>".
- eBay Browse rows record `observed` as the time of the lookup (the listing was live then) and `listed` as the listing's start date, so a long-running live listing still counts as current competition. Rows imported before this change keep their old date until the next lookup.
- A source that answers with a redirect is refused and not retried (`redirect: "error"`), in the adapters and in the Open Prices worker.
- `redact` removes credential values wherever they appear, plus `key=`, `token=` and `access_token=` query values and Bearer tokens. A mutation check confirmed that removing either the value-based or the query redaction fails tests.

#### `research.mjs`

- `importFile(db, kind, path)` returns `{ saved, parsed, skipped, withoutSeller }`.
- A sales file is all or nothing. If any row is not storable (a total of 0, for example), it throws "Invalid manual sale at index N ... Nothing was imported."
- The CLI prints the skipped rows, the Awin no-pack note and the count of sales with no seller name.
- `importFile` refuses a copy of one of the repository's sample files (compared by `contentHash`, which ignores line endings, a byte-order mark and trailing spaces) and any file holding a sample row, wherever it was copied to. Sample data is never imported as evidence; the attempt is recorded as a failed run.

#### `audit.mjs`

- `stockStatus(db, { barcode, retailer, locality, now })` returns `{ check, confirmed, availability, locality, reason }`. With no locality it is never confirmed, and the reason says to enter the locality. Every other unconfirmed case also has a reason.
- `validation_items` has three new columns:
  - `sales` (JSON `[{provider, sourceId}]`)
  - `weight_kg`
  - `estimate_inputs` (JSON)
- `recordItem` takes three new inputs:
  - `sales`: up to 500, deduplicated, and they need an offer.
  - `weightKg`
  - `estimateInputs`: the rest of the estimate request, for example costs, `offerAttributes` or category.
- From `estimateInputs`, the audit drops the keys it sets itself: offer, sales, locality, now, promotionEligible, weightKg, localStockConfirmed and costs.postage.
- The offer is checked with `findOffer`: it must exist, and have the same barcode and retailer.
- `auditEvidence(db, item)` runs `estimateFromEvidence` at the audit time (item.updated). It returns:
  - `evaluatedAt`
  - `stock`
  - `error` and `errorKind`
  - `offer`
  - `sales`: `{ confirmed, used, independent, withoutSeller, independenceRule, daysToSell, lowerMedian, newest, oldest, notUsed[{ sale, provider, sourceId, reason }] }`
  - `match`
  - `permission`
  - `tier` and `tierReasons`
  - `live`
  - `offerFresh`
  - `alert`
  - `warnings`
- `auditOutcome(item)` returns `{ passed, reasons, checks, contradictions[{ id, label, recorded, evidence, reason }] }`.
  - The checks run in this order: barcode, offer, live-evidence, offer-fresh, availability, promotion, shipping, days-to-sell, independent-sales, display-permitted, match, estimate-tier.
  - A typed value that disagrees with the evidence fails as a contradiction.
- `PASSING_TIERS` is `["Priority 1", "Priority 2"]`.
- `estimateInputs` is checked before it is stored: more than 5 levels of lists and objects, more than 4,000 characters or an unsupported value is a 400. An unknown parcel cost stays blank, so the estimate lists it as not entered.
- `progress(db, locality)` returns `{ locality, target: 30, audited, evidenced, passed, failed, withoutEvidence, remaining, complete, signedOff, signOffLapsed, failures }`. An item counts as evidenced only when it has a recorded offer whose stored evidence was read without an error and is not sample data, so 30 rows with only a title and barcode leave the audit at 0 of 30. `complete` is 30 evidenced items. It re-runs one estimate per item, so callers read it once per locality.
- `POST /api/audit/signoff { locality, passed?, evidenced?, note? }` records the operator's acceptance of a complete audit in `audit_signoffs` (time and counts). It is refused with 409 unless the audit is complete or when the counts the operator saw have changed, and with 403 when the request names a member. A sign-off lapses (`signedOff` null, `signOffLapsed` with the reason) when the audit falls below 30 evidenced items, the counts change or an item is saved after it. Bounties drop the pilot warning only while a sign-off stands; until then the warning gives the current count, or the pass count once the audit is complete.
- Import cycle: audit.mjs and estimate.mjs import each other. This is safe while neither uses the other's exports at module top level. `tableExists` is a hoisted function declaration.

#### Audit UI (`src/Audit.tsx`)

- The pilot locality is a setting kept in localStorage ("bounty-audit-pilot-locality"). It has no default and never uses the profile area. A notice appears when it equals the planner's sample area.
- `AuditHandover` = `AuditDraft` plus `sales`, `weightKg` and `estimateInputs`. Without these, an item handed over from Research cannot pass.
- Each item shows:
  - the stored evidence: "N confirmed sales from M independent sellers", the sales with no seller name, and the confirmed sales not used and why
  - each contradiction, as "you recorded X, the stored evidence says Y"
  - the estimate tier and its reasons
  - an "Every check" list
- Progress reads "N of 30 items checked against stored evidence in X" with the passed and failed counts, and one of three states: not validated yet; complete but not signed off (a tick box, an optional note and "Sign off the audit"); or signed off on a date. A lapsed sign-off says why. Items and the handover show "Not entered in Research: ..." when a required cost or time is blank.
- Checked at 390 and 1280 px: no horizontal overflow and no console errors.

### Planner, goals and baskets (`catalog.mjs`, `goals.mjs`, `routes-plan.mjs`)

All Planner and basket figures come from four synthetic Leeds fixtures (`offers`). They are always `sample: true`, their alert input uses `evidenceClass: "sample"`, so they can never become a buy alert. Each fixture carries `category` and `size` (category rules), modelled `salesPerWeek` and `competingListings`, `priceChecked` and `stockChecked` (null: never checked) and `storageNeeds`.

#### Profile (`readProfile`)

Money in pence. `fare` may be `null`, meaning not entered: `fareMissing` is true, the journey is listed among the missing inputs and the trip is never called a fit (`REASONS.FARE`) until a fare is sent (0 for free travel). The client keeps a blank fare as `null` (the field starts empty with the hint "Not entered"), checks it only when it is filled in and used (public transport without "My public transport is free"), sends 0 only when that box is ticked, and ignores it for walking, cycling and driving. Unknown rule keys, including `toString`, `constructor` and `__proto__`, give 400.

#### Load limit (`loadLimit(transport, carry)`)

One rule for the member's own transport and for "What changes if I drive?": car or van, the larger of the carry limit and `CAR_BOOT_KG` (25); public transport, the smaller of it and `HAND_CARRY_KG` (10); walking or cycling, the carry limit. Baskets use the same rule.

#### Quantity

`plan()` caps units at the smallest of: `trial` (effective `trialUnits`, lifted only for an offer with `provenItem: true`, never a fixture), `quantity`, `demand` (`offerDemand(offer)`, which is `opportunity.demandUnits` over `OPPORTUNITY_RULES.sellWindowWeeks`; unknown fails closed at 0), `stock`, `carry`, `storage`, `cash`. `limit` names the binding cap (trial first on ties); `afterTrial` is what the other limits would allow after a verified trade. Basket items use the same trial and demand caps.

#### `plan(offer, profile, { now, compare, timing })`

Additive result fields: `category`, `size`, `returnsRate` (clothing floor via `categoryReturnsRate`), `categoryFailures` (`categoryChecks`, passed to `classifyOpportunity` as `categoryFailures`), `carry` (load limit used), `carryEntered`, `caps.trial`, `caps.demand`, `trialUnits`, `afterTrial`, `sellWindowWeeks`, `salesPerWeek`, `competingListings`, `fareMissing`, `hardFilters`, `accessNeeds` (`[{ id, label, detail }]`), `checked` (`{ price, stock }`), `mainUncertainty`, `timing`. The return threshold uses `meetsReturn`. Alert input passes `availability: "unknown"`, `payoutDays` and `cashNeededDays` from `timing`; sample checks are reworded so lists match the figures shown (parcel cost "illustrative sample figure, not a quote").

Reasons, first match wins: `AREA`, `LIMIT` ("No units fit your limits"), `LOSS`, `HOURLY`, `THRESHOLDS`, `CASH_DATE` (cash date set and payout late or unknown), `FARE`, `FITS`.

`compare` (`compareModes`): `current` and `alternative` each have `mode, carry, units, limit, loadKg, miles, travelCost, parking, travelMinutes, cashRequired, contribution, hourly, fareMissing, reason, fits`; `difference` covers units, loadKg, miles, travelCost, parking, travelMinutes, cashRequired, contribution, hourly; `timeSaved` is current minus alternative travel minutes (null without a trip on both sides).

#### `planTrips(profile, { now, timing })` and `POST /api/plan`

Returns `{ sample, trips, rejected, drive, timing, accessNeeds, rules }`. `trips` is the shortlist and holds only offers inside every buying threshold (price band, weight, profit per unit after its share of travel, and return, with the member's stricter values). Every other offer is in `rejected` (`{ sku, name, variant, shop, area, miles, buy, weight, sample, units, unitProfit, returnOnCost, reasons, tier, accessNeeds }`) with reasons such as "Profit per unit of £2.42 is below £5.00", "No units fit: stopped by <limit>, so profit per unit cannot be checked" or "Profit per unit cannot be checked until these are entered: ..." (`blankInputs`: purchase price, parcel cost, packaging cost, handling time; a blank is never zero). `tier` is Reject when a threshold was measured and failed, otherwise the evidence tier. `drive` is `{ heading, current, alternative, extra, lost }`: shortlisted trips that fit only by the alternative transport, and those that fit now but not by it. The route passes a per-trip timing function, `(sale) => tripTiming(goals, { now, items: [sale] })`, so each trip's payout waits for its last unit to sell; the top-level `timing` is for one unit.

The alert input carries `missingInputs` (`catalog.missingInputs(offer, profile)`: the blank inputs plus "public transport fare" when the journey is unknown), `demandUnits` and `sellWindowWeeks`. Sample offers still fail the live-evidence check.

#### Access needs

PRD labels as data in `ACCESS_NEEDS`: widely accessible, vehicle required (one unit heavier than the carry limit), heavy handling (one unit at or above `ACCESS_RULES.heavyUnitKg`, 5 kg, or above the carry limit), limited local stock (stock at or below `ACCESS_RULES.limitedStockUnits`, 4, or unknown), specialist storage (`storageNeeds` set). The thresholds are assumptions and an open decision. The Planner lets a member hide trips with chosen needs (browser only).

#### Goals (`goals.mjs`)

`payoutDate`, `getGoals` and `cashTiming` keep their signatures. New:

- `tripTiming(goals, { now, items })` returns `{ start, daysToSell, daysToSellOneUnit, units, payout, payoutDays, cashNeededBy, cashNeededDays, cash }`; Planner and baskets use it for "Time until payment" and the alert gate. `start` is today in UK time (`londonDate`). `items` is `[{ units, salesPerWeek }]`; the payout waits for the last unit to sell (`lastSaleDays`, using `daysToSellAll`), and with several units and an unknown sales rate the payout is unknown and the cash-date check fails. Cash dates, goal deadlines and days left also use the UK date. Errors are full sentences in the Goals labels' words, never field names.
- Named goals in table `goal_targets (id, name, amount, deadline, start, created)`. `GET /api/goals/targets` returns `{ targets, basis }`; `POST /api/goals/targets { name, amount, deadline?, start? }` returns 201 with `id` and the list; `DELETE /api/goals/targets/:id` returns the list (404 when missing). Progress counts only cash received: payouts less receipts, expenses and refunds on resale trips dated from `start` to the deadline (or today), read through `ledger.listTrips` and `ledger.getTrip`. Sales waiting for payout, predictions and household savings never count. Goals are funded in deadline order, and cash counted towards an earlier goal whose dates overlap is not counted again. Each target has `payouts, costs, received, shared, counted, remaining, status ("reached" | "in progress" | "missed"), daysLeft`.

#### Baskets (`basketOptions`, `POST /api/baskets`)

An offer is excluded with `rejected: true` when it fails a hard filter, has a blank input, or fails the profit or return threshold. During the search a basket is dropped when any item, with its share of the journey, falls below the thresholds, and an offer that falls below them in every basket that fits is rejected with the reason, so every basket shown has every item inside the thresholds. Constraints add `carry` (load limit), `carryEntered`, `trialUnits`, `sellWindowWeeks`, `fareMissing`. Each basket adds `storage: { used, limit }` and `timing.payoutDays`; each item adds `maxUnits`, `provenItem`, `returnsRate`, `accessNeeds`, `checked`, `mainUncertainty`. A basket is recommended only with positive contribution, the hourly target met, every item inside the thresholds and the trial batch, a fare entered for public transport, and the payout on time when a cash date is set.

#### Client

The Planner and Goals read and write the member's stricter thresholds with `loadMemberRules` and `saveMemberRules` from `src/api.ts`. Tracking a Planner trip sends `predicted.sample: true` and `payoutBy`. Goals shows `potentialProceeds` (live predictions only) with `potentialProceedsLeftOut`, and household savings after trip costs with the gross and costs figures.

### Ledger

- `POST /api/ledger/trips` `{ label, source: "planner"|"research"|"bounty"|"manual", kind: "resale"|"household", reference?, predicted?: { units, proceeds, contribution, cashRequired, activeMinutes, payoutBy?, sample? } }` returns `{ id }`. Predictions are stored for forecast error and never counted as realised cash. `predicted.units` must be at least 1. `predicted.sample` is `true` when the prediction came from sample or illustrative figures and `false` when it came from live evidence; Planner trips are always stored as sample.
- Every trip view carries `predictionBasis` (`"live"`, `"sample"`, `"unknown"` when a prediction was stored without the flag, or `null` with no prediction) and `sample` (basis is sample). Only `"live"` predictions count in potential proceeds and the forecast measures; `"unknown"` is treated like sample (fail closed).
- `GET /api/ledger/summary?month=YYYY-MM` (default: the current month in UK time) returns `{ month, realisedEarnings, householdSavings, pendingPayouts, potentialProceeds, cashTiedUp, unsoldUnits, realisedMinutes, realisedHourly, hourly }` plus `payouts`, `verifiedPayouts`, `verifiedEarnings`, `verifiedTrips`, `unverifiedTrips`, `openTrips`, `basis`, `householdSavingsGross`, `householdTripCosts` and `potentialProceedsLeftOut: { sample, basisUnknown, nothingBought }`.
  - Realised earnings come only from recorded payouts less recorded costs dated in the month.
  - `realisedHourly` divides only the realised money of trips with work time dated in the month by that time, so one trip's money is never divided by another trip's hours. It is null ("not known") when no trip with work time has cash in or out in the month. `hourly: { trips, minutes, earnings, leftOutTrips, leftOutEarnings }` says what was measured and how much money from trips without work time was left out, shown as "Per hour over 2 h on 1 trip. £7.00 from 2 trips without work time is not included."
  - `householdSavings` is net: household saving entries minus household trip expenses (travel, parking) dated in the month, so it can be negative. It is the figure a savings goal counts. It is never earnings.
  - `pendingPayouts` is sales on open trips that no payout covers (see payout position below).
  - `potentialProceeds` counts an open resale trip only when its prediction is live, it has a purchase receipt and no payout yet: the predicted proceeds scaled to the units bought (never above the prediction), less sales already recorded. `potentialProceedsLeftOut` counts the open trips with a prediction that were left out.
- Payout position: payouts are applied in date order. A payout with a unit count pays that many sold units, oldest first; a payout without one covers every sale dated on or before it. Sales no payout covers are pending; the gap between covered sales and payouts is implied fees. The same money is never both pending and fees. `pendingBasis` is `"units"`, `"dates"` or `"no payouts"`.
- Discrepancies (`reconciliation.discrepancies`, resale, not legacy): `payout-without-sale`, `payout-above-sales`, `payout-above-paid-sales`, `sale-without-receipt`, `sold-above-bought`, `paid-above-sold`, `returned-above-sold`, `payout-before-receipt` (any payout before the first receipt), `sale-before-receipt`, `payout-before-sale`.
- Verification (`reconciliation.verified`, `verificationMissing`, `proofedEntries`): a resale trade is verified only when it has a receipt, a sale and a payout; every receipt entry and every payout entry has its own proof attached to that entry (whole-trip proofs never count, and one file, by the hash of its stored content, proves one receipt or payout entry in the whole ledger: a file on two such entries, on one trip or on two, counts for none of them, and every trip using it says so); and the records have no discrepancies. `verificationMissing` gives every reason in words. Verified cash (`verifiedPayouts`, `verifiedEarnings`, metrics `cash.verifiedPayouts`) is the payouts of verified trades only. Household trips and legacy totals are never verified.
- `GET /api/ledger/metrics`: measures over closed, non-legacy resale trips. `forecast` and `hourly.comparison` use only trips whose prediction is live and that have at least one entry; `forecast.leftOut: { sample, basisUnknown, notTaken }` counts the closed trips with a prediction that were not measured. Cash recovery, time to payout, unsold units and realised hourly use every closed trip's real records.
- Other routes: `GET /api/ledger/trips` (rows also carry `netHouseholdSaving` and `verificationMissing`), `GET /api/ledger/trips/:id` (entries, proof metadata, reconciliation), `POST /api/ledger/trips/:id/entries`, `DELETE /api/ledger/trips/:id/entries/:entryId` (open trips only; its proofs become whole-trip proofs), `POST /api/ledger/trips/:id/close`, `POST /api/ledger/trips/:id/proofs` `{ label, mediaType, data (base64), entryId? }` (JPEG, PNG or PDF up to 5 MB; image metadata removed before hashing; stored at `<data dir>/proofs/<sha256>`, mode 0600 in a 0700 directory, never served; refused with 409 "This file is already the proof for <trip> (<entry>): attach the document for this purchase or payout" when the file already proves another receipt or payout entry, checked before anything is written), `PATCH /api/ledger/trips/:id/proofs/:proofId` `{ entryId: number|null }` (re-link a proof to an entry on the same trip or to the whole trip; merges with an identical record already there; the same 409 applies), `DELETE /api/ledger/trips/:id/proofs/:proofId` (returns `removed: { id, file }` where file is `"deleted"`, `"in use"` when another proof record still refers to the same hash, `"missing"` or `"error"`; the stored file is deleted only when no other record refers to it). Tables: `ledger_trips`, `ledger_entries`, `ledger_proofs`, `ledger_legacy_outcomes`; the legacy `outcomes` table is migrated and kept. `ledger_entries` and `ledger_proofs` use `AUTOINCREMENT` (migrated in place, keeping every row, id, link and file), so a stale tab or a retried DELETE gets a 404 instead of removing a newer row that reused the id.
- `proofUses(db)` maps each file hash to its receipt and payout uses across the ledger; `verification()` and `reconcile()` take it, and `getTrip`, `listTrips`, `summary` and `metrics` always pass it, so other modules should read verification through those.

### Bounties (`bounties.mjs`, `routes-bounties.mjs`, `Bounties.tsx`)

A bounty asks local members to buy a matched item at a named branch and resell it. Everything here fails closed: missing or stale evidence stops trips, it never assumes stock, demand or permission.

#### Live bounties and samples

- A **live** bounty is created from an estimate (`estimate()` in estimate.mjs). The bounty stores a snapshot of the estimate: offer, unit cost, match, sold sample, competition, stock, economics, opportunity, promotion, permission and `askingLookup`.
- The opportunity tier comes from `estimate.opportunity`. A missing tier is stored as Review, which never meets the thresholds.
- Creation and `POST /api/bounties/:id/recheck` tell the operator the tier honestly:
  - when alerts can send: "Bounty created (tier) with a cap of N".
  - otherwise: "Bounty created as Review, but it cannot send alerts or take claims: <reasons>".
- A **sample** bounty (`sample: true`) holds hand-entered illustrative figures. It can never send an alert, take a claim or be marked as bought (all 409). Its reports are practice and earn no points, and the UI says so. Its wording says "illustrative".
- **Re-check** (`refreshBounty`):
  - A barcode mismatch keeps the old snapshot and makes the bounty ineligible.
  - Otherwise the snapshot, cap and alert eligibility are replaced.
  - A Review tier or a failed check removes eligibility.
  - Re-checks run before every claim and alert dispatch, after a verified report, and on demand.

#### Cap (capBasis)

`cap = distributionCap(used)`. Every input comes from evidence:

- **Units on the shelf:** the latest stock check's unit count only. The operator's "Most units to share" can only lower it, and no form default stands in for a count. No count means cap 0, with a note.
- **Sales a week:** the confirmed sold count over the window, lowered by the operator's entry.
- **Competing listings:** from `estimate.competition.activeListings`.
  - 0 listings counts as known only when an asking-price lookup is on record: `{provider, fetched}` from the injected `askingLookup` in routes-bounties (default: the evidence cache `cachedLookup("ebay")` over `barcodeQueries`), or `estimate.competition.lookup`.
  - Otherwise competition is unknown, the cap is 0, and the card says so.
- **Display:** a check that finds no listings shows "No competing listings found". Unknown shows "not known". Weeks of supply is `null` (shown as "not known") rather than 0.

#### When a trip is allowed (tripBlockers, tripState)

`tripBlockers(db, bounty, now)` is evaluated **live at `now`**, so nothing waits for a re-check. It lists, in order:

- withdrawn or expired;
- sample;
- buy-alert checks failing;
- offer price outside the last N days. A future-dated offer (age < 0) also blocks.
- stock check lapsed: older than `CHECK_VALID_DAYS` (audit.mjs), or undated;
- display no longer permitted;
- latest stock report found the shelf empty (paused).

Claims and alerts both use it. When it is non-empty, the card shows no "Every check passes", no Claim, and no "I bought them".

`tripState` gives the card and inbox one state, with `{state, go, label, headline}`:

| state | go | meaning |
| --- | --- | --- |
| `go` | true | Every check passes and the cap has room |
| `full` | true | Fully claimed (or cap 0). Existing claim holders may go, nobody new can claim |
| `paused` | false | The latest stock report found none on the shelf |
| `out-of-stock` | false | The latest branch check found none |
| `stock-unconfirmed` | false | The stock check lapsed |
| `blocked` | false | Another trip blocker applies |
| `sample` | false | Practice only |
| `expired` / `withdrawn` | false | Closed |

Every non-go headline starts "Don't make the trip:". The UI only shows a "Branch stock confirmed" tick when the live check passes and the shelf is not paused.

#### "Don't make the trip" notices

The table is `notices(id, bounty_id, member_id, kind, reason, ref, message, created)`, with `UNIQUE(bounty_id, member_id, ref)`.

- `notifyStop` writes a `stop` notice for every member alerted about the bounty, plus every member holding a live active claim (the reporter excluded). It uses `INSERT OR IGNORE`.
- **Triggers:**
  - an empty-shelf report that is now the latest word on the shelf (ref `empty:<observed_at>`);
  - its verification (same ref, so no duplicate);
  - a re-check whose branch check finds the item out of stock (ref `empty:<checked_at>`);
  - withdrawal (ref `withdrawn`).
- **Where notices appear:**
  - `GET /api/members/:id/alerts` returns `stopNotices`, which covers bounties the member claimed without an alert.
  - Each alert carries its own `notices`.
  - `bountyView.viewer.notices` and `viewer.stop` show them on the card.

#### Members: stricter thresholds, trial batch, promotions

- **Stricter thresholds:** `members.rules` holds a member's own overrides of `OPPORTUNITY_RULES` (JSON; `rules` on POST and PATCH `/api/members`).
  - Values are validated **tighten-only** through `effectiveRules`. A looser value is refused (400), and equal values are dropped. min unit price must not exceed max.
  - `memberRuleFailures` applies them, using integer `meetsReturn` for the return. Unknown figures fail. Results feed alerts (skipped) and claims (409), and appear under `viewer.ruleFailures`.
  - `memberView` returns `rules` and `effectiveRules`.
- **Trial batch:** until a verified trade proves the item (`opportunity.provenItem`), one member's total across live claims and units bought for the same barcode is capped at one trial batch. The batch is the bounty's, or the member's own stricter `trialUnits`.
  - `trialAllowance` returns `{limit, held, proven, allowance}`.
  - Claims beyond it get a 409, and alerts skip a member with nothing left.
  - `viewer.maxClaimUnits` is the most this member can claim now.
- **Promotions:** the bounty snapshot keeps `promotion {condition, price, regularPrice, costedAt, operatorConfirmed, needsMemberConfirmation}`. The operator's tick only covers the operator, and eligibility is per member.
  - The card and each alert show the condition and what a non-qualifying member would pay (`promotionRisk`).
  - Claiming needs `qualifiesForPromotion: true` (409 otherwise). It is stored as `claims.promotion` and `claims.promotion_confirmed`, and the alert row stores `promotion`.

#### Pre-validation warning

- `validationStatus(db, locality, cache?)` reads `progress()` from audit.mjs once per locality per read (a Map shared across a list or an inbox), and `validationFrom(locality, progress)` turns it into `{ locality, complete, signedOff, signedOffAt, audited, evidenced, passed, target, warning, signOffLapsed }`.
- The warning clears only while an operator sign-off stands for the locality. Until the audit is complete it reads "Pilot not validated in X: N of 30 items checked against stored evidence"; once complete but not signed off, "Pilot audit in X: P of E items passed, not yet signed off. Treat these figures with care." Cards and the inbox show the current status, never the text stored when an alert was sent.

#### Display permission (displayStatus)

- When the `permissions` table exists, `displayPermitted(provider, retailer)` from evidence.mjs decides **live**. Otherwise the permission recorded with the estimate decides. Anything missing means not permitted.
- **When display is not permitted:**
  - Members and visitors see "Details not shown" as the title. Retailer, barcode, prices, economics, promotion and opportunity figures are null.
  - The operator sees everything, labelled "Not shown to members or visitors: <basis>".
  - An eligible bounty whose permission is withdrawn gets a trip blocker.
  - The `display` field on the view is `{permitted, basis, hidden, label}`.

#### Times and figures

- `humanTime` formats every time shown to people as en-GB in Europe/London, 24-hour (for example "31 Oct 2026, 14:05"). API fields stay ISO.
- Returns are shown to one decimal place, rounded down (44.8%). Money is integer pence.
- Units on the shelf (`view.shelfUnits {units, source, at, boughtSince}`) come from the newer of the latest stock check or report, less units marked as bought since. An empty-shelf report gives 0. With no evidence, the value is null ("not known").

#### Routes (additive)

- `POST /api/bounties/:id/recheck`: re-runs the estimate and the asking-price lookup, and returns `{bounty, message}`.
- `GET /api/members/:id/alerts`: adds `stopNotices`.
- `POST /api/bounties/:id/claims`: needs `journeyCost` and `journeyMinutes` and accepts `qualifiesForPromotion`; `POST /api/bounties/:id/claim-check` and `POST /api/bounties/:id/eligibility` are new (see above).
- `POST /api/members`, `PATCH /api/members/:id`: accept `rules`.
- `POST /api/reports/:id/verify`: re-checks the bounty when the report became a stock check.

#### New view fields

- **bountyView:**
  - `trip`, `shelfUnits`, `display`, `validation`, `promotion`, `maxClaimUnits`
  - `claims[].promotionConfirmed`, `claims[].paused`
  - `viewer {blockers, ruleFailures, trial, maxClaimUnits, promotion, stop, notices}`
  - `pressure.sourcing.unitsSource`, `unitsAt`, `boughtSince`
  - `pressure.resale` notes
  - `capBasis.evidence.askingLookup`
- **memberAlerts entries:** `trip`, `shelf`, `promotion`, `warning`, `notices`.
- **dispatchAlerts results:** `promotion`, `warning`.

#### Second review round

- **Units and journey.** Figures are for the units one member can claim (`claimableUnits`: the smallest of the estimate's units, the cap and the trial batch). When the estimate was for more, the server re-runs it at that count on creation and on every re-check; if it cannot, the bounty sends no alerts and says why. The card labels the figures, for example "Figures for 1 unit, the most one member can claim, using the operator's return journey (£2.00, 20 minutes)". A claim needs the member's own `journeyCost` and `journeyMinutes` (a blank is a 400, never zero); the server re-runs the estimate at the claimed units with that journey, the stricter of both rule sets and the member's promotion answer (`memberRequest`, `memberTripCheck`) and refuses with 409 and the reasons when any check fails. `POST /api/bounties/:id/claim-check` previews the same check and stores nothing. Claims store `journey_cost`, `journey_minutes` and `figures`.
- **Freshness on every read.** `liveEvidence(db, bounty, now)` reads the newest availability check after the snapshot's, the offer as it stands now (gone, risen or fallen) and the age of the sales behind the independent-sales count. `blockerList` orders the blockers: withdrawn, expired, sample, shelf-empty, out-of-stock, stock-lapsed, offer-gone, price-rose, offer-stale, sales-aged, display, ineligible. `syncTrip` runs on every card, list, claim and inbox read and on dispatch: alerted members and claim holders with no current stop notice get "Don't make the trip" before the read returns, and when every check passes again they get an "Open for trips again" notice and the old stop notice is marked superseded. `recheckOpenBounties(db, { barcode, retailer, now })` does the same without a read; the branch-check route (`POST /api/research/checks`) and the import commands call it, so members who do not open the app are still told. `refreshOpenBounties` in routes-bounties.mjs also re-runs the estimates.
- **Competition.** A stale competing-listings count (no listing or lookup in 7 days) is unknown, so the cap stays at 0 and the card shows the note.
- **Promotions for new customers.** A first-order or new-customer offer is shown only to members who say they qualify. Others get a question instead of an alert (`kind: "question"`, no figures, not counted in exposure), and cards hide the figures from them. `POST /api/bounties/:id/eligibility { memberId, answer: "qualifies" | "not" | "used" }` records the answer in `promotion_answers`; "used" stops first-order offers at that retailer for the member, and "qualifies" sends their alert.
- **What the card says.** The applied category and any downgrade warning, attribute notes such as "Pack 1: confirmed by the operator, not stated by the source" (also in the exact-match check), when the price was seen and stock last checked, the main uncertainty and the access-need labels, on cards and in alerts. Tier reasons about competition and pressure are rewritten against the figures the card shows. A member who reports stock on a paused bounty is told their report is waiting for verification. "I bought them" stays available while a trip is paused. The paid-until date is a UK date.
- **Not yet:** members have no transport or carry profile, so access needs assume a hand-carried load and a walker is alerted like a driver (their own journey is checked at the claim). A member already holding a stop notice is not sent another when a different blocker takes over; the card and inbox always show the current reason.

`POST /api/bounties` takes `{ estimate: <estimateFromEvidence request>, title, locality, retailer, availableUnits, salesPerWeek, sellWindowWeeks, expiresAt, sponsored, sponsor? }`. The server recomputes the estimate; a bounty only sends alerts when `alert.eligible` is true, the live trip checks pass, it is not expired, and its distribution cap has room.
