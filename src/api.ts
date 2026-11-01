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
  // The session ended (signed out elsewhere or expired): reloading shows
  // the sign-in page.
  if (res.status === 401 && (data as { signIn?: boolean } | null)?.signIn) {
    window.location.reload();
    throw Error("Sign in to Bounty");
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
// Dates and times for people, in UK time: "31 Oct 2026, 14:05", or
// "30 Oct 2026" for a date with no time. Never a raw ISO string.
const ukDateTimeFormat = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/London",
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
const ukDateFormat = new Intl.DateTimeFormat("en-GB", {
  timeZone: "UTC",
  day: "numeric",
  month: "short",
  year: "numeric",
});
export const dateTime = (value: string | null | undefined) => {
  if (!value) return "unknown";
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const ms = Date.parse(value + "T12:00:00Z");
    return Number.isFinite(ms) ? ukDateFormat.format(new Date(ms)) : value;
  }
  // SQLite's "YYYY-MM-DD HH:MM:SS" is UTC without a zone marker.
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(value) ? value.replace(" ", "T") + "Z" : value;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ukDateTimeFormat.format(new Date(ms)) : value;
};

// Per-viewer profile shared by the planner, goals and research views.
export type Profile = {
  area: string;
  budget: number; // pounds
  target: number; // pounds per hour
  transport: string;
  carry: number; // kg
  quantity: number;
  // Pounds, return public transport fare; null when not entered. A blank is
  // never a free journey: £0 counts only when fareFree is ticked.
  fare: number | null;
  perMile: number; // pence per mile for car or van
  extra: number; // pounds, parking or tolls
  storage: number; // units of storage at home
  feeRate: number; // share, e.g. 0.13
  feeFixed: number; // pence per item
  returnsRate: number; // share
  fareFree?: boolean; // true when public transport is free for this member (a bus pass)
};
export const initialProfile: Profile = {
  area: "Leeds",
  budget: 100,
  target: 12,
  transport: "Walk",
  carry: 5,
  quantity: 4,
  fare: null,
  perMile: 45,
  extra: 0,
  storage: 10,
  feeRate: 0.13,
  feeFixed: 40,
  returnsRate: 0.05,
  fareFree: false,
};

/**
 * A saved fare as the profile keeps it. Anything that is not a number (an
 * empty field saved as "" or null, or nothing saved) is not entered. A saved
 * 0 was the old starting value of the field, so it counts as a free fare
 * only when "My public transport is free" is ticked.
 */
function savedFare(value: unknown, fareFree: boolean): number | null {
  const n =
    typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
  if (!Number.isFinite(n)) return null;
  if (n === 0 && !fareFree) return null;
  return n;
}

export function loadProfile(): Profile {
  try {
    const raw = JSON.parse(localStorage.getItem("bounty-profile") || "{}");
    const saved = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
    const fareFree = saved.fareFree === true;
    return { ...initialProfile, ...saved, fareFree, fare: savedFare(saved.fare, fareFree) };
  } catch {
    return { ...initialProfile };
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

// The barcode as it is printed and entered (EAN-13, or EAN-8), not the
// 14-digit form the server stores for matching. A UPC-A code keeps its
// leading zero, as EAN-13 prints it.
export const barcodeText = (code: string | null | undefined): string => {
  const text = typeof code === "string" ? code : "";
  return /^0{6}\d{8}$/.test(text) ? text.slice(6) : /^0\d{13}$/.test(text) ? text.slice(1) : text;
};

// Simple or Pro: how much detail Deals and Scan show. Both views use the same
// figures; Pro adds return on spend, competition and quantities. A display
// choice remembered in this browser, never a paid feature.
export type Lens = "simple" | "pro";
export function loadLens(): Lens {
  try {
    return localStorage.getItem("bounty-lens") === "pro" ? "pro" : "simple";
  } catch {
    return "simple";
  }
}
export function saveLens(lens: Lens) {
  try {
    localStorage.setItem("bounty-lens", lens);
  } catch {
    // Private windows may refuse storage; the switch still works for this visit.
  }
}
