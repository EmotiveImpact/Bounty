// The shapes the Bounty server sends. Copied from the website for now; they
// move to packages/shared with the monorepo so both apps read one copy.

export type Verdict = "buy" | "think" | "leave" | "unknown";

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
  costs: { fees: number; returns: number; postage: number; packaging: number } | null;
  unitProfit: number | null;
  returnOnCost: number | null;
  underSale: number | null;
  weight: number | null;
  stock: number | null;
  competingListings: number | null;
  salesPerWeek: number | null;
  priceChecked: string | null;
  priceSource?: "online" | "shelf" | null;
  storageNeeds: string | null;
  meetsThresholds: boolean;
  notes: string[];
  travel: { added: boolean; mode: string | null; miles: number | null; cost: number | null; minutes: number | null };
  sample: boolean;
  verdict: Verdict;
  reason: string;
  walkAway: number | null;
};

export type ScanResult =
  | { found: true; barcode: string | null; shelfPrice: number; deal: Deal }
  | { found: false; barcode: string | null; verdict: Verdict; reason: string };

export type Tip = {
  id: number;
  title: string;
  barcode: string | null;
  variant: string | null;
  retailer: string | null;
  locality: string;
  sample: boolean;
  status: string;
  cap: number;
  remaining: number;
  expiresAt: string | null;
  mainUncertainty: string | null;
  trip: { state: string; go: boolean; label: string; headline: string };
  reports: { total: number; positive: number; negative: number; latestAt: string | null };
};

export type TripRow = {
  id: number;
  label: string;
  kind: "resale" | "household";
  status: "open" | "closed";
  sample: boolean;
  created: string;
  realisedContribution: number | null;
  pendingPayout: number;
  unsoldUnits: number | null;
  verified: boolean;
};

export type Summary = {
  month: string;
  realisedEarnings: number;
  householdSavings: number;
  pendingPayouts: number;
  potentialProceeds: number;
  cashTiedUp?: number;
  unsoldUnits?: number;
  realisedMinutes?: number;
  realisedHourly?: number | null;
  openTrips?: number;
};

export type Goals = { targetType: "income" | "savings"; monthlyTarget: number };

export type Member = { email: string; name: string | null };
