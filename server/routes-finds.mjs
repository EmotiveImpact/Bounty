// AI finds: leads the deal finder picked out from deal sites and clearance
// pages. They are not checked against completed sales and are never deals.
import { latestFinds } from "./finder.mjs";

export function routes() {
  return [["GET", "/api/finds", () => latestFinds()]];
}
