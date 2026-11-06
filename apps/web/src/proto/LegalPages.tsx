// Help, Terms and Privacy. Plain English, written for UK members.
// The Terms and Privacy text is a first draft for a solicitor to check
// before members are charged; the pages say so.
import { useState } from "react";
import { Button, Card, Field, Input, Notice, PageHead, Section, Select } from "../ui/kit";
import "./legal.css";

const UPDATED = "6 November 2026";

function Draft() {
  return (
    <Notice tone="warn" title="Draft.">
      This page is being checked before Bounty starts charging. The business name and address will be added then.
    </Notice>
  );
}

export function Terms() {
  return (
    <div className="lg">
      <PageHead title="Terms" tint="lilac" lead={`The rules for using Bounty. Last updated ${UPDATED}.`} />
      <Draft />
      <article className="lg-text">
        <h2>Who we are</h2>
        <p>
          Bounty is a website and app that helps people in the UK find things in shops that sell for more than they
          cost, and keep track of what they buy and sell. “We” means Bounty. “You” means the person using it.
        </p>

        <h2>Who can use Bounty</h2>
        <p>You must be 18 or over and live in the UK. One account per person. Keep your password to yourself.</p>

        <h2>What Bounty is, and what it is not</h2>
        <ul>
          <li>
            Bounty shows prices, past sale prices, tips from other members and sums worked out from them. They are a
            guide, not a promise. Shop prices change, stock runs out, and things can sell for less than they did
            before.
          </li>
          <li>Any profit, “keep” figure or hourly rate is an estimate. You decide what to buy, and the risk is yours.</li>
          <li>Bounty is not financial, legal or tax advice. The tax notes in Money are a rough guide only.</li>
          <li>Anything marked “example” or “sample” is made up to show how a screen works. It is not a real deal.</li>
        </ul>

        <h2>Plans and payment</h2>
        <p>
          Bounty has monthly plans. Payments are not switched on yet, so nobody is charged. Before we take any money we
          will show the price, what you get and how to cancel, and you will have to agree to it.
        </p>

        <h2>Your part</h2>
        <ul>
          <li>Follow each shop’s rules, including limits on how many you can buy.</li>
          <li>Follow the rules of the places you sell on (for example eBay or Vinted), and sell only things you may sell.</li>
          <li>Share tips honestly. Don’t post a tip you know is wrong, or one that could send people on a wasted trip.</li>
          <li>Don’t copy Bounty’s data in bulk, try to break the site, or use someone else’s account.</li>
          <li>You are responsible for your own tax. If you sell regularly, HMRC may need to hear from you.</li>
        </ul>

        <h2>Tips and points</h2>
        <p>
          When you share a tip or a shelf price, you let us show it to other members. We may remove tips that look
          wrong, unsafe or unfair. Points and levels are earned only. They have no cash value and cannot be bought or
          sold.
        </p>

        <h2>Closing an account</h2>
        <p>
          You can delete your account at any time in Profile and settings. We may suspend or close an account that
          breaks these terms, and we will tell you why unless the law stops us.
        </p>

        <h2>If something goes wrong</h2>
        <p>
          We work hard to keep Bounty accurate and running, but we can’t promise it will always be right or available.
          We are not responsible for losses from a buying or selling decision you make, for a shop or platform’s
          actions, or for a trip that didn’t pay off. Nothing here limits rights you have by law, including under the
          Consumer Rights Act 2015.
        </p>

        <h2>Changes</h2>
        <p>
          If we change these terms in a way that matters, we will tell you on the site or by email before the change
          applies.
        </p>

        <h2>The law</h2>
        <p>These terms are under the law of England and Wales. You can also use the courts where you live in the UK.</p>

        <p className="lg-more">
          Questions? <a href="#Help">Send us a message</a>.
        </p>
      </article>
    </div>
  );
}

export function Privacy() {
  return (
    <div className="lg">
      <PageHead title="Privacy" tint="lilac" lead={`What we keep about you, why, and your rights. Last updated ${UPDATED}.`} />
      <Draft />
      <article className="lg-text">
        <h2>The short version</h2>
        <p>
          We keep what Bounty needs to work: your sign-in, the trips, sales and money goals you record, and the tips you
          share. We don’t sell your data, we don’t show adverts, and we don’t track you around the web. You can download
          or delete your data at any time in Profile and settings.
        </p>

        <h2>What we keep</h2>
        <table className="lg-table">
          <thead>
            <tr>
              <th>What</th>
              <th>Why</th>
              <th>How long</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Email, name and a scrambled copy of your password</td>
              <td>To sign you in and contact you about your account</td>
              <td>Until you delete your account</td>
            </tr>
            <tr>
              <td>Your Stock and Money: trips, purchases, sales, costs, goals, receipts</td>
              <td>To show you your profit and progress. Only you can see these.</td>
              <td>Until you delete them or your account</td>
            </tr>
            <tr>
              <td>Tips and shelf prices you share, with your scout name</td>
              <td>To show other members what’s in the shops near them</td>
              <td>While useful; your name is removed if you delete your account</td>
            </tr>
            <tr>
              <td>Shelf photos</td>
              <td>To check a tip. We remove the location data stored inside photos.</td>
              <td>As long as needed to check the tip</td>
            </tr>
            <tr>
              <td>Messages you send from Help</td>
              <td>To reply to you</td>
              <td>Up to 2 years</td>
            </tr>
            <tr>
              <td>Your plan</td>
              <td>To open the parts of Bounty your plan includes</td>
              <td>Until you delete your account</td>
            </tr>
          </tbody>
        </table>
        <p>
          Your postcode, saved finds and display choices are kept only in your browser on this device, not by us.
        </p>

        <h2>The legal basis</h2>
        <p>
          We use your data to provide the service you signed up for (a contract), and to keep Bounty safe and working
          (our legitimate interests). Where we ask for your permission, you can take it back at any time.
        </p>

        <h2>Who helps us run Bounty</h2>
        <ul>
          <li>Vercel runs the website (servers in London).</li>
          <li>Neon stores accounts and records (servers in London).</li>
          <li>Resend sends account emails, such as password resets, once email is switched on.</li>
          <li>Google Fonts supplies one of the fonts, so your browser asks Google for it.</li>
        </ul>
        <p>
          They handle data only to do this work for us. Where data leaves the UK, it is protected by the safeguards UK
          law requires.
        </p>

        <h2>Cookies</h2>
        <p>
          Bounty uses one cookie, to keep you signed in. It is needed for the site to work, so we don’t ask first. Your
          browser also keeps a few settings, such as your postcode and saved finds, on your device. We use no advertising
          or tracking cookies.
        </p>

        <h2>Your rights</h2>
        <p>
          You can ask to see, correct, download or delete your data, or object to how we use it. Most of this you can do
          yourself in Profile and settings. For anything else, <a href="#Help">send us a message</a>. If you’re unhappy
          with how we handle your data, you can complain to the Information Commissioner’s Office at ico.org.uk.
        </p>

        <h2>Changes</h2>
        <p>If we change this policy in a way that matters, we will tell you before it applies.</p>
      </article>
    </div>
  );
}

