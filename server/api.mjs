import { status } from "./sources.mjs";
import { createServer } from "node:http";
import { db } from "./db.mjs";
import { offers, defaults, plan } from "./catalog.mjs";
const finite = (v, min, max) =>
  typeof v === "number" && Number.isFinite(v) && v >= min && v <= max;
async function body(req) {
  let text = "";
  for await (const chunk of req) {
    text += chunk;
    if (text.length > 8192) throw Error("Request too large");
  }
  return JSON.parse(text);
}
createServer(async (req, res) => {
  function send(status, value) {
    res.writeHead(status, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    });
    res.end(JSON.stringify(value));
  }
  try {
    const path = req.url;
    if (
      req.method === "POST" &&
      req.headers.origin &&
      new URL(req.headers.origin).hostname !== "127.0.0.1" &&
      new URL(req.headers.origin).hostname !== "localhost"
    )
      return send(403, { error: "Local access only" });
    if (req.method === "POST" && path === "/api/plan") {
      const p = { ...defaults, ...(await body(req)) };
      if (
        typeof p.area !== "string" ||
        p.area.length > 100 ||
        !Object.hasOwn({ Walk: 1, Bicycle: 1, Car: 1, Van: 1 }, p.transport) ||
        !finite(p.budget, 0, 100000) ||
        !finite(p.target, 0, 10000) ||
        !finite(p.carry, 0, 10000) ||
        !finite(p.travel, 0, 10000) ||
        !Number.isInteger(p.quantity) ||
        !finite(p.quantity, 1, 1000)
      )
        throw Error("Invalid profile values");
      return send(
        200,
        offers
          .map((o) => plan(o, p))
          .sort(
            (a, b) =>
              Number(b.reason === "Fits your profile") -
                Number(a.reason === "Fits your profile") || b.hourly - a.hourly,
          ),
      );
    }
    if (req.method === "GET" && path === "/api/research")
      return send(200, {
        sources: status(),
        rows: db
          .prepare(
            "SELECT * FROM research ORDER BY imported DESC,provider,source_id LIMIT 200",
          )
          .all(),
      });
    if (req.method === "GET" && path === "/api/observations")
      return send(
        200,
        db
          .prepare(
            "SELECT * FROM observations ORDER BY day DESC,id DESC LIMIT 100",
          )
          .all(),
      );
    if (req.method === "GET" && path === "/api/outcomes")
      return send(
        200,
        db.prepare("SELECT * FROM outcomes ORDER BY id DESC").all(),
      );
    if (req.method === "POST" && path === "/api/outcomes") {
      const { sku, received, costs, minutes } = await body(req);
      if (
        !offers.some((o) => o.sku === sku) ||
        ![received, costs, minutes].every(Number.isSafeInteger) ||
        !finite(received, 0, 1e9) ||
        !finite(costs, 0, 1e9) ||
        !finite(minutes, 1, 1e6)
      )
        throw Error("Enter valid costs, proceeds and working time");
      db.prepare(
        "INSERT INTO outcomes(sku,received,costs,minutes) VALUES(?,?,?,?)",
      ).run(sku, received, costs, minutes);
      return send(201, { saved: true });
    }
    send(404, { error: "Unknown route" });
  } catch (error) {
    send(400, { error: error.message });
  }
}).listen(Number(process.env.PORT || 4174), "127.0.0.1");
