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

export interface ServerDeps {
  config: Config;
  // Map keyed by calendar slug. index.ts pre-resolves auth tokens at startup
  // so the server itself never sees a raw Notion token.
  notionClients: Map<string, NotionQueryClient>;
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

export function createServer(deps: ServerDeps): FastifyInstance {
  const app = Fastify({
    logger: deps.logger ?? false,
  });

  const calendarsBySlug = new Map(
    deps.config.calendars.map((c) => [c.slug, c] as const),
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
      const { filename } = req.params;
      if (!filename.endsWith('.ics')) {
        reply.code(404);
        return 'Not Found';
      }
      const slug = filename.slice(0, -'.ics'.length);
      const calendar = calendarsBySlug.get(slug);
      if (!calendar) {
        reply.code(404);
        return 'Not Found';
      }

      let events = cache.get(slug);
      if (events === undefined) {
        const client = deps.notionClients.get(slug);
        if (!client) {
          // Configuration bug: calendar exists but no Notion client wired.
          // Treat as 503 rather than crashing the request.
          req.log.error({ slug }, 'No Notion client registered for calendar');
          reply.code(503);
          return 'Service Unavailable';
        }

        let pending = inFlight.get(slug);
        if (pending === undefined) {
          pending = (async () => {
            try {
              const result = await fetchEvents(client, calendar);
              cache.set(slug, result, calendar.cacheTtlSeconds);
              return result;
            } finally {
              inFlight.delete(slug);
            }
          })();
          inFlight.set(slug, pending);
        }

        try {
          events = await pending;
        } catch (err) {
          // Never leak the underlying error to clients — it could include
          // token fragments or request bodies depending on the SDK. Pino is
          // also passed only scoped fields rather than the raw error tree.
          req.log.error(
            {
              slug,
              message: err instanceof Error ? err.message : String(err),
            },
            'Failed to fetch events from Notion',
          );
          reply.code(503);
          return 'Service Unavailable';
        }
      }

      const ics = buildIcalFeed(events, calendar);
      reply.type('text/calendar; charset=utf-8');
      reply.header('Cache-Control', `public, max-age=${calendar.cacheTtlSeconds}`);
      return ics;
    },
  );

  return app;
}
