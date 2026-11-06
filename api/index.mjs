// Vercel Function: every /api/... request reaches the same API as on your own
// computer. With DATABASE_URL set, members' records are kept in Neon between
// instances (apps/server/keep.mjs); without it the data lasts only as long as
// the instance (apps/server/demo.mjs). Set-up: docs/DEPLOY.md.
process.env.BOUNTY_DATA_DIR ||= "/tmp/bounty-data";

const { createApi } = await import("../apps/server/app.mjs");
const { database, openDb, dataDir } = await import("../apps/server/db.mjs");
const { keepForGood, neonKeepStore } = await import("../apps/server/keep.mjs");
const { refreshOpenBounties } = await import("../apps/server/routes-bounties.mjs");
const { accessConfig } = await import("../apps/server/access.mjs");
const { freshPrices } = await import("../apps/server/demo.mjs");
const { seedSampleTips } = await import("../apps/server/sample-tips.mjs");
const { accounts, neonStore } = await import("../apps/server/accounts.mjs");

let handler;
try {
  if (!process.env.DATABASE_URL && !process.env.BOUNTY_PASSWORD)
    throw Error(
      "add DATABASE_URL (a Neon connection string, for member sign-in) or BOUNTY_PASSWORD (16 or more characters) " +
        "in the Vercel project's environment variables, then redeploy",
    );
  const { publicHosts, password, databaseUrl, inviteCode, operators } = accessConfig();
  const members = databaseUrl ? accounts(await neonStore(databaseUrl), { inviteCode }) : null;
  // One API on one database file: the database, sample tips and the Open
  // Prices check that runs before each request.
  const build = (db, onImported = () => undefined) => {
    const api = createApi(db, { publicHosts, password, members, operators });
    seedSampleTips(db);
    const beforeRequest = freshPrices(db, {
      // Not awaited: the import may finish during a change that is waiting
      // on it, and saving waits for that change to end.
      refresh: async (d, o) => {
        await refreshOpenBounties(d, o);
        onImported();
      },
    });
    return {
      db,
      handle: async (req, res) => {
        await beforeRequest();
        return api(req, res);
      },
    };
  };
  if (databaseUrl && process.env.BOUNTY_KEEP_DATA !== "off") {
    // Members' records are copied to Neon after every change and back when
    // Vercel starts a fresh instance (apps/server/keep.mjs).
    const keeper = keepForGood({
      store: await neonKeepStore(databaseUrl),
      dir: dataDir(),
      build: (file) => build(openDb(file), () => void keeper.changed()),
    });
    handler = keeper.handle;
  } else {
    const app = build(database());
    handler = app.handle;
  }
} catch (error) {
  console.error("Bounty API not started: " + error.message);
  handler = (req, res) => {
    res.writeHead(503, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(JSON.stringify({ error: "Bounty is not set up yet: " + error.message }));
  };
}

export default (req, res) => handler(req, res);
