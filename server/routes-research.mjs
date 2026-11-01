// Research desk routes: acquisition offers, candidate evidence, estimates,
// branch availability checks and the validation audit.
import { fail, int, reply, text } from "./http.mjs";
import { ALERT_RULES } from "./alerts.mjs";
import { CATEGORY_RULES, OPPORTUNITY_RULES } from "./opportunity.mjs";
import {
  OFFER_ATTRIBUTE_KEYS,
  RULE_KEYS,
  candidatesFor,
  estimateFromEvidence,
  listOffers,
} from "./estimate.mjs";
import { listChecks, listItems, progress, recordCheck, recordItem, signOff, tableExists } from "./audit.mjs";
import { recheckOpenBounties } from "./bounties.mjs";
import { refreshOpenBounties } from "./routes-bounties.mjs";

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
      // size, pack, model and condition in the query are attributes the
      // operator confirmed after looking at the item; they fill only what the
      // source left blank, as in the estimate's offerAttributes.
      ({ url }) =>
        candidatesFor(db, {
          provider: queryText(url, "provider", 60),
          sourceId: queryText(url, "sourceId", 200),
          offerAttributes: Object.fromEntries(
            OFFER_ATTRIBUTE_KEYS.map((key) => [key, url.searchParams.get(key)]).filter(
              ([, value]) => value !== null && value !== "",
            ),
          ),
          now: serverNow(),
        }),
    ],
    [
      // The agreed buying thresholds and alert rules, so the interface can
      // show what is in force before any estimate is run. overridable lists
      // the thresholds a member may tighten (never loosen) in an estimate;
      // categories the clothing and food rules applied on top.
      "GET",
      "/api/research/rules",
      () => ({
        rules: OPPORTUNITY_RULES,
        overridable: RULE_KEYS,
        alertRules: ALERT_RULES,
        categories: CATEGORY_RULES,
      }),
    ],
    [
      "POST",
      "/api/research/estimate",
      ({ body }) => estimateFromEvidence(db, body, { now: serverNow() }),
    ],
    [
      "POST",
      "/api/research/checks",
      async ({ body }) => {
        const now = serverNow();
        const check = recordCheck(db, body, { now });
        // A check reaches open bounties for the item at once (R3B1): each
        // estimate, cap, demand and claim holder's own figures are worked out
        // again with it (refreshOpenBounties), so alerted members and claim
        // holders get "Don't make the trip" (or "Open for trips again") now,
        // not on their next read. If that fails the check stays recorded and
        // the blocker pass still runs.
        let bounties = null;
        if (tableExists(db, "bounties")) {
          try {
            bounties = await refreshOpenBounties(db, { barcode: check.barcode, retailer: check.retailer, now });
          } catch (error) {
            bounties = {
              ...recheckOpenBounties(db, { barcode: check.barcode, retailer: check.retailer, now }),
              error: `The bounties for this item could not be worked out again: ${error.message}`,
            };
          }
        }
        return reply(201, { ...check, bounties });
      },
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
    [
      // The operator's acceptance of a complete audit in a locality. This
      // pilot has no accounts (see routes-bounties.mjs), so operator-only
      // means it is an operator action: a request made as a member (a
      // memberId in the body, or a member as the viewer) is refused.
      // 409 unless the audit is complete, or when the counts the operator
      // saw no longer match.
      "POST",
      "/api/audit/signoff",
      ({ url, body }) => {
        const viewer = url.searchParams.get("viewer");
        const asMember =
          (viewer !== null && viewer !== "" && viewer !== "operator") ||
          (body && typeof body === "object" && body.memberId !== undefined && body.memberId !== null);
        if (asMember) fail("Only the operator can sign off the audit", 403);
        const result = signOff(db, body, { now: serverNow() });
        return reply(result.created ? 201 : 200, result);
      },
    ],
  ];
}
