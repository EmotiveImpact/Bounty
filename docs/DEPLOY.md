# Hosting Bounty

There are two ways to put Bounty online. Both need either member sign-in (accounts kept in a Neon Postgres database) or one shared password, because the database holds private notes, ledger amounts and member details.

| | Free demo | Persistent pilot |
| --- | --- | --- |
| Where | Everything on Vercel | App on Vercel, API on Railway |
| Cost | Free (Vercel Hobby) | Roughly £4 to £5 a month for Railway |
| Data | Temporary: Vercel can start a fresh, empty database at any time | Kept on a disk |
| Price imports | When the API is first used, then every six hours while in use | Every six hours |
| Largest upload | About 4.5 MB (Vercel's limit for a function request) | About 7 MB |

## Member sign-in (Neon)

With `DATABASE_URL` set to a Postgres connection string (the dev demo uses a free Neon project in London), the app opens on a sign-in page instead of the browser's password pop-up. A session cookie keeps each device signed in for 30 days. Each Vercel address (production and every preview) has its own cookie, so a new preview link asks once.

- New members sign up with `BOUNTY_INVITE_CODE` (at least 8 characters). Without it, sign-up is closed and only existing members can sign in.
- Accounts and sessions are the only things kept in Postgres (`server/accounts.mjs` creates the `bounty_users` and `bounty_sessions` tables on first use). Everything else stays in SQLite, so on the free demo it can still reset.
- Passwords are stored as scrypt hashes and session tokens as SHA-256 hashes. After eight wrong passwords for one email, that email is refused for 15 minutes.
- When `DATABASE_URL` is set, `BOUNTY_PASSWORD` is ignored.

Vercel's own **Deployment Protection** (a Vercel sign-in page on preview links) is separate from this and is set under the Vercel project's **Settings**, **Deployment Protection**.

## The password

Without `DATABASE_URL`, the shared password applies.

A hosted API refuses to start without `DATABASE_URL` or `BOUNTY_PASSWORD` (at least 16 characters). Every request must carry it, and the browser asks for it the first time the app calls the API: type any user name and the password. Anyone with the password can see and change everything, including acting as any member, so share it only with people you would trust with the whole database.

Settings (read by `server/access.mjs`):

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Postgres (Neon) connection string; turns on member sign-in |
| `BOUNTY_INVITE_CODE` | Code new members enter to sign up |
| `BOUNTY_PASSWORD` | Required whenever the API is reachable beyond this machine, unless `DATABASE_URL` is set |
| `BOUNTY_PUBLIC_HOSTS` | Extra host names the API answers, besides localhost. On Vercel the deployment's own addresses are added automatically |
| `BOUNTY_LISTEN_HOST` | Address to listen on (`0.0.0.0` in the Dockerfile) |
| `BOUNTY_DATA_DIR` | Where the database, proofs and photos live (`/tmp/bounty-data` on Vercel, `/data` in the Dockerfile) |

Partner credentials (`HOBNIGHT_API_KEY`, `KEEPA_API_KEY`, `EBAY_ACCESS_TOKEN`) go in the same environment variables if you have them. They stay on the server.

On your own computer nothing changes: with none of these set, the API listens on 127.0.0.1 with no password, as before.

## Free demo on Vercel

`vercel.json` builds the Vite app and sends every `/api/...` request to one Vercel Function (`api/index.mjs`) in London (`lhr1`). The function runs the same API as on your own computer, with its SQLite database in the function's temporary storage (`server/demo.mjs`). The first request to a fresh function imports Open Prices, and so does the first request after the prices are six hours old.

What you enter (ledger trips, bounties, members, audit items, proofs) lasts only as long as the function instance. Vercel stops an idle instance after a while and may run more than one at once, and each has its own database. Treat the demo as somewhere to click around, not somewhere to keep records.

1. In Vercel choose **Add New**, **Project** and import `EmotiveImpact/Bounty`. `vercel.json` sets the build, so the defaults can stay.
2. Under **Settings**, **Environment Variables**, add `DATABASE_URL` and `BOUNTY_INVITE_CODE` (or `BOUNTY_PASSWORD` for the older shared password) and redeploy.
3. Open the Vercel address and sign up with the invite code.

Until one of them is set, every API call answers that Bounty is not set up yet.

## Persistent pilot: API on Railway

When the data needs to last, run the API and the six-hourly import loop together in one small always-on container (`Dockerfile`, `railway.json`, `npm start`) with a disk for the SQLite file, proofs and photos. Vercel then only serves the app.

1. Sign in at [railway.com](https://railway.com) with GitHub, choose **New Project**, **Deploy from GitHub repo**, then `EmotiveImpact/Bounty`.
2. On the service, choose **Attach volume** with the mount path `/data`.
3. Under **Variables**, add `BOUNTY_PASSWORD`. Under **Settings**, choose the region nearest London.
4. Under **Settings**, **Networking**, choose **Generate Domain**.
5. Add `BOUNTY_PUBLIC_HOSTS` with the Railway host name and the Vercel host name, comma-separated.
6. In `vercel.json`, replace the `/api` rewrite destination with `https://<railway host>/api/:path*` and remove the `functions` entry, so Vercel forwards to Railway instead of running the demo function.

Keep the Railway service at one replica: SQLite is a single file on one disk. Turn on volume backups, or download `desk.sqlite` from time to time.

## Notes

- Preview deployments get their own addresses. On Vercel they are accepted automatically; for Railway, add them to `BOUNTY_PUBLIC_HOSTS`.
- Vercel's free Hobby plan is for non-commercial use. Move to Pro before charging members.
