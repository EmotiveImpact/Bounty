import { createServer } from "node:http";
import { database, dataDir } from "./db.mjs";
import { personalStores } from "./personal.mjs";
import { createApi } from "./app.mjs";
import { accessConfig } from "./access.mjs";
import { accounts, neonStore } from "./accounts.mjs";
import { mailer } from "./mail.mjs";
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
const members = databaseUrl ? accounts(await neonStore(databaseUrl), { inviteCode, mail: mailer() }) : null;
const db = database();
seedSampleTips(db);
// With accounts, each member's Stock and Money live in their own database.
const own = members ? personalStores(dataDir()) : null;
createServer(createApi(db, { publicHosts, password, members, operators, personal: own?.personal, forget: own?.forget })).listen(port, listenHost, () =>
  console.log(
    `Bounty API listening on ${listenHost}:${port}` +
      (publicHosts.length ? ` for ${publicHosts.join(", ")}` : "") +
      (members ? ", member sign-in required" : password ? ", password required" : ""),
  ),
);
