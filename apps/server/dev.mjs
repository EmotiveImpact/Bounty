import { spawn } from "node:child_process";
const children = [
  spawn(process.execPath, ["apps/server/api.mjs"], { stdio: "inherit" }),
  spawn(process.execPath, ["node_modules/vite/bin/vite.js", "apps/web"], {
    stdio: "inherit",
  }),
];
let stopping = false;
function stop(code) {
  if (stopping) return;
  stopping = true;
  children.forEach((c) => c.kill());
  process.exitCode = code;
}
children.forEach((c) => c.on("exit", (code) => stop(code ?? 0)));
process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));
