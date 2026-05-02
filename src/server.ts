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

function renderLandingPage(
  publicCalendars: CalendarConfig[],
  origin: string,
): string {
  const httpsOrigin = origin.replace(/^http:/, 'https:');
  const webcalOrigin = origin.replace(/^https?:/, 'webcal:');

  const calendarBlocks = publicCalendars
    .map((cal) => {
      const name = escapeHtml(cal.name ?? cal.slug);
      const slug = escapeHtml(cal.slug);
      const description = cal.description
        ? `<p class="desc">${escapeHtml(cal.description)}</p>`
        : '';
      const httpsUrl = `${httpsOrigin}/${slug}.ics`;
      const webcalUrl = `${webcalOrigin}/${slug}.ics`;
      return `
    <div class="cal">
      <h2>${name}</h2>
      ${description}
      <p><strong>Subscribe:</strong> <a href="${webcalUrl}">${webcalUrl}</a></p>
      <p><strong>Direct URL:</strong> <code>${httpsUrl}</code></p>
    </div>`;
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
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; max-width: 720px; margin: 2rem auto; padding: 0 1rem; color: #222; }
    h1 { margin-bottom: 0.25rem; }
    .sub { color: #666; margin-top: 0; }
    .cal { border: 1px solid #ddd; border-radius: 8px; padding: 1rem 1.25rem; margin-bottom: 1rem; }
    .cal h2 { margin-top: 0; }
    .desc { color: #555; }
    code { background: #f4f4f4; padding: 0.1rem 0.4rem; border-radius: 3px; font-size: 0.9em; word-break: break-all; }
    a { color: #0366d6; text-decoration: none; word-break: break-all; }
    a:hover { text-decoration: underline; }
    .empty { color: #888; font-style: italic; }
    footer { margin-top: 3rem; color: #888; font-size: 0.85em; }
  </style>
</head>
<body>
  <h1>notion-ical-bridge</h1>
  <p class="sub">Subscribe to Notion databases as calendar feeds.</p>
${body}
  <footer>Self-hosted · <a href="https://github.com/Afro666/notion-ical-bridge">source</a></footer>
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
    return renderLandingPage(publicCalendars, getRequestOrigin(req));
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
