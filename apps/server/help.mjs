// Messages sent from the Help page: questions, a wrong price, a bad tip, or
// "I can't get into my account". Anyone may send one (signed out too, so a
// member locked out can ask for help); only operators read them, in Admin.
import { HttpError, reply } from "./http.mjs";

export const TOPICS = ["question", "account", "wrong-price", "bad-tip", "other"];
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,253}\.[^\s@]{2,}$/;
// A few messages per address per hour is plenty; more is refused.
const PER_HOUR = 5;

export function schema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS help_messages (
    id INTEGER PRIMARY KEY,
    created TEXT NOT NULL,
    topic TEXT NOT NULL,
    email TEXT NOT NULL,
    name TEXT,
    message TEXT NOT NULL,
    page TEXT,
    account_email TEXT,
    done_at TEXT
  )`);
}

export function readMessage(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "Send the message as a JSON object.");
  const topic = TOPICS.includes(body.topic) ? body.topic : "other";
  const email = String(body.email || "").trim().toLowerCase();
  if (!EMAIL.test(email)) throw new HttpError(400, "Enter an email we can reply to.");
  const message = String(body.message || "").trim();
  if (message.length < 5) throw new HttpError(400, "Tell us a little more, so we can help.");
  if (message.length > 3000) throw new HttpError(400, "Keep the message under 3,000 characters.");
  const name = String(body.name || "").trim().slice(0, 80) || null;
  const page = String(body.page || "").trim().slice(0, 200) || null;
  return { topic, email, name, message, page };
}

export function routes(db) {
  return [
    [
      "POST",
      "/api/help",
      ({ body, user }) => {
        const m = readMessage(body);
        const since = new Date(Date.now() - 3600000).toISOString();
        const recent = db.prepare("SELECT COUNT(*) AS n FROM help_messages WHERE email = ? AND created > ?").get(m.email, since).n;
        if (recent >= PER_HOUR) throw new HttpError(429, "We've had a few messages from you this hour. We'll reply soon.");
        const { lastInsertRowid } = db
          .prepare(
            "INSERT INTO help_messages (created, topic, email, name, message, page, account_email) VALUES (?, ?, ?, ?, ?, ?, ?)",
          )
          .run(new Date().toISOString(), m.topic, m.email, m.name, m.message, m.page, user ? String(user.email).toLowerCase() : null);
        return reply(201, { id: Number(lastInsertRowid) });
      },
      // Open to signed-out visitors, so a locked-out member can ask for help.
      { read: true, limit: 16 * 1024 },
    ],
    [
      "GET",
      "/api/help",
      () => ({
        messages: db.prepare("SELECT * FROM help_messages ORDER BY done_at IS NOT NULL, created DESC LIMIT 200").all(),
      }),
      { operator: true },
    ],
    [
      "POST",
      "/api/help/:id/done",
      ({ params }) => {
        const id = Number(params.id);
        if (!Number.isInteger(id) || id < 1) throw new HttpError(400, "id must be a whole number");
        db.prepare("UPDATE help_messages SET done_at = COALESCE(done_at, ?) WHERE id = ?").run(new Date().toISOString(), id);
        return { ok: true };
      },
      { operator: true },
    ],
  ];
}
