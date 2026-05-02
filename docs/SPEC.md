# notion-ical-bridge — Specification

This is the canonical design document for `notion-ical-bridge`. It describes
what the system does, the request lifecycle, the configuration contract, and
the design decisions that are intentionally baked in and not up for debate
without a corresponding spec change.

For a user-facing setup guide, see [README.md](../README.md). For contribution
mechanics, see [CONTRIBUTING.md](../CONTRIBUTING.md).

## 1. Purpose and scope

A self-hosted HTTP server that exposes one or more Notion databases as iCal
(`.ics`) feeds suitable for subscription from any RFC 5545-compliant calendar
client (Apple Calendar, Google Calendar, Outlook, Fantastical, Thunderbird).

### In scope

- Read-only, one-way translation: Notion → iCal.
- Multiple calendars per server instance, each backed by a distinct Notion
  database (or the same database with a different filter).
- Configuration via a single YAML file plus environment variables for secrets.
- In-memory caching with single-flight coalescing and stale-cache fallback.
- Optional per-calendar token authentication.
- Containerized deployment as the primary distribution channel.

### Out of scope

- Two-way sync. Edits made in a calendar client never propagate back to Notion.
- Real-time push. Calendar clients re-fetch on their own schedules
  (typically 8–24 hours), and that latency is part of the iCalendar protocol,
  not a defect.
- Per-user authentication or multi-tenant identity. The deployment model is
  "one operator, N feeds." Per-feed tokens are an access-control coarse knob,
  not user identity.
- Notion API write operations.

## 2. Architecture

```
+-------------+        +--------------+         +-------------+
|  Calendar   |  GET   |  Fastify     |  query  |   Notion    |
|   client    |------->|  server.ts   |-------->|     API     |
| (RFC 5545)  |  /ics  |              |         |             |
+-------------+        |  cache.ts    |<--------|             |
                       |  ical.ts     | events  +-------------+
                       |  notion.ts   |
                       +--------------+
```

| Module | Responsibility |
|--------|----------------|
| [src/index.ts](../src/index.ts) | Entrypoint. Loads config, resolves Notion data-source IDs at startup, constructs the Fastify app, binds the listener. |
| [src/config.ts](../src/config.ts) | YAML loader + Zod schema. Validates calendar definitions, env-var interpolation, and slug shape. Fails fast on any invalid input. |
| [src/notion.ts](../src/notion.ts) | Notion API client wrapper. Resolves data-source IDs, queries pages, extracts properties into a normalized `CalendarEvent` shape. |
| [src/ical.ts](../src/ical.ts) | RFC 5545 builder. Maps `CalendarEvent` to iCal `VEVENT` blocks, with all-day vs timed event handling. |
| [src/cache.ts](../src/cache.ts) | TTL cache with stale-on-failure semantics. Coalesces concurrent misses via a per-slug single-flight map. |
| [src/server.ts](../src/server.ts) | Fastify routes, token auth, landing page rendering, caching glue, error response shaping. |

### 2.1 Request lifecycle for `GET /:slug.ics`

1. Parse the URL — the route accepts both `/<slug>.ics` and `/<slug>-<token>.ics`.
2. Look up the slug in the resolved-calendars map. Unknown slug → `404`.
3. If the calendar has `tokens` configured, compare the supplied token against
   each configured token using `crypto.timingSafeEqual` with fold-on-mismatch.
   Failure → `401`.
4. Cache lookup keyed by **slug only** (not by token). Hit → serve the cached
   bytes with `Cache-Control: public, max-age=<ttl>`.
5. Cache miss → enter single-flight: if another request for the same slug is
   already querying Notion, await its promise. Otherwise, call
   `fetchEvents(client, calendar, dataSourceId)`, build the iCal output, and
   store the result in the cache.
6. Notion failure → if a stale cached entry exists, serve it. Otherwise, log a
   scoped `{ slug, message }` and return `503 Service Unavailable` with a
   generic body. **The Notion error message is never echoed to the client.**

### 2.2 Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/:slug.ics` | iCal feed for a calendar without token auth. |
| `GET` | `/:slug-:token.ics` | iCal feed for a token-protected calendar. |
| `GET` | `/healthz` | Returns `200 OK` with body `ok` once the server is ready to serve. Used by Docker `HEALTHCHECK` and reverse proxies. |
| `GET` | `/` | Minimal HTML landing page listing calendars marked `public: true`, with copy-paste subscribe URLs (`webcal://` and `https://`). |

