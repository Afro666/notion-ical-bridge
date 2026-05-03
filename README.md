# notion-ical-bridge

Self-hosted HTTP server that turns Notion databases into iCal (`.ics`) feeds. Subscribe from any calendar app — Google, Apple, Outlook, Fantastical — and get one-way, read-only views of your Notion data on every device.

## What it does

- Serves any Notion database as a subscribable `.ics` feed at `/<slug>.ics`
- Multiple calendars per server, configured via `config.yaml`
- In-memory caching with a single-flight guard so a polling burst can't trip Notion's rate limit
- Stale-cache fallback: subscribers keep seeing your last good feed during a Notion outage
- Stable event UIDs (events update in place, never duplicate)
- All-day vs timed event detection, multi-day date ranges, DST-safe
- Optional per-calendar token auth for private feeds (`/<slug>-<token>.ics`)
- Docker-first deployment, designed to run behind Cloudflare Tunnel

## What it does NOT do

- **No two-way sync.** This is one-way: Notion → calendar. Edit events in Notion.
- **Not real-time.** Calendar apps refresh subscribed feeds on their own schedule (typically every 8–24 hours). That's the iCalendar protocol, not a bug here.
- **No write access.** This server only reads from Notion.

## Quickstart

```bash
git clone https://github.com/Afro666/notion-ical-bridge.git
cd notion-ical-bridge

cp .env.example .env                  # then edit .env: paste your NOTION_TOKEN
cp config.example.yaml config.yaml    # then edit config.yaml: your DB IDs + property names

docker compose up -d
```

Visit `http://localhost:3000` — calendars marked `public: true` are listed there with subscribe links. `http://localhost:3000/healthz` returns `ok` once the server is ready.

## Configuration

### 1. Create a Notion integration

1. Go to https://www.notion.com/my-integrations and create an internal integration. Give it a name like `notion-ical-bridge`.
2. Copy the secret token (`secret_…` or `ntn_…`) into your `.env` as `NOTION_TOKEN`.
3. Open each Notion database you want to expose, click **`···`** → **Connections** → add your integration. Without this the integration cannot read the database.

### 2. Find each database ID

Open the database as a full page; the URL is `https://notion.so/<workspace>/<DATABASE_ID>?v=…`. The 32-character chunk before `?v=` is the database ID. Notion sometimes renders it as a dashed UUID (`xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`) — both forms work; paste whichever Notion gives you.

### 3. Edit `config.yaml`

[`config.example.yaml`](./config.example.yaml) ships three patterns: a public unprotected calendar, a token-protected one, and one using a per-calendar Notion integration via `${NOTION_TOKEN_NAME}` environment variable references. Every field is documented inline.

Required per calendar:

| Field | Notes |
| --- | --- |
| `slug` | URL segment, must match `/^[a-z0-9-]+$/` |
| `databaseId` | Notion database ID |
| `dateProperty` | Name of the **Date** property in your Notion DB |
| `titleProperty` | Name of the **Title** property in your Notion DB |
| `timezone` | IANA TZ (e.g. `Europe/Amsterdam`); inherited from `defaults.timezone` if absent |

Optional: `name`, `description`, `public`, `locationProperty`, `descriptionProperty`, `urlProperty`, `filter`, `accessToken`, `tokens`, `cacheTtlSeconds`.

The schema is validated on startup with Zod — any error fails fast and points at the offending field.

### Branding (optional)

The landing page has a HUUB-inspired teal palette by default. Two top-level optional fields in `config.yaml` let you override:

| Field | Notes |
| --- | --- |
| `brandColor` | 6-digit hex (e.g. `'#0ca2af'`). Default lives in `DEFAULT_BRAND_COLOR` in `src/server.ts` (currently a HUUB-inspired teal). Drives the page background, primary buttons, and the mobile browser's `theme-color`. |
| `logoUrl` | Any `http://` or `https://` URL. Renders an `<img>` next to the heading. Bring your own asset (CDN, your own static host, etc.) — the bridge does not host images. |

