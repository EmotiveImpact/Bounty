// Whether a trip fits the person making it (round 5, finding 4): their
// transport, carry limit, the cash they can spend before a payout and the
// units they can store at home. Pure: no database, no clock.
//
// The load limit is the Planner's rule (catalog.mjs loadLimit): by car or
// van the larger of the carry limit and CAR_BOOT_KG, by public transport the
// smaller of it and HAND_CARRY_KG, on foot or by bicycle the carry limit.
//
// A blank value is unknown, never zero and never enough: a check that needs
// it fails and asks for it to be confirmed. Where the load limit, the cash
// or the storage would allow fewer units than planned, the check says how
// many.
import { MODES } from "./trip.mjs";
import { CAR_BOOT_KG, HAND_CARRY_KG, loadLimit } from "./catalog.mjs";
import { fail, int, num, oneOf } from "./http.mjs";

// The four checks, in the order the gate lists them.
export const SUITABILITY_CHECKS = Object.freeze([
  "one-unit-load",
  "total-load",
  "cash-available",
  "storage-space",
]);

// The profile fields, as requests name them, with the words used to ask for
// a blank one.
export const PROFILE_FIELDS = Object.freeze(["transport", "carryKg", "cashAvailable", "storageUnits"]);
const FIELD_WORDS = Object.freeze({
  transport: "how you will travel",
  carryKg: "how much you can carry (kg)",
  cashAvailable: "the cash you can spend on this trip",
  storageUnits: "how many units you have room for at home",
});

export const MAX_CARRY_KG = 1000;
export const MAX_CASH_PENCE = 10_000_000;
export const MAX_STORAGE_UNITS = 100_000;

const VEHICLES = new Set(["Car", "Van"]);
const BY = Object.freeze({
  Walk: "on foot",
  Bicycle: "by bicycle",
  "Public transport": "by public transport",
  Car: "by car",
  Van: "by van",
});

const blank = (v) => v === undefined || v === null || (typeof v === "string" && v.trim() === "");
const kg = (v) => Math.round(v * 100) / 100;
const pounds = (pence) => (pence < 0 ? "-£" : "£") + (Math.abs(pence) / 100).toFixed(2);
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const listWords = (items) =>
  items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;

/**
 * A trip profile from a request: { transport, carryKg, cashAvailable,
 * storageUnits }, each null when blank (unknown). A value that is given
 * must be valid, or the request is a 400 naming the field (prefix is how
 * the request names the object, such as "profile"). fields limits which
 * fields are read (a member's stored profile has no cash).
 */
export function readTripProfile(value, { prefix = "profile", fields = PROFILE_FIELDS } = {}) {
  if (blank(value)) return null;
  if (typeof value !== "object" || Array.isArray(value)) fail(`${prefix} must be an object`);
  const name = (k) => (prefix ? `${prefix}.${k}` : k);
  const out = {};
  for (const key of fields) {
    const v = value[key];
    if (blank(v)) out[key] = null;
    else if (key === "transport") out[key] = oneOf(v, name(key), MODES);
    else if (key === "carryKg") out[key] = num(v, name(key), 0, MAX_CARRY_KG);
    else if (key === "cashAvailable") out[key] = int(v, name(key), 0, MAX_CASH_PENCE);
    else if (key === "storageUnits") out[key] = int(v, name(key), 0, MAX_STORAGE_UNITS);
  }
  return out;
}

/** The profile with anything that is not a valid value read as unknown (null). */
export function tripProfile(value) {
  const p = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    transport: typeof p.transport === "string" && MODES.includes(p.transport) ? p.transport : null,
    carryKg:
      typeof p.carryKg === "number" && Number.isFinite(p.carryKg) && p.carryKg >= 0 && p.carryKg <= MAX_CARRY_KG
        ? p.carryKg
        : null,
    cashAvailable: Number.isSafeInteger(p.cashAvailable) && p.cashAvailable >= 0 ? p.cashAvailable : null,
    storageUnits: Number.isSafeInteger(p.storageUnits) && p.storageUnits >= 0 ? p.storageUnits : null,
    // Units already at home from earlier trips that take up that room (round
    // 5b: a member's units bought through bounties and not yet recorded as
    // sold or returned). The app's own count, so missing is 0.
    heldUnits: Number.isSafeInteger(p.heldUnits) && p.heldUnits >= 0 ? p.heldUnits : 0,
    // Units in the member's other live claims, on their way home if bought
    // (round 5b, second verification). Also the app's own count.
    claimedUnits: Number.isSafeInteger(p.claimedUnits) && p.claimedUnits >= 0 ? p.claimedUnits : 0,
  };
}

