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
import { planById } from "./plans.mjs";
import {
  BOUNTY_RULES,
  MEMBERSHIP,
  REPUTATION_RULES,
  TERMS,
  addReport,
  answerPromotion,
  bountyView,
  claim,
  completeClaim,
  humanTime,
  journeyInput,
  memberNotices,
  memberRequest,
  memberTripCheck,
  memberTripText,
  planForBounty,
  planForInput,
  promotionStanding,
  recheckOpenBounties,
  openBountyIds,
  createBounty,
  createMember,
  memberForAccount,
  applyPlanTier,
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
  tripBlockers,
  updateMember,
  verifyReport,
  withdrawBounty,
} from "./bounties.mjs";
// A member's own trip check: their hourly floor and cash date, the units
// already claimed on the bounty, and trip blockers ahead of the figures.
import { blockedTripCheck, claimTerms, memberTermsInput, sharedDemand } from "./bounties.mjs";
// Units bought through a claim that stop counting against the resale demand
// for the item: recorded as sold or returned by the member, or reconciled by
// the operator (round 5).
import { reconcileClaim, recordResale } from "./bounties.mjs";
// Whether a trip fits each member's own transport, carry limit, cash and
// storage (round 5, finding 4).
import { cashInput, memberProfileView, memberTripProfile } from "./bounties.mjs";
// A claim made before the cash was asked for stores the cash its member can
// spend, and a member's marketplace seller name stops their own listings
// counting twice against the demand (round 5b).
import { setClaimCash } from "./bounties.mjs";
// The operator confirms a member's seller name before their listings are
// counted once (round 5b, second verification).
import { confirmSellerName } from "./bounties.mjs";
// Units a member already has at home from bounties take up their storage
// room (round 5b).
import { homeStock, roomFor } from "./bounties.mjs";

// A bounty is shared with many members, so its own estimate leaves the
// transport, carry limit, cash and storage checks to each member's profile
// (estimate.mjs options.suitability); memberTripCheck applies them.
const PER_MEMBER = "per-member";

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
  // A locality that is not text (an object or array) is refused, never
  // turned into "[object Object]".
  const checked = text(request.locality, "estimate.locality", 120, { optional: true });
  if (checked && normaliseLocality(checked) !== normaliseLocality(place))
    fail(`The estimate checked stock in ${checked}, not ${place}`);
  // The operator's own profile (Research sends it) is not a member's: the
  // stored request never carries one.
  const { now: _now, profile: _profile, carryKg: _carry, ...rest } = request;
  return { ...rest, locality: place };
}

/**
 * The re-check for live bounties: re-runs a bounty's stored estimate with
 * the server clock and stores the result, so claims and alerts use evidence
 * checked now, worked out for the units one member can claim. A failed
 * re-check makes the bounty ineligible (fail closed). refreshBounty then
 * tells anyone alerted or holding a claim when the trip stopped or reopened.
 */
function rechecker(db, { estimate, askingLookup }) {
  const lookupFor = async (barcode, now) => {
    try {
      return (await askingLookup(db, barcode, { now })) ?? null;
    } catch {
      return null;
    }
  };
  async function recheck(bountyId, now) {
    const bounty = requireBounty(db, bountyId);
    if (bounty.sample) return bounty;
    const request = storedRequest(bounty);
    const lookup = await lookupFor(bounty.barcode, now);
    let result;
    try {
      if (!request) throw Error("no stored estimate request");
      result = await estimate(db, request, { now, suitability: PER_MEMBER });
      // The figures must be for the units one member can claim: when the
      // estimate was for more, work it out again for that many.
      const plan = planForBounty(bounty, result, { lookup, db, now });
      if (plan.rerun) result = await estimate(db, { ...request, units: plan.figures }, { now, suitability: PER_MEMBER });
    } catch (error) {
      result = { error: error.message };
    }
    // Every active claim is checked again on the same evidence (R3M2).
    const claimChecks = await recheckClaims(db, bounty, { estimate, now });
    return refreshBounty(db, bounty.id, result, now, { lookup, claimChecks });
  }
  return { recheck, lookupFor };
}

/**
 * Each active claim's own trip check worked out again on the evidence now
 * (R3M2), with its stored units and journey, the member's promotion
 * standing now (promotionStanding: a member who has since bought at a
 * first-order price at the retailer, or answered "not" or "used", no longer
 * qualifies, round 4 N2) and the member's rules (memberRequest,
 * memberTripCheck; neither is changed).
 * Demand is shared in claim order: the units bought on the bounty and the
 * units of claims made before this one count as competing units. A claim's
 * own hourly floor and cash date are used when the claim stores them (a
 * terms column); otherwise the operator's floor and no cash date. A claim
 * with no stored journey (made before journeys were kept) cannot be worked
 * out again and is left as it is. Returns [{ claimId, check }] for
 * refreshBounty, which stores each check on its claim.
 */
