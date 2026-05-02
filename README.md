# notion-ical-bridge

Self-hosted HTTP server that exposes Notion databases as iCal (`.ics`) feeds. Subscribe from any calendar app — Google, Apple, Outlook, Fantastical — and get one-way, read-only views of your Notion data on every device.

> **Status: under active development.** v1 is in progress. See [`Initial plan.md`](./Initial%20plan.md) for the full specification and [CONTRIBUTING.md](./CONTRIBUTING.md) for how to help.

## What it does

- Serves any Notion database as a subscribable `.ics` feed at `/<slug>.ics`
- Multiple calendars per server instance, configured via `config.yaml`
- In-memory caching to respect Notion's 3 req/s API limit
- Stable event UIDs (events update in place, never duplicate)
- All-day vs timed event detection, multi-day date ranges
- Optional per-calendar token auth for private feeds
- Docker-first deployment, designed to run behind Cloudflare Tunnel

## What it does NOT do

- **No two-way sync.** This is one-way: Notion → calendar. Edit events in Notion.
- **Not real-time.** Calendar apps refresh subscribed feeds every 8–24 hours by their own schedule. That's normal.
- **No write access.** This server only reads from Notion.

## Quickstart

> Full deploy guide lands in v1 (Phase 7). For now, see [`Initial plan.md`](./Initial%20plan.md) for the planned shape.

```bash
git clone https://github.com/Afro666/notion-ical-bridge.git
cd notion-ical-bridge
cp .env.example .env       # add NOTION_TOKEN
cp config.example.yaml config.yaml
# edit config.yaml with your database IDs and property names
docker compose up -d
```

## Tech stack

TypeScript · Node.js 22 · Fastify · @notionhq/client · ical-generator · Zod · Vitest · pnpm · Docker

## Development

```bash
pnpm install
pnpm test
pnpm dev
```

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the full workflow (git flow, branch naming, PR process).

## License

[MIT](./LICENSE) — fork, modify, deploy, sell. Just keep the copyright.

## Security

Found a security issue? See [SECURITY.md](./SECURITY.md) — please don't open a public issue.
