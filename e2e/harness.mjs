// Browser workflow harness. Each *.e2e.mjs file in this folder is a
// node:test file that starts its own API and Vite dev server on free ports
// with a throwaway data directory, drives the app in Chromium and stops
// both servers. Run with `npm run e2e`.
//
// Playwright is not a project dependency: the harness loads it with
// require(), which honours NODE_PATH, so a Playwright installed globally (as
// in the development container) is used. Without one the tests are skipped
// with a note, never failed.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer as netServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const ROOT = new URL("..", import.meta.url).pathname;

/** Playwright's chromium, or null when Playwright is not installed. */
export function loadChromium() {
  try {
    return require("playwright").chromium;
  } catch {
    return null;
  }
}

const freePort = () =>
  new Promise((resolve, reject) => {
    const s = netServer();
    s.unref();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

async function waitFor(url, ms = 20000) {
  const until = Date.now() + ms;
  for (;;) {
    try {
      const r = await fetch(url);
      if (r.status < 500) return;
    } catch {
      // not up yet
    }
    if (Date.now() > until) throw new Error("Timed out waiting for " + url);
    await new Promise((r) => setTimeout(r, 150));
  }
}

/**
 * Starts the API and the Vite dev server against a new data directory. Vite
 * gets its own dependency cache inside that directory: a cache shared by two
 * runs at once (for example from two checkouts sharing node_modules) is
 * rewritten under the other run's page, which then never loads.
 * Returns { url, apiUrl, dataDir, api(path, init), stop() }. api() calls
 * the API directly (JSON in and out) with the local Origin, so a test can
 * set up data through the real routes.
 */
export async function startApp({ env = {} } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "bounty-e2e-"));
  const apiPort = await freePort();
  const webPort = await freePort();
  const childEnv = { ...process.env, ...env, DATABASE_URL: "", BOUNTY_KEEP_DATA: "off", BOUNTY_DATA_DIR: dataDir, PORT: String(apiPort) };
  const apiProc = spawn(process.execPath, ["apps/server/api.mjs"], { cwd: ROOT, env: childEnv, stdio: "ignore" });
  const viteScript = `
    import { createServer } from "vite";
    const server = await createServer({
      root: "apps/web",
      configFile: "apps/web/vite.config.js",
      logLevel: "error",
      cacheDir: ${JSON.stringify(join(dataDir, "vite-cache"))},
      server: { port: ${webPort}, strictPort: true, proxy: { "/api": "http://127.0.0.1:${apiPort}" } },
    });
    await server.listen();
  `;
  const webProc = spawn(process.execPath, ["--input-type=module", "-e", viteScript], {
    cwd: ROOT,
    env: childEnv,
    stdio: "ignore",
  });
  const apiUrl = `http://127.0.0.1:${apiPort}`;
  const url = `http://127.0.0.1:${webPort}`;
  const stop = () => {
    for (const p of [apiProc, webProc]) if (p.exitCode === null) p.kill();
    rmSync(dataDir, { recursive: true, force: true });
  };
  try {
    await waitFor(apiUrl + "/api/sources");
    await waitFor(url + "/");
  } catch (e) {
    stop();
    throw e;
  }
  const api = async (path, init = {}) => {
    const r = await fetch(apiUrl + path, {
      ...init,
      headers: { "content-type": "application/json", origin: url, ...(init.headers || {}) },
      body: init.body === undefined || typeof init.body === "string" ? init.body : JSON.stringify(init.body),
    });
    const text = await r.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    return { status: r.status, body };
  };
  return { url, apiUrl, dataDir, api, stop };
}

/**
 * Opens a page at each width in turn, runs fn(page, width) and fails on a
 * console error or horizontal overflow. Returns nothing; throws on failure.
 */
export async function atWidths(browser, url, fn, widths = [390, 1280]) {
  for (const width of widths) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    const errors = [];
    page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
    page.on("pageerror", (e) => errors.push(String(e)));
    // Skip the first-visit "Where do you hunt?" window; it would sit over
    // every screen the tests use.
    await page.addInitScript(() => {
      try {
        localStorage.setItem("bounty-onboarded", "true");
      } catch {
        // A page without storage still shows the window; tests then fail loudly.
      }
    });
    await page.goto(url);
    await fn(page, width);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    await page.close();
    if (overflow > 0) throw new Error(`Horizontal overflow of ${overflow}px at ${width}px`);
    if (errors.length) throw new Error(`Console errors at ${width}px: ${errors.join(" | ")}`);
  }
}