## 3. Configuration

### 3.1 File layout

Two files compose the deployable configuration:

- `config.yaml` — calendar definitions. Mounted into the container.
- `.env` — secrets only. Currently `NOTION_TOKEN`, `LOG_LEVEL`, `PORT`, `HOST`.

`.env` interpolation: any `${ENV_VAR_NAME}` token in `config.yaml` is replaced
at load time with the corresponding environment variable. Variable names must
match `^[A-Z_][A-Z0-9_]*$`; mixed-case names raise a `ConfigValidationError`
at startup.

### 3.2 Calendar schema

Each entry under `calendars:` accepts these fields. Defined in
[src/config.ts](../src/config.ts).

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `slug` | string | Yes | URL path segment. Must match `^[a-z0-9-]+$`. |
| `databaseId` | string | Yes | Notion database ID (32-char hex, with or without dashes). |
| `name` | string | No | Display name on the landing page and in `X-WR-CALNAME`. |
| `description` | string | No | Calendar description; emitted as `X-WR-CALDESC`. |
| `timezone` | string | No | IANA timezone for timed events; emitted as `X-WR-TIMEZONE`. |
| `public` | bool | No (default `false`) | Whether the calendar appears on the landing page. |
| `dateProperty` | string | Yes | Name of the Notion `date` property holding the event date. |
| `titleProperty` | string | Yes | Name of the Notion `title` property. |
| `locationProperty` | string | No | Maps to `LOCATION`. |
| `descriptionProperty` | string | No | Maps to `DESCRIPTION`. |
| `urlProperty` | string | No | Maps to `URL`. |
| `filter` | object | No | Passed through verbatim to `dataSources.query` as the `filter` argument. |
| `accessToken` | string | No | Per-calendar Notion token override. Falls back to `${NOTION_TOKEN}`. |
| `tokens` | string[] | No | Access tokens accepted on the URL. Empty array is rejected — either omit the field (public) or supply at least one non-empty token. |
| `cacheTtlSeconds` | int > 0 | No | Per-calendar override of the global default (300 s). |

A `defaults:` block at the top of the file may set `timezone` and
`cacheTtlSeconds`; per-calendar values override.

## 4. Notion → iCal mapping

### 4.1 Date semantics

Notion exposes dates as ISO-8601 strings. The bridge classifies events by
inspecting the raw `start` value:

| Notion `start` shape | Classified as | Examples |
|----------------------|---------------|----------|
| `YYYY-MM-DD` (no `T`) | All-day | `2026-05-03` |
| `YYYY-MM-DDTHH:MM:SS[Z|±hh:mm]` | Timed | `2026-05-03T14:30:00+02:00` |

`CalendarEvent.start` and `CalendarEvent.end` preserve the **raw Notion
strings**; an `isAllDay: boolean` discriminator is set at extraction time.
The iCal builder branches on `isAllDay` to choose between `DATE` and
`DATE-TIME` value-types.

### 4.2 All-day anchoring

All-day dates are anchored to **UTC midnight** (`T00:00:00Z`). This is the
only timezone-agnostic anchor: UTC arithmetic guarantees exactly 24 hours
between successive UTC midnights, which keeps multi-day all-day spans
reproducible across DST transitions and host-timezone changes.

### 4.3 Date ranges

| Notion `start` | Notion `end` | Emitted as |
|----------------|--------------|------------|
| Set | Unset, all-day | Single all-day `VEVENT` (`DTSTART;VALUE=DATE`, `DTEND` = next UTC midnight). |
| Set | Set, all-day | Multi-day all-day `VEVENT` (`DTEND` = day after the last day, per RFC 5545). |
| Set | Unset, timed | `VEVENT` from `DTSTART` to `DTSTART + 1 hour`. |
| Set | Set, timed | `VEVENT` from `DTSTART` to the supplied `DTEND`. |

### 4.4 Stable UIDs

`UID` = the raw Notion page ID (UUID, no `@domain` suffix). Notion page IDs
are globally unique on their own, so calendar clients reliably update events
in place rather than duplicating them when titles or times change.

## 5. Caching, single-flight, and stale fallback

