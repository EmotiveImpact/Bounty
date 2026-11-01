import { createServer } from "node:http";
import { database } from "./db.mjs";
import { createApi } from "./app.mjs";
import { accessConfig } from "./access.mjs";

const port = Number(process.env.PORT || 4174);
let access;
try {
  access = accessConfig();
} catch (error) {
  console.error("Bounty API not started: " + error.message);
  process.exit(1);
}
const { listenHost, publicHosts, password } = access;
createServer(createApi(database(), { publicHosts, password })).listen(port, listenHost, () =>
  console.log(
    `Bounty API listening on ${listenHost}:${port}` +
      (publicHosts.length ? ` for ${publicHosts.join(", ")}` : "") +
      (password ? ", password required" : ""),
  ),
);
