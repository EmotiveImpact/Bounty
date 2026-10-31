import { spawn } from "node:child_process";
import { setTimeout as wait } from "node:timers/promises";
for (;;) {
  const code = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["server/worker.mjs"], {
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", resolve);
  });
  if (code !== 0)
    console.error("Import failed; will retry after the interval.");
  await wait(6 * 3600000);
}
