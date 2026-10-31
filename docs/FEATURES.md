# Bounty feature backlog

Ideas for Bounty beyond the [product requirements](PRD.md). Nothing here is agreed scope until it moves into the PRD. Each idea is tagged with a stage and, where it came from a competitor, the source of the idea.

- **Now:** small, fits the local pilot and the 30-item validation.
- **Next:** needed for the closed member beta.
- **Later:** after the paid release, or once data access allows.

Every idea must keep the PRD rules: exact barcode and variant matches for buying, completed sales kept apart from asking prices, no privileged access, no fabricated sales and no automatic checkout.

## What we learned from existing tools

| Tool | What it is | What we take | What we leave |
| --- | --- | --- | --- |
| SellerAmp SAS | UK Amazon sourcing tool: Chrome extension, web and phone app, Keepa data, about £14 to £20 a month | One login across extension, web and phone; variation viewer; "can you sell this" check | Amazon-only fee model |
| ProfitPath and ProfitGo | EU and UK Amazon sourcing with extension and apps, about €140 to €190 a month | Break-even price; deal age filter; reviewed flag; competing seller and stock counts | Bulk online arbitrage |
| eBay Product Research (Terapeak) | eBay's own sold data, up to three years, filters by condition, location and barcode | Barcode search, sold date ranges, sell-through rate | Its data, which has no open API |
| Underpriced | Cheap profit checker with AI item recognition, from about $2.99 a month | Great, Good, Fair, Pass style rating; fee breakdown; freemium entry | AI recognition as buying evidence |
| Deal alert groups (Deal Soldier, Glitchdeals, Discord groups) | Paid alerts for clearance and price errors | Community and speed | Uncapped alerts that swamp every deal |
| Trolley.co.uk | UK supermarket price comparison | Household savings mode | Reliance on unlicensed retailer data |
| Roamler and mystery shopping apps | Paid in-store checks | Rewarding accurate stock reports | |

There is no open source equivalent of these tools. Useful open source pieces are ZXing, html5-qrcode and QuaggaJS for camera barcode scanning, changedetection.io and Discount Bandit for price and restock monitoring, and Open Prices, which Bounty already uses. Open source eBay sold-price scrapers such as bidbybid are ruled out because they breach eBay's terms.

## 1. Finding opportunities

- **Break-even and maximum buy price** (Now, from ProfitPath). For each matched item, show the highest shelf price at which it still meets your profit and hourly targets. "Walk away above £7.40."
- **Deal rating** (Now, from Underpriced). Map the proposed hard filters onto Priority 1, Priority 2, Watch, Review and Reject, with the reason for the rating shown.
- **Evidence confidence score** (Now). Combine the number of independent recent sales, their age, how spread out the prices are and how exact the match is. Low confidence blocks buy alerts.
- **Sell-through rate and days to sell** (Now, from Terapeak). Compare recent sold counts with active listings to estimate how quickly an item clears.
- **Deal age and reviewed flags** (Now, from ProfitPath). Filter by when evidence was last checked, and mark items you have already judged so they do not resurface unless something changes.
- **Variation viewer** (Next, from SellerAmp). Show every size, colour and pack of a product side by side with its own sold evidence, so you pick the one that sells.
- **Watchlist with price-drop alerts** (Next, inspired by Keepa and changedetection.io). Save a barcode and get told when a permitted source shows it below your maximum buy price.
- **Restricted items check** (Next, from SellerAmp). Flag items eBay or Vinted restrict, brands that enforce rights, age-restricted goods, and items Royal Mail or couriers will not carry, such as aerosols and loose batteries.
- **Seasonal radar** (Later). Use accumulated sold evidence to show when an item usually sells best, for example costumes before Halloween or garden items in a heatwave, and when shops usually clear seasonal stock.
- **Multipack splitting** (Later). Work out whether buying a multipack and selling singles, or bundling singles into a lot, pays better. Each split must still match sold evidence for the exact unit sold.
- **Shelf label capture** (Later). Photograph a reduced price label. Read the barcode and price, store the photo privately as evidence and optionally contribute the price back to Open Prices.

## 2. Planning trips

- **Return window flag** (Now). Show each retailer's change-of-mind returns period so members can see their fallback if an item does not sell, where the retailer's policy allows it.
- **Fee engine for private and business sellers** (Now). eBay and Vinted charge private sellers and business sellers differently, and buyer protection fees change what buyers will pay. Keep fee rules dated and editable.
- **Basket optimiser** (Next). Choose the best mix of items under one cash limit, carrying weight and storage space, rather than comparing single-item trips.
- **Multi-stop routes** (Next). Plan a walk, bus or drive across several shops, respect opening hours, and share journey costs across every unit bought.
- **Travel cost defaults** (Next). Bus fare, walking at zero cost, or driving using GOV.UK Fuel Finder prices or the HMRC mileage rate.
- **Cash flow timeline** (Next). Show cash out today, expected sale dates and payout dates for each platform, against the date you said you need the money.
- **Dispatch planner** (Next). Compare Royal Mail, Evri, InPost and others by parcel size, and fit dispatch around your post office or locker days. Include packaging costs.
- **Storage meter** (Later). Track how much space and cash is tied up in unsold stock at home.
- **Worst case view** (Next). Show what you lose if nothing sells, after any returns, next to the expected outcome.

