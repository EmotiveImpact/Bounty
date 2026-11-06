// Admin: the operator tools, kept off the member screens. Reached from the
// account menu, not the main navigation. Tips desk (create tips, act as any
// member, verify shelf reports, send alerts), Sources, the evidence register
// and the audit sign-off. The tools themselves are unchanged.
import React, { useState } from "react";
import Audit, { type AuditHandover } from "../Audit";
import Bounties from "../Bounties";
import Research, { EvidenceRegister } from "../Research";
import Sources from "../Sources";
import { Button, Card, Field, Input, Notice, PageHead, Tabs } from "../ui/kit";
import "./admin.css";
import "./legacy-kit.css";

type Tab = "tips" | "members" | "sources" | "evidence" | "check" | "audit";

// Members: help someone back in while account emails are not switched on.
// Makes a one-use reset link (24 hours) to send them by hand.
function MemberHelp() {
  const [email, setEmail] = useState("");
  const [link, setLink] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function make() {
    setBusy(true);
    setError(null);
    setLink(null);
    try {
      const res = await fetch("/api/account/reset-link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw Error(data?.error || "That did not work (HTTP " + res.status + ")");
      setLink(data.link);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card>
      <h3 style={{ marginTop: 0 }}>Help a member back in</h3>
      <p className="adm-sub">
        For a member who forgot their password while account emails are off. Check it is really them first (for
        example, a message from the email on the account). The link works once, for 24 hours.
      </p>
      <Field label="Their account email" htmlFor="adm-reset" error={error}>
        <Input id="adm-reset" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
      </Field>
      <Button variant="main" disabled={busy || !email} onClick={() => void make()}>
        Make a reset link
      </Button>
      {link && (
        <Field label="Send them this link" htmlFor="adm-link">
          <Input id="adm-link" readOnly value={link} onFocus={(e) => e.currentTarget.select()} />
        </Field>
      )}
    </Card>
  );
}

export default function Admin() {
  const [tab, setTab] = useState<Tab>("tips");
  const [draft, setDraft] = useState<AuditHandover | null>(null);
  const wrap = (node: React.ReactNode) => <div className="legacy adm-legacy">{node}</div>;
  return (
    <div className="adm">
      <PageHead
        title="Admin"
        tint="lilac"
        lead="Operator tools, kept away from members: tips desk, sources, evidence and audit sign-off."
      />
      <Notice tone="warn" title="Operators only.">
        Members do not see this page. Anything changed here affects every member.{" "}
        <a href="#Blocks">See the building blocks</a> the screens are made from.
      </Notice>
      <Tabs
        label="Admin tools"
        value={tab}
        onChange={setTab}
        tabs={[
          { value: "tips", label: "Tips desk", content: wrap(<Bounties />) },
          { value: "members", label: "Members", content: <MemberHelp /> },
          { value: "sources", label: "Sources", content: wrap(<Sources />) },
          { value: "evidence", label: "Evidence register", content: wrap(<EvidenceRegister />) },
          {
            value: "check",
            label: "Check for audit",
            content: wrap(
              <Research
                onAuditDraft={(d) => {
                  setDraft(d as AuditHandover);
                  setTab("audit");
                }}
              />,
            ),
          },
          { value: "audit", label: "Audit sign-off", content: wrap(<Audit draft={draft} />) },
        ]}
      />
    </div>
  );
}
