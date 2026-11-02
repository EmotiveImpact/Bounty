// Made-up example tips for while Bounty is in development. Each one is a
// sample bounty (createBounty with sample: true): labelled Sample
// everywhere, illustrative figures entered by hand, never claimable and
// never an alert. They match items in the sample Deals list
// (sample-deals.mjs) so the two screens tell the same story.
//
// seedSampleTips runs when the API starts (server/api.mjs and the Vercel
// function), not inside createApi, so tests start with no tips. It adds the
// set only when no sample tip is open, so a restart never doubles them, and
// a fresh set appears once the last ones expire.
import { createBounty } from "./bounties.mjs";

const DAY = 86400000;

// [title, variant, retailer, places, sales a week, weeks to sell,
//  competing listings, competing sellers, days until it ends]
const TIPS = [
  ["Wireless headphones", "Over-ear · Black · Sealed", "Tesco", 4, 3, 4, 6, 4, 6],
  ["Space shuttle building set", "412 pieces · Age 8+ · New", "Argos", 3, 2, 4, 4, 3, 5],
  ["Mechanical keyboard", "Full size · RGB · Sealed", "Argos", 3, 1.5, 6, 3, 2, 9],
  ["Remote control stunt car", "Rechargeable · Red · New", "B&M", 5, 2.5, 4, 5, 4, 4],
  ["Chunky knit throw", "130 x 170 cm · Cream · New", "Dunelm", 4, 2, 5, 3, 3, 7],
  ["Ionic hair dryer", "2200 W · Black · New", "Argos", 3, 2, 4, 4, 3, 3],
  ["Perfume gift set", "50 ml and body lotion · Sealed · New", "Superdrug", 6, 3, 3, 8, 5, 12],
  ["Large fox soft toy", "60 cm · Orange · New", "TK Maxx", 4, 2.5, 4, 2, 2, 2],
];

/** True when at least one sample tip is still open. */
function haveOpenSamples(db, now) {
  return Boolean(
    db.prepare("SELECT 1 FROM bounties WHERE sample = 1 AND status = 'open' AND expires_at > ? LIMIT 1").get(now),
  );
}

/**
 * Adds the example tips when none is open. Returns how many were added.
 * A failure is logged and never stops the API starting.
 */
export function seedSampleTips(db, { now = new Date().toISOString(), log = console.error } = {}) {
  try {
    if (haveOpenSamples(db, now)) return 0;
    const at = Date.parse(now);
    for (const [title, variant, retailer, places, salesPerWeek, sellWindowWeeks, listings, sellers, days] of TIPS)
      createBounty(
        db,
        {
          sample: true,
          title,
          variant,
          retailer,
          locality: "Leeds",
          availableUnits: places,
          salesPerWeek,
          sellWindowWeeks,
          competingListings: listings,
          competingSellers: sellers,
          expiresAt: new Date(at + days * DAY).toISOString(),
          sponsored: false,
        },
        { now },
      );
    return TIPS.length;
  } catch (error) {
    log("Example tips not added: " + error.message);
    return 0;
  }
}
