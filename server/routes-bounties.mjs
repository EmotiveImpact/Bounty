// Bounty and membership routes. Members are local profiles: this pilot has
// no accounts, so "acting as" a member or the operator is chosen by whoever
// uses this computer and none of these routes is secure until accounts
// exist. Every bounty is buy and resell: the member buys and owns the stock
// and carries the risk, and a bounty never pays a reward. Stock reports earn
// reputation points. Shelf photos are stored privately on this computer and
// never served: responses carry their hash, size and type only.
//
// routes(db, options) accepts injected dependencies so tests never depend on
// other modules' files:
//   estimate(db, request, { now })  estimateFromEvidence from ./estimate.mjs
//   recordCheck(db, check, { now }) recordCheck from ./audit.mjs
//   askingLookup(db, barcode, { now })  the latest asking-price lookup for
//                                   a barcode inside its time to live,
//                                   { provider, fetched } or null (default:
//                                   the eBay Browse lookup cache)
//   photoDir                        where shelf photos are kept (default
//                                   <data dir>/report-photos)
//   clock()                         the server clock (ISO string)
import { join } from "node:path";
import { bool, fail, int, reply, text } from "./http.mjs";
import {
  BOUNTY_RULES,
  MEMBERSHIP,
  REPUTATION_RULES,
  TERMS,
  addReport,
  bountyView,
  claim,
  completeClaim,
  humanTime,
  memberNotices,
  createBounty,
  createMember,
  dispatchAlerts,
  listBounties,
  listMembers,
  memberAlerts,
  memberView,
  normaliseLocality,
  refreshBounty,
  releaseClaim,
  requireBounty,
  requireMember,
  resolveViewer,
  storedRequest,
  updateMember,
  verifyReport,
  withdrawBounty,
} from "./bounties.mjs";

// A 5 MB photo is about 6.7 million base64 characters.
const REPORT_BODY_LIMIT = 7_200_000;

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const body0 = (body) => (isObject(body) ? body : fail("Send a JSON object"));

/** A numeric path parameter; anything else is not a record that exists. */
const pathId = (value, name) =>
  /^\d{1,15}$/.test(String(value)) ? int(Number(value), name, 1, Number.MAX_SAFE_INTEGER) : fail(`${name} not found`, 404);

// Loaded on first use so this module (and its tests) do not depend on the
// estimate, audit or database modules until a real request needs them.
const defaultEstimate = async (db, request, options) =>
  (await import("./estimate.mjs")).estimateFromEvidence(db, request, options);
const defaultRecordCheck = async () => (await import("./audit.mjs")).recordCheck;
const defaultPhotoDir = async () => join((await import("./db.mjs")).dataDir(), "report-photos");

/**
 * Ways a barcode may have been typed into an asking-price lookup: the
 * 14-digit GTIN and its shorter forms without leading zeros.
 */
const barcodeQueries = (gtin) =>
  [...new Set([14, 13, 12, 8].filter((n) => /^0*$/.test(gtin.slice(0, 14 - n))).map((n) => gtin.slice(14 - n)))];

/**
 * The latest eBay Browse lookup for the barcode still inside its time to
 * live (evidence.mjs lookup cache), or null. Without one, an empty list of
 * asking prices means nobody looked.
 */
async function defaultAskingLookup(db, barcode, { now }) {
  if (typeof barcode !== "string" || !/^\d{14}$/.test(barcode)) return null;
  try {
    const { cachedLookup } = await import("./evidence.mjs");
    let best = null;
    for (const query of barcodeQueries(barcode)) {
      const hit = cachedLookup(db, "ebay", query, { now });
      if (hit && (!best || hit.fetched > best.fetched)) best = { provider: "ebay", fetched: hit.fetched };
    }
    return best;
  } catch {
    return null; // no lookup cache: nothing is on record
  }
}

/**
 * The estimate request a bounty is created from, ready for the server to
 * run: the client's clock is dropped (the server clock decides freshness)
 * and the bounty's locality decides which branch stock checks count.
 */
function bountyRequest(request, locality) {
  if (!isObject(request))
    fail("estimate is required: the estimate request from the Research tab, or create a labelled sample bounty");
  const place = text(locality, "locality", 120);
  if (request.locality && normaliseLocality(request.locality) !== normaliseLocality(place))
    fail(`The estimate checked stock in ${request.locality}, not ${place}`);
  const { now: _now, ...rest } = request;
  return { ...rest, locality: place };
}