const FAQ: [string, React.ReactNode][] = [
  [
    "Are the deals real?",
    "Not yet. Every card marked “example” is made up to show how Bounty works, so you can try it out. Real deals start once live prices are connected, and the example labels go when they do.",
  ],
  [
    "How is “keep” worked out?",
    "It is what an item sold for recently, minus the shop price, the selling fees and postage. Travel is shown beside it, never hidden. It is a guide, not a promise.",
  ],
  [
    "Who can see my Stock and Money?",
    "Only you. Each member’s trips, sales and goals are private to their account.",
  ],
  [
    "I forgot my password.",
    "Use “Forgot your password?” on the sign-in window. If the email doesn’t arrive, send us a message below with the email you signed up with.",
  ],
  [
    "How do I delete my account?",
    "Go to Profile and settings, then Your account, then Delete my account. You can download your data first.",
  ],
  [
    "Do I need to tell HMRC?",
    "Possibly. You can earn up to £1,000 a year from selling before you need to tell HMRC, but it depends on your situation. Money shows a rough tracker. It is not tax advice.",
  ],
];

const TOPICS: { value: string; label: string }[] = [
  { value: "question", label: "A question" },
  { value: "account", label: "I can’t get into my account" },
  { value: "wrong-price", label: "A price or deal looks wrong" },
  { value: "bad-tip", label: "A tip looks wrong or unsafe" },
  { value: "other", label: "Something else" },
];

export function Help({ email: knownEmail }: { email?: string | null }) {
  const [topic, setTopic] = useState("question");
  const [email, setEmail] = useState(knownEmail ?? "");
  const [name, setName] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  async function send() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/help", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topic, email, name, message, page: document.referrer || undefined }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw Error(data?.error || "That did not send (HTTP " + res.status + ")");
      setSent(true);
      setMessage("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="lg">
      <PageHead title="Help" tint="sky" lead="Answers to common questions, and a way to reach us." />
      <div className="lg-two">
        <Section title="Common questions">
          <div className="lg-faq">
            {FAQ.map(([q, a]) => (
              <details key={q}>
                <summary>{q}</summary>
                <p>{a}</p>
              </details>
            ))}
          </div>
          <p className="lg-more">
            Also see our <a href="#Terms">terms</a> and <a href="#Privacy">privacy policy</a>.
          </p>
        </Section>
        <Section title="Send us a message" lead="We usually reply within two working days.">
          <Card>
            {sent ? (
              <>
                <Notice tone="profit" title="Thanks, it’s sent.">
                  We’ll reply to {email}.
                </Notice>
                <Button onClick={() => setSent(false)}>Send another</Button>
              </>
            ) : (
              <>
                <Field label="What’s it about?" htmlFor="help-topic">
                  <Select id="help-topic" value={topic} onChange={(e) => setTopic(e.target.value)}>
                    {TOPICS.map((t) => (
                      <option key={t.value} value={t.value}>
                        {t.label}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Your email" htmlFor="help-email" hint="So we can reply.">
                  <Input id="help-email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
                </Field>
                <Field label="Your name (optional)" htmlFor="help-name">
                  <Input id="help-name" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} />
                </Field>
                <Field label="Message" htmlFor="help-msg" error={error}>
                  <textarea
                    id="help-msg"
                    className="k-input lg-msg"
                    rows={6}
                    maxLength={3000}
                    value={message}
                    onChange={(e) => setMessage(e.target.value)}
                  />
                </Field>
                <Button variant="main" disabled={busy || !email || message.trim().length < 5} onClick={() => void send()}>
                  {busy ? "Sending…" : "Send message"}
                </Button>
              </>
            )}
          </Card>
        </Section>
      </div>
    </div>
  );
}

/** The small links at the foot of every page. */
export function SiteFoot() {
  return (
    <footer className="lg-foot">
      <a href="#Help">Help</a>
      <a href="#Terms">Terms</a>
      <a href="#Privacy">Privacy</a>
      <span>© 2026 Bounty</span>
    </footer>
  );
}