async function recheckClaims(db, bounty, { estimate, now }) {
  if (bounty.sample) return [];
  const at = new Date(Date.parse(now)).toISOString();
  const rows = db
    .prepare("SELECT * FROM claims WHERE bounty_id = ? AND status = 'active' AND expires_at > ? ORDER BY created, id")
    .all(bounty.id, at);
  const bought = db.prepare("SELECT member_id, units FROM claims WHERE bounty_id = ? AND status = 'completed'").all(bounty.id);
  const boughtUnits = bought.reduce((n, c) => n + (Number.isSafeInteger(c.units) ? c.units : 0), 0);
  const out = [];
  let ahead = 0;
  for (const c of rows) {
    const units = c.units;
    const journey = { cost: c.journey_cost, minutes: c.journey_minutes };
    let member = null;
    try {
      member = requireMember(db, c.member_id);
    } catch {
      member = null;
    }
    if (member && Number.isSafeInteger(journey.cost) && Number.isSafeInteger(journey.minutes)) {
      let terms = null;
      try {
        terms = typeof c.terms === "string" && c.terms ? JSON.parse(c.terms) : null;
      } catch {
        terms = null;
      }
      const mine = bought.filter((r) => r.member_id === c.member_id).reduce((n, r) => n + r.units, 0);
      const shared = { ...sharedDemand(db, bounty, member, now), committed: boughtUnits + ahead, mine };
      // The member's standing now, not only the answer stored with the claim
      // (round 4, N2): once they buy at a first-order price at this retailer
      // (or answer "not" or "used"), the price is no longer theirs.
      const standing = promotionStanding(db, bounty, member);
      const qualifies = standing ? standing.confirmed === true : c.promotion_confirmed === 1;
      const request = memberRequest(bounty, member, { units, journey, qualifies, terms });
      let result;
      try {
        if (!request) throw Error("no stored estimate request");
        result = await estimate(db, request, { now, suitability: PER_MEMBER });
      } catch (error) {
        result = { error: error.message };
      }
      // The member's profile now, with the cash they gave with the claim
      // (round 5): a claim that stored none fails the cash check.
      const own = claimTerms(bounty, terms);
      // Their room at home less units held and units in their claims made
      // before this one (homeStock).
      const profile = memberTripProfile(member, own.cashAvailable, homeStock(db, member.id, { bountyId: bounty.id, before: c, now }));
      out.push({ claimId: c.id, check: memberTripCheck(result, { units, journey, shared, terms: own, profile }) });
    }
    ahead += Number.isSafeInteger(units) ? units : 0;
  }
  return out;
}

/**
 * Re-runs the estimate for every open live bounty for a barcode (all of
 * them when none is given), optionally only at one retailer: the cap,
 * demand, competition and figures are worked out again (recheck, with every
 * active claim's own figures, R3M2), then the blocker pass runs
 * (recheckOpenBounties), so "Don't make the trip" and reopen notices go out
 * before it returns. Call it after a branch availability check is recorded
 * and after an import changes offers or sales (R3B1). There is no blocker
 * pass before the re-runs, so a trip the new evidence reopens is not
 * stopped and reopened in one go. A bounty whose re-run throws is listed in
 * failed and still gets the blocker pass. options: now (ISO), estimate and
 * askingLookup (the defaults are estimateFromEvidence and the eBay lookup
 * cache). Returns { rechecked: [bountyId], checked, bountyIds, stopped,
 * reopened, heldBack, failed }: stopped as recheckOpenBounties (the
 * bounties a blocker stops); reopened the bounties that reopened, as
 * { bountyId, title, noticesSent }; noticesSent counts the notices of that
 * kind this call sent; heldBack lists open bounties where some claim holders
 * were told to stop (beyond the units on the shelf, or their own figures
 * fail), as { bountyId, title, noticesSent }.
 */