Both are optional; omit them for the default look. The page is mobile-first and offers per-calendar one-tap subscribe buttons for iPhone / Mac / Outlook (`webcal://`) and Google Calendar (deep-link), plus a tap-to-select direct URL for everything else.

### 4. Environment variables

[`.env.example`](./.env.example) lists everything. The essentials:

| Var | Default | Purpose |
| --- | --- | --- |
| `NOTION_TOKEN` | — | Default Notion integration token; per-calendar `accessToken` overrides it |
| `HOST` | `0.0.0.0` | Bind address (use `0.0.0.0` inside Docker) |
| `PORT` | `3000` | HTTP port |
| `LOG_LEVEL` | `info` | `trace` / `debug` / `info` / `warn` / `error` / `fatal` / `silent` |
| `CONFIG_PATH` | `./config.yaml` | Path to your calendar config |

## Subscribing from calendar apps

Replace `https://your-host` with wherever the bridge is reachable.

- **Apple Calendar (macOS/iOS)** — File → New Calendar Subscription → `webcal://your-host/<slug>.ics`
- **Google Calendar** — Settings → Add calendar → From URL → `https://your-host/<slug>.ics`
- **Outlook (web)** — Calendar → Add calendar → Subscribe from web → paste the `https://` URL
- **Fantastical / Thunderbird / etc.** — Use the `webcal://` URL where supported, otherwise the `https://` URL

Token-protected calendars use the URL `https://your-host/<slug>-<token>.ics`. Anyone without a valid token gets `404` — not `401` — so the calendar's existence is invisible to probes.

## Deploying behind Cloudflare Tunnel

The intended deployment is a homelab box exposed through `cloudflared`:

1. `docker compose up -d` on the homelab host.
2. Create a Cloudflare Tunnel that maps a hostname (e.g. `cal.example.com`) to `http://localhost:3000`.
3. Subscribers use `https://cal.example.com/<slug>.ics`.

This avoids opening any inbound port on the homelab and gets you HTTPS for free. `Cache-Control` headers are set per-calendar so Cloudflare can cache subsequent fetches between subscriber polls.

## Operational notes

- **Caching.** Each calendar has an independent TTL (`cacheTtlSeconds`, default 300). When N subscribers hit a stale cache simultaneously, only one request is sent upstream — the rest wait on the in-flight promise. Without that, a polling burst at the TTL boundary would exhaust Notion's per-integration rate limit and 503 every subscriber.
- **Stale fallback.** If Notion fails AND we have a previously-cached body, the bridge serves it with `X-Cache: stale` and a short `Cache-Control: max-age=30`. A 503 only happens when there's no cached body to fall back on.
- **Logs.** Successful requests are not logged (per-subscriber tokens would land in stdout). Notion fetch failures, missing client wiring, and ical-build errors are logged with structured fields (`{ slug, message, … }`); never the token.
- **Secrets in URLs.** Tokens appear in subscriber URLs by necessity (calendar apps can't add headers). Treat each token as a long-lived bearer credential: generate them with `openssl rand -hex 24`, share over a secure channel, and remove from `tokens:` to revoke.

## Known v1 limitations

- The landing page derives subscribe URLs from the request's `Host` header. If the bridge is reached via an unexpected hostname, the landing page will display URLs for that hostname. For homelab-via-Cloudflare-Tunnel deployments this is fine — you control the hostname.
- Tokens are validated via constant-time comparison, but token *length* is leaked. Use long random tokens (≥ 24 bytes of entropy) and length leaks become irrelevant.
- No on-disk persistence: a process restart drops the cache. Subscribers will see the next refresh take a few hundred ms longer than usual.

## Development

```bash
pnpm install
pnpm test          # unit tests; no live Notion calls needed
pnpm typecheck
pnpm build
pnpm dev           # tsx watch mode against ./config.yaml
```

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the git-flow + PR process.

## Tech stack

TypeScript · Node.js 22 · Fastify · @notionhq/client · ical-generator · Zod · Vitest · pnpm · Docker

## License

[MIT](./LICENSE) — fork, modify, deploy, sell. Just keep the copyright.