/** The load limit for a profile in kg (loadLimit), or null when transport or carry limit is unknown. */
export function profileLoadLimit(profile) {
  const p = tripProfile(profile);
  return p.transport === null || p.carryKg === null ? null : loadLimit(p.transport, p.carryKg);
}

/** How the load limit was set, in words: "your 0.1 kg load limit on foot". */
function limitWords(p, load) {
  return `your ${kg(load)} kg load limit ${BY[p.transport]}`;
}

/** Why the load limit is what it is, when the transport changes it. */
function limitBasis(p, load) {
  if (VEHICLES.has(p.transport) && load > p.carryKg)
    return ` (a vehicle takes ${CAR_BOOT_KG} kg, more than your ${kg(p.carryKg)} kg carry limit)`;
  if (p.transport === "Public transport" && load < p.carryKg)
    return ` (at most ${HAND_CARRY_KG} kg, about two full shopping bags, less than your ${kg(p.carryKg)} kg carry limit)`;
  return "";
}

/**
 * Whether a trip fits the person making it.
 *
 * input:
 *  units         units planned
 *  unitKg        weight of one unit in kg; null or missing is unknown
 *  cashRequired  cash the trip needs before any payout (tripEconomics
 *                cashRequired: stock, packaging, postage and the journey);
 *                null or missing is unknown
 *  cashFixed     the part of cashRequired that does not grow with units
 *                (the journey), so the units the cash allows can be counted;
 *                missing is 0
 *  profile       { transport, carryKg, cashAvailable, storageUnits,
 *                heldUnits, claimedUnits }; a blank value is unknown.
 *                storageUnits is the room at home; heldUnits (default 0)
 *                are units already there from bounties and claimedUnits
 *                (default 0) units in the member's other live claims, which
 *                take up some of it, so the room now is storageUnits less
 *                both. For a member, storageUnits is their room in all;
 *                Research and the Planner pass neither, so there it is the
 *                room free for this trip's units
 *  cash          false leaves the cash check out (it is asked later, for
 *                example when a member claims)
 *
 * Returns { ok, known, checks: [{ id, ok, detail, known, maxUnits }],
 * reasons, profile, missing, loadLimitKg, maxUnits: { load, cash, storage,
 * all } }. ok is true only when every check passes; known is false when a
 * profile value or a figure a check needs is blank. maxUnits.all is the
 * most units every known limit allows, or null when a limit is unknown.
 */
