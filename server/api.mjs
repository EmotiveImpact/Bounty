import { createServer } from "node:http";
import { database } from "./db.mjs";
import { createApi } from "./app.mjs";
import { accessConfig } from "./access.mjs";
import { accounts, neonStore } from "./accounts.mjs";
import { seedSampleTips } from "./sample-tips.mjs";

const port = Number(process.env.PORT || 4174);
let access;
try {
  access = accessConfig();
} catch (error) {
  console.error("Bounty API not started: " + error.message);
  process.exit(1);
}
const { listenHost, publicHosts, password, databaseUrl, inviteCode, operators } = access;
const members = databaseUrl ? accounts(await neonStore(databaseUrl), { inviteCode }) : null;
const db = database();
seedSampleTips(db);
createServer(createApi(db, { publicHosts, password, members, operators })).listen(port, listenHost, () =>
  console.log(
    `Bounty API listening on ${listenHost}:${port}` +
      (publicHosts.length ? ` for ${publicHosts.join(", ")}` : "") +
      (members ? ", member sign-in required" : password ? ", password required" : ""),
  ),
);
