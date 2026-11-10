// Read network bodies before entering the snapshot queue or a database
// transaction. A slow sender must not own another member's write lock.
import { HttpError } from './http.mjs';
const READS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function requestIntake({ timeoutMs = 10000, maxRequests = 32,
  maxBytes = 16 * 1024 * 1024, maxBodyBytes = 7 * 1024 * 1024 } = {}) {
  let requests = 0;
  let buffered = 0;
  return async function receive(req) {
    if (requests >= maxRequests) throw new HttpError(503, 'Bounty is busy. Try again shortly.');
    requests++;
    let bytes = 0;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      requests--;
      buffered -= bytes;
    };
    let timer;
    try {
      if (READS.has(req.method)) return { req, release };
      const length = req.headers?.['content-length'];
      if (length !== undefined && (!/^\d+$/.test(String(length)) || Number(length) > maxBodyBytes))
        throw new HttpError(413, 'Request too large');
      const chunks = [];
      const deadline = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new HttpError(408, 'Request body timed out. Try again.')), timeoutMs);
      });
      const iterator = req[Symbol.asyncIterator]();
      for (;;) {
        const { done, value } = await Promise.race([iterator.next(), deadline]);
        if (done) break;
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
        if (bytes + chunk.length > maxBodyBytes) throw new HttpError(413, 'Request too large');
        if (buffered + chunk.length > maxBytes) throw new HttpError(503, 'Bounty is busy. Try again shortly.');
        bytes += chunk.length;
        buffered += chunk.length;
        chunks.push(chunk);
      }
      // Expose only the request fields used by the API, and replay exactly the
      // received bytes. Route-specific JSON and upload limits still apply.
      return { req: { method: req.method, url: req.url, headers: req.headers,
        async *[Symbol.asyncIterator]() { yield* chunks; } }, release };
    } catch (error) {
      release();
      throw error;
    } finally {
      clearTimeout(timer);
    }
  };
}

export function rejectIntake(req, res, error) {
  if (res.headersSent || res.destroyed) { req.destroy?.(); return; }
  // Finish the error response before closing a partial request's socket.
  // Never drain an unbounded remainder or let it enter the write queue.
  req.pause?.();
  res.once?.('finish', () => { if (!req.complete) req.destroy?.(); });
  res.writeHead(error instanceof HttpError ? error.status : 400, {
    'Content-Type': 'application/json', 'Cache-Control': 'no-store', Connection: 'close',
    ...(error.status === 503 ? { 'Retry-After': '2' } : {}),
  });
  res.end(JSON.stringify({ error: error instanceof HttpError ? error.message : 'Request body was interrupted' }));
}
