// The Blocks page (#Blocks): every building block from kit.tsx, live, with
// when to use it. Screens are built only from these. Figures here are
// sample data and say so.
import React, { useState } from "react";
import {
  Answer,
  Button,
  Card,
  Chip,
  Empty,
  Field,
  Figure,
  Figures,
  Input,
  Menu,
  Meter,
  MoneyInput,
  Notice,
  PageHead,
  Row,
  Rows,
  Segmented,
  Tabs,
  Toasts,
  Window,
  useToast,
  type Tint,
} from "./kit";
import "./blocks.css";

const RULES: [string, string][] = [
  ["One answer first", "Each screen opens on the thing you came for: a verdict, a figure or your next step. Detail comes after."],
  ["Depth one tap away", "Evidence, history and the full records open in a window or in Pro. Nothing is removed."],
  ["One main button", "Each card and window has a single black button for the likely next step. The rest sit under More."],
  ["Colour means where you are", "The tab colour marks the page and its windows. Green, amber and red only ever mean profit, careful and loss."],
  ["Pounds, said plainly", "Money is in pounds, estimates say so, and sample figures always carry a Sample label."],
];
const SWATCH: [Tint, string, string][] = [
  ["lime", "Deals", "lime"],
  ["sky", "Tips", "sky"],
  ["periwinkle", "Scan", "periwinkle"],
  ["peach", "Stock", "peach"],
  ["candy", "Money", "candy"],
  ["pistachio", "My trip", "pistachio"],
  ["butter", "Research", "butter"],
  ["lemon", "Saved", "lemon"],
  ["lilac", "Settings, Admin", "lilac"],
];

export default function Blocks() {
  return (
    <Toasts>
      <Page />
    </Toasts>
  );
}

function Block({ name, use, not, children }: { name: string; use: string; not?: string; children: React.ReactNode }) {
  return (
    <div className="bk-block">
      <div className="bk-about">
        <h3>{name}</h3>
        <p>{use}</p>
        {not && <p className="bk-not">{not}</p>}
      </div>
      <div className="bk-stage">{children}</div>
    </div>
  );
}

