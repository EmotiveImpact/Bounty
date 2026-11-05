import { test } from "node:test";
import assert from "node:assert/strict";
import { memoryDb, serve } from "./test-support.mjs";
import { accounts } from "./accounts.mjs";
import { INTRO_DAYS, PLANS, introEnds, planById } from "./plans.mjs";

test("three plans, each opening everything the cheaper one does", () => {
  assert.deepEqual(PLANS.map((p) => [p.id, p.pricePence]), [
    ["starter", 399],
    ["plus", 999],
    ["fulltime", 2499],
  ]);
  for (let i = 1; i < PLANS.length; i++)
    for (const f of PLANS[i - 1].opens) assert.ok(PLANS[i].opens.includes(f), `${PLANS[i].id} keeps ${f}`);
  assert.ok(!planById("starter").opens.includes("trip"));
  assert.ok(planById("plus").opens.includes("research"));
  assert.ok(planById("fulltime").opens.includes("taxExport"));
  assert.equal(planById("gold"), null);
});

test("the £1 start lasts 7 days", () => {
  assert.equal(INTRO_DAYS, 7);
  assert.equal(introEnds("2026-11-02T12:00:00.000Z"), "2026-11-09T12:00:00.000Z");
  assert.equal(introEnds("not a date"), null);
});

test("without accounts the one plan is kept on this machine", async () => {
  const api = await serve(memoryDb(), [], { now: undefined });
  try {
    const first = await api.call("GET", "/api/plans");
    assert.equal(first.status, 200);
    assert.equal(first.body.current, null);
    assert.equal(first.body.payments, false);
    assert.deepEqual(first.body.intro, { pence: 100, days: 7, oncePerCard: true });

    const bad = await api.call("POST", "/api/plans/choose", { plan: "gold" });
    assert.equal(bad.status, 400);

    const plus = await api.call("POST", "/api/plans/choose", { plan: "plus" });
    assert.equal(plus.body.current.id, "plus");
    const since = plus.body.current.since;
    // Moving up keeps the start date, so the £1 week is not given twice.
    const full = await api.call("POST", "/api/plans/choose", { plan: "fulltime" });
    assert.equal(full.body.current.id, "fulltime");
    assert.equal(full.body.current.since, since);
    assert.equal((await api.call("GET", "/api/plans")).body.current.id, "fulltime");

    const none = await api.call("POST", "/api/plans/choose", { plan: null });
    assert.equal(none.body.current, null);
  } finally {
    await api.close();
  }
});

test("with accounts the plan belongs to the signed-in member", async () => {
  const users = [{ id: 1, email: "a@b.co.uk", name: null, plan: null, plan_since: null }];
  const store = {
    async sessionUser(hash) {
      return hash ? { id: 1, email: "a@b.co.uk", name: null } : null;
    },
    async plan(id) {
      const u = users.find((x) => x.id === id);
      return u ? { plan: u.plan, since: u.plan_since } : null;
    },
    async setPlan(id, plan, since) {
      const u = users.find((x) => x.id === id);
      Object.assign(u, { plan, plan_since: since });
      return { plan, since };
    },
  };
  const api = await serve(memoryDb(), [], { members: accounts(store), password: null });
  try {
    const out = await api.call("GET", "/api/plans");
    assert.equal(out.body.signedIn, false);
    assert.equal(out.body.current, null);
    assert.equal((await api.call("POST", "/api/plans/choose", { plan: "plus" })).status, 401);

    const cookie = { Cookie: "bounty_session=token" };
    const chose = await api.call("POST", "/api/plans/choose", { plan: "starter" }, cookie);
    assert.equal(chose.status, 200);
    assert.equal(chose.body.current.id, "starter");
    assert.equal(users[0].plan, "starter");
    const mine = await api.call("GET", "/api/plans", undefined, cookie);
    assert.equal(mine.body.signedIn, true);
    assert.equal(mine.body.current.id, "starter");
  } finally {
    await api.close();
  }
});
