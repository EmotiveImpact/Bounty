// Your account, on Profile and settings: email (and whether it is
// confirmed), change password, change email, download your data, delete the
// account. Only shown to a signed-in member on the hosted site.
import { useEffect, useState } from "react";
import { Button, Card, Field, Input, Notice, Row, Rows, Section, Window } from "../ui/kit";

type Account = {
  email: string;
  name: string | null;
  verified: boolean;
  plan: string | null;
  created: string | null;
};

async function call(path: string, body?: unknown) {
  const res = await fetch("/api/account" + path, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw Error(data?.error || "That did not work (HTTP " + res.status + ")");
  return data;
}

type Open = null | "password" | "email" | "delete";

export default function AccountSettings({ onSignedOut, onEmailChanged }: { onSignedOut: () => void; onEmailChanged: () => void }) {
  const [account, setAccount] = useState<Account | null>(null);
  const [open, setOpen] = useState<Open>(null);
  const [note, setNote] = useState<string | null>(null);
  const [noteError, setNoteError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [email, setEmail] = useState("");
  const [sure, setSure] = useState("");

  const load = () =>
    call("")
      .then(setAccount)
      .catch(() => setAccount(null));
  useEffect(() => {
    void load();
  }, []);

  const show = (o: Open) => {
    setOpen(o);
    setNoteError(false);
    setError(null);
    setCurrent("");
    setNext("");
    setEmail("");
    setSure("");
  };
  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function resend() {
    setNoteError(false);
    try {
      const data = await call("/verify/send", {});
      setNote(
        data?.queued ? "Verification email requested. Check your inbox; if it does not arrive, try again." : data?.sent
          ? "We’ve sent a new link to " + account?.email + ". It works for 7 days."
          : data?.mailOn ? "The email was not sent. Please try again." : "Email is not switched on yet.",
      );
    } catch (error) {
      setNoteError(true);
      setNote(error instanceof Error ? error.message : "The email request failed. Please try again.");
    }
  }

  async function download() {
    const data = await call("/export");
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "bounty-my-data-" + new Date().toISOString().slice(0, 10) + ".json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  if (!account) return null;
  return (
    <Section title="Your account" lead="Sign-in details, your data and your account.">
      <Card>
        {note && <Notice tone={noteError ? "warn" : "profit"}>{note}</Notice>}
        <Rows>
          <Row
            title={account.email}
            sub={account.verified ? "Email confirmed" : "Email not confirmed yet"}
            slot={
              !account.verified && (
                <Button size="sm" onClick={() => void resend()}>
                  Send the link again
                </Button>
              )
            }
          />
          <Row title="Password" sub="At least 10 characters" slot={<Button size="sm" onClick={() => show("password")}>Change</Button>} />
          <Row title="Email address" sub="We’ll ask you to confirm the new one" slot={<Button size="sm" onClick={() => show("email")}>Change</Button>} />
          <Row
            title="Download my data"
            sub="Your account, Stock and Money as a file"
            slot={
              <Button size="sm" onClick={() => void run(download)}>
                Download
              </Button>
            }
          />
          <Row
            title="Delete my account"
            sub="Removes your account, Stock and Money for good"
            slot={
              <Button size="sm" className="k-danger" onClick={() => show("delete")}>
                Delete
              </Button>
            }
          />
        </Rows>
      </Card>

      <Window
        open={open === "password"}
        onOpenChange={(o) => !o && show(null)}
        title="Change your password"
        description="You’ll stay signed in here and be signed out on other devices."
        footer={
          <Button
            variant="main"
            disabled={busy || next.length < 10 || !current}
            onClick={() =>
              void run(async () => {
                await call("/password", { current, password: next });
                show(null);
                setNote("Password changed.");
              })
            }
          >
            Save new password
          </Button>
        }
      >
        <Field label="Current password" htmlFor="acc-cur">
          <Input id="acc-cur" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
        </Field>
        <Field label="New password" htmlFor="acc-new" hint="At least 10 characters." error={error}>
          <Input id="acc-new" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
        </Field>
      </Window>

      <Window
        open={open === "email"}
        onOpenChange={(o) => !o && show(null)}
        title="Change your email"
        description="Your Stock, Money and scout points stay with your account."
        footer={
          <Button
            variant="main"
            disabled={busy || !email || !current}
            onClick={() =>
              void run(async () => {
                const data = await call("/email", { email, password: current });
                show(null);
                await load();
                onEmailChanged();
                setNote(
                  data.queued ? "Email changed. A verification email was requested for " + data.user.email + "." : data.sent
                    ? "Email changed. We’ve sent a link to " + data.user.email + " to confirm it."
                    : "Email changed to " + data.user.email + ".",
                );
              })
            }
          >
            Change email
          </Button>
        }
      >
        <Field label="New email" htmlFor="acc-email">
          <Input id="acc-email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field label="Your password" htmlFor="acc-pw" error={error}>
          <Input id="acc-pw" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
        </Field>
      </Window>

      <Window
        open={open === "delete"}
        onOpenChange={(o) => !o && show(null)}
        title="Delete your account?"
        description="This removes your sign-in, your Stock and your Money for good. It can’t be undone."
        footer={
          <Button
            variant="main"
            className="k-danger"
            disabled={busy || !current || sure.trim().toUpperCase() !== "DELETE"}
            onClick={() =>
              void run(async () => {
                await call("/delete", { password: current });
                show(null);
                onSignedOut();
              })
            }
          >
            Delete my account
          </Button>
        }
      >
        <Notice tone="warn">
          Want a copy first? Close this and use Download my data. Tips you shared stay on Bounty without your name.
        </Notice>
        <Field label="Your password" htmlFor="acc-del-pw">
          <Input id="acc-del-pw" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
        </Field>
        <Field label='Type DELETE to confirm' htmlFor="acc-del-sure" error={error}>
          <Input id="acc-del-sure" value={sure} onChange={(e) => setSure(e.target.value)} autoComplete="off" />
        </Field>
      </Window>
    </Section>
  );
}
