// Round 5, finding 4 in the browser: a trip must fit the person making it.
// A member with no profile is asked to confirm it; they enter "on foot,
// 0.1 kg" in the Bounties tab and the card refuses the claim (one 0.9 kg
// unit needs a car or van); they change to a car, their own check refuses a
// cash figure too small for the trip, and with enough cash the claim is
// recorded. Research then shows the same checks for the operator's own
// profile, blank until entered and ticked, at 390 and 1280 px.
//
// The evidence (an Open Prices price, 26 recent exact sales, an asking-price
// lookup that found none) is written straight into the throwaway database,
// as the import commands would; the branch check, the bounty and the member
// go through the real routes.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { atWidths, loadChromium, startApp } from "./harness.mjs";

const chromium = loadChromium();
const BARCODE = "5012345678115";
const TITLE = "Mini Bluetooth speaker black";
const DAY = 86400000;
let app;
let browser;

async function setUp() {
  const { openDb } = await import("../server/db.mjs");
  const { londonDate } = await import("../server/http.mjs");
  const { storeLookup, upsertObservations, upsertResearch } = await import("../server/evidence.mjs");
  const now = new Date().toISOString();
  const ago = (n) => londonDate(new Date(Date.now() - n * DAY));
  const db = openDb(join(app.dataDir, "desk.sqlite"));
  upsertObservations(
    db,
    [{ id: 900001, title: TITLE, store: "Home Bargains", place: "PR1 2AR", city: "Preston", osm_id: "node/111", price: 1200, day: ago(0), barcode: BARCODE }],
    { now },
  );
  const base = { title: TITLE, barcode: BARCODE, size: "one size", pack: "1", model: "BTS-20", condition: "new" };
  const sales = Array.from({ length: 26 }, (_, i) => {
    const sold = 1 + Math.floor((i * 80) / 26);
    return { source_id: "s" + i, seller: "seller" + i, observed: ago(sold), listed: ago(sold + 4) };
  });
  upsertResearch(
    db,
    "sales",
    sales.map((s) => ({ ...base, ...s, kind: "Reported completed sale", price: 2800, retailer: "eBay UK", licence: "Self-reported" })),
    { now },
  );
  storeLookup(db, "ebay", BARCODE, [], { now });
  db.close();

  const ok = (res, status = 200) => {
    assert.equal(res.status, status, JSON.stringify(res.body));
    return res.body;
  };
  const post = (path, body) => app.api(path, { method: "POST", body });
  ok(
    await post("/api/research/checks", {
      barcode: BARCODE,
      retailer: "Home Bargains",
      locality: "Camden",
      method: "in_store",
      inStock: true,
      unitsSeen: 6,
      branch: "Home Bargains, Camden High Street NW1 7JE",
      pricePence: 1250,
    }),
    201,
  );
  // Three 0.9 kg units. The operator's own profile is never kept with a
  // bounty: each member's decides.
  const bounty = ok(
    await post("/api/bounties", {
      title: "Mini speaker",
      locality: "Camden",
      retailer: "Home Bargains",
      salesPerWeek: 10,
      sellWindowWeeks: 2,
      expiresAt: new Date(Date.now() + 5 * DAY).toISOString(),
      sponsored: false,
      estimate: {
        offer: { provider: "openprices", sourceId: "900001" },
        sales: sales.map((s) => ({ provider: "sales", sourceId: s.source_id })),
        units: 3,
        weightKg: 0.9,
        costs: { postage: 300, packaging: 30, handlingMinutes: 5, journeyCost: 0, journeyMinutes: 15 },
        hourlyFloor: 800,
        locality: "Camden",
        offerAttributes: { pack: "1", model: "BTS-20", condition: "new", size: "one size" },
        category: "general",
        categoryReason: "A loudspeaker, not food",
      },
    }),
    201,
  );
  assert.match(bounty.message, /with a cap of 4 units/);
  const paidUntil = new Date(Date.now() + 200 * DAY).toISOString().slice(0, 10);
  // Members with no profile yet.
  for (const name of ["Ann", "Bea"])
    ok(await post("/api/members", { name, alertsOptIn: true, alertLocalities: ["Camden"], paidTier: "diamond", paidUntil }), 201);
}

before(async () => {
  if (!chromium) return;
  app = await startApp();
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
  app?.stop();
});