## 3. Selling

- **Listing helper** (Next, inspired by Underpriced AI and Flogit). Draft a title, description and item specifics from the matched barcode and variant, with a photo checklist.
- **List price suggestion** (Next). Offer a quick-sale price and a patient price from the sold evidence.
- **Days listed and price nudges** (Next). Remind you to relist or reduce after a set number of days, and show how that changes profit.
- **Cross-listing** (Later). Publish to eBay through its official selling API. For platforms without a public API, such as Vinted, provide copy-ready listing text and a reminder to delist when sold elsewhere.
- **Returns tracking** (Later). Record buyer returns and their cost against the original trip.

## 4. Money and records

- **Prediction against outcome** (Now). For every trip, compare predicted profit and hours with what the ledger records. This is how forecasts get calibrated.
- **Receipt capture** (Next). Photograph receipts and attach them to trips as private evidence.
- **Tax counters** (Next). Track progress against the £1,000 trading allowance and the platform reporting thresholds for HMRC. Show this as information, not tax advice.
- **Exports** (Next). CSV export of trips, sales, costs and mileage for spreadsheets or an accountant.
- **Goals dashboard** (Next). Separate savings and earnings targets, such as "£300 by 20 December", with progress from realised cash only.
- **Your best patches** (Later). Which shops, categories and days have earned you the most per hour.

## 5. Bounties and community

- **Capped bounty slots with waitlist** (Next). Limit claims by stock and resale pressure, with expiry and claim timers.
- **Stock reports with proof** (Next). Timestamped photo reports, including "not there" reports, which earn reputation when accurate.
- **Reputation from accuracy** (Next). Earned only from verified reports and outcomes, kept separate from paid membership.
- **Resale pressure meter** (Next). Count how many members recently bought the same item and reduce alerts as the market fills.
- **Outcome reports** (Next). "Sold mine for £X" reports feed a separate, self-reported evidence class that never counts as verified sold evidence on its own.
- **Patch rotation** (Later). Spread members across different shops so the same branch is not visited by everyone.
- **Starter bounties** (Later). Low-cost, low-risk first trips with a checklist for new members.
- **Labelled sponsored bounties** (Later). Retailers or brands can fund bounties, always clearly marked.

## 6. Capture tools

- **Phone barcode scanning** (Now). Scan in store from the web app using an open source library such as html5-qrcode or ZXing. No native app needed.
- **Offline mode** (Next). Cache recent evidence on the phone, as ScoutIQ does, because shop signal is often poor.
- **Bluetooth scanner support** (Later, from Profit Bandit). For members scanning many items.
- **Chrome extension** (Next):
  - **Sold evidence helper:** while viewing a sale in eBay Product Research, save it to Bounty's import format in one click. Check eBay's terms before building.
  - **Retailer page check:** on a UK retailer product page, show matched sold evidence, profit after fees and postage, and an "add to trip" button.
  - **Shared login** with the web app.

## 7. Alerts

- **Opt-in alerts with filters** (Next). Distance, budget, transport, category and quiet hours, delivered by email or push, with Telegram or WhatsApp later.
- **Daily digest** (Next). "Three trips worth doing near you today", only when evidence passes the confidence threshold.

## 8. Household savings mode

- **Cheapest basket** (Later, inspired by Trolley.co.uk). Find the cheapest nearby shop for a shopping list using Open Prices, counted as savings, not earnings.
- **Price drops on things you buy anyway** (Later).
- **Loyalty prices** (Later). Mark Clubcard, Nectar and similar prices as conditional rather than the shelf price.

## 9. Guardrails

- **Spend caps and stop-loss** (Now). A monthly limit on cash tied up, and a nudge to stop buying when unsold stock passes a set value.
- **No pressure framing** (Now). No countdowns or "don't miss out" copy until forecasts are calibrated. Show expected and worst cases together.
- **Excluded tactics** (Now). No repeat sign-ups to reuse new-customer offers, no price-error exploitation that breaches retailer terms, no automated buying.

## Suggested build order

1. Break-even price, deal rating and evidence confidence score in Research and the planner.
2. Fee engine, sell-through rate and prediction against outcome.
3. Phone barcode scanning and deal age and reviewed flags.
4. Chrome extension, starting with the sold evidence helper.
5. Basket optimiser, multi-stop routes and dispatch planner.
6. Bounty slots, stock reports and reputation for the member beta.