export async function refreshOpenBounties(
  db,
  { barcode = null, retailer = null, now = new Date().toISOString(), estimate = defaultEstimate, askingLookup = defaultAskingLookup } = {},
) {
  const { recheck } = rechecker(db, { estimate, askingLookup });
  const ids = openBountyIds(db, { barcode, retailer, now });
  const lastNotice = (bountyId) =>
    db.prepare("SELECT COALESCE(MAX(id), 0) AS n FROM notices WHERE bounty_id = ?").get(bountyId).n;
  const since = new Map(ids.map((bountyId) => [bountyId, lastNotice(bountyId)]));
  const failed = [];
  for (const bountyId of ids) {
    try {
      await recheck(bountyId, now);
    } catch (error) {
      failed.push({ bountyId, error: error.message });
    }
  }
  const after = recheckOpenBounties(db, { barcode, retailer, now });
  // Notices this call sent (during the re-runs or the blocker pass).
  const added = (bountyId, kind, reason = null) =>
    db
      .prepare(`SELECT COUNT(*) AS n FROM notices WHERE bounty_id = ? AND id > ? AND kind = ?${reason ? " AND reason = ?" : ""}`)
      .get(bountyId, since.get(bountyId) ?? 0, kind, ...(reason ? [reason] : [])).n;
  const stoppedIds = new Set(after.stopped.map((b) => b.bountyId));
  const titles = new Map(
    after.bountyIds.map((bountyId) => [bountyId, db.prepare("SELECT title FROM bounties WHERE id = ?").get(bountyId)?.title ?? null]),
  );
  return {
    rechecked: ids,
    checked: after.checked,
    bountyIds: after.bountyIds,
    stopped: after.stopped.map((b) => ({ ...b, noticesSent: added(b.bountyId, "stop") })),
    reopened: after.bountyIds
      .filter((bountyId) => !stoppedIds.has(bountyId) && added(bountyId, "reopen", "reopened") > 0)
      .map((bountyId) => ({ bountyId, title: titles.get(bountyId), noticesSent: added(bountyId, "reopen", "reopened") })),
    heldBack: after.bountyIds
      .filter((bountyId) => !stoppedIds.has(bountyId) && added(bountyId, "stop") > 0)
      .map((bountyId) => ({ bountyId, title: titles.get(bountyId), noticesSent: added(bountyId, "stop") })),
    failed,
  };
}

