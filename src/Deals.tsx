import { loadProfile } from "./api";
import type { Verdict } from "./Verdict";

// What the deals API returns for each find, and the travel and fee settings
// a member saved, sent with each deals or scan request. The Deals screen
// itself is proto/App.tsx; the first version that lived here was removed.

type Travel = {
  added: boolean;
  mode: string | null;
  miles: number | null;
  cost: number | null;
  minutes: number | null;
};
export type Deal = {
  sku: string;
  name: string;
  variant: string | null;
  category: string;
  shop: string;
  area: string | null;
  miles: number | null;
  buy: number;
  salePrice: number | null;
  sales: number[];
  costs: {
    fees: number;
    returns: number;
    postage: number;
    packaging: number;
  } | null;
  feeRate: number;
  feeFixed: number;
  returnsRate: number;
  unitProfit: number | null;
  returnOnCost: number | null;
  underSale: number | null;
  weight: number | null;
  stock: number | null;
  competingListings: number | null;
  salesPerWeek: number | null;
  priceChecked: string | null;
  stockChecked: string | null;
  storageNeeds: string | null;
  meetsThresholds: boolean;
  notes: string[];
  travel: Travel;
  sample: boolean;
  verdict: Verdict;
  reason: string;
  walkAway: number | null;
};
export function savedExtras(): Record<string, unknown> {
  let saved = false;
  try {
    saved = localStorage.getItem("bounty-profile") !== null;
  } catch {
    saved = false;
  }
  if (!saved) return {};
  const p = loadProfile();
  const fare =
    typeof p.fare === "number" && Number.isFinite(p.fare)
      ? Math.round(p.fare * 100)
      : null;
  return {
    transport: p.transport,
    fare,
    fareFree: p.fareFree === true,
    perMile: Number.isFinite(p.perMile) ? Math.round(p.perMile) : undefined,
    extra: Number.isFinite(p.extra) ? Math.round(p.extra * 100) : undefined,
    feeRate: Number.isFinite(p.feeRate) ? p.feeRate : undefined,
    feeFixed: Number.isFinite(p.feeFixed) ? Math.round(p.feeFixed) : undefined,
    returnsRate: Number.isFinite(p.returnsRate) ? p.returnsRate : undefined,
  };
}
