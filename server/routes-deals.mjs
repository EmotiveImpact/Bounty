// Deals route: every find with its shop price, completed-sale estimate and
// profit a unit after fees and postage. No buying profile is needed; the
// body may carry optional extras (how the member travels, their own selling
// fees) for sharper numbers. Never a buy alert.
import { listDeals, readDealOptions } from "./deals.mjs";

export function routes() {
  return [
    ["GET", "/api/deals", () => listDeals()],
    ["POST", "/api/deals", ({ body }) => listDeals(readDealOptions(body))],
  ];
}
