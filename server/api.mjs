import { createServer } from "node:http";
import { database } from "./db.mjs";
import { createApi } from "./app.mjs";

const port = Number(process.env.PORT || 4174);
createServer(createApi(database())).listen(port, "127.0.0.1", () =>
  console.log("Bounty API listening on http://127.0.0.1:" + port),
);
