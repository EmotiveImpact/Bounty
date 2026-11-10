import { test } from "node:test";
import assert from "node:assert/strict";
import { retryStart } from "./retry-start.mjs";

test("a failed cold start is shared, retried, and never leaks connection details", async () => {
  let attempts = 0;
  let handled = 0;
  const handler = retryStart(async () => {
    if (++attempts === 1) throw Error("synthetic private connection detail");
    return () => { handled++; };
  }, { log: () => {} });
  const responses = Array.from({ length: 2 }, () => ({
    status: 0, body: "",
    writeHead(status) { this.status = status; },
    end(body) { this.body = body; },
  }));
  await Promise.all(responses.map((res) => handler({}, res)));
  assert.equal(attempts, 1);
  for (const res of responses) {
    assert.equal(res.status, 503);
    assert.doesNotMatch(res.body, /private connection/);
  }
  await Promise.all(responses.map((res) => handler({}, res)));
  assert.equal(attempts, 2);
  assert.equal(handled, 2);
  await handler({}, responses[0]);
  assert.equal(attempts, 2);
  assert.equal(handled, 3);
});
