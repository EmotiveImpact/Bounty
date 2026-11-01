// Sign-in and sign-up for a hosted pilot with member accounts. Shown instead
// of the app until /api/auth/me finds a session. On your own computer, where
// accounts are off, the app opens straight away.
import { useState } from "react";
import "./SignIn.css";

export type Member = { email: string; name: string | null };

export default function SignIn({
  inviteOpen,
  onSignedIn,
}: {
  inviteOpen: boolean;
  onSignedIn: (member: Member) => void;
}) {
  const [mode, setMode] = useState<"in" | "up">("in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [invite, setInvite] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/" + (mode === "in" ? "signin" : "signup"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(mode === "in" ? { email, password } : { email, password, name, invite }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw Error(data?.error || "Sign-in failed (HTTP " + res.status + ")");
      onSignedIn(data.user);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="signin">
      <form className="signin-card" onSubmit={submit}>
        <h1>Bounty</h1>
        <p className="signin-sub">
          {mode === "in" ? "Sign in to your account." : "Create your account with the invite code you were given."}
        </p>
        {mode === "up" && (
          <label>
            Your name
            <input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" maxLength={80} />
          </label>
        )}
        <label>
          Email
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
          />
        </label>
        <label>
          Password
          <input
            type="password"
            required
            minLength={mode === "up" ? 10 : undefined}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={mode === "in" ? "current-password" : "new-password"}
          />
          {mode === "up" && <small>At least 10 characters.</small>}
        </label>
        {mode === "up" && (
          <label>
            Invite code
            <input required value={invite} onChange={(e) => setInvite(e.target.value)} autoComplete="off" />
          </label>
        )}
        {error && (
          <p className="signin-error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" disabled={busy}>
          {busy ? "One moment…" : mode === "in" ? "Sign in" : "Create account"}
        </button>
        <p className="signin-note">You stay signed in on this device for 30 days.</p>
        {(inviteOpen || mode === "up") && (
          <button
            type="button"
            className="signin-switch"
            onClick={() => (setMode(mode === "in" ? "up" : "in"), setError(null))}
          >
            {mode === "in" ? "New here? Create an account" : "Already have an account? Sign in"}
          </button>
        )}
      </form>
    </main>
  );
}