export function suitability({ units, unitKg = null, cashRequired = null, cashFixed = 0, profile = null, cash = true } = {}) {
  const p = tripProfile(profile);
  const n = Number.isSafeInteger(units) && units >= 0 ? units : null;
  const weight = typeof unitKg === "number" && Number.isFinite(unitKg) && unitKg > 0 ? unitKg : null;
  const need = Number.isSafeInteger(cashRequired) && cashRequired >= 0 ? cashRequired : null;
  const fixed = Number.isSafeInteger(cashFixed) && cashFixed >= 0 ? cashFixed : 0;
  const missing = PROFILE_FIELDS.filter((k) => p[k] === null && (cash || k !== "cashAvailable"));
  const load = p.transport !== null && p.carryKg !== null ? loadLimit(p.transport, p.carryKg) : null;
  const checks = [];
  const add = (id, ok, detail, known = true, maxUnits = null) => checks.push({ id, ok: ok === true, detail, known, maxUnits });

  // The load: one unit, then every unit planned.
  const loadMissing = ["transport", "carryKg"].filter((k) => p[k] === null);
  const confirmLoad = `Confirm ${listWords(loadMissing.map((k) => FIELD_WORDS[k]))}: the load limit depends on ${
    loadMissing.length === 1 && loadMissing[0] === "carryKg" ? "it" : "your transport and carry limit"
  }, and a blank is never counted as zero or as enough`;
  const maxByLoad = load !== null && weight !== null ? Math.floor(load / weight + 1e-9) : null;
  if (load === null) add("one-unit-load", false, confirmLoad, false);
  else if (weight === null) add("one-unit-load", false, "Unit weight not entered, so the load cannot be checked", false);
  else if (weight > load + 1e-9)
    add(
      "one-unit-load",
      false,
      `One unit weighs ${kg(weight)} kg, more than ${limitWords(p, load)}${limitBasis(p, load)}${
        VEHICLES.has(p.transport) ? "" : ": it needs a car or van"
      }`,
      true,
      0,
    );
  else add("one-unit-load", true, `One unit (${kg(weight)} kg) is within ${limitWords(p, load)}${limitBasis(p, load)}`, true, maxByLoad);

  const total = n !== null && weight !== null ? kg(n * weight) : null;
  if (n === null) add("total-load", false, "Units planned not known, so the load cannot be checked", false);
  else if (load === null)
    add(
      "total-load",
      false,
      `The load for ${plural(n, "unit")}${total === null ? "" : ` (${total} kg)`} cannot be checked until you confirm ${listWords(loadMissing.map((k) => FIELD_WORDS[k]))}`,
      false,
    );
  else if (weight === null) add("total-load", false, "Unit weight not entered, so the load cannot be checked", false);
  else if (n * weight > load + 1e-9)
    add(
      "total-load",
      false,
      `${plural(n, "unit")} weigh ${total} kg in all, more than ${limitWords(p, load)}${limitBasis(p, load)}: ${
        maxByLoad > 0 ? `at most ${plural(maxByLoad, "unit")} ${maxByLoad === 1 ? "fits" : "fit"} your ${kg(load)} kg load limit` : "not one unit fits it"
      }`,
      true,
      maxByLoad,
    );
  else
    add(
      "total-load",
      true,
      n === 1
        ? `The load (${total} kg) is within ${limitWords(p, load)}`
        : `All ${n} units (${total} kg) are within ${limitWords(p, load)}`,
      true,
      maxByLoad,
    );

  // Cash before any payout.
  let maxByCash = null;
  if (cash) {
    const perUnit = need !== null && n ? (need - Math.min(fixed, need)) / n : null;
    maxByCash =
      p.cashAvailable !== null && perUnit !== null && perUnit > 0
        ? Math.max(0, Math.floor((p.cashAvailable - Math.min(fixed, need) + 1e-9) / perUnit))
        : null;
    if (p.cashAvailable === null)
      add("cash-available", false, `Confirm ${FIELD_WORDS.cashAvailable}: a blank is never counted as zero or as enough`, false);
    else if (need === null)
      add(
        "cash-available",
        false,
        `The cash this trip needs before any payout is not known until every cost is entered, so it cannot be checked against your ${pounds(p.cashAvailable)}`,
        false,
      );
    else if (need > p.cashAvailable)
      add(
        "cash-available",
        false,
        `The trip needs ${pounds(need)} in cash before any payout, more than the ${pounds(p.cashAvailable)} you can spend${
          maxByCash === null ? "" : maxByCash > 0 ? `: at most ${plural(maxByCash, "unit")} ${maxByCash === 1 ? "fits" : "fit"} your cash` : ": not one unit fits it"
        }`,
        true,
        maxByCash,
      );
    else
      add("cash-available", true, `${pounds(need)} cash needed before any payout, within the ${pounds(p.cashAvailable)} you can spend`, true, maxByCash);
  }

  // Storage at home: the room, less units already there from bounties and
  // not yet recorded as sold or returned, and units in the member's other
  // live claims (round 5b).
  const held = p.heldUnits;
  const claimed = p.claimedUnits;
  const free = p.storageUnits === null ? null : Math.max(0, p.storageUnits - held - claimed);
  const taken = [
    held > 0 ? `${plural(held, "unit")} bought through bounties and not yet recorded as sold or returned` : "",
    claimed > 0 ? `${plural(claimed, "unit")} in your other live claims` : "",
  ].filter(Boolean);
  const heldText = taken.length ? ` (room for ${p.storageUnits} in all, less ${taken.join(", and ")})` : "";
  const maxByStorage = free;
  if (p.storageUnits === null)
    add("storage-space", false, `Confirm ${FIELD_WORDS.storageUnits}: a blank is never counted as zero or as enough`, false);
  else if (n === null) add("storage-space", false, "Units planned not known, so storage cannot be checked", false);
  else if (n > free)
    add(
      "storage-space",
      false,
      free === 0
        ? `You have no room at home for more units now${heldText}`
        : `${plural(n, "unit")}, more than the room you have at home for ${free} more now${heldText}: at most ${plural(free, "unit")} ${free === 1 ? "fits" : "fit"} your storage`,
      true,
      maxByStorage,
    );
  else
    add("storage-space", true, `${plural(n, "unit")} ${n === 1 ? "fits" : "fit"} the room you have at home for ${free} more now${heldText}`, true, maxByStorage);

  const caps = [maxByLoad, ...(cash ? [maxByCash] : []), maxByStorage];
  const known = checks.every((c) => c.known);
  return {
    ok: checks.every((c) => c.ok),
    known,
    checks,
    reasons: checks.filter((c) => !c.ok).map((c) => c.detail),
    profile: p,
    missing,
    loadLimitKg: load === null ? null : kg(load),
    maxUnits: {
      load: maxByLoad,
      cash: maxByCash,
      storage: maxByStorage,
      all: caps.some((c) => c === null) ? null : Math.min(...caps),
    },
  };
}
