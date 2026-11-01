// Hosted start: the API and the six-hourly Open Prices import loop in one
// container, sharing the database on the mounted disk (BOUNTY_DATA_DIR).
// If either stops, both stop, so the host restarts the pair together.
//
//   npm start
import { spawn } from "node:child_process";

const children = ["server/api.mjs", "server/loop.mjs"].map((script) =>
  spawn(process.execPath, [script], { stdio: "inherit" }),
);
let stopping = false;
function stop(code) {
  if (stopping) return;
  stopping = true;
  children.forEach((c) => c.kill("SIGTERM"));
  process.exitCode = code;
}
children.forEach((c) => c.on("exit", (code) => stop(code ?? 1)));
process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));
