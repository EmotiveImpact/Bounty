// Helpers for tests. Build a database with only the schemas a test needs, so
// a module's tests do not depend on unrelated modules.
import { DatabaseSync } from "node:sqlite";
import { createServer } from "node:http";
import { createApi } from "./app.mjs";

export function memoryDb(...schemas) {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON;");
  for (const schema of schemas) schema(db);
  return db;
}

// Starts the API for the given route modules on an ephemeral port.
// Returns { call(method, path, body?), close() }; call resolves to
// { status, body } with the parsed JSON body.
export async function serve(db, modules) {
  const server = createServer(createApi(db, { modules }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = "http://127.0.0.1:" + server.address().port;
  return {
    base,
    async call(method, path, body, headers = {}) {
      const res = await fetch(base + path, {
        method,
        headers:
          body === undefined
            ? headers
            : { "Content-Type": "application/json", ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : null };
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