- **Cache key:** the slug only. Tokens are validated *before* the cache
  lookup; multiple valid tokens for the same slug share the same cached body.
- **TTL:** per-calendar `cacheTtlSeconds`, default 300.
- **Single-flight:** an `inFlight: Map<slug, Promise<events>>` coalesces
  concurrent cache misses. This protects against bursty calendar-client
  polling and keeps Notion's 3 req/s rate limit from being tripped.
- **Stale fallback:** if Notion fails *and* the cache holds a stale entry,
  the stale bytes are served. This trades freshness for availability during
  Notion incidents, which calendar subscribers prefer overwhelmingly.
- **Cache headers:** `Cache-Control: public, max-age=<ttl>` so HTTP
  intermediaries (including Cloudflare) respect the same TTL.

## 6. Security model

### 6.1 Threats considered

| Threat | Mitigation |
|--------|------------|
| Token leakage in error responses | Notion errors never leak to the response body; only a generic `503` is returned. |
| Token leakage in logs | Per-request logs are scoped to `{ slug, message }`. The token is never logged. |
| Timing attack against token comparison | `crypto.timingSafeEqual` with fold-on-mismatch (constant-time over the entire token list, not just the one matching position). |
| XSS on the landing page | All Notion-controlled metadata is HTML-escaped before rendering. |
| Calendar-client RCE/XSS via crafted Notion content | iCal output is character-escaped per RFC 5545; properties are not interpolated into raw output. |
| Image baking secrets | `.env`, `config.yaml`, `node_modules`, `dist`, and `test` are excluded by `.dockerignore`. The runtime stage copies only built `dist`, prod-pruned `node_modules`, and `package.json`. |
| Container privilege escalation | Image runs as the unprivileged `node` user (UID 1000) via `USER node` and `--chown=node:node` on copied files. |

### 6.2 Threats not handled

- TLS termination — assumed delegated to the reverse proxy (typically
  Cloudflare Tunnel in the documented deployment model).
- Brute-force token guessing — there is no rate limiter. Tokens are expected
  to be high-entropy (>= 32 random bytes); operators should rotate periodically.
- Misconfigured Notion integrations sharing private databases — out of scope.
  The integration's database access list is the source of truth for what
  the bridge can read.

## 7. Coupling to `@notionhq/client`

The Notion SDK is a sharp dependency: it changed its method surface between
v4 (`databases.query`) and v5 (`dataSources.query`) without a major bump in
the way most projects pin minors. Internally we type the SDK client through
a hand-rolled `NotionQueryClient` subset interface to keep test stubs
inexpensive, but **a structural conformance test pins us to the real SDK**:

```ts
// test/notion.types.test.ts
const _conformance = (c: Client): NotionQueryClient => c;
```

If a future SDK release renames or removes a method we depend on, the
conformance test fails to type-check at build time, not at production
smoke time. Filter argument types are derived directly from the SDK via
`Parameters<Client['dataSources']['query']>[0]['filter']` rather than
re-typed by hand, so they cannot drift.

This decision is the direct consequence of an incident in pre-1.0
development where 130 unit tests passed against a hand-rolled stub while
production returned 503 because `client.databases.query` no longer
existed. We don't relitigate the conformance pattern.

## 8. Deployment

- Primary distribution: Docker image, multi-stage build on `node:22-alpine`,
  ~259 MB, runs as UID 1000.
- Reverse proxy expected; Cloudflare Tunnel is the documented homelab path.
- Health endpoint: `GET /healthz` returns `200 ok` and is wired into the
  Dockerfile `HEALTHCHECK` directive.
- Logging: Fastify's pino logger; structured JSON in production
  (`NODE_ENV=production`). Level controlled via `LOG_LEVEL` env var,
  validated at startup against pino's known levels.

## 9. Versioning

Semantic Versioning. The public contracts subject to SemVer guarantees are:

- The YAML config schema (any breaking change to required fields, accepted
  types, or default behavior is a major version bump).
- The URL routes (`/:slug.ics`, `/:slug-:token.ics`, `/healthz`, `/`).
- The iCal output mapping (any change in how a given Notion DB row is
  serialized is at least a minor bump and must be called out in release
  notes).

Internal module boundaries (the `src/notion.ts` interface, cache internals,
log format) are not part of the public contract.
