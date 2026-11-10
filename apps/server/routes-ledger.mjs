// Ledger routes: trips, dated entries, reconciliation, private proofs, the
// monthly summary and forecast metrics. Proof files are written to a private
// directory and never served: no route returns their contents.
import { join } from "node:path";
import { fail, int, londonDate, reply } from "./http.mjs";
import { dataDir } from "./db.mjs";
import {
  addEntry,
  recordPurchase,
  checkProofTarget,
  closeTrip,
  createTrip,
  deleteEntry,
  getTrip,
  listTrips,
  metrics,
  monthParam,
  proofFileUses,
  proofTarget,
  recordProof,
  relinkProof,
  removeProof,
  summary,
} from "./ledger.mjs";
import { decodeBase64, deleteProofFile, prepareProof, ProofError, PROOF_TYPES, writeProof } from "./proofs.mjs";

// A 5 MB file is about 6.7 MB as base64, plus the label and JSON framing.
export const PROOF_BODY_LIMIT = 7 * 1024 * 1024;

/** A positive whole-number id from the path. */
function idParam(value, name = "id") {
  if (typeof value !== "string" || !/^\d{1,15}$/.test(value)) fail(`${name} must be a whole number`);
  return int(Number(value), name, 1, Number.MAX_SAFE_INTEGER);
}

/**
 * routes(db, { proofDir, now }): proofDir defaults to <data dir>/proofs and
 * now to the system clock; tests inject both.
 */
export function routes(db, { proofDir, now = () => new Date() } = {}) {
  const proofs = () => proofDir || join(dataDir(), "proofs");
  return [
    ["POST", "/api/ledger/purchases", ({ body }) => {
      const result = recordPurchase(db, body, { now: now() });
      return reply(result.created ? 201 : 200, result);
    }],
    ["GET", "/api/ledger/trips", () => ({ trips: listTrips(db) })],
    [
      "POST",
      "/api/ledger/trips",
      ({ body }) => reply(201, { id: createTrip(db, body, { now: now() }) }),
    ],
    ["GET", "/api/ledger/trips/:id", ({ params }) => getTrip(db, idParam(params.id))],
    [
      "POST",
      "/api/ledger/trips/:id/entries",
      ({ params, body }) => {
        const tripId = idParam(params.id);
        const id = addEntry(db, tripId, body, { now: now() });
        return reply(201, { id, ...getTrip(db, tripId) });
      },
    ],
    [
      "DELETE",
      "/api/ledger/trips/:id/entries/:entryId",
      ({ params }) => deleteEntry(db, idParam(params.id), idParam(params.entryId, "entryId")),
    ],
    [
      "POST",
      "/api/ledger/trips/:id/close",
      ({ params }) => closeTrip(db, idParam(params.id), { now: now() }),
    ],
    [
      "POST",
      "/api/ledger/trips/:id/proofs",
      ({ params, body }) => {
        // Check the target and fields before anything is written to disk.
        const { trip, entryId, label } = proofTarget(db, idParam(params.id), body);
        if (!PROOF_TYPES.includes(body.mediaType))
          fail("mediaType must be one of: " + PROOF_TYPES.join(", "));
        let prepared;
        try {
          prepared = prepareProof(decodeBase64(body.data), body.mediaType);
        } catch (error) {
          if (error instanceof ProofError) fail(error.message);
          throw error;
        }
        // One file proves one receipt or payout in the whole ledger: refuse a
        // file that already proves another entry before anything is written.
        checkProofTarget(db, { tripId: trip.id, entryId, sha256: prepared.sha256 });
        const stored = writeProof(proofs(), prepared);
        let result;
        try {
          result = recordProof(
            db,
            { tripId: trip.id, entryId, label, sha256: stored.sha256, bytes: stored.bytes, mediaType: body.mediaType },
            { now: now() },
          );
        } catch (error) {
          // Refused after writing (another request attached it first): do not
          // leave a new file behind that no proof record refers to.
          if (!stored.existed && proofFileUses(db, stored.sha256) === 0) deleteProofFile(proofs(), stored.sha256);
          throw error;
        }
        return reply(result.created ? 201 : 200, { proof: result.proof, ...getTrip(db, trip.id) });
      },
      { limit: PROOF_BODY_LIMIT },
    ],
    [
      "PATCH",
      "/api/ledger/trips/:id/proofs/:proofId",
      ({ params, body }) => relinkProof(db, idParam(params.id), idParam(params.proofId, "proofId"), body),
    ],
    [
      "DELETE",
      "/api/ledger/trips/:id/proofs/:proofId",
      ({ params }) => {
        const tripId = idParam(params.id);
        const proofId = idParam(params.proofId, "proofId");
        const { sha256, fileUnused } = removeProof(db, tripId, proofId);
        // The stored file goes only when no other proof refers to it.
        let file = "in use";
        if (fileUnused) {
          try {
            file = deleteProofFile(proofs(), sha256);
          } catch (error) {
            console.error(error);
            file = "error";
          }
        }
        return { removed: { id: proofId, file }, ...getTrip(db, tripId) };
      },
    ],
    [
      "GET",
      "/api/ledger/summary",
      ({ url }) => {
        const month = url.searchParams.get("month");
        return summary(db, month ? monthParam(month) : londonDate(now()).slice(0, 7));
      },
    ],
    ["GET", "/api/ledger/metrics", () => metrics(db)],
  ];
}
