import { Buffer } from 'node:buffer';
import { timingSafeEqual } from 'node:crypto';
import Fastify, {
  type FastifyInstance,
  type FastifyLoggerOptions,
  type FastifyReply,
  type FastifyRequest,
} from 'fastify';
import type { CalendarConfig, Config } from './config.js';
import {
  fetchEvents,
  type CalendarEvent,
  type NotionQueryClient,
} from './notion.js';
import { buildIcalFeed } from './ical.js';
import { TTLCache } from './cache.js';

export interface ResolvedCalendar {
  client: NotionQueryClient;
  dataSourceId: string;
}

export interface ServerDeps {
  config: Config;
  // Map keyed by calendar slug. index.ts pre-resolves auth tokens at startup
  // so the server itself never sees a raw Notion token.
  resolvedCalendars: Map<string, ResolvedCalendar>;
  logger?: boolean | FastifyLoggerOptions;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function getRequestOrigin(request: FastifyRequest): string {
  const forwardedProto = request.headers['x-forwarded-proto'];
  const proto =
    typeof forwardedProto === 'string' && forwardedProto.length > 0
      ? forwardedProto.split(',')[0]!.trim()
      : request.protocol;
  const host = request.headers.host ?? request.hostname;
  return `${proto}://${host}`;
}

const DEFAULT_BRAND_COLOR = '#0ca2af';

interface LandingBranding {
  brandColor?: string;
  logoUrl?: string;
}

function renderLandingPage(
  publicCalendars: CalendarConfig[],
  origin: string,
  branding: LandingBranding = {},
): string {
  const httpsOrigin = origin.replace(/^http:/, 'https:');
  const webcalOrigin = origin.replace(/^https?:/, 'webcal:');
  // Defense-in-depth: Zod validates brandColor and logoUrl at config load,
  // but escapeHtml here protects callers that bypass parseConfig (tests,
  // dev tooling). brandColor lands in <style>; logoUrl in <img src>.
  const brandColor = escapeHtml(branding.brandColor ?? DEFAULT_BRAND_COLOR);
  const logoTag = branding.logoUrl
    ? `<img src="${escapeHtml(branding.logoUrl)}" alt="" class="logo">`
    : '';

  const calendarBlocks = publicCalendars
    .map((cal) => {
      const name = escapeHtml(cal.name ?? cal.slug);
      const slug = escapeHtml(cal.slug);
      const description = cal.description
        ? `<p class="desc">${escapeHtml(cal.description)}</p>`
        : '';
      const httpsUrl = `${httpsOrigin}/${slug}.ics`;
      const webcalUrl = `${webcalOrigin}/${slug}.ics`;
      // Google Calendar's "add by URL" deep link. On Android Chrome it opens
      // the Google Calendar add-by-URL flow directly; on desktop it opens
      // calendar.google.com to the same page. Saves users from "copy URL,
      // open settings, paste" — a real friction point on phones.
      const gcalUrl = `https://calendar.google.com/calendar/r/settings/addbyurl?cid=${encodeURIComponent(httpsUrl)}`;
      return `
    <article class="cal">
      <h2>${name}</h2>
      ${description}
      <div class="actions">
        <a class="btn btn-primary" href="${webcalUrl}">Subscribe (iPhone, Mac, Outlook)</a>
        <a class="btn btn-secondary" href="${gcalUrl}">Add to Google Calendar</a>
      </div>
      <p class="url-label">Or copy the direct URL (Outlook web, Thunderbird, Fantastical):</p>
      <input class="url-input" type="text" readonly value="${httpsUrl}" aria-label="Direct calendar URL for ${name}">
    </article>`;
    })
    .join('');

  const body =
    publicCalendars.length === 0
      ? '<p class="empty">No public calendars are configured on this server.</p>'
      : calendarBlocks;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>notion-ical-bridge</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" content="${brandColor}">
  <style>
    :root { --brand: ${brandColor}; --accent: #f2a829; }
    *, *::before, *::after { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; }
    body {
      background: var(--brand);
      color: #fff;
      font-family: 'Montserrat', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
      min-height: 100vh;
      padding: 1.5rem 1rem 3rem;
      line-height: 1.5;
      -webkit-font-smoothing: antialiased;
    }
    .wrap { max-width: 760px; margin: 0 auto; }
    .header { display: flex; align-items: center; gap: 1rem; margin-bottom: 0.25rem; flex-wrap: wrap; }
    .logo { height: 2.75rem; width: auto; flex-shrink: 0; }
    h1 {
      font-size: clamp(1.75rem, 6vw, 2.5rem);
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      margin: 0;
      color: #fff;
    }
    .sub {
      font-size: 1rem;
      color: rgba(255,255,255,0.85);
      margin: 0.25rem 0 1.75rem;
    }
    .cal {
      background: #fff;
      color: #1f1f22;
      border-radius: 14px;
      padding: 1.25rem 1.25rem 1rem;
      margin-bottom: 1.25rem;
      box-shadow: 0 6px 20px rgba(0,0,0,0.18);
    }
    .cal h2 {
      font-size: 1.25rem;
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: 0.03em;
      margin: 0 0 0.5rem;
      color: #353740;
    }
    .desc { color: #565552; margin: 0 0 1rem; }
    .actions {
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
      margin: 0 0 1rem;
    }
    .btn {
      display: block;
      text-align: center;
      padding: 0.85rem 1rem;
      min-height: 44px;
      border-radius: 10px;
      text-decoration: none;
      font-weight: 700;
      font-size: 0.95rem;
      letter-spacing: 0.02em;
      word-break: break-word;
    }
    .btn-primary { background: var(--brand); color: #fff; }
    .btn-secondary { background: var(--accent); color: #1f1f22; }
    .btn:hover { filter: brightness(1.08); }
    .btn:active { filter: brightness(0.94); }
    .url-label { font-size: 0.85rem; color: #565552; margin: 0 0 0.4rem; }
    .url-input {
      width: 100%;
      padding: 0.75rem 0.85rem;
      min-height: 44px;
      border: 1px solid #cfd3d3;
      border-radius: 8px;
      background: #f7f7f7;
      color: #1f1f22;
      font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
      font-size: 0.9rem;
    }
    .empty {
      background: rgba(255,255,255,0.12);
      border-radius: 14px;
      padding: 2rem 1.25rem;
      color: rgba(255,255,255,0.92);
      text-align: center;
      font-style: italic;
    }
    footer {
      color: rgba(255,255,255,0.75);
      font-size: 0.85rem;
      margin-top: 2rem;
      text-align: center;
    }
    footer a { color: rgba(255,255,255,0.95); text-decoration: underline; }
    /* Tablet+: lay subscribe buttons side-by-side, give more page padding. */
    @media (min-width: 600px) {
      body { padding: 3rem 1.5rem 4rem; }
      .actions { flex-direction: row; flex-wrap: wrap; }
      .btn { flex: 1 1 200px; }
    }
  </style>
</head>
<body>
  <div class="wrap">
    <header class="header">
      ${logoTag}
      <h1>notion-ical-bridge</h1>
    </header>
    <p class="sub">Subscribe to Notion databases as calendar feeds.</p>
${body}
    <footer>Self-hosted · <a href="https://github.com/Afro666/notion-ical-bridge">source</a></footer>
  </div>
</body>
</html>
`;
}

interface SlugRouteParams {
  filename: string;
}

// Cache-Control max-age served alongside a stale fallback body. We don't want
// clients to lock onto a stale response for the calendar's full TTL — pick a
// short value so a successful refresh on the next poll wins quickly.
const STALE_CACHE_MAX_AGE_SECONDS = 30;

interface ResolvedRoute {
  slug: string;
  token?: string;
}

// Constant-time membership check: avoid leaking which token a request was
// closest to via response-latency timing. The length pre-check leaks token
// LENGTH (not value), which is acceptable for high-entropy random tokens.
function tokenMatches(candidate: string, allowed: readonly string[]): boolean {
  const candidateBuf = Buffer.from(candidate);
  // Reduce-style fold so we check every entry instead of short-circuiting,
  // which would itself be a (weaker) timing oracle on list position.
  let matched = false;
  for (const t of allowed) {
    const tBuf = Buffer.from(t);
    if (
      candidateBuf.length === tBuf.length &&
      timingSafeEqual(candidateBuf, tBuf)
    ) {
      matched = true;
    }
  }
  return matched;
}

function resolveRoute(
  filename: string,
  slugsByLengthDesc: readonly string[],
): ResolvedRoute | undefined {
  if (!filename.endsWith('.ics')) return undefined;
  const base = filename.slice(0, -'.ics'.length);
  // Iterate slugs longest-first so a calendar named `team-alpha` wins over
  // `team` for the URL `/team-alpha.ics` — otherwise the request would be
  // mis-parsed as slug=team, token=alpha.
  for (const slug of slugsByLengthDesc) {
    if (base === slug) return { slug };
    if (base.startsWith(`${slug}-`)) {
      const token = base.slice(slug.length + 1);
      if (token.length > 0) return { slug, token };
    }
  }
  return undefined;
}

export function createServer(deps: ServerDeps): FastifyInstance {
  const app = Fastify({
    logger: deps.logger ?? false,
    // The default Fastify request log echoes req.url at info level, which
    // would write the per-subscriber token to stdout on every request. We
    // emit our own scoped error logs in the handler instead.
    disableRequestLogging: true,
  });

  const calendarsBySlug = new Map(
    deps.config.calendars.map((c) => [c.slug, c] as const),
  );
  const slugsByLengthDesc = [...calendarsBySlug.keys()].sort(
    (a, b) => b.length - a.length,
  );
  const cache = new TTLCache<CalendarEvent[]>();
  // Single-flight: when N concurrent requests miss the cache for the same
  // slug, only the first hits Notion; the rest await the in-flight promise.
  // Without this, a polling burst at the TTL boundary would trip Notion's
  // 3 req/s rate limit and 503 every subscriber.
  const inFlight = new Map<string, Promise<CalendarEvent[]>>();

  app.get('/healthz', async (_req: FastifyRequest, reply: FastifyReply) => {
    reply.type('text/plain; charset=utf-8');
    return 'ok';
  });

  app.get('/', async (req: FastifyRequest, reply: FastifyReply) => {
    const publicCalendars = deps.config.calendars.filter((c) => c.public);
    reply.type('text/html; charset=utf-8');
    return renderLandingPage(publicCalendars, getRequestOrigin(req), {
      brandColor: deps.config.brandColor,
      logoUrl: deps.config.logoUrl,
    });
  });

  app.get(
    '/:filename',
    async (
      req: FastifyRequest<{ Params: SlugRouteParams }>,
      reply: FastifyReply,
    ) => {
      const resolved = resolveRoute(req.params.filename, slugsByLengthDesc);
      if (!resolved) {
        reply.code(404);
        return 'Not Found';
      }
      const { slug, token } = resolved;
      const calendar = calendarsBySlug.get(slug);
      if (!calendar) {
        reply.code(404);
        return 'Not Found';
      }

      // Token gate. We never return 401 — that would confirm the calendar
      // exists to anonymous probes. Always 404 on any auth mismatch so that
      // protected calendars are indistinguishable from non-existent ones.
      if (calendar.tokens !== undefined) {
        if (token === undefined || !tokenMatches(token, calendar.tokens)) {
          reply.code(404);
          return 'Not Found';
        }
      } else if (token !== undefined) {
        // Calendar isn't token-protected; a hyphen-suffix request can't be
        // valid for it.
        reply.code(404);
        return 'Not Found';
      }

      let events = cache.get(slug);
      let servedStale = false;
      if (events === undefined) {
        const resolved = deps.resolvedCalendars.get(slug);
        if (!resolved) {
          // Startup wiring bug: calendar parsed from config but never
          // resolved. index.ts builds resolvedCalendars only on success,
          // so this branch is unreachable in normal operation; we still
          // 503 defensively rather than crashing the request.
          req.log.error({ slug }, 'No resolved calendar registered for slug');
          reply.code(503);
          return 'Service Unavailable';
        }
        const { client, dataSourceId } = resolved;

        let pending = inFlight.get(slug);
        if (pending === undefined) {
          // Log inside the IIFE rather than per-waiter so a Notion outage
          // produces ONE log line per upstream call, not one per coalesced
          // subscriber. The error is never leaked to clients — pino is
          // passed only scoped fields rather than the raw error tree.
          pending = (async () => {
            try {
              const result = await fetchEvents(client, calendar, dataSourceId);
              cache.set(slug, result, calendar.cacheTtlSeconds);
              return result;
            } catch (err) {
              req.log.error(
                {
                  slug,
                  message: err instanceof Error ? err.message : String(err),
                },
                'Failed to fetch events from Notion',
              );
              throw err;
            } finally {
              inFlight.delete(slug);
            }
          })();
          inFlight.set(slug, pending);
        }

        try {
          events = await pending;
        } catch {
          // Serve the last good body if we have one, so a transient Notion
          // outage doesn't break every subscriber's calendar at once.
          const stale = cache.getStale(slug);
          if (stale === undefined) {
            reply.code(503);
            return 'Service Unavailable';
          }
          events = stale;
          servedStale = true;
        }
      }

      let ics: string;
      try {
        ics = buildIcalFeed(events, calendar);
      } catch (err) {
        // A stale body containing a malformed date can fail serialization.
        // Without this catch the request would 500 with no slug context,
        // leaving operators blind to which calendar is broken.
        req.log.error(
          {
            slug,
            servedStale,
            eventCount: events.length,
            message: err instanceof Error ? err.message : String(err),
          },
          'Failed to build iCal feed',
        );
        reply.code(500);
        return 'Internal Server Error';
      }
      reply.type('text/calendar; charset=utf-8');
      if (servedStale) {
        reply.header('X-Cache', 'stale');
        reply.header(
          'Cache-Control',
          `public, max-age=${STALE_CACHE_MAX_AGE_SECONDS}`,
        );
      } else {
        reply.header(
          'Cache-Control',
          `public, max-age=${calendar.cacheTtlSeconds}`,
        );
      }
      return ics;
    },
  );

  return app;
}
