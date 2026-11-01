# Hosting the pilot

Bounty runs in two pieces when it is hosted:

- **The app** (React, built by Vite) is static files served by **Vercel**.
- **The API** and the six-hourly Open Prices import run together in one small always-on container on **Railway**, with a persistent disk for the SQLite database, ledger proofs and shelf photos.

Vercel forwards every `/api/...` request to the Railway API (a rewrite in `vercel.json`), so the browser only ever talks to the Vercel address and nothing changes in the client.

The API stays as it was on your own computer: the same SQLite file, the same synchronous queries and the same files on disk. Vercel Functions have no lasting disk and stop between requests, which is why the API does not run there. Moving it onto Vercel would mean replacing SQLite with a hosted database and the files with Vercel Blob, and running the import from Vercel Cron.

## The password

Bounty has no accounts yet, and the database holds private notes, ledger amounts and member details. A hosted API therefore refuses to start without `BOUNTY_PASSWORD` (at least 16 characters). Every request must carry it, and the browser asks for it the first time the app calls the API: type any user name and the password. Anyone with the password can see and change everything, including acting as any member, so share it only with people you would trust with the whole database.

Settings (all read by `server/access.mjs`):

| Variable              | Hosted value                                         | Purpose                                                        |
| --------------------- | ---------------------------------------------------- | -------------------------------------------------------------- |
| `BOUNTY_PASSWORD`     | a long random password                               | Required whenever the API listens beyond this machine          |
| `BOUNTY_PUBLIC_HOSTS` | `<app>.vercel.app,<api>.up.railway.app`              | Host names and origins the API answers, besides localhost      |
| `BOUNTY_LISTEN_HOST`  | `0.0.0.0` (set by the Dockerfile)                    | Address to listen on                                           |
| `BOUNTY_DATA_DIR`     | `/data` (set by the Dockerfile)                      | Where the database, proofs and photos live: the mounted volume |
| `PORT`                | set by Railway                                       | Port to listen on                                              |

Partner credentials (`HOBNIGHT_API_KEY`, `KEEPA_API_KEY`, `EBAY_ACCESS_TOKEN`) go in the same Railway variables if you have them. They stay on the server.

On your own computer nothing changes: with none of these set, the API listens on 127.0.0.1 with no password, as before.

## Setting it up

### 1. The API on Railway

1. Sign in at [railway.com](https://railway.com) with GitHub and choose **New Project**, **Deploy from GitHub repo**, then `EmotiveImpact/Bounty`. Railway reads `railway.json` and builds the `Dockerfile`.
2. On the service, choose **Attach volume** and set the mount path to `/data`.
3. Under **Variables**, add `BOUNTY_PASSWORD`. Under **Settings**, choose the region nearest London (EU West).
4. Under **Settings**, **Networking**, choose **Generate Domain**. Note the address, for example `bounty-api-production.up.railway.app`.
5. Add `BOUNTY_PUBLIC_HOSTS` with that Railway host name for now. The deploy log should end with `Bounty API listening on 0.0.0.0:<port> for ..., password required` and an Open Prices import.

Keep the service at one replica: SQLite is a single file on one disk.

### 2. The app on Vercel

1. Put the Railway host name into the rewrite destination in `vercel.json` (replacing `set-your-api-host.invalid`) and merge it.
2. In Vercel choose **Add New**, **Project** and import `EmotiveImpact/Bounty`. `vercel.json` sets the Vite build and output folder, so the defaults can stay.
3. Add the Vercel host name (for example `bounty.vercel.app`) to `BOUNTY_PUBLIC_HOSTS` on Railway, comma-separated after the Railway one. Railway redeploys.
4. Open the Vercel address. The browser asks for a user name and password on the first API call.

Preview deployments get their own addresses, which the API refuses until they are added to `BOUNTY_PUBLIC_HOSTS`. That is deliberate: only addresses you name can reach the data.

## After the first deploy

- Upload a ledger proof and a shelf photo of a few megabytes to check that Vercel's proxy passes bodies that size (the API accepts up to about 7 MB).
- Turn on volume backups in Railway, or download `desk.sqlite` from time to time.
- Vercel's free Hobby plan is for non-commercial use. Move to Pro before charging members.
