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

export async function readJson(req, limit = 65536) {
  let text = "";
  for await (const chunk of req) {
    text += chunk;
    if (text.length > limit) throw new HttpError(413, "Request too large");
  }
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
export const isoDate = (value, name, { optional = false } = {}) => {
  if (optional && (value === undefined || value === null || value === ""))
    return null;
  return typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    new Date(value + "T00:00:00Z").toISOString().slice(0, 10) === value
    ? value
    : fail(`${name} must be a calendar date (YYYY-MM-DD)`);
};

// Runs fn inside BEGIN IMMEDIATE so concurrent writers serialise.
export function transaction(db, fn) {
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
