# Bounty product requirements

## Purpose and customers

Help a UK shopper decide whether a specific trip can save money or produce enough resale income for their time. Serve occasional earners first: a £100 budget, walking or public transport, limited storage and fixed dispatch days. Support experienced resellers with vehicles and higher hourly targets. Keep household savings distinct from realised earnings.

## Decisions and boundaries

Vite + React + TypeScript client, Node HTTP API, persistent SQLite and independent ingestion workers for the single-user pilot. Retail acquisition, competing asking prices, and completed sales are separate evidence classes. Retailers set permissions per programme. An affiliate feed does not establish local stock. No privileged access, fabricated sales or automatic checkout. Promotion eligibility is assessed per person: a new-customer or first-order offer appears only for a member who genuinely qualifies, and Bounty never suggests repeat sign-ups or extra accounts to reuse one. Sponsored placements never change the ranking, which stays based on the member's own profit, time and costs.

## User journeys and acceptance

1. **Source research**: import dated, attributable GB observations; retain source IDs and units. A retry must not duplicate rows. Expose provenance, source availability and missing configuration. Keep licensed feed data and ODbL observations separate.
2. **Match an offer**: use a barcode plus exact size, pack, model and condition. A similar product goes to research. Preserve observation time separately from import time. A completed sale requires the actual realised amount including buyer postage. Keep active listings outside the sold sample. Where available, show three prices side by side: the retailer's claimed previous price, the price observed over time, and recent completed resale prices. A large claimed reduction alone never qualifies an offer.
3. **Plan a trip**: budget, units, location, transport, comfortable load and hourly floor constrain the result. Show cash required before payout, fees, returns, variable travel costs, parcel costs, contribution, active hours and earnings per hour. Share journey costs across units. Show active working time separately from time until payment. Recommend a purchase quantity from budget, carrying limit, competition and the member's own sales history, starting with a small trial batch. Label access needs: widely accessible, vehicle required, heavy handling, limited local stock or specialist storage. Offer **What changes if I drive?**, keeping the walking or public transport plan on screen beside a driving plan with the extra opportunities, mileage, parking, total load and time saved. Fixed costs such as insurance are goals that earnings can cover; fuel for the collection run is a cost of that trip, never counted twice. Each opportunity card shows when price and stock were last checked and its main uncertainty. Negative profit, expired observations or absent evidence must not trigger a buy alert.
4. **Personal goals**: support dispatch windows, storage, monthly savings or income target, date cash is needed and downside if units remain unsold. Compare combined baskets under one cash constraint, reserving cash for postage and packaging before any stock is bought; separate cards for alternative trips do not meet this requirement. Goals can name what the money is for, such as a hobby, fuel or a bill; a deadline goal counts only cash received by that date. Track realised cash separately from potential proceeds.
5. **Bounties**: cap distribution by available units and competing sellers. Allow opt-in alerts, expiry, stock reports and claims. Claims reserve attention, not retailer stock. Show sourcing pressure separately from resale competition. Every bounty is **buy and resell**: the member spends their own money, owns the stock and carries the risk, and each card says so. There are no fixed cash rewards for tasks at launch; stock reports and other contributions earn reputation points instead. Sponsored tasks paid by a retailer or brand may come later. Pause alerts when an opportunity looks saturated, and send a "don't make the trip" notice when a member reports the shelf empty.
6. **Trust and membership**: reconcile receipt, sold listing, payout, expenses, returns and elapsed work. Reward accurate negative reports too. A verified trade needs the purchase receipt and the payout record; together they prove realised profit. Shelf photos count as stock reports that earn points, with location metadata stripped on upload, and never as proof of profit on their own. Keep evidence private. Clearly distinguish paid early access from earned reputation. From launch, members can reach early access either by paying for membership or by earning reputation through verified contributions, and the app shows paid and earned status separately. Early access uses ranked tiers with staggered release windows, sized to remaining stock and resale demand; tier names, number of tiers and window lengths are open decisions. Sponsored placements must be identifiable.

## Opportunity rules

These hard filters are the agreed defaults. Members can tighten them for themselves; the defaults change only when realised outcomes, including the 30-item validation, show they should. An offer failing any of them never reaches the shortlist.

