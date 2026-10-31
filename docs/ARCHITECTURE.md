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

An affiliate feed or online catalogue never establishes branch stock. Local stock is only confirmed by a dated stock report or a validation audit entry.

## Layout

| Area                              | Server files                                                                                       | Client files                                |
| --------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| Shared foundations                | `contract.mjs`, `http.mjs`, `app.mjs`, `api.mjs`, `db.mjs`, `trip.mjs`, `alerts.mjs`, `test-support.mjs` | `main.tsx`, `api.ts`, `style.css`           |
| Sources and ingestion             | `sources.mjs`, `evidence.mjs`, `worker.mjs`, `research.mjs`, `loop.mjs`, `routes-evidence.mjs`        | `Sources.tsx`                               |
| Matching, estimate, validation    | `matching.mjs`, `estimate.mjs`, `audit.mjs`, `routes-research.mjs`                                    | `Research.tsx`, `ResearchCalculator.tsx`    |
| Planner, goals and baskets        | `catalog.mjs`, `goals.mjs`, `routes-plan.mjs`                                                         | `Planner.tsx`, `Goals.tsx`                  |
| Bounties and membership           | `bounties.mjs`, `routes-bounties.mjs`                                                                 | `Bounties.tsx`                              |
| Ledger and private proofs         | `ledger.mjs`, `proofs.mjs`, `routes-ledger.mjs`                                                       | `Ledger.tsx`                                |

`db.mjs` opens SQLite and calls `schema(db)` on `evidence`, `audit`, `goals`, `bounties` and `ledger`. Each `schema` is idempotent and migrates older local databases in place. Modules take `db` as a parameter and never import `db.mjs`, so tests run against an in-memory database built with `memoryDb(schema)` from `test-support.mjs`.

## HTTP

`app.mjs` mounts every `routes-*.mjs`. A route module exports `routes(db)` returning `[method, pattern, handler, options?]`. Patterns use `:name` segments. Handlers receive `{ req, url, params, body }` and return JSON or `reply(status, value)`; client errors throw via `fail(message, status)`. `options.limit` raises the JSON body limit (default 64 KB).

The API answers only requests addressed to `127.0.0.1`, `localhost` or `::1`, rejects writes from foreign origins, and requires JSON content type on writes. It listens on 127.0.0.1 only.

## Trip economics (`server/trip.mjs`)

`journey({ mode, miles, fare, perMile, extra, minutes })` gives the cost and minutes of one return journey. `tripEconomics(input)` returns `units, sold, proceeds, costs{stock, packaging, postage, fees, returns, travel}, totalCosts, contribution, unitContribution, cashRequired, journeyPerUnit, activeMinutes, activeHours, hourly, unsoldLoss, breakEvenSale, allSellAssumed`. The journey is shared across units once. `cashRequired` is the cash that leaves before any payout. `unsoldLoss` is the loss if nothing sells. `lowerMedian(values)` is the cautious sale estimate.

## Buy-alert gate (`server/alerts.mjs`)

`evaluateAlert(input)` returns `{ eligible, reasons, checks }`. Every check must pass on positive evidence: live evidence, exact match, positive contribution, hourly floor, fresh offer (7 days), confirmed branch stock, in stock, promotion eligibility, known parcel cost, at least three independent completed sales in 90 days, days to sell known and within the cash date, and display permission. Planner fixtures always fail the first check.

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
  localStockConfirmed: false, promotionEligible: false,
  cashNeededDays: null, now: "2026-10-31T12:00:00Z"
}
```

Result: `{ offer, sample: { used, excluded: [{ row, reason }], count, independent, lowerMedian, newest, oldest, daysToSell }, competition: { activeListings, lowestAsking, sellers }, match, economics, alert }` where `match` is `"exact" | "research" | "none"`, `economics` is a `tripEconomics` result or `null` when no sale qualifies, and `alert` is an `evaluateAlert` result. Active listings are reported under `competition` and never enter `sample`.

### Ledger

- `POST /api/ledger/trips` `{ label, source: "planner"|"research"|"bounty"|"manual", kind: "resale"|"household", reference?, predicted?: { units, proceeds, contribution, cashRequired, activeMinutes, payoutBy? } }` returns `{ id }`. Predictions are stored for forecast error and never counted as realised cash.
- `GET /api/ledger/summary?month=YYYY-MM` returns `{ month, realisedEarnings, householdSavings, pendingPayouts, potentialProceeds, cashTiedUp, unsoldUnits, realisedMinutes, realisedHourly }`. Realised earnings come only from recorded payouts less recorded costs; potential proceeds come only from predictions on open trips; household savings are never counted as earnings.

### Bounties

`POST /api/bounties` takes `{ estimate: <estimateFromEvidence request>, title, locality, retailer, availableUnits, salesPerWeek, sellWindowWeeks, expiresAt, sponsored, sponsor? }`. The server recomputes the estimate; a bounty only sends alerts when `alert.eligible` is true, it is not expired, and its distribution cap has room.
