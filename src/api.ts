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
