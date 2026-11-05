// Deals route: every find with its shop price, completed-sale estimate and
// profit a unit after fees and postage. No buying profile is needed; the
// body may carry optional extras (how the member travels, their own selling
// fees) for sharper numbers. Never a buy alert. /api/scan answers one scan
// in the shop with the same figures and a plain verdict. Both use the full
// made-up sample set (sample-deals.mjs) while Bounty is in development.
import { listDeals, readDealOptions, scan } from "./deals.mjs";
import { allSampleOffers as offers } from "./sample-deals.mjs";

export function routes() {
  return [
    ["GET", "/api/deals", () => listDeals({}, { offers })],
    ["POST", "/api/deals", ({ body }) => listDeals(readDealOptions(body), { offers }), { read: true }],
    ["POST", "/api/scan", ({ body }) => scan(body, { offers }), { read: true }],
  ];
}
