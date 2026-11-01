# Hosting Bounty

There are two ways to put Bounty online. Both sit behind one shared password, because Bounty has no accounts yet and the database holds private notes, ledger amounts and member details.

| | Free demo | Persistent pilot |
| --- | --- | --- |
| Where | Everything on Vercel | App on Vercel, API on Railway |
| Cost | Free (Vercel Hobby) | Roughly £4 to £5 a month for Railway |
| Data | Temporary: Vercel can start a fresh, empty database at any time | Kept on a disk |
| Price imports | When the API is first used, then every six hours while in use | Every six hours |
| Largest upload | About 4.5 MB (Vercel's limit for a function request) | About 7 MB |

## The password

A hosted API refuses to start without `BOUNTY_PASSWORD` (at least 16 characters). Every request must carry it, and the browser asks for it the first time the app calls the API: type any user name and the password. Anyone with the password can see and change everything, including acting as any member, so share it only with people you would trust with the whole database.

Settings (read by `server/access.mjs`):

| Variable | Purpose |
| --- | --- |
| `BOUNTY_PASSWORD` | Required whenever the API is reachable beyond this machine |
| `BOUNTY_PUBLIC_HOSTS` | Extra host names the API answers, besides localhost. On Vercel the deployment's own addresses are added automatically |
| `BOUNTY_LISTEN_HOST` | Address to listen on (`0.0.0.0` in the Dockerfile) |
| `BOUNTY_DATA_DIR` | Where the database, proofs and photos live (`/tmp/bounty-data` on Vercel, `/data` in the Dockerfile) |

Partner credentials (`HOBNIGHT_API_KEY`, `KEEPA_API_KEY`, `EBAY_ACCESS_TOKEN`) go in the same environment variables if you have them. They stay on the server.

On your own computer nothing changes: with none of these set, the API listens on 127.0.0.1 with no password, as before.

## Free demo on Vercel

`vercel.json` builds the Vite app and sends every `/api/...` request to one Vercel Function (`api/index.mjs`) in London (`lhr1`). The function runs the same API as on your own computer, with its SQLite database in the function's temporary storage (`server/demo.mjs`). The first request to a fresh function imports Open Prices, and so does the first request after the prices are six hours old.

What you enter (ledger trips, bounties, members, audit items, proofs) lasts only as long as the function instance. Vercel stops an idle instance after a while and may run more than one at once, and each has its own database. Treat the demo as somewhere to click around, not somewhere to keep records.

1. In Vercel choose **Add New**, **Project** and import `EmotiveImpact/Bounty`. `vercel.json` sets the build, so the defaults can stay.
2. Under **Settings**, **Environment Variables**, add `BOUNTY_PASSWORD` and redeploy.
3. Open the Vercel address. The browser asks for a user name and password on the first API call.

Until the password is set, every API call answers that Bounty is not set up yet.

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
