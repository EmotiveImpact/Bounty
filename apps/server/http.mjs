// Request helpers shared by every route module.

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
export const fail = (message, status = 400) => {
  throw new HttpError(status, message);
};

const REPLY = Symbol("reply");
// Return reply(201, value) from a handler to choose the status code.
export const reply = (status, body) => ({ [REPLY]: true, status, body });
export const isReply = (value) => Boolean(value && value[REPLY]);

// Reads a JSON body of at most limit bytes. Chunks are joined before
// decoding, so a character split across two chunks is not corrupted.
export async function readJson(req, limit = 65536) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    bytes += buffer.length;
    if (bytes > limit) throw new HttpError(413, "Request too large");
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, "Request body is not valid JSON");
  }
}

// Validators return the value or throw a 400 naming the field.
export const int = (value, name, min = 0, max = 1e12) =>
  Number.isSafeInteger(value) && value >= min && value <= max
    ? value
    : fail(`${name} must be a whole number between ${min} and ${max}`);
export const num = (value, name, min = 0, max = 1e12) =>
  typeof value === "number" &&
  Number.isFinite(value) &&
  value >= min &&
  value <= max
    ? value
    : fail(`${name} must be a number between ${min} and ${max}`);
export const text = (value, name, max = 200, { optional = false } = {}) => {
  if (optional && (value === undefined || value === null || value === ""))
    return null;
  return typeof value === "string" && value.trim() && value.length <= max
    ? value.trim()
    : fail(`${name} is required (up to ${max} characters)`);
};
export const oneOf = (value, name, options) =>
  options.includes(value)
    ? value
    : fail(`${name} must be one of: ${options.join(", ")}`);
export const bool = (value, name) =>
  typeof value === "boolean" ? value : fail(`${name} must be true or false`);
// True for a real calendar date written YYYY-MM-DD. Impossible months or
// days (2026-13-01, 2026-02-30) are false rather than an exception.
export function isCalendarDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const at = new Date(value + "T00:00:00Z");
  return Number.isFinite(at.getTime()) && at.toISOString().slice(0, 10) === value;
}
export const isoDate = (value, name, { optional = false } = {}) => {
  if (optional && (value === undefined || value === null || value === ""))
    return null;
  return isCalendarDate(value) ? value : fail(`${name} must be a calendar date (YYYY-MM-DD)`);
};

// Today's calendar date in the UK (YYYY-MM-DD), the date a person would
// write. Use it, never the UTC date, to start payout and deadline counts, so
// the answer does not change at midnight UTC during British Summer Time.
const londonFormat = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/London",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
export const londonDate = (now = new Date()) =>
  londonFormat.format(typeof now === "string" ? new Date(now) : now);

// Runs fn inside BEGIN IMMEDIATE so concurrent writers serialise. Inside an
// open transaction (for example a schema migration) fn joins it.
export function transaction(db, fn) {
  if (db.isTransaction) return fn();
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