| Filter                     | Starting default                                       |
| -------------------------- | ------------------------------------------------------ |
| Purchase price             | £5 to £50 per unit                                     |
| Parcel                     | Small and simple to pack, preferably under 2 kg        |
| Estimated profit           | At least £5 per unit after variable costs              |
| Return on acquisition cost | At least 35%                                           |
| Demand evidence            | Multiple recent completed sales of the exact variant   |
| Match confidence           | Exact match; uncertain matches go to Review            |
| Stock exposure             | Small trial purchase before increasing quantity        |

Each qualifying opportunity is placed in one tier:

| Tier       | Meaning                                                                       |
| ---------- | ----------------------------------------------------------------------------- |
| Priority 1 | Strong profit, convincing sold evidence, easy fulfilment and confirmed stock  |
| Priority 2 | Promising economics with weaker demand or more competition                   |
| Watch      | Worth buying only if the price falls further                                  |
| Review     | Potential opportunity with missing or uncertain evidence                      |
| Reject     | Fails a profit, size, demand or risk limit                                    |

Category rules apply on top: clothing needs size-specific demand and a higher returns allowance; food such as honey needs weight, packaging and shelf-life checks.

## Delivery gates

| Gate               | Acceptance                                                                                                                                                                                                                                               |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Local pilot        | App starts from a clean checkout; sample opportunities labelled; API and persistent ledger work.                                                                                                                                                         |
| Source foundation  | Document all upstreams and access requirements; support a public feed, credential-gated research, repeatable imports and manually researched sales; expose readiness in app.                                                                             |
| Real buying alerts | In one London locality (borough to be chosen), check 30 barcoded items against retailer and actual sold evidence. Audit availability, promotion eligibility, shipping, days to sell, multiple independent recent sales and permission to display. Fail closed on uncertain matches. |
| Closed member beta | Accounts, private proof storage, claim concurrency, saturation limits and opt-in alerts; test cash recovery and realised hourly earnings against predictions.                                                                                            |
| Paid release       | Verify licensing, exposure limits and membership billing; measure retention, forecast error, unsold stock and time to payout.                                                                                                                            |

## Open decisions

- Automated source of completed eBay sales; until one is licensed, sold evidence is manual and buy alerts stay operator-reviewed.
- London borough and the two retailers for the 30-item validation, and which source gives branch-level stock.
- Membership: tier names, number of tiers, release window lengths and pricing (paid and earned routes both apply from launch).

## Operational model

Schedule public imports upstream of user requests. Credentialed lookups are explicitly triggered, cache results locally and never expose tokens to the browser. Separate imported records, estimates and user-entered outcomes. Start with one worker and one API. Add durable queues, user isolation, monitoring and retries before opening access beyond localhost.

## Feature backlog

Candidate features, competitor lessons and a suggested build order are kept in the [feature backlog](FEATURES.md). An idea becomes scope only when it is added here.

## Implementation status
Updated 31 October 2026. The local single-user pilot implements the planner, goals and baskets, research estimate, validation audit with operator sign-off, bounties with membership release order, outcome ledger and source setup. Retail offers, active asking prices and completed sales are stored and shown as separate evidence classes. The agreed buying thresholds are built in (£5 to £50 per unit, under 2 kg, at least £5 profit per unit after variable costs including the unit's share of travel, at least a 35% return, several recent independent exact sales, a trial batch of three), members can tighten but not loosen them, and opportunities are placed in five tiers. A buy alert needs every check to pass, including every required cost and time entered (a blank is never zero, including a blank public transport fare), no more units than are likely left on the shelf, demand for the units planned and a payout for the last unit before the cash date. An Open Prices offer is costed at the newest price seen at the same shop. Bounty figures are for the units one member can claim, and each claim is re-checked with the member's own journey. Open Prices has been imported live with data. Hobnight, Keepa and eBay Browse adapters have been checked against their published specifications and live endpoints (which refuse a dummy credential as expected), but need real credentials for an acceptance run; Awin needs a publisher account and feed; Fuel Finder needs client credentials and has no connector; The Range has no permitted access. Completed eBay sales are recorded by hand. Planner figures are illustrative sample data and can never become alerts. An audit item counts towards the 30 only with a recorded offer, a confirmed exact sale and a branch check in the locality, and a sign-off needs at least one passed item; that bar is configuration pending Edem's decision. Category rules, access-need thresholds, the sell window for demand, and membership tier names, windows and pricing are also configuration pending Edem's decisions. Not yet built: accounts and authentication, billing, alert delivery outside the app, member transport and carry profiles, and linking verified trades back to items (so every item stays at a trial batch). The 30-product validation in a London pilot locality, member beta and paid release gates are pending.
