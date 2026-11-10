// Sends account emails (confirm your email, reset your password) through
// Resend, an email sending service with a free tier.
//
//   RESEND_API_KEY     the key from resend.com; without it no email is sent
//   BOUNTY_MAIL_FROM   who the email is from, on a domain set up in Resend,
//                      for example "Bounty <hello@grababounty.com>"
//
// With either missing, mail.on is false: the app says email is not switched
// on yet, and an operator can make a reset link by hand in Admin.
export function mailer({
  apiKey = process.env.RESEND_API_KEY,
  from = process.env.BOUNTY_MAIL_FROM,
  send = (url, init) => fetch(url, init),
  log = console.error,
} = {}) {
  const on = Boolean(apiKey && from);
  return {
    on,
    async send({ to, subject, text }) {
      if (!on) return false;
      try {
        const res = await send("https://api.resend.com/emails", {
          method: "POST",
          signal: AbortSignal.timeout(10000),
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({ from, to: [to], subject, text }),
        });
        if (!res.ok) {
          log(`Email not sent (Resend answered ${res.status})`);
          return false;
        }
        return true;
      } catch (error) {
        log("Email not sent: " + error.message);
        return false;
      }
    },
  };
}
