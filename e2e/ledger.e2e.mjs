// Ledger workflows recorded through the interface, at phone and desktop
// widths (round five, findings 3 and 5):
//   - a trip bought and worked on in October and paid out in November shows
//     £38.40 an hour (the whole trip, £80 over 125 minutes) in November and
//     no hourly figure in October, with labels that say what they cover;
//   - a unit refunded and sent back by the buyer can be sold again with no
//     discrepancy and the trade reaches verified with its proofs; a refund
//     where the buyer kept the item leaves nothing to sell, so a second sale
//     is flagged.
// Each width gets its own app and data directory, so both record the same
// trips from scratch.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { atWidths, loadChromium, startApp } from "./harness.mjs";

const chromium = loadChromium();
let browser;
before(async () => {
  if (chromium) browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
});

/** Polls a locator's text until it matches, failing with the text last seen. */
async function waitText(locator, pattern, what, ms = 10000) {
  const until = Date.now() + ms;
  let seen = "";
  for (;;) {
    seen = (await locator.count()) ? await locator.first().innerText() : "(not on the page)";
    if (pattern.test(seen)) return seen;
    if (Date.now() > until) throw new Error(`${what}: expected ${pattern}, saw ${JSON.stringify(seen)}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function newTrip(page, name) {
  const details = page.locator("details", { has: page.locator("summary", { hasText: "New trip" }) });
  if (!(await details.evaluate((d) => d.open))) await details.locator("summary").click();
  await details.locator('input[name="label"]').fill(name);
  await details.locator('select[name="kind"]').selectOption("resale");
  await details.getByRole("button", { name: "Create trip" }).click();
  await waitText(page.locator(".ledger-heading h2").nth(1), new RegExp("^" + name + "$"), "the new trip opens");
}

const entryRows = (page) => page.locator("table", { has: page.locator("th", { hasText: /^Entry$/ }) }).locator("tbody tr");

/** Adds one entry with the entry form and waits for its row. */
async function addEntry(page, { type, amount, units, minutes, date, refund }) {
  const form = page.getByRole("group", { name: "Add an entry" });
  const rows = entryRows(page);
  const before = await rows.count();
  await form.locator("select").first().selectOption(type);
  if (refund) {
    const choice = form.getByRole("group", { name: "Did the buyer send the item back?" });
    await choice.getByRole("radio", { name: refund === "returned" ? /Yes, it came back to me/ : /No, the buyer kept it/ }).check();
    // Units are asked for only when the item came back.
    assert.equal(await form.locator('input[name="units"]').count(), refund === "returned" ? 1 : 0, "units field for " + refund);
  }
  if (minutes !== undefined) await form.locator('input[name="minutes"]').fill(String(minutes));
  if (amount !== undefined) await form.locator('input[name="amount"]').fill(String(amount));
  if (units !== undefined) await form.locator('input[name="units"]').fill(String(units));
  await form.locator('input[name="occurred"]').fill(date);
  await form.getByRole("button", { name: "Save entry" }).click();
  const until = Date.now() + 10000;
  while ((await rows.count()) <= before) {
    const alert = form.locator('[role="alert"]');
    if (await alert.count()) throw new Error(`Saving the ${type} entry failed: ${await alert.innerText()}`);
    if (Date.now() > until) throw new Error(`The ${type} entry did not appear`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** Stores a small PDF as the proof for the entry whose option text is given. */
async function attachProof(page, entryLabel, body) {
  const group = page.getByRole("group", { name: "Private proofs" });
  const stored = group.locator(".ledger-proofs li");
  const before = await stored.count();
  await group.locator('input[name="file"]').setInputFiles({
    name: body + ".pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("%PDF-1.4\n%" + body + "\n%%EOF\n", "latin1"),
  });
  await group.locator('select[name="entryId"]').selectOption({ label: entryLabel });
  await group.getByRole("button", { name: "Store proof" }).click();
  const until = Date.now() + 10000;
  while ((await stored.count()) <= before) {
    const alert = group.locator('form [role="alert"]');
    if (await alert.count()) throw new Error(`Storing the proof for ${entryLabel} failed: ${await alert.innerText()}`);
    if (Date.now() > until) throw new Error(`The proof for ${entryLabel} did not appear`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** The ledger figure (dd) after the term (dt) matching the pattern. */
const figure = (page, pattern) => page.locator(".ledger-figures dt", { hasText: pattern }).first().locator("xpath=following-sibling::dd[1]");

async function showMonth(page, month) {
  await page.locator('.ledger-summary input[type="month"]').fill(month);
}

const hourlyStat = (page) => page.locator(".ledger-stat", { has: page.locator(".ledger-stat-label", { hasText: /^Earnings per hour on/ }) });
const stat = (page, label) => page.locator(".ledger-stat", { has: page.locator(".ledger-stat-label", { hasText: label }) });

test(
  "ledger: cross-month earnings per hour and a returned unit sold again, at 390 and 1280 px",
  { skip: !chromium && "Playwright is not installed", timeout: 240000 },
  async () => {
    for (const width of [390, 1280]) {
      const app = await startApp();
      try {
        await atWidths(
          browser,
          app.url + "/#Ledger",
          async (page) => {
            await page.waitForLoadState("networkidle");

            // Finding 3: £100 and 2 h in October; £180 and 5 minutes in November.
            await newTrip(page, "Cross-month kettle");
            await addEntry(page, { type: "receipt", amount: 100, units: 1, date: "2026-10-10" });
            await addEntry(page, { type: "work", minutes: 120, date: "2026-10-10" });
            await addEntry(page, { type: "sale", amount: 200, units: 1, date: "2026-11-01" });
            await addEntry(page, { type: "payout", amount: 180, units: 1, date: "2026-11-01" });
            await addEntry(page, { type: "work", minutes: 5, date: "2026-11-01" });

            await showMonth(page, "2026-11");
            await waitText(hourlyStat(page).locator(".ledger-stat-label"), /^Earnings per hour on the 1 trip completed in November 2026$/, "November label");
            await waitText(hourlyStat(page).locator(".ledger-stat-value"), /^£38\.40 an hour$/, "November per hour");
            await waitText(hourlyStat(page), /\+£80\.00 over 2\.08 h, counting all of the trip's payouts, costs and work time/, "November note");
            await waitText(stat(page, "Realised earnings").locator(".ledger-stat-value"), /^\+£180\.00$/, "November cash");
            assert.doesNotMatch(await page.locator(".ledger-summary").innerText(), /2,160/);

            await showMonth(page, "2026-10");
            await waitText(hourlyStat(page).locator(".ledger-stat-label"), /^Earnings per hour on trips completed in October 2026$/, "October label");
            await waitText(hourlyStat(page).locator(".ledger-stat-value"), /^not known$/, "October per hour");
            await waitText(hourlyStat(page), /1 trip with entries this month was completed in a later month and counts there/, "October note");
            await waitText(stat(page, "Realised earnings").locator(".ledger-stat-value"), /^-£100\.00$/, "October cash");
            assert.doesNotMatch(await page.locator(".ledger-summary").innerText(), /-£50\.00/);

            // The trip's own figure is the whole trip too.
            await waitText(figure(page, /^Realised earnings per hour/), /£38\.40 per hour/, "trip per hour");
            await waitText(figure(page, /^Realised earnings per hour/), /counts in November 2026's earnings per hour/, "trip completion");

            // Finding 5: buy 1, sell it, the buyer sends it back, sell it again.
            await newTrip(page, "Returned and resold");
            await addEntry(page, { type: "receipt", amount: 10, units: 1, date: "2026-10-01" });
            await addEntry(page, { type: "sale", amount: 25, units: 1, date: "2026-10-03" });
            await addEntry(page, { type: "payout", amount: 22, units: 1, date: "2026-10-05" });
            await addEntry(page, { type: "refund", amount: 25, refund: "returned", units: 1, date: "2026-10-07" });
            await addEntry(page, { type: "sale", amount: 25, units: 1, date: "2026-10-09" });
            await addEntry(page, { type: "payout", amount: 22, units: 1, date: "2026-10-12" });
            await addEntry(page, { type: "work", minutes: 30, date: "2026-10-12" });
            await waitText(figure(page, /^Units bought, sold, returned$/), /^1 \/ 2 \/ 1$/, "units");
            await waitText(figure(page, /^Unsold units$/), /^0$/, "unsold");
            await waitText(entryRows(page).filter({ hasText: "Refund to a buyer" }), /Item came back into stock/, "refund row");
            assert.equal(await page.getByText("Discrepancies to check").count(), 0);
            await waitText(page.locator("b", { hasText: /^Reconciliation/ }), /^Reconciliation\s+Complete$/i, "reconciliation");
            await attachProof(page, "Purchase receipt, 1 Oct 2026, £10.00", "till receipt " + width);
            await attachProof(page, "Payout, 5 Oct 2026, £22.00", "payout one " + width);
            await attachProof(page, "Payout, 12 Oct 2026, £22.00", "payout two " + width);
            await waitText(page.locator("b", { hasText: /^Verification/ }), /^Verification\s+Verified$/i, "verification");
            assert.equal(await page.locator("b", { hasText: /^Verification/ }).locator(".badge.ok").count(), 1);

            // The buyer kept the item: nothing comes back, so a second sale is flagged.
            await newTrip(page, "Buyer kept it");
            await addEntry(page, { type: "receipt", amount: 10, units: 1, date: "2026-10-01" });
            await addEntry(page, { type: "sale", amount: 25, units: 1, date: "2026-10-03" });
            await addEntry(page, { type: "payout", amount: 22, units: 1, date: "2026-10-05" });
            await addEntry(page, { type: "refund", amount: 25, refund: "kept", date: "2026-10-07" });
            await waitText(entryRows(page).filter({ hasText: "Refund to a buyer" }), /Buyer kept the item/, "kept refund row");
            await waitText(figure(page, /^Unsold units$/), /^0$/, "nothing to resell");
            await addEntry(page, { type: "sale", amount: 25, units: 1, date: "2026-10-09" });
            await waitText(
              page.locator("ul.checks li", { hasText: "The sale on 9 Oct 2026" }),
              /is for 1 unit, but none was in stock at that point/,
              "short sale flagged",
            );
          },
          [width],
        );
      } finally {
        app.stop();
      }
    }
  },
);
