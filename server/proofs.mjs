// Private local evidence storage for ledger proofs: purchase receipts, sold
// listings and payout statements. Files are written to one directory on this
// computer, named by the SHA-256 of the stored bytes, readable only by the
// current user. Nothing in the API serves these files back: listings carry
// metadata (hash, size, type, label) only, so proof contents never leave the
// machine through Bounty.
//
// Photos are stripped of embedded metadata (Exif GPS location, device and
// time) before they are hashed and stored, so the stored file and its hash
// describe the cleaned image. PDFs are stored unchanged: their document
// properties (author, creation software, dates) are kept, and the UI says so.
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stripMetadata } from "./metadata.mjs";

export const PROOF_TYPES = Object.freeze(["image/jpeg", "image/png", "application/pdf"]);
export const MAX_PROOF_BYTES = 5 * 1024 * 1024;

// Leading bytes each accepted type must start with. The declared media type
// alone is never trusted.
const MAGIC = Object.freeze({
  "image/jpeg": Buffer.from([0xff, 0xd8, 0xff]),
  "image/png": Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  "application/pdf": Buffer.from("%PDF-", "latin1"),
});

/** A rejected upload. Routes turn it into a 400 with this message. */
export class ProofError extends Error {
  constructor(message) {
    super(message);
    this.name = "ProofError";
  }
}

/** True when the buffer starts with the signature of the declared type. */
export function matchesMagic(buffer, mediaType) {
  const magic = MAGIC[mediaType];
  return Boolean(
    magic && buffer.length >= magic.length && buffer.subarray(0, magic.length).equals(magic),
  );
}

/** True for images whose metadata is removed before storage (not PDFs). */
export const removesMetadata = (mediaType) =>
  mediaType === "image/jpeg" || mediaType === "image/png";

/**
 * Decodes strict base64 (the payload of a data URL, without the prefix).
 * Buffer.from(..., "base64") silently skips invalid characters, so the text
 * is checked first and anything malformed is rejected rather than stored.
 */
export function decodeBase64(data) {
  if (typeof data !== "string" || !data.length)
    throw new ProofError("data must be the file content as base64");
  // 5 MB of bytes is about 6.7 million base64 characters.
  if (data.length > Math.ceil(MAX_PROOF_BYTES / 3) * 4)
    throw new ProofError("Proof files must be 5 MB or smaller");
  if (data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data))
    throw new ProofError("data is not valid base64");
  return Buffer.from(data, "base64");
}

/**
 * Validates an upload and returns the bytes that will be stored. Checks the
 * type, size and magic bytes of what was sent, then strips image metadata.
 * The hash is of the stored (cleaned) content.
 */
export function prepareProof(buffer, mediaType) {
  if (!PROOF_TYPES.includes(mediaType))
    throw new ProofError("Proofs must be JPEG or PNG photos, or PDF documents");
  if (!Buffer.isBuffer(buffer) && !(buffer instanceof Uint8Array))
    throw new ProofError("Proof content is missing");
  const input = Buffer.from(buffer);
  if (!input.length) throw new ProofError("The proof file is empty");
  if (input.length > MAX_PROOF_BYTES) throw new ProofError("Proof files must be 5 MB or smaller");
  if (!matchesMagic(input, mediaType))
    throw new ProofError("The file content does not match " + mediaType);
  let content;
  try {
    content = stripMetadata(input, mediaType);
  } catch (error) {
    throw new ProofError("The file could not be read as " + mediaType + ": " + error.message);
  }
  const sha256 = createHash("sha256").update(content).digest("hex");
  return { content, sha256, bytes: content.length, metadataRemoved: removesMetadata(mediaType) };
}

/**
 * Stores a proof at <dir>/<sha256> with mode 0o600 inside a 0o700 directory.
 * Only JPEG, PNG and PDF files up to 5 MB whose leading bytes match their
 * declared type are accepted. Storing the same content twice keeps one file.
 * Returns { sha256, bytes, metadataRemoved }.
 */
export function storeProof(dir, buffer, mediaType) {
  const { content, sha256, bytes, metadataRemoved } = prepareProof(buffer, mediaType);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700); // also tightens a directory that already existed
  const file = join(dir, sha256);
  try {
    writeFileSync(file, content, { mode: 0o600, flag: "wx" });
  } catch (error) {
    // Same hash means same content: the existing file already holds it.
    if (error.code !== "EEXIST") throw error;
  }
  chmodSync(file, 0o600);
  return { sha256, bytes, metadataRemoved };
}
