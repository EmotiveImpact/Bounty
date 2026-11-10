/** Strict British pounds to integer pence. Never silently removes decimal commas. */
export function poundsText(text: string): number | null {
  const t = text.trim().replace(/^£\s*/, "");
  if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?$/.test(t)) return null;
  const [whole, fraction = ""] = t.replaceAll(",", "").split(".");
  const pence = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  return Number.isSafeInteger(pence) && pence >= 0 ? pence : null;
}

export function todayUk(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(now);
}
