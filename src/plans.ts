// Membership plans on the client (server/plans.mjs). One shared copy, so
// every screen updates together when a plan is chosen.
import { useEffect, useState } from "react";
import { api } from "./api";

export type Feature = "deals" | "scan" | "stock" | "money" | "tips" | "trip" | "research" | "taxExport";

export type Plan = {
  id: "starter" | "plus" | "fulltime";
  name: string;
  pricePence: number;
  forWho: string;
  opens: Feature[];
  areas: number | null;
  tipTiming: string;
};

export type PlanChoice = { id: Plan["id"]; since: string; introEnds: string | null };

export type PlansInfo = {
  plans: Plan[];
  features: Record<Feature, string>;
  intro: { pence: number; days: number; oncePerCard: boolean };
  payments: boolean;
  // null without accounts (this machine), otherwise whether signed in.
  signedIn: boolean | null;
  current: PlanChoice | null;
};

const EVENT = "bounty:plans";
let cache: PlansInfo | null = null;
let loading: Promise<PlansInfo> | null = null;

function load(force = false): Promise<PlansInfo> {
  if (!force && cache) return Promise.resolve(cache);
  if (!force && loading) return loading;
  loading = api<PlansInfo>("plans")
    .then((info) => {
      cache = info;
      window.dispatchEvent(new Event(EVENT));
      return info;
    })
    .finally(() => {
      loading = null;
    });
  return loading;
}

/** Chooses a plan (or null for none) and updates every screen. */
export async function choosePlan(id: Plan["id"] | null): Promise<PlanChoice | null> {
  const { current } = await api<{ current: PlanChoice | null }>("plans/choose", { plan: id });
  if (cache) {
    cache = { ...cache, current };
    window.dispatchEvent(new Event(EVENT));
  }
  return current;
}

/** Reloads after sign-in or sign-out. */
export const reloadPlans = () => load(true).catch(() => null);

export function usePlans(): { info: PlansInfo | null; error: string } {
  const [info, setInfo] = useState<PlansInfo | null>(cache);
  const [error, setError] = useState("");
  useEffect(() => {
    const update = () => setInfo(cache);
    window.addEventListener(EVENT, update);
    load()
      .then(setInfo)
      .catch((e: Error) => setError(e.message));
    return () => window.removeEventListener(EVENT, update);
  }, []);
  return { info, error };
}

/** The member's plan, or null when none is chosen yet. */
export function currentPlan(info: PlansInfo | null): Plan | null {
  return info?.current ? info.plans.find((p) => p.id === info.current!.id) ?? null : null;
}

/**
 * Whether the member's plan opens a feature. Before any plan is chosen the
 * whole app stays open to look around, so testing is not blocked.
 */
export function opens(info: PlansInfo | null, feature: Feature): boolean {
  const plan = currentPlan(info);
  return !plan || plan.opens.includes(feature);
}

/** The cheapest plan that opens a feature. */
export function cheapestFor(info: PlansInfo | null, feature: Feature): Plan | null {
  return info?.plans.find((p) => p.opens.includes(feature)) ?? null;
}
