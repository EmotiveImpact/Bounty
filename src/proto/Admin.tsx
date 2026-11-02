// Admin: the operator tools, kept off the member screens. Reached from the
// account menu, not the main navigation. Tips desk (create tips, act as any
// member, verify shelf reports, send alerts), Sources, the evidence register
// and the audit sign-off. The tools themselves are unchanged.
import React, { useState } from "react";
import Audit, { type AuditHandover } from "../Audit";
import Bounties from "../Bounties";
import Research, { EvidenceRegister } from "../Research";
import Sources from "../Sources";
import { Notice, PageHead, Tabs } from "../ui/kit";
import "./admin.css";
import "./legacy-kit.css";

type Tab = "tips" | "sources" | "evidence" | "check" | "audit";

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