test(
  "a member enters a profile in the Bounties tab, is refused on foot and allowed by car, and Research shows the checks, at 390 and 1280 px",
  { skip: !chromium && "Playwright is not installed" },
  async () => {
    await setUp();
    const who = { 390: "Ann", 1280: "Bea" };
    await atWidths(browser, app.url + "/#Bounties", async (page, width) => {
      const name = who[width];
      await page.getByLabel("Acting as").selectOption({ label: name });
      const card = page.locator("article.bounty", { hasText: "Mini speaker" });
      const fit = card.locator(".fit");

      // No profile: asked to confirm it, never told go, no claim form.
      await fit.getByText("Confirm your transport, carrying limit and storage").waitFor();
      assert.equal(await fit.getAttribute("data-fit"), "unknown");
      await card.locator(".badge", { hasText: "Confirm your transport, carrying limit and storage" }).waitFor();
      assert.equal(await card.getByRole("button", { name: "Claim" }).count(), 0);
      const summary = page.locator(".member-summary");
      await summary.getByText(/^Transport not entered, carrying limit not entered, room at home not entered\./).waitFor();
      // The alert checks never close with "every check passes" under a
      // failing check of the member's own.
      const checks = card.locator("details", { has: page.locator("summary", { hasText: "Alert checks now" }) });
      if (!(await checks.evaluate((el) => el.open))) await checks.locator("summary").click();
      await checks
        .getByText(
          "The checks for every member pass and the cap has room, but no trip is shown to you as one to make until your transport, carrying limit and room at home are entered in your profile.",
        )
        .waitFor();
      assert.equal(await checks.getByText("Every check passes now and the cap has room.").count(), 0);

      // On foot, 0.1 kg: refused, with the reason.
      await page.locator("summary", { hasText: "Edit profile, alerts and paid tier" }).click();
      const form = page.locator(".member-area form.member-form");
      await form.getByLabel("How you travel").selectOption("Walk");
      await form.getByLabel("How much you can carry (kg)").fill("0.1");
      await form.getByLabel("Room at home for units, in all").fill("10");
      await form.getByRole("button", { name: "Save member" }).click();
      await form.getByText("Saved.").waitFor();
      await summary.getByText(/^On foot, carries up to 0\.1 kg, room for 10 units at home in all\. Load limit 0\.1 kg; room at home for 10 more units now\./).waitFor();
      await fit.getByText("Does not fit you for 3 units").waitFor();
      assert.equal(await fit.getAttribute("data-fit"), "no");
      await fit
        .locator('li[data-check="one-unit-load"]')
        .getByText("One unit weighs 0.9 kg, more than your 0.1 kg load limit on foot: it needs a car or van")
        .waitFor();
      await card.locator(".badge", { hasText: "Does not fit your transport or storage" }).waitFor();
      await checks.getByText("The checks for every member pass and the cap has room, but this trip does not fit you as planned.").waitFor();
      assert.equal(await checks.getByText("Every check passes now and the cap has room.").count(), 0);
      await card.locator(".claim-panel .checks li", { hasText: "it needs a car or van" }).first().waitFor();
      assert.equal(await card.getByRole("button", { name: "Claim" }).count(), 0, "no claim form on foot");

      // By car: the boot takes 25 kg, so it fits and the claim form opens.
      await form.getByLabel("How you travel").selectOption("Car");
      await form.getByLabel("How much you can carry (kg)").fill("5");
      await form.getByRole("button", { name: "Save member" }).click();
      await fit.getByText("Your load limit and room at home fit 3 units").waitFor();
      assert.equal(await fit.getAttribute("data-fit"), "yes");
      await fit.getByText(/^One unit \(0\.9 kg\) is within your 25 kg load limit by car \(a vehicle takes 25 kg, more than your 5 kg carry limit\)$/).waitFor();
      await fit.getByText("The cash you can spend on this trip is asked when you claim", { exact: false }).first().waitFor();
      await checks.getByText("Every check passes now and the cap has room.").waitFor();

      // Room at home for 2: the card says 2 of the 3 units fit, and why the
      // claim is limited to 2.
      await form.getByLabel("Room at home for units, in all").fill("2");
      await form.getByRole("button", { name: "Save member" }).click();
      await card.locator(".badge", { hasText: "2 of the 3 units fit you" }).waitFor();
      await card.getByText(/; 2 of the 3 units fit you, so check your own figures for 2 units before you claim$/).waitFor();
      await card.getByText("Units to claim (up to 2 units now: what fits your room at home)").waitFor();
      await checks.getByText("The checks for every member pass and the cap has room, but only 2 of the 3 units fit you: check your own figures for 2 units before you claim.").waitFor();
      await form.getByLabel("Room at home for units, in all").fill("10");
      await form.getByRole("button", { name: "Save member" }).click();
      await fit.getByText("Your load limit and room at home fit 3 units").waitFor();

      // The claim form needs the cash for the trip; too little is refused
      // by the member's own check, with the reason.
      const claim = card.locator("form.claim-form");
      await claim.getByLabel("Your return journey cost (£)").fill("0");
      await claim.getByLabel("Your journey time there and back (minutes)").fill("15");
      const cash = claim.getByLabel("Cash you can spend on this trip (£)");
      assert.equal(await cash.evaluate((el) => el.required), true, "the cash is required");
      await cash.fill("10");
      await claim.getByRole("button", { name: "Check my figures" }).click();
      const own = claim.locator(".own-figures");
      await own.getByText(/^Your figures fail for 1 unit/).waitFor();
      await own.getByText(/more than the £10\.00 you can spend/).waitFor();
      await cash.fill("100");
      await claim.getByRole("button", { name: "Check my figures" }).click();
      await own.getByText(/^Your figures pass every check for 1 unit/).waitFor();
      await claim.getByRole("button", { name: "Claim" }).click();
      await card.getByText(/^Claim recorded for 1 unit/).waitFor();

      // Research: the operator's own profile, blank until entered (nothing
      // was saved in the Planner in this browser) and used only once ticked.
      await page.goto(app.url + "/#Research");
      await page.locator(".offer-list button", { hasText: TITLE }).first().click();
      const costs = page.locator("fieldset", { has: page.locator("legend", { hasText: "3. Your costs and time" }) });
      await costs.getByLabel("Units to buy").fill("3");
      await costs.getByLabel("Unit weight (kg)").fill("0.9");
      await costs.getByLabel("Parcel cost per unit sold (£), required").fill("3");
      await costs.getByLabel("Packaging per unit (£), required").fill("0.30");
      await costs.getByLabel("Return journey cost (£), required").fill("0");
      await costs.getByLabel("Journey minutes (return), required").fill("15");
      await costs.getByLabel("Handling minutes per unit, required").fill("5");
      await costs.getByLabel("Locality for the stock check").fill("Camden");
      const profile = costs.locator(".trip-profile");
      assert.equal(await profile.getByLabel("How you will travel, required").inputValue(), "");
      assert.equal(await profile.getByLabel("How much you can carry (kg), required").inputValue(), "");
      await profile.getByText("Tick once you have checked them.", { exact: false }).waitFor();
      const panel = page.locator(".fit-panel");
      await panel
        .getByText(/^Not known yet: confirm how you will travel, how much you can carry, the cash you can spend and your room at home above\./)
        .waitFor();
      await panel.locator('li[data-check="cash-available"]').getByText(/^Confirm the cash you can spend on this trip/).waitFor();

      await profile.getByLabel("How you will travel, required").selectOption("Walk");
      await profile.getByLabel("How much you can carry (kg), required").fill("0.1");
      await profile.getByLabel("Cash you can spend on this trip (£), required").fill("100");
      await profile.getByLabel("Room at home for this trip's units, required").fill("10");
      await profile.getByLabel("These are right for this trip", { exact: false }).check();
      await panel.getByText("No: not one unit fits your load limit. To make this trip you would need to travel another way or carry more.").waitFor();
      assert.equal(await panel.getAttribute("data-fit"), "no");
      await panel
        .locator('li[data-check="one-unit-load"]')
        .getByText("One unit weighs 0.9 kg, more than your 0.1 kg load limit on foot: it needs a car or van")
        .waitFor();
      await panel
        .locator('li[data-check="total-load"]')
        .getByText("3 units weigh 2.7 kg in all, more than your 0.1 kg load limit on foot: not one unit fits it")
        .waitFor();
      // The same checks are in the buy-alert list, so the trip cannot be alerted.
      await page.locator(".result ul.checks li", { hasText: "it needs a car or van" }).first().waitFor();

      // Two units' storage: says how many fit.
      await profile.getByLabel("How you will travel, required").selectOption("Car");
      await profile.getByLabel("Room at home for this trip's units, required").fill("2");
      await panel.getByText("No: at most 2 units fit your room at home. Lower the units to buy, or make room at home.").waitFor();
      await panel
        .locator('li[data-check="storage-space"]')
        .getByText("3 units, more than the room you have at home for 2 more now: at most 2 units fit your storage")
        .waitFor();
      await profile.getByLabel("Room at home for this trip's units, required").fill("10");
      await panel.getByText("Yes: it fits your transport, carrying limit, cash and storage.").waitFor();
      assert.equal(await panel.getAttribute("data-fit"), "yes");
    });
  },
);

