# wss-qr-tracker

A self-hosted **dynamic QR code + scan tracker** running on Cloudflare Workers + D1 (free plan, always on).

The QR code points at a short link on this Worker (e.g. `https://<worker>.workers.dev/r/wss`). On each scan the Worker logs the hit and **302-redirects** to the destination stored in the database, so the destination can be changed at any time without reprinting the QR.

## Features

- `GET /r/<slug>`: looks up the slug, logs the scan in the background (`ctx.waitUntil`), then returns a `302` to the exact stored URL (query string untouched). An unknown slug returns `404`.
- Each scan stores: UTC timestamp, slug, hashed visitor id (SHA-256 of IP + user agent + secret salt; raw IPs are never stored), user agent, referer, and an `is_bot` flag.
- Bot and link-preview filtering: user agents matching `bot|crawl|spider|preview|facebookexternalhit|WhatsApp|Slackbot|TelegramBot|Discordbot|LinkedInBot|Twitterbot|curl|wget` are logged but **not counted**. This covers WhatsApp and Instagram link previews.
- `/admin` dashboard (HTTP Basic Auth, user `admin`): every link with total scans, unique visitors and scans today (Asia/Kolkata), an inline destination editor, a QR PNG download and a details page, plus a form to create new links.
- Details page: scans per day for the last 60 days, the latest 100 scans, and a CSV export.
- QR PNGs are generated in the Worker (`qrcode-generator` + a small built-in PNG encoder): about 1200px, error correction M, 4-module quiet border.

## Deploy (from scratch)

```sh
npm install
npx wrangler login
npx wrangler d1 create wss-qr-tracker-db        # copy the database_id into wrangler.toml
npx wrangler d1 migrations apply wss-qr-tracker-db --remote
npx wrangler deploy
npx wrangler secret put ADMIN_PASSWORD           # dashboard password
npx wrangler secret put SALT                     # long random string for visitor hashing
```

Secrets live only in Cloudflare. They are never committed. For local development, copy `.dev.vars.example` to `.dev.vars` (git-ignored) and run `npm run dev`.

## Change a destination

Open `/admin`, edit the destination field on the link's card, and click **Update**. It takes effect immediately and the QR stays the same.

Or from the CLI:

```sh
npx wrangler d1 execute wss-qr-tracker-db --remote --command \
  "UPDATE links SET destination='https://new.example.com/', updated_at=datetime('now') WHERE slug='wss'"
```

## Add a new link

Use the **Create a new link** form at the bottom of `/admin` (slug, label, destination), then click **Download QR (PNG)** on the new card.

## Custom domain

The QR encodes the host you open `/admin` on, so **set up a custom domain before printing QR codes**. In the Cloudflare dashboard, go to Workers & Pages → `wss-qr-tracker` → Settings → Domains & Routes → Add → Custom domain (the domain must be on Cloudflare DNS). Then open `/admin` on that domain and download the QRs again. You can also pin the QR host by setting `PUBLIC_BASE_URL` under `[vars]` in `wrangler.toml`.

## Data

- `links(slug, label, destination, created_at, updated_at)`
- `scans(id, ts, slug, visitor_hash, user_agent, referer, is_bot)`, where `ts` is UTC `YYYY-MM-DD HH:MM:SS`

Migrations are in `migrations/`. `0002_seed.sql` seeds the `wss`, `wss-insta`, `wss-whatsapp` and `wss-poster` links.
