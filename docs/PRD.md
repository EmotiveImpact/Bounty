# Bounty product requirements

## Purpose and customers

Help a UK shopper decide whether a specific trip can save money or produce enough resale income for their time. Serve occasional earners first: a £100 budget, walking or public transport, limited storage and fixed dispatch days. Support experienced resellers with vehicles and higher hourly targets. Keep household savings distinct from realised earnings.

## Decisions and boundaries

Vite + React + TypeScript client, Node HTTP API, persistent SQLite and independent ingestion workers for the single-user pilot. Retail acquisition, competing asking prices, and completed sales are separate evidence classes. Retailers set permissions per programme. An affiliate feed does not establish local stock. No privileged access, fabricated sales or automatic checkout.

## User journeys and acceptance

1. **Source research**: import dated, attributable GB observations; retain source IDs and units. A retry must not duplicate rows. Expose provenance, source availability and missing configuration. Keep licensed feed data and ODbL observations separate.
2. **Match an offer**: use a barcode plus exact size, pack, model and condition. A similar product goes to research. Preserve observation time separately from import time. A completed sale requires the actual realised amount including buyer postage. Keep active listings outside the sold sample.
3. **Plan a trip**: budget, units, location, transport, comfortable load and hourly floor constrain the result. Show cash required before payout, fees, returns, variable travel costs, parcel costs, contribution, active hours and earnings per hour. Share journey costs across units. Negative profit, expired observations or absent evidence must not trigger a buy alert.
4. **Personal goals**: support dispatch windows, storage, monthly savings or income target, date cash is needed and downside if units remain unsold. Compare baskets under one cash constraint. Track realised cash separately from potential proceeds.
5. **Bounties**: cap distribution by available units and competing sellers. Allow opt-in alerts, expiry, stock reports and claims. Claims reserve attention, not retailer stock. Show sourcing pressure separately from resale competition.
6. **Trust and membership**: reconcile receipt, sold listing, payout, expenses, returns and elapsed work. Reward accurate negative reports too. Keep evidence private. Clearly distinguish paid early access from earned reputation. Sponsored placements must be identifiable.

## Delivery gates

| Gate               | Acceptance                                                                                                                                                                                                                                               |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Local pilot        | App starts from a clean checkout; sample opportunities labelled; API and persistent ledger work.                                                                                                                                                         |
| Source foundation  | Document all upstreams and access requirements; support a public feed, credential-gated research, repeatable imports and manually researched sales; expose readiness in app.                                                                             |
| Real buying alerts | In one UK locality, check 30 barcoded items against retailer and actual sold evidence. Audit availability, promotion eligibility, shipping, days to sell, multiple independent recent sales and permission to display. Fail closed on uncertain matches. |
| Closed member beta | Accounts, private proof storage, claim concurrency, saturation limits and opt-in alerts; test cash recovery and realised hourly earnings against predictions.                                                                                            |
| Paid release       | Verify licensing, exposure limits and membership billing; measure retention, forecast error, unsold stock and time to payout.                                                                                                                            |

## Operational model

Schedule public imports upstream of user requests. Credentialed lookups are explicitly triggered, cache results locally and never expose tokens to the browser. Separate imported records, estimates and user-entered outcomes. Start with one worker and one API. Add durable queues, user isolation, monitoring and retries before opening access beyond localhost.

## Implementation status
The local pilot and source setup are implemented. Source-specific request shapes and sample imports are tested locally. Live public observations have been retrieved. Authenticated providers need credentialed acceptance runs. The Research desk supports selecting a barcoded acquisition offer and confirming matching sold variants before calculating an illustrative per-unit trip. No automatic promotion follows a manual sale. The 30-product validation, member beta and paid release gates are pending.