function Page() {
  const say = useToast();
  const [win, setWin] = useState<"" | "sale" | "detail">("");
  const [travel, setTravel] = useState("bus");
  const [tab, setTab] = useState("open");
  const [paid, setPaid] = useState("");
  const [tried, setTried] = useState(false);
  const paidBad = tried && !(Number(paid.replace(/[£,\s]/g, "")) > 0);

  return (
    <div className="bk">
      <PageHead
        title="Building blocks"
        tint="lilac"
        lead="The small set of pieces every Bounty screen is built from, so Research, Tips, Stock and the rest feel like one app. Everything here works. Figures are sample data."
      />

      <section className="bk-sec">
        <header>
          <span className="bk-kick">How every screen works</span>
          <h2 className="k-display">Five rules</h2>
        </header>
        <div className="bk-rules">
          {RULES.map(([h, p], i) => (
            <div key={h}>
              <span className="bk-n k-display">{i + 1}</span>
              <h3>{h}</h3>
              <p>{p}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="bk-sec">
        <header>
          <span className="bk-kick">Foundations</span>
          <h2 className="k-display">Type and colour</h2>
        </header>
        <Block name="Type" use="Cal Sans for page titles, window titles and big figures. Google Sans for everything you read or tap.">
          <div className="bk-type">
            <div><small>Page title</small><span className="k-display" style={{ fontSize: 52, lineHeight: 1 }}>Stock</span></div>
            <div><small>Big figure</small><span className="k-display" style={{ fontSize: 40, color: "var(--k-profit)" }}>£412.00</span></div>
            <div><small>Window title</small><span className="k-display" style={{ fontSize: 28 }}>Record a sale</span></div>
            <div><small>Card title</small><b style={{ fontSize: 17 }}>Boots clearance</b></div>
            <div><small>Body</small><span>Two sold, seven left. Record it when the money arrives.</span></div>
            <div><small>Small print</small><span style={{ fontSize: 12.5, color: "var(--k-muted)" }}>Bought 28 Oct at £4.11 each</span></div>
          </div>
        </Block>
        <Block name="Colour" use="One light tint per tab. Meaning colours are kept apart and never used for decoration.">
          <div className="bk-swatches">
            {SWATCH.map(([t, n, c]) => (
              <div key={t} style={{ background: `var(--k-${t})` }}>
                <b>{n}</b>
                <small>{c}</small>
              </div>
            ))}
            <div style={{ background: "var(--k-profit-bg)", color: "var(--k-profit)" }}><b>Profit, buy</b><small>green</small></div>
            <div style={{ background: "var(--k-warn-bg)", color: "var(--k-warn)" }}><b>Careful, think</b><small>amber</small></div>
            <div style={{ background: "var(--k-loss-bg)", color: "var(--k-loss)" }}><b>Loss, leave</b><small>red</small></div>
            <div style={{ background: "var(--k-ink)", color: "#fff" }}><b>Ink</b><small>main buttons</small></div>
          </div>
        </Block>
      </section>

      <section className="bk-sec">
        <header>
          <span className="bk-kick">The pieces</span>
          <h2 className="k-display">Thirteen blocks</h2>
          <p>Each says when to use it. Try the ones that move.</p>
        </header>

        <Block name="Page header" use="The tab colour block with the page name and one line on what it is for.">
          <PageHead title="Money" tint="candy" lead="November so far. Only money that has reached you counts as kept." />
        </Block>

        <Block name="Answer card" use="The one answer a screen gives: Scan, Research, My trip, a find's page." not="Never more than one per screen.">
          <Answer
            verdict="buy"
            headline="Keep £5.72 each"
            why="Sold 9 times in 30 days at about £21. After fees and postage you keep £5.72 on an £8.00 bottle."
            facts={[
              ["Walk away above", "£8.72"],
              ["Sells in", "about 6 days"],
              ["Money back", "by 13 Nov"],
            ]}
          >
            <div><Button variant="text" onClick={() => setWin("detail")}>See the evidence</Button></div>
          </Answer>
          <div className="bk-two">
            <Answer verdict="think" why="Profit is there but under your £5 minimum." />
            <Answer verdict="leave" why="Fees and postage eat it. You would lose £1.10." />
          </div>
        </Block>

        <Block name="Figures" use="Up to four numbers that sum up a page. The lead figure can be green." not="Four at most. Never a wall of tiles.">
          <Figures>
            <Figure label="Kept this month" value="£412.00" tone="profit" note="after what you spent" />
            <Figure label="Waiting for money" value="£27.50" note="sold, not paid out yet" />
            <Figure label="Not sold yet" value="7 units" note="£28.77 of your cash" />
          </Figures>
        </Block>

        <Block name="Card" use="One thing you are working on: a trip, a find, a tip. Title, status, a meter if it helps, then the buttons.">
          <Card>
            <div className="bk-cardtop">
              <div className="k-chips" style={{ display: "grid", gap: 8 }}>
                <h3>Boots clearance</h3>
                <div className="k-chips"><Chip tone="wait">Sold, waiting for money</Chip><Chip tone="sample">Sample</Chip></div>
              </div>
              <div className="bk-cardmoney"><small>Waiting</small><b>£27.50</b></div>
            </div>
            <Meter label="Sold" value={2} max={9} shown="2 of 9 · 7 left" />
            <div className="bk-acts">
              <Button variant="main" onClick={() => say("Money recorded. Money counts it as kept.", () => say("Undone."))}>Money arrived</Button>
              <Menu
                items={[
                  { label: "Record a sale", onSelect: () => setWin("sale") },
                  { label: "Add a cost", onSelect: () => say("This would open Add a cost.") },
                  { label: "Record a return", onSelect: () => say("This would open Record a return.") },
                  "-",
                  { label: "Close trip", onSelect: () => say("This would ask before closing.") },
                ]}
              />
              <Button variant="text" onClick={() => setWin("detail")}>Details</Button>
            </div>
          </Card>
        </Block>

        <Block name="List row" use="Anything you scan down: trips, tips, sales, sources. The whole row opens its window.">
          <Card>
            <Rows>
              <Row badge="TM" tint="pistachio" title="TK Maxx toys" sub="3 of 3 sold · started 25 Oct" value="£34.00" valueNote="kept" tone="profit" onClick={() => setWin("detail")} />
              <Row badge="BC" tint="butter" title="Boots clearance" sub="2 of 9 sold · waiting for £27.50" value="£27.50" valueNote="waiting" onClick={() => setWin("detail")} />
              <Row badge="3" tint="peach" title="Lip balm gift set" sub="3 at £4.11 each · 0 sold" slot={<Button size="sm" onClick={() => setWin("sale")}>Sold one</Button>} />
            </Rows>
          </Card>
        </Block>

        <Block name="Buttons" use="Black for the one main step. Tab colour for a positive extra. Outline for the rest. Underlined text for see-more." not="One black button per card or window.">
          <div className="bk-acts">
            <Button variant="main">Record a sale</Button>
            <Button variant="tab" tint="lime">Add to my trip</Button>
            <Button variant="line">Cancel</Button>
            <Button variant="text">See the evidence</Button>
          </div>
          <div className="bk-acts">
            <Button variant="main" size="sm">Save</Button>
            <Button variant="line" size="sm">Sold one</Button>
            <Button variant="main" disabled>Saving…</Button>
          </div>
        </Block>

        <Block name="Status chips" use="Where something is up to. The same words and colours on every screen.">
          <div className="k-chips">
            <Chip tone="plan">Planned</Chip>
            <Chip tone="bought">Bought</Chip>
            <Chip tone="listed">Selling</Chip>
            <Chip tone="wait">Sold, waiting for money</Chip>
            <Chip tone="paid">All sold and paid</Chip>
            <Chip tone="done">Finished</Chip>
          </div>
          <div className="k-chips">
            <Chip tone="buy">Buy</Chip>
            <Chip tone="think">Think</Chip>
            <Chip tone="leave">Leave</Chip>
            <Chip tone="buy">Verified</Chip>
            <Chip tone="sample">Sample</Chip>
          </div>
        </Block>

        <Block name="Meter" use="Cash, carry, units sold, the £1,000 HMRC guide. Turns red when you go over.">
          <div style={{ display: "grid", gap: 16, maxWidth: 460 }}>
            <Meter label="Cash" value={34} max={100} shown="£34 of £100" ink />
            <Meter label="Carry" value={6.2} max={5} shown="6.2 of 5 kg" over />
            <Meter label="Paid out since 6 April" value={412} max={1000} shown="£412 of £1,000" />
          </div>
        </Block>

        <Block name="Form" use="Label above, hint below, the error in plain words in red. Money fields show the £. Big enough to tap on a phone.">
          <form
            className="k-form"
            style={{ maxWidth: 460 }}
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              setTried(true);
              if (Number(paid.replace(/[£,\s]/g, "")) > 0) say("Looks good. Nothing was saved, this is a sample.");
            }}
          >
            <Field label="Item" htmlFor="bk-item">
              <Input id="bk-item" defaultValue="Lip balm gift set" />
            </Field>
            <Field label="Buyer paid" htmlFor="bk-paid" hint="The total the buyer paid, with any postage." error={paidBad ? "Type what the buyer paid, like 9.50." : undefined}>
              <MoneyInput id="bk-paid" value={paid} onChange={(e) => setPaid(e.target.value)} placeholder="0.00" />
            </Field>
            <Field label="Getting around" hint="Used to count fares and time. It never hides a deal.">
              <Segmented label="Getting around" value={travel} onChange={setTravel} options={[["car", "Car"], ["bus", "Bus"], ["walk", "Walk"]]} />
            </Field>
            <div><Button variant="main" type="submit">Check it</Button></div>
          </form>
        </Block>

        <Block name="Tabs" use="Two to four views of the same list, like Open and Finished.">
          <Tabs
            label="Trips"
            value={tab}
            onChange={setTab}
            tabs={[
              { value: "open", label: "Open", count: 2, content: <Notice title="Open.">Trips you are still selling.</Notice> },
              { value: "done", label: "Finished", count: 5, content: <Notice title="Finished.">Closed trips and what each one kept.</Notice> },
            ]}
          />
        </Block>

        <Block name="Window" use="A task, like recording a sale, or the full detail behind a card. Centred on a computer; on a phone it rises from the bottom and fills the screen." not="Replaces side drawers.">
          <div className="bk-acts">
            <Button variant="main" onClick={() => setWin("sale")}>Record a sale</Button>
            <Button variant="line" onClick={() => setWin("detail")}>Open a trip's details</Button>
          </div>
        </Block>

        <Block name="Notices" use="Grey for sample data, amber for check before you go, red when something failed.">
          <div style={{ display: "grid", gap: 10 }}>
            <Notice title="Sample data.">These figures are illustrations, not real offers.</Notice>
            <Notice tone="warn" title="Check first.">Only 2 on the shelf at Tesco and you planned 3.</Notice>
            <Notice tone="loss" title="Not saved.">The connection dropped. Try again.</Notice>
          </div>
        </Block>

        <Block name="Empty state" use="Says what will appear here and the one step to get there.">
          <Empty
            title="No open trips"
            text="Plan a trip from Deals, tick things off in the shop, then press Finish trip. What you got lands here."
            action={<Button variant="main">Browse deals</Button>}
          />
        </Block>

        <Block name="Toast" use="Confirms what just happened, with Undo when it can be undone. Swipe down to dismiss on a phone.">
          <div className="bk-acts">
            <Button variant="line" onClick={() => say("Sale recorded. It waits until the money arrives.", () => say("Sale removed."))}>
              Show a toast
            </Button>
          </div>
        </Block>
      </section>

      <Window
        open={win === "sale"}
        onOpenChange={(o) => !o && setWin("")}
        tint="peach"
        title="Record a sale"
        description="Boots clearance · sample"
        footer={
          <>
            <Button variant="line" onClick={() => setWin("")}>Cancel</Button>
            <Button variant="main" onClick={() => (setWin(""), say("Sale recorded. It waits until the money arrives.", () => say("Sale removed.")))}>Save</Button>
          </>
        }
      >
        <div className="k-form">
          <div className="k-pair">
            <Field label="Item" htmlFor="bk-w-item"><Input id="bk-w-item" defaultValue="Lip balm gift set" /></Field>
            <Field label="How many" htmlFor="bk-w-n"><Input id="bk-w-n" type="number" defaultValue={1} /></Field>
          </div>
          <Field label="Buyer paid" htmlFor="bk-w-paid" hint="The total the buyer paid, with any postage they paid. Fees come off when the money arrives.">
            <MoneyInput id="bk-w-paid" placeholder="0.00" />
          </Field>
          <Field label="Date" htmlFor="bk-w-date"><Input id="bk-w-date" type="date" defaultValue="2026-11-02" /></Field>
        </div>
      </Window>

      <Window
        open={win === "detail"}
        onOpenChange={(o) => !o && setWin("")}
        tint="peach"
        wide
        title="Boots clearance"
        description={<span className="k-chips" style={{ marginTop: 4 }}><Chip tone="wait">Sold, waiting for money</Chip><Chip tone="sample">Sample</Chip></span>}
        footer={
          <>
            <Button variant="text" style={{ marginRight: "auto" }}>Proofs and checks</Button>
            <Button variant="main" onClick={() => (setWin(""), say("Money recorded. Money counts it as kept."))}>Money arrived</Button>
          </>
        }
      >
        <div className="bk-wfigs">
          <Figure label="You spent" value="£37.00" />
          <Figure label="Paid out to you" value="£0.00" />
          <Figure label="Waiting" value="£27.50" />
          <Figure label="Cash in stock" value="£28.77" />
        </div>
        <Rows>
          <Row badge="7" tint="peach" title="Lip balm gift set" sub="9 at £4.11 each · 2 sold" slot={<Button size="sm" onClick={() => setWin("sale")}>Sold one</Button>} />
        </Rows>
        <Rows>
          <Row badge="1" tint="sky" title="Sold: Lip balm gift set" sub="1 Nov · 2 units" value="£27.50" />
          <Row badge="28" tint="peach" title="Bought: Lip balm gift set" sub="28 Oct · 9 units" value="£37.00" />
        </Rows>
      </Window>
    </div>
  );
}
