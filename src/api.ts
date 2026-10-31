// Shared client helpers. All money from the API is integer pence.

export async function api<T>(
  route: string,
  body?: unknown,
  method?: "POST" | "PUT" | "PATCH" | "DELETE",
): Promise<T> {
  const res = await fetch(
    "/api/" + route,
    body === undefined && !method
      ? {}
      : {
          method: method || "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body ?? {}),
        },
  );
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    throw Error("The API returned an unreadable response");
  }
  if (!res.ok)
    throw Error(
      (data as { error?: string } | null)?.error ||
        "Request failed (HTTP " + res.status + ")",
    );
  return data as T;
}

const gbp = new Intl.NumberFormat("en-GB", {
  style: "currency",
  currency: "GBP",
});
export const money = (pence: number | null | undefined) =>
  pence === null || pence === undefined || !Number.isFinite(pence)
    ? "not known"
    : gbp.format(pence / 100);
export const toPence = (pounds: number | string) =>
  Math.round(Number(pounds) * 100);
export const hours = (minutes: number) =>
  (minutes / 60).toLocaleString("en-GB", { maximumFractionDigits: 2 }) + " h";
export const percent = (share: number) =>
  (share * 100).toLocaleString("en-GB", { maximumFractionDigits: 1 }) + "%";
export const dateTime = (value: string | null | undefined) =>
  value ? value.replace("T", " ").replace(/\.\d+Z$|Z$/, "") : "unknown";

// Per-viewer profile shared by the planner, goals and research views.
export type Profile = {
  area: string;
  budget: number; // pounds
  target: number; // pounds per hour
  transport: string;
  carry: number; // kg
  quantity: number;
  fare: number; // pounds, return public transport fare
  perMile: number; // pence per mile for car or van
  extra: number; // pounds, parking or tolls
  storage: number; // units of storage at home
  feeRate: number; // share, e.g. 0.13
  feeFixed: number; // pence per item
  returnsRate: number; // share
  fareFree?: boolean; // true when a public transport fare of £0 is real, not blank
};
export const initialProfile: Profile = {
  area: "Leeds",
  budget: 100,
  target: 12,
  transport: "Walk",
  carry: 5,
  quantity: 4,
  fare: 0,
  perMile: 45,
  extra: 0,
  storage: 10,
  feeRate: 0.13,
  feeFixed: 40,
  returnsRate: 0.05,
};
export function loadProfile(): Profile {
  try {
    return {
      ...initialProfile,
      ...JSON.parse(localStorage.getItem("bounty-profile") || "{}"),
    };
  } catch {
    return initialProfile;
  }
}
export function saveProfile(profile: Profile) {
  try {
    localStorage.setItem("bounty-profile", JSON.stringify(profile));
  } catch {
    /* storage unavailable: the profile lasts for this visit only */
  }
}

// A member's own stricter buying thresholds, shared by every tab so that the
// Planner, Research and bounty drafts apply the same figures. Stored in API
// units: pence for money, kilograms, a share for the return, whole units.
// The server applies an override only where it is stricter than the agreed
// thresholds, so a stale or edited value can never loosen them.
export type RuleKey =
  | "minUnitPrice"
  | "maxUnitPrice"
  | "maxWeightKg"
  | "minUnitProfit"
  | "minReturn"
  | "trialUnits";
export type MemberRules = Partial<Record<RuleKey, number>>;
export const RULE_KEYS: RuleKey[] = [
  "minUnitPrice",
  "maxUnitPrice",
  "maxWeightKg",
  "minUnitProfit",
  "minReturn",
  "trialUnits",
];
const RULES_KEY = "bounty-rules";
const LEGACY_RESEARCH_RULES_KEY = "bounty-stricter-thresholds";

function cleanRules(saved: unknown): MemberRules {
  const rules: MemberRules = {};
  if (saved && typeof saved === "object")
    for (const key of RULE_KEYS) {
      const v = (saved as Record<string, unknown>)[key];
      if (typeof v === "number" && Number.isFinite(v) && v >= 0) rules[key] = v;
    }
  return rules;
}

/** The member's saved thresholds, in API units. Empty when none are saved. */
export function loadMemberRules(): MemberRules {
  try {
    const raw = localStorage.getItem(RULES_KEY);
    if (raw !== null) return cleanRules(JSON.parse(raw));
    // One-off move of thresholds saved by an earlier Research tab, which
    // kept them as form text in pounds and percent.
    const legacy = JSON.parse(localStorage.getItem(LEGACY_RESEARCH_RULES_KEY) || "{}");
    const rules: MemberRules = {};
    if (legacy && typeof legacy === "object")
      for (const key of RULE_KEYS) {
        const text = typeof legacy[key] === "string" ? legacy[key].trim() : "";
        const n = text === "" ? NaN : Number(text);
        if (!Number.isFinite(n) || n < 0) continue;
        if (key === "minUnitPrice" || key === "maxUnitPrice" || key === "minUnitProfit")
          rules[key] = toPence(n);
        else if (key === "minReturn") rules[key] = Math.round(n * 10) / 1000;
        else if (key === "trialUnits") rules[key] = Math.round(n);
        else rules[key] = n;
      }
    return rules;
  } catch {
    return {};
  }
}

/** Saves the member's thresholds for every tab. */
export function saveMemberRules(rules: MemberRules) {
  try {
    localStorage.setItem(RULES_KEY, JSON.stringify(cleanRules(rules)));
    localStorage.removeItem(LEGACY_RESEARCH_RULES_KEY);
  } catch {
    /* storage unavailable: the thresholds last for this visit only */
  }
}
