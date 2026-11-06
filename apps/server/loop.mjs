// Repeatable public imports: runs the Open Prices worker now, then six hours
// after each successful run finishes. A failed run is retried after 15 and
// then 45 minutes before falling back to the six-hour cycle. The worker also
// retries transient failures itself. Use a process supervisor to restart this
// loop after a host reboot.
//
//   npm run worker:loop
import { spawn } from "node:child_process";
import { setTimeout as wait } from "node:timers/promises";

const INTERVAL = 6 * 3600000;
const RETRIES = [15 * 60000, 45 * 60000];
let child = null;
let stopping = false;

function runWorker() {
  return new Promise((resolve) => {
    child = spawn(process.execPath, ["apps/server/worker.mjs", "--scheduled"], { stdio: "inherit" });
    child.once("error", (error) => {
      console.error("Could not start the worker: " + error.message);
      resolve(1);
    });
    child.once("exit", (code, signal) => resolve(signal ? 1 : (code ?? 1)));
  }).finally(() => {
    child = null;
  });
}

for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    stopping = true;
    child?.kill(signal);
    process.exit(0);
  });

let failures = 0;
while (!stopping) {
  const code = await runWorker();
  if (code === 0) failures = 0;
  else failures++;
  const pause = code === 0 || failures > RETRIES.length ? INTERVAL : RETRIES[failures - 1];
  const next = new Date(Date.now() + pause).toISOString();
  console.error(
    code === 0
      ? "Next Open Prices import at " + next
      : `Import failed (exit ${code}); ` +
          (failures > RETRIES.length ? "will retry on the regular cycle at " : "will retry at ") +
          next,
  );
  if (failures > RETRIES.length) failures = 0;
  await wait(pause);
}