export function routes(db, options = {}) {
  const clock = options.clock ?? (() => new Date().toISOString());
  const estimate = options.estimate ?? defaultEstimate;
  const recordCheck = async () => options.recordCheck ?? (await defaultRecordCheck());
  const photoDir = async () => options.photoDir ?? (await defaultPhotoDir());
  const askingLookup = options.askingLookup ?? defaultAskingLookup;
  const { recheck, lookupFor } = rechecker(db, { estimate, askingLookup });

  /**
   * The estimate re-run for one member's own trip on a bounty, at the units
   * they claim with their own journey, thresholds, hourly floor and cash
   * date (memberRequest), for memberTripCheck. A failed run fails closed.
   */
  async function memberCheck(bounty, member, { units, journey, qualifies, terms = null }) {
    const request = memberRequest(bounty, member, { units, journey, qualifies, terms });
    let result;
    try {
      if (!request) throw Error("no stored estimate request");
      result = await estimate(db, request, { now: clock(), suitability: PER_MEMBER });
    } catch (error) {
      result = { error: error.message };
    }
    return result;
  }

  /** The claim units from a request: a whole number up to the largest trial batch. */
  const claimUnits = (value) =>
    Number.isSafeInteger(value) && value >= 1 && value <= BOUNTY_RULES.maxClaimUnits
      ? value
      : fail(
          `units must be a whole number from 1 to ${BOUNTY_RULES.maxClaimUnits}: a claim is at most a trial batch until a verified trade exists`,
        );

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

  const viewerOf = (url, user, operator, accountsOn) => {
    if (!accountsOn || operator) return resolveViewer(db, url.searchParams.get("viewer"));
    const requested = url.searchParams.get("viewer");
    const mine = memberForAccount(db, user?.email);
    if (requested && requested !== "public" && (!mine || requested !== String(mine.id)))
      fail("You can only view tips as your own scout profile", user ? 403 : 401);
    return mine ? { kind: "member", member: mine } : { kind: "public" };
  };

  const isCount = (v) => Number.isSafeInteger(v) && v >= 0;
  const units = (n) => `${n} unit${n === 1 ? "" : "s"}`;
  /** What still counts against the demand after a release (round 5). */
  const outstandingWords = (n) =>
    n === 0
      ? "None of the units bought through this claim count against the demand for the item now."
      : `${units(n)} bought through this claim still ${n === 1 ? "counts" : "count"} against the demand for the item until recorded as sold or returned.`;
  /**
   * After units are released, the open bounties for the item are worked out
   * again, so their cap and figures use the demand left now. A failure is
   * reported, never thrown: the release is already stored.
   */
  async function refreshItem(bountyId, now) {
    try {
      const barcode = requireBounty(db, bountyId).barcode;
      if (!barcode) return { rechecked: [], failed: [] };
      const done = await refreshOpenBounties(db, { barcode, now, estimate, askingLookup });
      return { rechecked: done.rechecked, failed: done.failed };
    } catch (error) {
      return { rechecked: [], failed: [], error: error.message };
    }
  }

  /**
   * The open bounties for every item a member bought through a bounty,
   * worked out again (after their seller name changes, round 5b). A failure
   * is reported, never thrown: the change is already stored.
   */
  async function refreshBought(memberId, now) {
    const barcodes = db
      .prepare(
        "SELECT DISTINCT b.barcode FROM claims c JOIN bounties b ON b.id = c.bounty_id WHERE c.member_id = ? AND c.status = 'completed' AND b.sample = 0 AND b.barcode IS NOT NULL",
      )
      .all(memberId)
      .map((r) => r.barcode);
    const out = { rechecked: [], failed: [] };
    for (const barcode of barcodes) {
      try {
        const done = await refreshOpenBounties(db, { barcode, now, estimate, askingLookup });
        out.rechecked.push(...done.rechecked);
        out.failed.push(...done.failed);
      } catch (error) {
        out.failed.push({ barcode, error: error.message });
      }
    }
    return out;
  }

  /**
   * The open bounties where a member holds a live claim, worked out again
   * (round 5b, second verification): after their transport, carry limit or
   * room at home changes, and after another of their claims is marked as
   * bought, released or recorded as sold or returned, so each claim is
   * checked on their profile and room now and they are told at once when
   * it stops or reopens. except: bounty ids already worked out again. A
   * failure is reported, never thrown: the change is already stored.
   */
  async function recheckMemberClaims(memberId, now, { except = [] } = {}) {
    const skip = new Set(except);
    const open = new Set(openBountyIds(db, { now }));
    const at = new Date(Date.parse(now)).toISOString();
    const ids = db
      .prepare("SELECT DISTINCT bounty_id FROM claims WHERE member_id = ? AND status = 'active' AND expires_at > ? ORDER BY bounty_id")
      .all(memberId, at)
      .map((r) => r.bounty_id)
      .filter((bountyId) => open.has(bountyId) && !skip.has(bountyId));
    const out = { rechecked: [], failed: [] };
    for (const bountyId of ids) {
      try {
        await recheck(bountyId, now);
        out.rechecked.push(bountyId);
      } catch (error) {
        out.failed.push({ bountyId, error: error.message });
      }
    }
    return out;
  }
  const merged = (...parts) => {
    const out = { rechecked: [], failed: [] };
    for (const p of parts.filter(Boolean)) {
      for (const id of p.rechecked ?? []) if (!out.rechecked.includes(id)) out.rechecked.push(id);
      out.failed.push(...(p.failed ?? []));
      if (p.error) out.error = p.error;
    }
    return out;
  };

  // Signed in, a member's own plan decides their paid early access and how
  // many alert areas they may have; only an operator sets a paid tier by
  // hand. Returns the body to save and the plan (or null).
  async function planRules(body, user, operator, planRow) {
    if (!user || operator) return { input: body, plan: null };
    const plan = planById((await planRow())?.plan ?? null);
    const input = { ...body };
    delete input.paidTier;
    delete input.paidUntil;
    const areas = plan ? plan.areas : 0;
    if (areas !== null && Array.isArray(input.alertLocalities) && new Set(input.alertLocalities.map((a) => String(a).trim().toLowerCase())).size > areas)
      fail(!plan ? "Choose a plan before adding alert areas." :
        `Your ${plan.name} plan covers ${areas === 1 ? "one area" : `${areas} areas`}. ` +
          (plan.id === "starter" ? "Plus covers 3 and Full-time any number." : "Full-time covers any number."),
      );
    return { input, plan };
  }

  // Signed in with member accounts, a member may act only as the scout
  // profile linked to their own account; an operator may act as anyone.
  // Without accounts (this computer) user is null and nothing changes.
  function ownProfile(user, operator, memberId) {
    if (!user || operator || memberId === undefined || memberId === null) return;
    const member = Number.isInteger(Number(memberId))
      ? db.prepare("SELECT account_email FROM members WHERE id = ?").get(Number(memberId))
      : null;
    if (!member) return; // the handler answers "not found"
    if (member.account_email !== String(user.email).toLowerCase())
      fail("That scout profile belongs to another account", 403);
  }

  return [
    [
      "GET",
      "/api/members",
      ({ user, operator, accountsOn }) => {
        const now = clock();
        return {
          members: listMembers(db).map((m) => {
            const view = memberView(db, m, { now });
            if (!accountsOn || operator || m.account_email === user?.email) return view;
            return { id: view.id, name: view.name, locality: view.locality, earned: view.earned };
          }),
          tiers: MEMBERSHIP.tiers,
          paidTierIds: MEMBERSHIP.paidTierIds,
          reputation: REPUTATION_RULES,
          terms: TERMS,
        };
      },
    ],
    [
      // The scout profile linked to the signed-in account, or null (always
      // null signed out or without accounts).
      "GET",
      "/api/members/me",
      ({ user }) => {
        const member = memberForAccount(db, user?.email);
        return { member: member ? memberView(db, member, { now: clock() }) : null };
      },
    ],
    [
      "POST",
      "/api/members",
      async ({ body, user, operator, plan: planRow }) => {
        const now = clock();
        const { input, plan } = await planRules(body0(body), user, operator, planRow);
        // Signed in, the new profile is linked to the account (one each) and
        // gets the early access its plan buys.
        const made = createMember(db, input, { now, accountEmail: user?.email ?? null });
        if (user && !operator) applyPlanTier(db, user.email, plan?.tipTier ?? null, plan ? plan.areas : 0);
        const member = user && !operator ? requireMember(db, made.id) : made;
        return reply(201, { member: memberView(db, member, { now }), notice: TERMS.privacy });
      },
    ],
    [
      "PATCH",
      "/api/members/:id",
      async ({ params, body, user, operator, plan: planRow }) => {
        ownProfile(user, operator, params.id);
        const now = clock();
        const memberId = pathId(params.id, "Member");
        const { input } = await planRules(body0(body), user, operator, planRow);
        const before = requireMember(db, memberId);
        const member = updateMember(db, memberId, input, { now });
        // A new or changed seller name changes how many competing listings
        // are the member's own units (round 5b), so the open bounties for
        // items they bought through bounties are worked out again.
        const sellerChanged = Object.hasOwn(input, "sellerName") && (before?.seller_name ?? null) !== (member.seller_name ?? null);
        const bought = sellerChanged ? await refreshBought(member.id, now) : null;
        // A changed transport, carry limit or room at home changes whether
        // the member's live claims fit them, so each is checked again at
        // once (round 5b): a claim waiting on a profile value goes on.
        const profileChanged =
          before.transport !== member.transport || before.carry_kg !== member.carry_kg || before.storage_units !== member.storage_units;
        const claims = profileChanged ? await recheckMemberClaims(member.id, now, { except: bought?.rechecked ?? [] }) : null;
        const bounties = bought || claims ? merged(bought, claims) : null;
        // A completed trip profile (round 5) turns a "confirm your profile"
        // entry into the alert, as saying they qualify does for a question,
        // when the trip fits it and there is room under the cap.
        let alerted = 0;
        if (memberProfileView(member).complete)
          for (const { bounty_id: bountyId } of db
            .prepare("SELECT bounty_id FROM alerts WHERE member_id = ? AND kind = 'profile'")
            .all(member.id))
            alerted += dispatchAlerts(db, bountyId, now, { memberId: member.id }).sent.length;
        const checked = claims?.rechecked.length ?? 0;
        return {
          member: memberView(db, member, { now }),
          alerted,
          ...(bounties ? { bounties } : {}),
          ...(checked
            ? { message: `Saved. Your ${checked === 1 ? "live claim was" : `${checked} live claims were`} checked again against your profile now.` }
            : {}),
        };
      },
    ],
    [
      "POST",
      "/api/members/:id/seller-confirmation",
      async ({ params, body }) => {
        // The operator confirms that a member's seller name is theirs, from
        // their marketplace profile or one of their listings, or withdraws
        // that (round 5b). Until it is confirmed the member's listings count
        // in full. Accounts are not authenticated yet, so "operator" is
        // whoever uses the operator view (TERMS.privacy), as for reconcile.
        const now = clock();
        const input = body0(body);
        if (input.viewer !== "operator")
          fail('Only the operator can confirm a seller name: send viewer "operator" from the operator view', 403);
        const member = confirmSellerName(db, pathId(params.id, "Member"), input, { now });
        const bounties = await refreshBought(member.id, now);
        return {
          member: memberView(db, member, { now }),
          bounties,
          message:
            input.withdraw === true
              ? `Confirmation withdrawn: listings under ${member.seller_name ? `"${member.seller_name}"` : "this member's seller name"} count in full as competing listings again.`
              : `Confirmed: "${member.seller_name}" is ${member.name}'s seller name. Their listings with a listing time after they bought the item through a bounty are counted once, up to the units they still hold.`,
        };
      },
    ],
    [
      "GET",
      "/api/members/:id/alerts",
      ({ params, body, user, operator, accountsOn }) => {
        if (accountsOn && !user) fail("Sign in to read your alerts", 401);
        ownProfile(user, operator, params.id);
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
      ({ url, user, operator, accountsOn }) => {
        const now = clock();
        const viewer = viewerOf(url, user, operator, accountsOn);
        return { bounties: listBounties(db, { viewer, now }), rules: BOUNTY_RULES, terms: TERMS };
      },
    ],
    [
      "GET",
      "/api/bounties/:id",
      ({ params, url, user, operator, accountsOn }) => {
        const now = clock();
        const viewer = viewerOf(url, user, operator, accountsOn);
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
          result = await estimate(db, request, { now, suitability: PER_MEMBER });
          lookup = await lookupFor(result?.offer?.gtin, now);
          // Work the figures out for the units one member can claim (the
          // smallest of the estimate's units, the cap and the trial batch).
          // Units earlier bounties for the item still have against its
          // demand come off the cap first (round 5).
          const plan = planForInput(input, result, { lookup, now, db });
          // The operator's units stay in the stored request, so a re-check
          // works the figures out again for more units once the cap allows
          // them (for example after units from an earlier bounty are
          // recorded as sold), as it does for fewer.
          if (plan.rerun) result = await estimate(db, { ...request, units: plan.figures }, { now, suitability: PER_MEMBER });
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
      async ({ params, body, user, operator }) => {
        ownProfile(user, operator, body?.memberId);
        const now = clock();
        const input = body0(body);
        const bountyId = pathId(params.id, "Bounty");
        const member = requireMember(db, input.memberId);
        const units = claimUnits(input.units);
        const journey = journeyInput(input);
        // The cash they can spend on this trip: required, never zero (round 5).
        const cashAvailable = cashInput(input);
        // The member's own hourly floor and cash date (optional).
        const terms = memberTermsInput(input, { now });
        const qualifies = input.qualifiesForPromotion;
        if (qualifies !== undefined && qualifies !== null) bool(qualifies, "qualifiesForPromotion");
        // A price they said they do not qualify for, or a first-order offer
        // they used here, is refused whatever qualifiesForPromotion says.
        const said = promotionStanding(db, requireBounty(db, bountyId), member);
        if (said?.declined) fail(said.refusal, 409);
        const fresh = await recheck(bountyId, now);
        const blockers = tripBlockers(db, fresh, now);
        if (blockers.length) fail(blockers.join(". ") + ".", 409);
        const standing = promotionStanding(db, fresh, member);
        const confirmed = qualifies === true || standing?.confirmed === true;
        const check = await memberCheck(fresh, member, { units, journey, qualifies: confirmed, terms });
        const shared = sharedDemand(db, fresh, member, now);
        const made = claim(db, {
          bountyId,
          memberId: member.id,
          units,
          journey,
          check,
          qualifiesForPromotion: qualifies === true,
          terms,
          cashAvailable,
          now,
        });
        const own = memberTripCheck(check, {
          units,
          journey,
          shared,
          terms: claimTerms(fresh, terms),
          profile: memberTripProfile(member, cashAvailable, roomFor(db, requireBounty(db, bountyId), member.id, now)),
        });
        const bounty = requireBounty(db, bountyId);
        return reply(201, {
          claim: made,
          check: own,
          bounty: bountyView(db, bounty, { viewer: { kind: "member", member }, now }),
          message:
            `Claim recorded for ${made.units} unit${made.units === 1 ? "" : "s"} until ${humanTime(made.expires_at)}. ${memberTripText(own)}` +
            (made.promotion ? ` You said you qualify for: ${made.promotion}.` : "") +
            ` ${TERMS.claim} ${TERMS.buyAndResell}`,
        });
      },
    ],
    [
      "POST",
      "/api/bounties/:id/claim-check",
      async ({ params, body, user, operator }) => {
        ownProfile(user, operator, body?.memberId);
        // A member's own figures for a trip before they claim: the estimate
        // re-run at their units with their journey, thresholds, hourly
        // floor and cash date, beside the units already claimed on the
        // bounty. Nothing is stored. While the trip is blocked (or nothing is
        // left under the cap) the check is never ok and leads with the
        // "Don't make the trip" line.
        const now = clock();
        const input = body0(body);
        const bountyId = pathId(params.id, "Bounty");
        const member = requireMember(db, input.memberId);
        const units = claimUnits(input.units);
        const journey = journeyInput(input);
        const cashAvailable = cashInput(input);
        const terms = memberTermsInput(input, { now });
        const bounty = requireBounty(db, bountyId);
        if (bounty.sample) fail("Sample bounty: illustrative figures only, so there is no trip to check", 409);
        const view = bountyView(db, bounty, { viewer: { kind: "member", member }, now });
        if (view.display.hidden) fail("The source does not permit showing this offer's figures", 409);
        const standing = promotionStanding(db, bounty, member);
        if (standing?.declined) fail(standing.refusal, 409);
        if (standing && !standing.confirmed)
          fail(`Say whether you qualify for this price ("${standing.condition}") first: the figures depend on it`, 409);
        const result = await memberCheck(bounty, member, { units, journey, qualifies: Boolean(standing?.confirmed), terms });
        const own = memberTripCheck(result, {
          units,
          journey,
          shared: sharedDemand(db, bounty, member, now),
          terms: claimTerms(bounty, terms),
          // Their stored transport, carry limit and storage, and the cash
          // they can spend on this trip (round 5).
          profile: memberTripProfile(member, cashAvailable, roomFor(db, requireBounty(db, bountyId), member.id, now)),
        });
        const blockers = [...view.claimBlockers];
        let headline = blockers.length ? view.trip.headline : null;
        if (!blockers.length && view.remaining <= 0) {
          // Units earlier bounties for the item still have against its
          // demand are named when they are why (round 5).
          const owed = view.earlier?.binding ? view.earlier.note : null;
          headline =
            view.cap === 0
              ? `Nothing is left to claim: the distribution cap is 0, ${owed ? "because " + owed : "so the evidence leaves no units to share"}`
              : `Nothing is left to claim: the distribution cap for this bounty is fully claimed${owed ? `. ${owed.charAt(0).toUpperCase()}${owed.slice(1)}` : ""}`;
          blockers.push(headline);
        }
        const check = blockers.length ? blockedTripCheck(own, { blockers, headline }) : own;
        return { check, message: memberTripText(check), blockers: view.claimBlockers };
      },
    ],
    [
      "POST",
      "/api/bounties/:id/eligibility",
      ({ params, body, user, operator }) => {
        ownProfile(user, operator, body?.memberId);
        // A member's answer to a promotion question: "qualifies", "not",
        // "used" (already used a first-order offer at this retailer), or
        // "undo" (an answer given by mistake: the question is asked again).
        const now = clock();
        const input = body0(body);
        const bountyId = pathId(params.id, "Bounty");
        const member = requireMember(db, input.memberId);
        const standing = answerPromotion(db, { bountyId, memberId: member.id, answer: input.answer, now });
        // Saying they qualify turns an eligibility question into the alert.
        const dispatched = standing.confirmed ? dispatchAlerts(db, bountyId, now, { memberId: member.id }) : null;
        const bounty = requireBounty(db, bountyId);
        const unlisted = standing.declined && standing.firstOrder ? ", and this bounty is no longer listed for you" : "";
        return {
          eligibility: standing,
          alerted: Boolean(dispatched?.sent.length),
          bounty: bountyView(db, bounty, { viewer: { kind: "member", member }, now }),
          message: standing.confirmed
            ? `Thanks: you said you qualify for "${standing.condition}". The figures are shown on the card${dispatched?.sent.length ? " and the alert is in your inbox" : ""}. You still confirm it when you claim.`
            : input.answer === "undo"
              ? "Your answer was removed. Answer the question again when you are ready: nothing is claimed by answering."
              : standing.usedHere
                ? `Thanks: first-order offers at ${bounty.retailer} will not be sent to you again${unlisted}.`
                : `Thanks: you will not be alerted for this bounty${unlisted}.`,
        };
      },
    ],
    [
      "POST",
      "/api/claims/:id/release",
      async ({ params, body, user, operator }) => {
        ownProfile(user, operator, body?.memberId);
        const now = clock();
        const input = body0(body);
        const released = releaseClaim(db, { claimId: pathId(params.id, "Claim"), memberId: input.memberId, now });
        // The room it took at home is free for the member's other live
        // claims again (round 5b).
        const bounties = await recheckMemberClaims(released.member_id, now, { except: [released.bounty_id] });
        return { claim: released, bounties, message: "Claim released. Its units are free for other members." };
      },
    ],
    [
      "POST",
      "/api/claims/:id/cash",
      async ({ params, body, user, operator }) => {
        ownProfile(user, operator, body?.memberId);
        // "Check my figures" under a live claim (round 5b): the member who
        // holds it gives the cash they can spend on this trip (a claim made
        // before the cash was asked for stores none), and every claim on the
        // bounty is checked again on the evidence now.
        const now = clock();
        const input = body0(body);
        const stored = setClaimCash(db, {
          claimId: pathId(params.id, "Claim"),
          memberId: input.memberId,
          cashAvailable: input.cashAvailable,
          now,
        });
        const bounty = await recheck(stored.bounty_id, now);
        const member = requireMember(db, stored.member_id);
        const view = bountyView(db, bounty, { viewer: { kind: "member", member }, now });
        const mine = view.claims.find((c) => c.id === stored.id) ?? null;
        const f = mine?.figures ?? null;
        const cashGiven = mine?.cashAvailable ?? input.cashAvailable;
        const saved = `Saved: £${(cashGiven / 100).toFixed(2)} you can spend on this trip.`;
        const result = !f
          ? "Your figures could not be worked out again: do not make the trip until they pass."
          : f.ok
            ? `Your figures for ${units(stored.units)} were checked again on the latest evidence and every check passes.`
            : Array.isArray(f.confirm) && f.confirm.length
              ? `Your figures were checked again. ${view.viewer?.stop ?? "Confirm your member profile, then check your figures again"}.`
              : `Your figures for ${units(stored.units)} were checked again on the latest evidence and now fail: ${(f.reasons ?? []).join("; ")}.`;
        const trip = view.trip.go || !view.trip.headline || (f && !f.ok) ? "" : ` ${view.trip.headline}.`;
        return { claim: mine, bounty: view, message: `${saved} ${result}${trip}` };
      },
    ],
    [
      "POST",
      "/api/claims/:id/complete",
      async ({ params, body, user, operator }) => {
        ownProfile(user, operator, body?.memberId);
        const now = clock();
        const input = body0(body);
        const done = completeClaim(db, {
          claimId: pathId(params.id, "Claim"),
          memberId: input.memberId,
          unitsBought: input.units,
          now,
        });
        const retailer = requireBounty(db, done.bounty_id).retailer;
        // Claims this member holds on other first-order bounties at the
        // retailer are told at once that the price is no longer theirs.
        if (done.promotionUsed) recheckOpenBounties(db, { retailer, now });
        // The units bought are at home now, so the member's other live
        // claims are checked again on the room left (round 5b): one that no
        // longer fits is told at once.
        const bounties = await recheckMemberClaims(done.member_id, now, { except: [done.bounty_id] });
        const used = done.promotionUsed
          ? ` You bought at a first-order price, so the first-order offer at ${retailer} is now recorded as used and its price will not be offered to you again.`
          : "";
        return {
          claim: done,
          bounties,
          message: `Marked as bought: ${done.units} unit${done.units === 1 ? "" : "s"}. You own this stock and carry the risk.${used} ${TERMS.verified} Until you record them as sold or returned, the units you bought count against the demand for this item on any later bounty for it.`,
        };
      },
    ],
    [
      "POST",
      "/api/claims/:id/resale",
      async ({ params, body, user, operator }) => {
        ownProfile(user, operator, body?.memberId);
        // The member who bought units through a claim records how many they
        // sold or returned to the shop (round 5), so those units stop
        // counting against the resale demand for the item.
        const now = clock();
        const input = body0(body);
        const recorded = recordResale(db, {
          claimId: pathId(params.id, "Claim"),
          memberId: input.memberId,
          sold: input.sold,
          returned: input.returned,
          now,
        });
        const sold = isCount(input.sold) ? input.sold : 0;
        const returned = isCount(input.returned) ? input.returned : 0;
        const what = [sold ? `${units(sold)} sold` : "", returned ? `${units(returned)} returned to the shop` : ""].filter(Boolean).join(" and ");
        const item = await refreshItem(recorded.claim.bounty_id, now);
        // Room at home is freed for the member's live claims on other items too.
        const own = await recheckMemberClaims(recorded.claim.member_id, now, { except: item.rechecked });
        return {
          claim: recorded.claim,
          bought: recorded.bought,
          released: recorded.released,
          outstanding: recorded.outstanding,
          bounties: merged(item, own),
          message: `Recorded: ${what}. ${outstandingWords(recorded.outstanding)}`,
        };
      },
    ],
    [
      "POST",
      "/api/claims/:id/reconcile",
      async ({ params, body }) => {
        // The operator releases units bought through a claim that the
        // evidence shows are no longer heading to the resale market, with a
        // reason (round 5). Accounts are not authenticated yet, so "operator"
        // is whoever uses the operator view (TERMS.privacy).
        const now = clock();
        const input = body0(body);
        if (input.viewer !== "operator")
          fail('Only the operator can record a reconciliation: send viewer "operator" from the operator view', 403);
        const recorded = reconcileClaim(db, { claimId: pathId(params.id, "Claim"), units: input.units, reason: input.reason, now });
        return {
          claim: recorded.claim,
          bought: recorded.bought,
          released: recorded.released,
          outstanding: recorded.outstanding,
          bounties: await refreshItem(recorded.claim.bounty_id, now),
          message: `Reconciliation recorded: ${units(input.units)} released, with the reason given. ${outstandingWords(recorded.outstanding)}`,
        };
      },
    ],
    [
      "POST",
      "/api/bounties/:id/reports",
      async ({ params, body, user, operator }) => {
        ownProfile(user, operator, body?.memberId);
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
        const view = bountyView(db, bounty, { viewer: { kind: "member", member }, now });
        // A sighting while the trip is still stopped by an earlier empty
        // shelf waits for the operator: say so rather than repeat the stop.
        const waiting =
          report.units_seen > 0 && !bounty.sample && !view.trip.go && ["paused", "out-of-stock"].includes(view.trip.state);
        return reply(201, {
          bounty: view,
          reportId: report.id,
          message: waiting
            ? `Thanks: your report of ${report.units_seen} unit${report.units_seen === 1 ? "" : "s"} is waiting for the operator to verify it. Until then the bounty stays paused after the earlier ${
                view.trip.state === "paused" || /confirmed a report of none/.test(view.trip.headline ?? "")
                  ? "empty-shelf report"
                  : "branch check that found none"
              }.` +
              " An accurate report earns reputation points once the operator verifies it." +
              (report.photo_sha256 ? " " + TERMS.photo : "")
            : (report.units_seen === 0
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
