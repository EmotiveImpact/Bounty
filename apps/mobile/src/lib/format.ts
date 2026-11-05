// Money, dates and barcodes for people, the same way the website shows them.
// These copy the website's helpers (apps/web/src/api.ts); next they
// move to packages/shared so both apps use one copy.

const gbp = new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" });

export const money = (pence: number | null | undefined) =>
  pence === null || pence === undefined || !Number.isFinite(pence) ? "not known" : gbp.format(pence / 100);

export const toPence = (pounds: number | string) => Math.round(Number(pounds) * 100);

export const percent = (share: number) =>
  (share * 100).toLocaleString("en-GB", { maximumFractionDigits: 1 }) + "%";

/** Pounds typed by a person ("£4.50", "4,50" is refused) as pence, or null. */
export function poundsText(text: string): number | null {
  const t = text.trim().replace(/[£,\s]/g, "");
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) && n > 0 ? toPence(n) : null;
}

const ukDateTime = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/London",
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
const ukDate = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", day: "numeric", month: "short", year: "numeric" });

/** "31 Oct 2026, 14:05", or "30 Oct 2026" for a date with no time. */
export function dateTime(value: string | null | undefined) {
  if (!value) return "unknown";
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const ms = Date.parse(value + "T12:00:00Z");
    return Number.isFinite(ms) ? ukDate.format(new Date(ms)) : value;
  }
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(value) ? value.replace(" ", "T") + "Z" : value;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ukDateTime.format(new Date(ms)) : value;
}

/** Today in UK time as YYYY-MM-DD, for dating a record. */
export function todayUk() {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/**
 * The barcode as it is printed (EAN-13, or EAN-8), not the 14-digit form
 * the server stores for matching.
 */
export const barcodeText = (code: string | null | undefined): string => {
  const text = typeof code === "string" ? code : "";
  return /^0{6}\d{8}$/.test(text) ? text.slice(6) : /^0\d{13}$/.test(text) ? text.slice(1) : text;
};
