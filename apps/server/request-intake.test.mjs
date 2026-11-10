import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requestIntake } from './request-intake.mjs';
import { readJson } from './http.mjs';
const request = (chunks, headers = {}) => ({ method: 'POST', url: '/api/test', headers, async *[Symbol.asyncIterator]() { yield* chunks; } });

test('intake preserves split Unicode and keeps route-specific limits', async () => {
  const bytes = Buffer.from('{"name":"Zoë £5"}');
  const got = await requestIntake()(request([...bytes].map(b => Buffer.from([b]))));
  assert.deepEqual(await readJson(got.req), { name: 'Zoë £5' });
  await assert.rejects(readJson(got.req, 5), { status: 413 });
  got.release(); got.release();
});
test('intake bounds declared and streamed bytes before any application work', async () => {
  const receive = requestIntake({ maxBodyBytes: 8 });
  await assert.rejects(receive(request([], { 'content-length': '9' })), { status: 413 });
  await assert.rejects(receive(request(['1234', '56789'])), { status: 413 });
  const next = await receive(request(['{}'])); next.release();
});
test('intake caps queued bytes and requests and recovers its budget after release', async () => {
  const receive = requestIntake({ maxRequests: 2, maxBytes: 6 });
  const one = await receive(request(['1234']));
  await assert.rejects(receive(request(['567'])), { status: 503 });
  const two = await receive(request(['{}']));
  await assert.rejects(receive(request([])), { status: 503 });
  one.release(); two.release();
  const recovered = await receive(request(['123456'])); recovered.release();
});
test('an interrupted stream never returns a request and releases its reservation', async () => {
  const receive = requestIntake({ maxRequests: 1, maxBytes: 4 });
  await assert.rejects(receive({ method: 'POST', headers: {}, async *[Symbol.asyncIterator]() { yield '1234'; throw Error('interrupted'); } }), /interrupted/);
  const recovered = await receive(request(['{}'])); recovered.release();
});

test('tiny and empty chunks cannot bypass the intake memory budget', async () => {
  const receive = requestIntake({ maxRequests: 1, maxChunks: 4 });
  await assert.rejects(receive(request(['', '', '', '', ''])), { status: 413 });
  await assert.rejects(receive(request(['1', '2', '3', '4', '5'])), { status: 413 });
  const recovered = await receive(request(['{', '}']));
  assert.deepEqual(await readJson(recovered.req), {});
  recovered.release();
});