export function routes(db, options = {}) {
  const clock = options.clock ?? (() => new Date().toISOString());
  const estimate = options.estimate ?? defaultEstimate;
  const recordCheck = async () => options.recordCheck ?? (await defaultRecordCheck());
  const photoDir = async () => options.photoDir ?? (await defaultPhotoDir());
  const askingLookup = options.askingLookup ?? defaultAskingLookup;
  const lookupFor = async (barcode, now) => {
    try {
      return (await askingLookup(db, barcode, { now })) ?? null;
    } catch {
      return null;
    }
  };

  /**
   * Re-runs the stored estimate for a live bounty with the server clock and
   * stores the result, so claims and alerts use evidence checked now. A
   * failed re-check makes the bounty ineligible (fail closed).
   */
  async function recheck(bountyId, now) {
    const bounty = requireBounty(db, bountyId);
    if (bounty.sample) return bounty;
    const request = storedRequest(bounty);
    let result;
    try {
      if (!request) throw Error("no stored estimate request");
      result = await estimate(db, request, { now });
    } catch (error) {
      result = { error: error.message };
    }
    return refreshBounty(db, bounty.id, result, now, { lookup: await lookupFor(bounty.barcode, now) });
  }

  /** The operator's message after a live bounty is created or re-checked. */
  const outcome = (view, created) => {
    const tier = view.opportunity?.tier ?? "Review";
    const why = [...(view.claimBlockers ?? [])];
    if (view.remaining <= 0) why.push(view.cap === 0 ? "the distribution cap is 0" : "the cap is fully claimed");
    const hiddenNote = view.display.permitted
      ? ""
      : " Its source does not permit display, so members and visitors see no title, retailer, prices or sale figures.";
    if (view.alert.canSend)
      return `${created ? "Bounty created" : "Evidence re-checked"} (${tier}) with a cap of ${view.cap} unit${view.cap === 1 ? "" : "s"}. ${TERMS.buyAndResell}${hiddenNote}`;
    return `${created ? "Bounty created" : "Evidence re-checked"} as ${tier}, but it cannot send alerts or take claims: ${why.join("; ") || "the buy-alert checks do not pass"}.${hiddenNote}`;
  };

  const viewerOf = (url) => resolveViewer(db, url.searchParams.get("viewer"));

  return [
    [
      "GET",
      "/api/members",
      () => {
        const now = clock();
        return {
          members: listMembers(db).map((m) => memberView(db, m, { now })),
          tiers: MEMBERSHIP.tiers,
          paidTierIds: MEMBERSHIP.paidTierIds,
          reputation: REPUTATION_RULES,
          terms: TERMS,
        };
      },
    ],
    [
      "POST",
      "/api/members",
      ({ body }) => {
        const now = clock();
        const member = createMember(db, body0(body), { now });
        return reply(201, { member: memberView(db, member, { now }), notice: TERMS.privacy });
      },
    ],
    [
      "PATCH",
      "/api/members/:id",
      ({ params, body }) => {
        const now = clock();
        const member = updateMember(db, pathId(params.id, "Member"), body0(body), { now });
        return { member: memberView(db, member, { now }) };
      },
    ],
    [
      "GET",
      "/api/members/:id/alerts",
      ({ params }) => {
        const memberId = pathId(params.id, "Member");
        const now = clock();
        return {
          alerts: memberAlerts(db, memberId, { now }),
          // "Don't make the trip" notices, including bounties the member
          // claimed without an alert.
          stopNotices: memberNotices(db, memberId),
          notice: TERMS.alerts,
        };
      },
    ],
    [
      "GET",
      "/api/bounties",
      ({ url }) => {
        const now = clock();
        const viewer = viewerOf(url);
        return { bounties: listBounties(db, { viewer, now }), rules: BOUNTY_RULES, terms: TERMS };
      },
    ],
    [
      "GET",
      "/api/bounties/:id",
      ({ params, url }) => {
        const now = clock();
        const viewer = viewerOf(url);
        return { bounty: bountyView(db, requireBounty(db, pathId(params.id, "Bounty")), { viewer, now }) };
      },
    ],
    [
      "POST",
      "/api/bounties",
      async ({ body }) => {
        const now = clock();
        const input = body0(body);
        const sample = input.sample === undefined ? false : bool(input.sample, "sample");
        let result = null;
        let request = null;
        let lookup = null;
        if (sample) {
          if (input.estimate !== undefined && input.estimate !== null)
            fail("A sample bounty takes no estimate: remove the estimate or set sample to false");
        } else {
          request = bountyRequest(input.estimate, input.locality);
          result = await estimate(db, request, { now });
          lookup = await lookupFor(result?.offer?.gtin, now);
        }
        const bounty = createBounty(db, input, { estimate: result, request, lookup, now });
        const view = bountyView(db, bounty, { viewer: { kind: "operator" }, now });
        return reply(201, {
          bounty: view,
          message: view.sample
            ? "Sample bounty created. It is labelled Sample, shows illustrative figures only, can never send an alert and cannot be claimed."
            : outcome(view, true),
        });
      },
    ],
    [
      "POST",
      "/api/bounties/:id/recheck",
      async ({ params }) => {
        const now = clock();
        const bounty = await recheck(pathId(params.id, "Bounty"), now);
        const view = bountyView(db, bounty, { viewer: { kind: "operator" }, now });
        return {
          bounty: view,
          message: view.sample ? "Sample bounty: there is no evidence to re-check." : outcome(view, false),
        };
      },
    ],
    [
      "POST",
      "/api/bounties/:id/withdraw",
      ({ params }) => {
        const now = clock();
        const bounty = withdrawBounty(db, pathId(params.id, "Bounty"), { now });
        return {
          bounty: bountyView(db, bounty, { viewer: { kind: "operator" }, now }),
          message:
            "Bounty withdrawn. Active claims were released, and members alerted or holding a claim were told not to make the trip.",
        };
      },
    ],
    [
      "POST",
      "/api/bounties/:id/claims",
      async ({ params, body }) => {
        const now = clock();
        const input = body0(body);
        const bountyId = pathId(params.id, "Bounty");
        const member = requireMember(db, input.memberId);
        await recheck(bountyId, now);
        const qualifies = input.qualifiesForPromotion;
        if (qualifies !== undefined && qualifies !== null) bool(qualifies, "qualifiesForPromotion");
        const made = claim(db, {
          bountyId,
          memberId: member.id,
          units: input.units,
          qualifiesForPromotion: qualifies === true,
          now,
        });
        const bounty = requireBounty(db, bountyId);
        return reply(201, {
          claim: made,
          bounty: bountyView(db, bounty, { viewer: { kind: "member", member }, now }),
          message:
            `Claim recorded for ${made.units} unit${made.units === 1 ? "" : "s"} until ${humanTime(made.expires_at)}.` +
            (made.promotion ? ` You confirmed you qualify for: ${made.promotion}.` : "") +
            ` ${TERMS.claim} ${TERMS.buyAndResell}`,
        });
      },
    ],
    [
      "POST",
      "/api/claims/:id/release",
      ({ params, body }) => {
        const input = body0(body);
        const released = releaseClaim(db, { claimId: pathId(params.id, "Claim"), memberId: input.memberId, now: clock() });
        return { claim: released, message: "Claim released. Its units are free for other members." };
      },
    ],
    [
      "POST",
      "/api/claims/:id/complete",
      ({ params, body }) => {
        const input = body0(body);
        const done = completeClaim(db, {
          claimId: pathId(params.id, "Claim"),
          memberId: input.memberId,
          unitsBought: input.units,
          now: clock(),
        });
        return {
          claim: done,
          message: `Marked as bought: ${done.units} unit${done.units === 1 ? "" : "s"}. You own this stock and carry the risk. ${TERMS.verified}`,
        };
      },
    ],
    [
      "POST",
      "/api/bounties/:id/reports",
      async ({ params, body }) => {
        const now = clock();
        const input = body0(body);
        const bountyId = pathId(params.id, "Bounty");
        const member = requireMember(db, input.memberId);
        const report = addReport(
          db,
          { ...input, bountyId, memberId: member.id },
          { now, photoDir: input.photo ? await photoDir() : null },
        );
        const bounty = requireBounty(db, bountyId);
        return reply(201, {
          bounty: bountyView(db, bounty, { viewer: { kind: "member", member }, now }),
          reportId: report.id,
          message:
            (report.units_seen === 0
              ? "Report saved: none on the shelf. Claims and alerts for this bounty pause until someone reports stock again" +
                (bounty.sample ? "." : ", and members alerted or holding a claim are told not to make the trip.")
              : "Report saved: stock seen.") +
            (bounty.sample
              ? " This is a sample bounty, so the report is practice and earns no reputation points."
              : " An accurate report earns reputation points once the operator verifies it, whether or not stock was there.") +
            (report.photo_sha256 ? " " + TERMS.photo : ""),
        });
      },
      { limit: REPORT_BODY_LIMIT },
    ],
    [
      "POST",
      "/api/reports/:id/verify",
      async ({ params, body }) => {
        const now = clock();
        const input = body0(body);
        const result = verifyReport(db, pathId(params.id, "Report"), input.accurate, {
          now,
          recordCheck: await recordCheck(),
        });
        // A verified report became a branch stock check: re-check the
        // bounty's evidence so its stock status follows at once.
        if (result.stockCheckId !== null) await recheck(result.report.bounty_id, now);
        return {
          ...result,
          message:
            result.points > 0
              ? `${result.reason}: ${result.points} reputation points.`
              : result.reason + ".",
        };
      },
    ],
    [
      "POST",
      "/api/bounties/:id/alerts",
      async ({ params }) => {
        const now = clock();
        const bountyId = pathId(params.id, "Bounty");
        await recheck(bountyId, now);
        const result = dispatchAlerts(db, bountyId, now);
        return { ...result, notice: TERMS.alerts };
      },
    ],
  ];
}
