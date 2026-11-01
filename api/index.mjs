// Vercel Function for the free demo: every /api/... request reaches the same
// API as on your own computer. See server/demo.mjs for what the demo keeps
// and for how long, and docs/DEPLOY.md for set-up.
process.env.BOUNTY_DATA_DIR ||= "/tmp/bounty-data";

const { createApi } = await import("../server/app.mjs");
const { database } = await import("../server/db.mjs");
const { accessConfig } = await import("../server/access.mjs");
const { freshPrices } = await import("../server/demo.mjs");

let handler;
try {
  const { publicHosts, password } = accessConfig();
  if (!password) throw Error("Set BOUNTY_PASSWORD in the Vercel project's environment variables, then redeploy");
  const db = database();
  const api = createApi(db, { publicHosts, password });
  const beforeRequest = freshPrices(db);
  handler = async (req, res) => {
    await beforeRequest();
    return api(req, res);
  };
} catch (error) {
  console.error("Bounty API not started: " + error.message);
  handler = (req, res) => {
    res.writeHead(503, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(JSON.stringify({ error: "Bounty is not set up yet: " + error.message }));
  };
}

export default (req, res) => handler(req, res);