test(
  "Research fills only the trip fields someone changed in the Planner, and the profile counts only once ticked, at 390 and 1280 px",
  { skip: !chromium && "Playwright is not installed" },
  async () => {
    const fillCosts = async (page) => {
      await page.locator(".offer-list button", { hasText: TITLE }).first().click();
      const costs = page.locator("fieldset", { has: page.locator("legend", { hasText: "3. Your costs and time" }) });
      await costs.getByLabel("Units to buy").fill("3");
      await costs.getByLabel("Unit weight (kg)").fill("0.9");
      await costs.getByLabel("Parcel cost per unit sold (£), required").fill("3");
      await costs.getByLabel("Packaging per unit (£), required").fill("0.30");
      await costs.getByLabel("Return journey cost (£), required").fill("0");
      await costs.getByLabel("Journey minutes (return), required").fill("15");
      await costs.getByLabel("Handling minutes per unit, required").fill("5");
      await costs.getByLabel("Locality for the stock check").fill("Camden");
      return costs.locator(".trip-profile");
    };
    await atWidths(browser, app.url + "/", async (page) => {
      // Opening the Planner (the landing tab) saves nothing.
      await page.evaluate(() => localStorage.clear());
      await page.reload();
      await page.getByRole("heading", { name: "Your buying profile" }).waitFor();
      await page.waitForTimeout(400);
      assert.equal(await page.evaluate(() => localStorage.getItem("bounty-profile")), null, "the Planner's starting values are not saved");
      await page.getByText("The transport, cash, carry limit and storage you change here are kept in this browser to fill in Research and member forms.").waitFor();

      // Changing only the hourly target saves the profile, but marks none of
      // the trip fields, so Research fills none of the starting values in.
      await page.getByLabel("Hourly target (£)").fill("15");
      await page.waitForFunction(() => JSON.parse(localStorage.getItem("bounty-profile") || "{}").target === 15);
      assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem("bounty-profile")).edited), []);
      await page.goto(app.url + "/#Research");
      let profile = await fillCosts(page);
      for (const label of ["How you will travel, required", "How much you can carry (kg), required", "Cash you can spend on this trip (£), required", "Room at home for this trip's units, required"])
        assert.equal(await profile.getByLabel(label).inputValue(), "", `${label} stays blank`);
      // The member form's button fills nothing in either, and says where to change them.
      const memberForm = async () => {
        await page.goto(app.url + "/#Bounties");
        await page.getByLabel("Acting as").selectOption({ label: "Ann" });
        await page.locator("summary", { hasText: "Edit profile, alerts and paid tier" }).click();
        const form = page.locator(".member-area form.member-form");
        // Blank first (not saved), so anything filled in came from the Planner.
        await form.getByLabel("How you travel").selectOption("");
        await form.getByLabel("How much you can carry (kg)").fill("");
        await form.getByLabel("Room at home for units, in all").fill("");
        await form.getByRole("button", { name: "Use the Planner profile saved in this browser" }).click();
        return form;
      };
      let form = await memberForm();
      await form
        .getByText(
          "No trip fields from the Planner are kept in this browser: its starting values are never used. Enter yours here, or change how you travel, what you can carry or your storage in the Planner first.",
        )
        .waitFor();
      assert.equal(await form.getByLabel("How you travel").inputValue(), "");
      assert.equal(await form.getByLabel("How much you can carry (kg)").inputValue(), "");
      // Changing the transport marks that field alone.
      await page.evaluate(() => sessionStorage.clear());
      await page.goto(app.url + "/");
      await page.getByRole("combobox", { name: /^Transport/ }).selectOption("Car");
      await page.waitForFunction(() => JSON.parse(localStorage.getItem("bounty-profile") || "{}").transport === "Car");
      assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem("bounty-profile")).edited), ["transport"]);
      await page.goto(app.url + "/#Research");
      profile = await fillCosts(page);
      assert.equal(await profile.getByLabel("How you will travel, required").inputValue(), "Car");
      assert.equal(await profile.getByLabel("How much you can carry (kg), required").inputValue(), "", "the starting carry limit is not taken");
      assert.equal(await profile.getByLabel("Room at home for this trip's units, required").inputValue(), "");
      // The member form takes the transport alone and says what is left to enter.
      form = await memberForm();
      await form
        .getByText(
          "Filled in from what you changed in the Planner. How much you can carry and your room at home were not changed there, so enter them here. Save member to keep it.",
        )
        .waitFor();
      assert.equal(await form.getByLabel("How you travel").inputValue(), "Car");
      assert.equal(await form.getByLabel("How much you can carry (kg)").inputValue(), "", "the Planner's starting 5 kg is not taken");
      assert.equal(await form.getByLabel("Room at home for units, in all").inputValue(), "", "nor its starting room for 10");

      // A profile saved without the mark (an older Planner saved its starting
      // values on load) fills nothing in.
      await page.evaluate(() =>
        localStorage.setItem("bounty-profile", JSON.stringify({ transport: "Walk", carry: 5, budget: 100, storage: 10 })),
      );
      await page.evaluate(() => sessionStorage.clear());
      await page.goto(app.url + "/#Research");
      await page.reload();
      profile = await fillCosts(page);
      assert.equal(await profile.getByLabel("How you will travel, required").inputValue(), "");
      assert.equal(await profile.getByLabel("How much you can carry (kg), required").inputValue(), "");
      assert.equal(await profile.getByLabel("Room at home for this trip's units, required").inputValue(), "");

      // An older mark of true does not say which fields were changed, so it
      // fills nothing in either (fail closed).
      await page.evaluate(() => {
        sessionStorage.clear();
        localStorage.setItem("bounty-profile", JSON.stringify({ transport: "Car", carry: 25, budget: 100, storage: 10, edited: true }));
      });
      await page.reload();
      profile = await fillCosts(page);
      assert.equal(await profile.getByLabel("How you will travel, required").inputValue(), "");
      assert.equal(await profile.getByLabel("Cash you can spend on this trip (£), required").inputValue(), "");

      // A profile whose four trip fields someone changed in the Planner fills
      // them in, but nothing counts until the box is ticked.
      // (The Research draft for this tab is cleared, as a new tab would be.)
      await page.evaluate(() => {
        sessionStorage.clear();
        localStorage.setItem(
          "bounty-profile",
          JSON.stringify({ transport: "Car", carry: 25, budget: 100, storage: 10, edited: ["transport", "carry", "budget", "storage"] }),
        );
      });
      await page.reload();
      profile = await fillCosts(page);
      assert.equal(await profile.getByLabel("How you will travel, required").inputValue(), "Car");
      assert.equal(await profile.getByLabel("How much you can carry (kg), required").inputValue(), "25");
      assert.equal(await profile.getByLabel("Cash you can spend on this trip (£), required").inputValue(), "100");
      assert.equal(await profile.getByLabel("Room at home for this trip's units, required").inputValue(), "10");
      const panel = page.locator(".fit-panel");
      await panel.getByText(/^Not known yet: confirm how you will travel/).waitFor();
      assert.equal(await panel.getAttribute("data-fit"), "no");
      await page.locator(".result ul.checks li:not(.pass)", { hasText: "Confirm how you will travel" }).first().waitFor();
      await profile.getByLabel("These are right for this trip", { exact: false }).check();
      await panel.getByText("Yes: it fits your transport, carrying limit, cash and storage.").waitFor();
      assert.equal(await page.locator(".result ul.checks li", { hasText: "Confirm how you will travel" }).count(), 0);

      // The headline names the cause: a blank cost leaves the cash the trip
      // needs unknown (the profile is complete).
      const costs = page.locator("fieldset", { has: page.locator("legend", { hasText: "3. Your costs and time" }) });
      await costs.getByLabel("Parcel cost per unit sold (£), required").fill("");
      await panel.getByText("Not known yet: enter every cost, so the cash the trip needs before any payout is known. A blank is never counted as zero or as enough.").waitFor();
      await costs.getByLabel("Parcel cost per unit sold (£), required").fill("3");
      // A known failure is "No", whatever is still blank; only the remedies that apply.
      await profile.getByLabel("How you will travel, required").selectOption("Walk");
      await profile.getByLabel("How much you can carry (kg), required").fill("0.1");
      await profile.getByLabel("Room at home for this trip's units, required").fill("");
      await panel.getByText("No: not one unit fits your load limit. To make this trip you would need to travel another way or carry more.").waitFor();
      await profile.getByLabel("How you will travel, required").selectOption("Car");
      await profile.getByLabel("Room at home for this trip's units, required").fill("10");
      await profile.getByLabel("Cash you can spend on this trip (£), required").fill("20");
      await panel.getByText("No: at most 1 unit fits the cash you can spend. Lower the units to buy, or have more cash ready.").waitFor();
      // Two remedies read as two: by bicycle with 1 kg and room for 1.
      await profile.getByLabel("Cash you can spend on this trip (£), required").fill("100");
      await profile.getByLabel("How you will travel, required").selectOption("Bicycle");
      await profile.getByLabel("How much you can carry (kg), required").fill("1");
      await profile.getByLabel("Room at home for this trip's units, required").fill("1");
      await panel
        .getByText("No: at most 1 unit fits your load limit and your room at home. Lower the units to buy. To buy them all, travel another way or carry more, and make room at home.")
        .waitFor();
    });
  },
);
