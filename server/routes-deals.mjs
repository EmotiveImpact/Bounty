// Deals route: every find with its shop price, completed-sale estimate and
// profit a unit after fees and postage. No buying profile is needed; the
// body may carry optional extras (how the member travels, their own selling
// fees) for sharper numbers. Never a buy alert. /api/scan answers one scan
// in the shop with the same figures and a plain verdict.
import { listDeals, readDealOptions, scan } from "./deals.mjs";

export function routes() {
  return [
    ["GET", "/api/deals", () => listDeals()],
    ["POST", "/api/deals", ({ body }) => listDeals(readDealOptions(body)), { read: true }],
    ["POST", "/api/scan", ({ body }) => scan(body), { read: true }],
  ];
}
