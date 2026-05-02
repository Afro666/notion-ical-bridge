# Security Policy

Thanks for helping keep `notion-ical-bridge` and its users safe.

## Supported versions

Only the latest tagged release on `main` receives security fixes. Older versions are not patched — please upgrade.

| Version | Supported |
|---------|-----------|
| Latest `1.x` release | Yes |
| Anything older | No |

## Reporting a vulnerability

**Please do not open a public GitHub issue or PR for security problems.** Public reports leak the vulnerability to anyone scraping the repo.

Use one of these private channels instead:

1. **Preferred:** GitHub's [private vulnerability reporting](https://github.com/Afro666/notion-ical-bridge/security/advisories/new) — opens a private advisory thread.
2. **Backup:** email **aronwojciechowicz0603@gmail.com** with subject line `notion-ical-bridge security: <short summary>`.

Include:

- A description of the vulnerability and the impact you believe it has.
- Steps to reproduce (a minimal `config.yaml` snippet — redacted of real tokens — and the request that triggers the bug).
- The version affected (commit hash or release tag).
- Whether you'd like to be credited in the fix's release notes.

## What to expect

- **Acknowledgement:** within 72 hours.
- **Triage and severity assessment:** within 7 days.
- **Fix or mitigation plan:** within 30 days for high/critical issues; lower-severity issues may take longer.
- **Coordinated disclosure:** by default we hold disclosure until a patched release is tagged. We're happy to discuss a different timeline if you have one in mind.

This is a hobby/homelab project maintained in spare time, so timelines are best-effort, not contractual.

## Scope

In scope — please report:

- Token leakage (in logs, error responses, the landing page, or HTTP headers).
- Authentication bypass on token-protected feeds.
- Timing or side-channel attacks against the token comparison.
- Injection into iCal output (calendar-client RCE/XSS via crafted Notion content).
- XSS or HTML injection on the landing page.
- SSRF or path traversal in the request handling.
- Cache poisoning that could let one user serve another's feed.
- Denial-of-service that a small request can trigger (e.g., unbounded memory growth).

Out of scope — please don't report:

- Misconfigured deployments (open ports, missing TLS, weak tokens, etc.) — that's the operator's responsibility.
- Bugs in upstream dependencies (file those upstream — `@notionhq/client`, `fastify`, etc.).
- Notion API behavior, including data leaks caused by oversharing a database with the integration.
- Calendar-client bugs (Apple/Google/Outlook quirks).
- Issues that require already having the operator's `NOTION_TOKEN` or shell access to the host.

## Security practices in this codebase

For context when reviewing:

- Tokens are compared with `crypto.timingSafeEqual` in `src/server.ts`, with fold-on-mismatch to avoid leaking position-of-first-difference.
- Notion errors never propagate to the response body — they log scoped `{ slug, message }` and return a generic `503 Service Unavailable`.
- The landing page HTML-escapes calendar metadata to prevent XSS via Notion-controlled fields.
- The Docker image runs as the unprivileged `node` user (UID 1000); no `root` runtime.
- `.env` and `config.yaml` are gitignored and never baked into the image.
