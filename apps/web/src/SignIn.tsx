// Sign-in and sign-up window for a hosted pilot with member accounts. The
// site itself is open to look around; this opens from the Sign in button at
// the top, or when someone tries to save a change while signed out.
import { useEffect, useState } from "react";
import "./SignIn.css";
import { CrewArt } from "./proto/CrewArt";

export type Member = { email: string; name: string | null };

// Other ways in. Each one needs its own developer app (Google Cloud, Reddit
// app preferences, Meta for Developers, Apple Developer) before it can work,
// so a button only shows once its provider is listed in READY. Until then the
// window offers email only. For a design preview of every button (shown as
// "Coming soon"), set localStorage "bounty-signin-preview" to "1".
type Provider = "google" | "reddit" | "facebook" | "apple";
const PROVIDERS: { id: Provider; label: string }[] = [
  { id: "google", label: "Google" },
  { id: "reddit", label: "Reddit" },
  { id: "facebook", label: "Facebook" },
  { id: "apple", label: "Apple" },
];
const READY: Provider[] = [];

function preview() {
  try {
    return localStorage.getItem("bounty-signin-preview") === "1";
  } catch {
    return false;
  }
}

function Logo({ id }: { id: Provider }) {
  if (id === "google")
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path fill="#4285F4" d="M23.5 12.3c0-.8-.1-1.6-.2-2.3H12v4.4h6.5a5.6 5.6 0 0 1-2.4 3.7v3h3.9c2.2-2.1 3.5-5.2 3.5-8.8z" />
        <path fill="#34A853" d="M12 24c3.2 0 6-1.1 8-2.9l-3.9-3c-1.1.7-2.5 1.2-4.1 1.2-3.1 0-5.8-2.1-6.7-5H1.3v3.1A12 12 0 0 0 12 24z" />
        <path fill="#FBBC05" d="M5.3 14.3a7.2 7.2 0 0 1 0-4.6V6.6h-4a12 12 0 0 0 0 10.8l4-3.1z" />
        <path fill="#EA4335" d="M12 4.8c1.8 0 3.4.6 4.6 1.8l3.4-3.4A12 12 0 0 0 1.3 6.6l4 3.1c.9-2.9 3.6-4.9 6.7-4.9z" />
      </svg>
    );
  if (id === "reddit")
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="12" fill="#FF4500" />
        <ellipse cx="12" cy="14" rx="6.2" ry="4.3" fill="#fff" />
        <circle cx="17.6" cy="10.6" r="1.5" fill="#fff" />
        <circle cx="6.4" cy="10.6" r="1.5" fill="#fff" />
        <circle cx="16.8" cy="5.6" r="1.2" fill="#fff" />
        <path d="M12 9.6l1-4 3.8.9" stroke="#fff" strokeWidth="0.9" fill="none" />
        <circle cx="9.8" cy="13.4" r="1" fill="#FF4500" />
        <circle cx="14.2" cy="13.4" r="1" fill="#FF4500" />
        <path d="M9.6 15.9c1.3.9 3.5.9 4.8 0" stroke="#FF4500" strokeWidth="0.8" fill="none" strokeLinecap="round" />
      </svg>
    );
  if (id === "facebook")
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="12" fill="#1877F2" />
        <path fill="#fff" d="M13.4 24v-8.4h2.8l.4-3.3h-3.2v-2.1c0-1 .3-1.6 1.6-1.6h1.7V5.7a23 23 0 0 0-2.5-.1c-2.5 0-4.2 1.5-4.2 4.3v2.4H7.2v3.3H10V24h3.4z" />
      </svg>
    );
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path fill="currentColor" d="M16.4 12.7c0-2.6 2.1-3.8 2.2-3.9-1.2-1.8-3.1-2-3.7-2-1.6-.2-3.1.9-3.9.9-.8 0-2-.9-3.4-.9a5 5 0 0 0-4.2 2.6c-1.8 3.1-.5 7.7 1.3 10.2.9 1.2 1.9 2.6 3.2 2.6 1.3-.1 1.8-.8 3.3-.8s2 .8 3.4.8c1.4 0 2.3-1.3 3.1-2.5 1-1.4 1.4-2.8 1.4-2.9 0 0-2.7-1-2.7-4.1zM13.9 5.1c.7-.8 1.2-2 1-3.1-1 0-2.2.7-2.9 1.5-.6.7-1.2 1.9-1 3 1.1.1 2.2-.6 2.9-1.4z" />
    </svg>
  );
}

export default function SignIn({
  startMode = "in",
  inviteOpen,
  onSignedIn,
  onClose,
}: {
  startMode?: "in" | "up";
  inviteOpen: boolean;
  onSignedIn: (member: Member) => void;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<"in" | "up">(startMode);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [invite, setInvite] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

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

  const shown = PROVIDERS.filter((p) => READY.includes(p.id) || preview());
  const up = mode === "up";

  return (
    <div className="signin" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form
        className="signin-card"
        onSubmit={submit}
        role="dialog"
        aria-modal="true"
        aria-labelledby="signin-title"
      >
        <button type="button" className="signin-close" aria-label="Close" onClick={onClose}>
          ×
        </button>
        <CrewArt look={up ? "boss-thumbs" : "negotiator-deal"} className="signin-crew" />
        <h1 id="signin-title">{up ? "Join the crew" : "Welcome back"}</h1>
        <p className="signin-sub">
          {up
            ? "Create your Bounty account to save finds, plan trips and track your stock."
            : "Sign in to pick up your finds, trips and stock where you left them."}
        </p>

        {shown.length > 0 && (
          <>
            <div className="signin-ways">
              {shown.map((p) => {
                const ready = READY.includes(p.id);
                return (
                  <button
                    key={p.id}
                    type="button"
                    className="signin-way"
                    disabled={!ready}
                    onClick={() => ready && (window.location.href = "/api/auth/oauth/" + p.id)}
                  >
                    <Logo id={p.id} />
                    {(up ? "Sign up with " : "Continue with ") + p.label}
                    {!ready && <em>Coming soon</em>}
                  </button>
                );
              })}
            </div>
            <div className="signin-or">
              <span>or use your email</span>
            </div>
          </>
        )}

        {up && (
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
            autoFocus
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
            minLength={up ? 10 : undefined}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={up ? "new-password" : "current-password"}
          />
          {up && <small>At least 10 characters.</small>}
        </label>
        {up && (
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
        <button type="submit" className="signin-main" disabled={busy}>
          {busy ? "One moment…" : up ? "Create my account" : "Sign in with email"}
        </button>
        {(inviteOpen || up) && (
          <p className="signin-switchline">
            {up ? "Already a member?" : "New to Bounty?"}{" "}
            <button
              type="button"
              className="signin-switch"
              onClick={() => (setMode(up ? "in" : "up"), setError(null))}
            >
              {up ? "Sign in" : "Create an account"}
            </button>
          </p>
        )}
        <p className="signin-note">
          You stay signed in on this device for 30 days. By continuing you accept Bounty’s terms and privacy policy.
        </p>
      </form>
    </div>
  );
}
