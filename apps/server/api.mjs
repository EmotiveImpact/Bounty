import { createServer } from "node:http";
import { database, dataDir } from "./db.mjs";
import { personalStores } from "./personal.mjs";
import { createApi } from "./app.mjs";
import { accessConfig } from "./access.mjs";
import { accounts, postgresStore } from "./accounts.mjs";
import { mailer } from "./mail.mjs";
import { neonTransactions } from "./account-transaction.mjs";
import { keepForGood, postgresKeepStore } from "./keep.mjs";
import { openDb } from "./db.mjs";
import { join } from "node:path";
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
const coordinator = databaseUrl ? await neonTransactions(databaseUrl) : null;
const store = coordinator ? postgresStore(coordinator.query, coordinator) : null;
if (store) await store.ready();
const members = store ? accounts(store, { inviteCode, mail: coordinator.mail(mailer()) }) : null;
let handle;
if (members) {
  if (process.env.BOUNTY_KEEP_DATA === "off") throw Error("Member accounts require durable snapshots");
  const snapshots = await postgresKeepStore(coordinator.query);
  await snapshots.ready();
  const keeper = keepForGood({
    dir: dataDir(), store: snapshots, transaction: coordinator.transaction,
    build() {
      const db = openDb(join(dataDir(), "desk.sqlite"));
      const own = personalStores(dataDir());
      seedSampleTips(db);
      return {
        handle: createApi(db, { publicHosts, password, members, operators, personal: own.personal, forget: own.forget }),
        checkpoint() { db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); own.checkpoint(); },
        close() { own.close(); db.close(); },
      };
    },
  });
  handle = keeper.handle;
} else {
  const db = database();
  seedSampleTips(db);
  handle = createApi(db, { publicHosts, password, operators });
}
createServer(handle).listen(port, listenHost, () =>
  console.log(
    `Bounty API listening on ${listenHost}:${port}` +
      (publicHosts.length ? ` for ${publicHosts.join(", ")}` : "") +
      (members ? ", member sign-in required" : password ? ", password required" : ""),
  ),
);
