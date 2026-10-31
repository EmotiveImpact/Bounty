// Research desk routes: acquisition offers, candidate evidence, estimates,
// branch availability checks and the validation audit.
import { fail, int, reply, text } from "./http.mjs";
import { ALERT_RULES } from "./alerts.mjs";
import { OPPORTUNITY_RULES } from "./opportunity.mjs";
import { RULE_KEYS, candidatesFor, estimateFromEvidence, listOffers } from "./estimate.mjs";
import { listChecks, listItems, progress, recordCheck, recordItem } from "./audit.mjs";

// Query-string helpers: values arrive as text and are validated like JSON.
function queryInt(url, name, min, max, fallback) {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === "") return fallback;
  if (!/^\d+$/.test(raw)) fail(`${name} must be a whole number between ${min} and ${max}`);
  return int(Number(raw), name, min, max);
}
const queryText = (url, name, max, optional = false) =>
  text(url.searchParams.get(name) ?? undefined, name, max, { optional });

// The server clock decides freshness, so a client cannot make an expired
// offer or a stale stock check look current.
const serverNow = () => new Date().toISOString();

export function routes(db) {
  return [
    [
      "GET",
      "/api/research/offers",
      ({ url }) => ({
        ...listOffers(db, {
          q: queryText(url, "q", 100, true),
          limit: queryInt(url, "limit", 1, 200, 50),
          offset: queryInt(url, "offset", 0, 1_000_000, 0),
          now: serverNow(),
        }),
        maxOfferAgeDays: ALERT_RULES.maxOfferAgeDays,
      }),
    ],
    [
      "GET",
      "/api/research/candidates",
      ({ url }) =>
        candidatesFor(db, {
          provider: queryText(url, "provider", 60),
          sourceId: queryText(url, "sourceId", 200),
          now: serverNow(),
        }),
    ],
    [
      // The agreed buying thresholds and alert rules, so the interface can
      // show what is in force before any estimate is run. overridable lists
      // the thresholds a member may tighten (never loosen) in an estimate.
      "GET",
      "/api/research/rules",
      () => ({ rules: OPPORTUNITY_RULES, overridable: RULE_KEYS, alertRules: ALERT_RULES }),
    ],
    [
      "POST",
      "/api/research/estimate",
      ({ body }) => estimateFromEvidence(db, body, { now: serverNow() }),
    ],
    [
      "POST",
      "/api/research/checks",
      ({ body }) => reply(201, recordCheck(db, body, { now: serverNow() })),
    ],
    [
      "GET",
      "/api/research/checks",
      ({ url }) => ({ rows: listChecks(db, queryText(url, "barcode", 40)) }),
    ],
    [
      "GET",
      "/api/audit",
      ({ url }) => {
        const locality = queryText(url, "locality", 120);
        return { locality, items: listItems(db, locality) };
      },
    ],
    [
      "POST",
      "/api/audit",
      ({ body }) => reply(201, recordItem(db, body, { now: serverNow() })),
    ],
    [
      "GET",
      "/api/audit/progress",
      ({ url }) => progress(db, queryText(url, "locality", 120)),
    ],
  ];
}
