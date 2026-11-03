# Bounty phone app

The Bounty app for iPhone and Android, built with Expo. It talks to the same
server as the website (bounty-nu.vercel.app), so deals, tips and records match.

## What is in it

Five tabs along the bottom, in the bold look (Cal Sans headings, Google Sans
text, one bright tint per tab, crew characters on white):

- **Deals**: finds near you, sorted by what you keep, with a page for each.
- **Tips**: shelf finds members have spotted, with places left.
- **Scan**: reads a barcode with the camera (or typed), takes the sticker
  price and answers buy, think or leave.
- **Stock**: your trips and what is left to sell. Add a purchase from here,
  from a deal or from a scan.
- **Money**: what you kept this month, what is on its way, cash in stock.

Sign in and sign up use the website's accounts and its 30-day session cookie,
which iOS and Android keep for the app. Sample figures always carry a
"Sample" label.

## Try it on your phone

On a Mac or PC on the same Wi-Fi as your phone:

```bash
cd apps/mobile
npm install
npx expo start
```

Then scan the QR code: with the Camera app on iPhone, or the Expo Go app on
Android. Install Expo Go from the App Store or Google Play first.

To point the app at another server (for example one running on your
computer), set `EXPO_PUBLIC_API_URL`, for example
`EXPO_PUBLIC_API_URL=http://192.168.1.20:4174 npx expo start`.

## Checks

```bash
npx tsc --noEmit
npx expo lint
```

## Code map

- `src/app/` screens (Expo Router: every file is a screen). `(tabs)/` holds
  the five tabs; `deal/[sku].tsx`, `sign-in.tsx`, `account.tsx` and
  `add-stock.tsx` open on top.
- `src/ui/` building blocks (`kit.tsx`), colours and fonts (`theme.ts`),
  icons and deal parts. Build new screens from these.
- `src/lib/` server calls, sign-in, formatting and the data shapes.
- `assets/crew/` crew pictures; `assets/fonts/` Cal Sans Medium (a static cut
  of Cal Sans v2 at GEOM 50, opsz 45, OFL licence alongside).

`src/lib/format.ts` and `src/lib/types.ts` copy the website's helpers. When
the repo becomes a monorepo they move to `packages/shared`.

## Not in this version

Payments, push alerts, the Simple/Pro switch, posting tips, and the App Store
and Google Play listings. The app id `london.bounty.app` in `app.json` is a
placeholder until the store accounts are set up.
