import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type ResolvedCalendar } from '../src/server.js';
import type { CalendarConfig } from '../src/config.js';
import type {
  NotionQueryClient,
  NotionQueryResponse,
} from '../src/notion.js';

const makeCalendar = (overrides: Partial<CalendarConfig> = {}): CalendarConfig => ({
  slug: 'events',
  databaseId: 'db_test',
  timezone: 'UTC',
  public: false,
  dateProperty: 'Date',
  titleProperty: 'Name',
  cacheTtlSeconds: 300,
  ...overrides,
});

const makeQueryResponse = (results: unknown[]): NotionQueryResponse => ({
  results,
  has_more: false,
  next_cursor: null,
});

const samplePage = (id: string, title: string, start: string) => ({
  id,
  properties: {
    Name: { type: 'title', title: [{ plain_text: title }] },
    Date: { type: 'date', date: { start, end: null, time_zone: null } },
  },
});

function makeStubClient(response: NotionQueryResponse) {
  const query = vi.fn().mockResolvedValue(response);
  const client: NotionQueryClient = {
    databases: { retrieve: vi.fn() },
    dataSources: { query },
  };
  return { client, query };
}

function makeRejectingClient(query: ReturnType<typeof vi.fn>): NotionQueryClient {
  return {
    databases: { retrieve: vi.fn() },
    dataSources: { query },
  };
}

// Synthetic data source ID used by tests; in production index.ts resolves
// the real ID once per slug at startup via Notion's databases.retrieve.
const FAKE_DS_ID = 'ds_test';

function resolvedMap(
  pairs: ReadonlyArray<readonly [string, NotionQueryClient]>,
): Map<string, ResolvedCalendar> {
  return new Map(
    pairs.map(([slug, client]) => [slug, { client, dataSourceId: FAKE_DS_ID }]),
  );
}

describe('createServer - GET /healthz', () => {
  it('returns 200 with body "ok"', async () => {
    const app = createServer({
      config: { calendars: [] },
      resolvedCalendars: new Map(),
    });
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('ok');
  });

  it('takes precedence over the parametric /:filename route even if a calendar is named "healthz"', async () => {
    const app = createServer({
      config: { calendars: [makeCalendar({ slug: 'healthz' })] },
      resolvedCalendars: new Map(),
    });
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('ok');
  });
});

describe('createServer - GET /:slug.ics', () => {
  it('returns 200 with text/calendar content for a known slug', async () => {
    const { client } = makeStubClient(
      makeQueryResponse([samplePage('p1', 'Event A', '2026-05-02')]),
    );
    const calendar = makeCalendar({ slug: 'sisterhood' });
    const app = createServer({
      config: { calendars: [calendar] },
      resolvedCalendars: resolvedMap([['sisterhood', client]]),
    });

    const res = await app.inject({ method: 'GET', url: '/sisterhood.ics' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/calendar/);
    expect(res.body).toContain('BEGIN:VCALENDAR');
    expect(res.body).toContain('UID:p1');
  });

  it('emits Cache-Control header reflecting the calendar TTL', async () => {
    const { client } = makeStubClient(makeQueryResponse([]));
    const calendar = makeCalendar({ slug: 'fast', cacheTtlSeconds: 60 });
    const app = createServer({
      config: { calendars: [calendar] },
      resolvedCalendars: resolvedMap([['fast', client]]),
    });

    const res = await app.inject({ method: 'GET', url: '/fast.ics' });
    expect(res.headers['cache-control']).toBe('public, max-age=60');
  });

  it('returns 404 for an unknown slug', async () => {
    const app = createServer({
      config: { calendars: [makeCalendar({ slug: 'events' })] },
      resolvedCalendars: new Map(),
    });
    const res = await app.inject({ method: 'GET', url: '/nonexistent.ics' });
    expect(res.statusCode).toBe(404);
  });

  it('returns 404 for paths missing the .ics extension', async () => {
    const app = createServer({
      config: { calendars: [makeCalendar({ slug: 'events' })] },
      resolvedCalendars: new Map(),
    });
    const res = await app.inject({ method: 'GET', url: '/events' });
    expect(res.statusCode).toBe(404);
  });

  it('caches the Notion response: second request within TTL does not re-query', async () => {
    const { client, query } = makeStubClient(
      makeQueryResponse([samplePage('p1', 'A', '2026-05-02')]),
    );
    const calendar = makeCalendar({ slug: 'cached', cacheTtlSeconds: 300 });
    const app = createServer({
      config: { calendars: [calendar] },
      resolvedCalendars: resolvedMap([['cached', client]]),
    });

    await app.inject({ method: 'GET', url: '/cached.ics' });
    await app.inject({ method: 'GET', url: '/cached.ics' });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('returns 503 when Notion fails and no cache is available', async () => {
    const query = vi.fn().mockRejectedValue(new Error('Notion API unreachable'));
    const calendar = makeCalendar({ slug: 'failing' });
    const app = createServer({
      config: { calendars: [calendar] },
      resolvedCalendars: resolvedMap([['failing', makeRejectingClient(query)]]),
    });

    const res = await app.inject({ method: 'GET', url: '/failing.ics' });
    expect(res.statusCode).toBe(503);
    expect(res.body).toBe('Service Unavailable');
  });

  it('returns 503 when calendar is configured but no resolved entry is registered', async () => {
    const calendar = makeCalendar({ slug: 'unwired' });
    const app = createServer({
      config: { calendars: [calendar] },
      resolvedCalendars: new Map(),
    });
    const res = await app.inject({ method: 'GET', url: '/unwired.ics' });
    expect(res.statusCode).toBe(503);
    expect(res.body).toBe('Service Unavailable');
  });

  it('coalesces concurrent cache-miss requests into a single Notion query', async () => {
    let resolveQuery!: (response: NotionQueryResponse) => void;
    const pending = new Promise<NotionQueryResponse>((resolve) => {
      resolveQuery = resolve;
    });
    const query = vi.fn().mockReturnValue(pending);
    const calendar = makeCalendar({ slug: 'busy' });
    const app = createServer({
      config: { calendars: [calendar] },
      resolvedCalendars: resolvedMap([['busy', makeRejectingClient(query)]]),
    });

    const r1 = app.inject({ method: 'GET', url: '/busy.ics' });
    const r2 = app.inject({ method: 'GET', url: '/busy.ics' });
    const r3 = app.inject({ method: 'GET', url: '/busy.ics' });

    // Yield the event loop so all three requests reach the in-flight check.
    await new Promise<void>((resolve) => setImmediate(resolve));

    resolveQuery(
      makeQueryResponse([samplePage('p1', 'Coalesced', '2026-05-02')]),
    );

    const responses = await Promise.all([r1, r2, r3]);
    expect(responses.every((r) => r.statusCode === 200)).toBe(true);
    expect(responses.every((r) => r.body.includes('UID:p1'))).toBe(true);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('clears the in-flight slot after a failure so the next request retries', async () => {
    const query = vi
      .fn()
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValueOnce(
        makeQueryResponse([samplePage('p1', 'Recovered', '2026-05-02')]),
      );
    const calendar = makeCalendar({ slug: 'recovers' });
    const app = createServer({
      config: { calendars: [calendar] },
      resolvedCalendars: resolvedMap([['recovers', makeRejectingClient(query)]]),
    });

    const fail = await app.inject({ method: 'GET', url: '/recovers.ics' });
    expect(fail.statusCode).toBe(503);

    const ok = await app.inject({ method: 'GET', url: '/recovers.ics' });
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toContain('UID:p1');
    expect(query).toHaveBeenCalledTimes(2);
  });
});

describe('createServer - token auth via /:slug-:token.ics', () => {
  it('returns 404 for a token-protected calendar accessed without a token', async () => {
    const { client, query } = makeStubClient(makeQueryResponse([]));
    const calendar = makeCalendar({ slug: 'protected', tokens: ['secret-1'] });
    const app = createServer({
      config: { calendars: [calendar] },
      resolvedCalendars: resolvedMap([['protected', client]]),
    });

    const res = await app.inject({ method: 'GET', url: '/protected.ics' });
    expect(res.statusCode).toBe(404);
    // Bare-slug must not have triggered Notion at all — protects token-only
    // calendars from cache-warming or rate-limit drain by anonymous probes.
    expect(query).not.toHaveBeenCalled();
  });

  it('returns 200 for a token-protected calendar accessed with a valid token', async () => {
    const { client } = makeStubClient(
      makeQueryResponse([samplePage('p1', 'Token Event', '2026-05-02')]),
    );
    const calendar = makeCalendar({ slug: 'protected', tokens: ['secret-1'] });
    const app = createServer({
      config: { calendars: [calendar] },
      resolvedCalendars: resolvedMap([['protected', client]]),
    });

    const res = await app.inject({
      method: 'GET',
      url: '/protected-secret-1.ics',
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/calendar/);
    expect(res.body).toContain('UID:p1');
  });

  it('returns 404 (not 401) for a wrong token — does not reveal calendar existence', async () => {
    const { client, query } = makeStubClient(makeQueryResponse([]));
    const calendar = makeCalendar({ slug: 'protected', tokens: ['secret-1'] });
    const app = createServer({
      config: { calendars: [calendar] },
      resolvedCalendars: resolvedMap([['protected', client]]),
    });

    const res = await app.inject({
      method: 'GET',
      url: '/protected-wrongtoken.ics',
    });
    expect(res.statusCode).toBe(404);
    expect(query).not.toHaveBeenCalled();
  });

  it('accepts each token in a multi-token list independently', async () => {
    const { client } = makeStubClient(
      makeQueryResponse([samplePage('p1', 'A', '2026-05-02')]),
    );
    const calendar = makeCalendar({
      slug: 'multi',
      tokens: ['alpha', 'bravo', 'charlie'],
    });
    const app = createServer({
      config: { calendars: [calendar] },
      resolvedCalendars: resolvedMap([['multi', client]]),
    });

    const r1 = await app.inject({ method: 'GET', url: '/multi-alpha.ics' });
    const r2 = await app.inject({ method: 'GET', url: '/multi-bravo.ics' });
    const r3 = await app.inject({ method: 'GET', url: '/multi-charlie.ics' });
    expect(r1.statusCode).toBe(200);
    expect(r2.statusCode).toBe(200);
    expect(r3.statusCode).toBe(200);
  });

  it('still serves an unprotected calendar via bare /slug.ics when tokens is unset', async () => {
    const { client } = makeStubClient(
      makeQueryResponse([samplePage('p1', 'A', '2026-05-02')]),
    );
    const calendar = makeCalendar({ slug: 'open' });
    const app = createServer({
      config: { calendars: [calendar] },
      resolvedCalendars: resolvedMap([['open', client]]),
    });

    const res = await app.inject({ method: 'GET', url: '/open.ics' });
    expect(res.statusCode).toBe(200);
  });

  it('rejects a hyphen-suffix request for an unprotected calendar with 404', async () => {
    const { client, query } = makeStubClient(makeQueryResponse([]));
    const calendar = makeCalendar({ slug: 'open' });
    const app = createServer({
      config: { calendars: [calendar] },
      resolvedCalendars: resolvedMap([['open', client]]),
    });

    const res = await app.inject({
      method: 'GET',
      url: '/open-anything.ics',
    });
    expect(res.statusCode).toBe(404);
    expect(query).not.toHaveBeenCalled();
  });

  it('shares cache across distinct valid tokens (cache key = slug, not token)', async () => {
    const { client, query } = makeStubClient(
      makeQueryResponse([samplePage('p1', 'A', '2026-05-02')]),
    );
    const calendar = makeCalendar({
      slug: 'shared',
      tokens: ['alpha', 'bravo'],
    });
    const app = createServer({
      config: { calendars: [calendar] },
      resolvedCalendars: resolvedMap([['shared', client]]),
    });

    await app.inject({ method: 'GET', url: '/shared-alpha.ics' });
    await app.inject({ method: 'GET', url: '/shared-bravo.ics' });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('accepts a token that itself contains hyphens', async () => {
    // Guards against a future refactor of resolveRoute that splits on every
    // hyphen instead of slicing everything after the first slug- prefix.
    // All other token-auth tests use single-segment tokens, so they would
    // continue to pass while hyphenated tokens silently broke.
    const { client } = makeStubClient(
      makeQueryResponse([samplePage('p1', 'A', '2026-05-02')]),
    );
    const calendar = makeCalendar({
      slug: 'events',
      tokens: ['my-secret-token'],
    });
    const app = createServer({
      config: { calendars: [calendar] },
      resolvedCalendars: resolvedMap([['events', client]]),
    });

    const res = await app.inject({
      method: 'GET',
      url: '/events-my-secret-token.ics',
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('UID:p1');
  });

  it('prefers the longest matching slug when slugs share a hyphen-prefix', async () => {
    // Calendars `team` and `team-alpha` both exist. A request for
    // `/team-alpha.ics` must resolve as slug=team-alpha, NOT slug=team
    // with token=alpha.
    const { client: clientShort } = makeStubClient(
      makeQueryResponse([samplePage('short', 'Short Match', '2026-05-02')]),
    );
    const { client: clientLong } = makeStubClient(
      makeQueryResponse([samplePage('long', 'Long Match', '2026-05-02')]),
    );
    const app = createServer({
      config: {
        calendars: [
          makeCalendar({ slug: 'team' }),
          makeCalendar({ slug: 'team-alpha' }),
        ],
      },
      resolvedCalendars: resolvedMap([
        ['team', clientShort],
        ['team-alpha', clientLong],
      ]),
    });

    const res = await app.inject({ method: 'GET', url: '/team-alpha.ics' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('UID:long');
    expect(res.body).not.toContain('UID:short');
  });

  it('does not log the token value when an invalid token is rejected', async () => {
    const calendar = makeCalendar({
      slug: 'protected',
      tokens: ['the-real-secret'],
    });
    const logs: unknown[] = [];
    const app = createServer({
      config: { calendars: [calendar] },
      resolvedCalendars: new Map(),
      logger: {
        level: 'info',
        stream: {
          write: (line: string) => {
            logs.push(line);
          },
        },
      },
    });

    await app.inject({
      method: 'GET',
      url: '/protected-this-is-a-guess.ics',
    });
    const joined = logs.map((l) => String(l)).join('\n');
    expect(joined).not.toContain('this-is-a-guess');
    expect(joined).not.toContain('the-real-secret');
  });
});

describe('createServer - stale-cache fallback on Notion failure', () => {
  it('serves stale cached events with X-Cache: stale when a refresh fails', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const query = vi
        .fn()
        .mockResolvedValueOnce(
          makeQueryResponse([samplePage('p1', 'Original', '2026-05-02')]),
        )
        .mockRejectedValueOnce(new Error('Notion 500'));
      const calendar = makeCalendar({ slug: 'flaky', cacheTtlSeconds: 60 });
      const app = createServer({
        config: { calendars: [calendar] },
        resolvedCalendars: resolvedMap([['flaky', makeRejectingClient(query)]]),
      });

      // Prime the cache.
      const fresh = await app.inject({ method: 'GET', url: '/flaky.ics' });
      expect(fresh.statusCode).toBe(200);
      expect(fresh.headers['x-cache']).toBeUndefined();

      // Move past TTL — next request will miss and try Notion (which fails).
      vi.advanceTimersByTime(61_000);

      const stale = await app.inject({ method: 'GET', url: '/flaky.ics' });
      expect(stale.statusCode).toBe(200);
      expect(stale.headers['x-cache']).toBe('stale');
      expect(stale.body).toContain('UID:p1');
      expect(stale.body).toContain('Original');
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns 503 when Notion fails AND no stale cache exists', async () => {
    const query = vi.fn().mockRejectedValue(new Error('Notion 500'));
    const calendar = makeCalendar({ slug: 'cold' });
    const app = createServer({
      config: { calendars: [calendar] },
      resolvedCalendars: resolvedMap([['cold', makeRejectingClient(query)]]),
    });

    const res = await app.inject({ method: 'GET', url: '/cold.ics' });
    expect(res.statusCode).toBe(503);
    expect(res.body).toBe('Service Unavailable');
    expect(res.headers['x-cache']).toBeUndefined();
  });

  it('emits a short Cache-Control on a stale response so clients retry sooner', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const query = vi
        .fn()
        .mockResolvedValueOnce(
          makeQueryResponse([samplePage('p1', 'A', '2026-05-02')]),
        )
        .mockRejectedValueOnce(new Error('boom'));
      const calendar = makeCalendar({ slug: 'flaky', cacheTtlSeconds: 600 });
      const app = createServer({
        config: { calendars: [calendar] },
        resolvedCalendars: resolvedMap([['flaky', makeRejectingClient(query)]]),
      });

      await app.inject({ method: 'GET', url: '/flaky.ics' });
      vi.advanceTimersByTime(601_000);
      const stale = await app.inject({ method: 'GET', url: '/flaky.ics' });
      // Don't tell clients to cache the stale body for the calendar's full
      // TTL — we want them to retry sooner so the next live response wins.
      const cc = stale.headers['cache-control'];
      expect(cc).toBeDefined();
      const m = String(cc).match(/max-age=(\d+)/);
      expect(m).not.toBeNull();
      expect(Number(m![1])).toBeLessThan(calendar.cacheTtlSeconds);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('createServer - cache TTL expiry at the route level', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('re-fetches from Notion after the per-calendar TTL elapses', async () => {
    const { client, query } = makeStubClient(
      makeQueryResponse([samplePage('p1', 'A', '2026-05-02')]),
    );
    const calendar = makeCalendar({ slug: 'ttl', cacheTtlSeconds: 60 });
    const app = createServer({
      config: { calendars: [calendar] },
      resolvedCalendars: resolvedMap([['ttl', client]]),
    });

    await app.inject({ method: 'GET', url: '/ttl.ics' });
    expect(query).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(61_000);

    await app.inject({ method: 'GET', url: '/ttl.ics' });
    expect(query).toHaveBeenCalledTimes(2);
  });
});

describe('createServer - GET / (landing page)', () => {
  it('returns HTML', async () => {
    const app = createServer({
      config: { calendars: [makeCalendar({ public: true })] },
      resolvedCalendars: new Map(),
    });
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
  });

  it('lists only calendars marked public: true', async () => {
    const app = createServer({
      config: {
        calendars: [
          makeCalendar({ slug: 'public-cal', name: 'Public Cal', public: true }),
          makeCalendar({ slug: 'private-cal', name: 'Private Cal', public: false }),
        ],
      },
      resolvedCalendars: new Map(),
    });
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.body).toContain('public-cal');
    expect(res.body).not.toContain('private-cal');
  });

  it('shows both webcal:// and https:// links derived from the request host', async () => {
    const app = createServer({
      config: { calendars: [makeCalendar({ slug: 'sub', public: true })] },
      resolvedCalendars: new Map(),
    });
    const res = await app.inject({
      method: 'GET',
      url: '/',
      headers: { host: 'cal.example.com', 'x-forwarded-proto': 'https' },
    });
    expect(res.body).toContain('https://cal.example.com/sub.ics');
    expect(res.body).toContain('webcal://cal.example.com/sub.ics');
  });

  it('renders an empty state when no public calendars are configured', async () => {
    const app = createServer({
      config: { calendars: [makeCalendar({ public: false })] },
      resolvedCalendars: new Map(),
    });
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatch(/no public calendars/i);
  });

  it('escapes HTML special characters in calendar names', async () => {
    const app = createServer({
      config: {
        calendars: [
          makeCalendar({
            slug: 'safe',
            name: '<script>alert(1)</script>',
            public: true,
          }),
        ],
      },
      resolvedCalendars: new Map(),
    });
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.body).not.toContain('<script>alert(1)</script>');
    expect(res.body).toContain('&lt;script&gt;');
  });

  it('renders the page title "notion-ical-bridge"', async () => {
    const app = createServer({
      config: { calendars: [makeCalendar({ public: true })] },
      resolvedCalendars: new Map(),
    });
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.body).toContain('<title>notion-ical-bridge</title>');
  });

  it('escapes HTML special characters in calendar descriptions', async () => {
    const app = createServer({
      config: {
        calendars: [
          makeCalendar({
            slug: 'safe',
            description: '<img src=x onerror=alert(1)>',
            public: true,
          }),
        ],
      },
      resolvedCalendars: new Map(),
    });
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.body).not.toContain('<img src=x onerror=alert(1)>');
    expect(res.body).toContain('&lt;img');
  });

  it('renders each public calendar slug inside an <a href=".../slug.ics"> link', async () => {
    const app = createServer({
      config: {
        calendars: [
          makeCalendar({ slug: 'sisterhood', name: 'Sis', public: true }),
        ],
      },
      resolvedCalendars: new Map(),
    });
    const res = await app.inject({
      method: 'GET',
      url: '/',
      headers: { host: 'cal.example.com', 'x-forwarded-proto': 'https' },
    });
    expect(res.body).toMatch(/href="[^"]*sisterhood\.ics"/);
  });
});

describe('createServer - GET / (landing page) - branding', () => {
  it('applies the default brand color (#0ca2af) when config.brandColor is unset', async () => {
    const app = createServer({
      config: { calendars: [makeCalendar({ public: true })] },
      resolvedCalendars: new Map(),
    });
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.body.toLowerCase()).toContain('#0ca2af');
  });

  it('applies a custom brandColor from config and omits the default', async () => {
    const app = createServer({
      config: {
        calendars: [makeCalendar({ public: true })],
        brandColor: '#ff00aa',
      },
      resolvedCalendars: new Map(),
    });
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.body.toLowerCase()).toContain('#ff00aa');
    expect(res.body.toLowerCase()).not.toContain('#0ca2af');
  });

  it('escapes the brandColor value defensively before injecting into <style>', async () => {
    // Defense-in-depth. Zod validates brandColor at config-load time, but
    // tests construct Config directly. If brandColor ever contained a
    // </style><script> sequence, the rendered body must not contain an
    // unescaped <script> tag. Sentinel against any future Zod bypass.
    const app = createServer({
      config: {
        calendars: [makeCalendar({ public: true })],
        brandColor: '</style><script>alert(1)</script>',
      },
      resolvedCalendars: new Map(),
    });
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.body).not.toContain('<script>alert(1)</script>');
  });

  it('does NOT render an <img class="logo"> when config.logoUrl is unset', async () => {
    const app = createServer({
      config: { calendars: [makeCalendar({ public: true })] },
      resolvedCalendars: new Map(),
    });
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.body).not.toMatch(/<img\b[^>]*class="logo"/);
  });

  it('renders an <img class="logo"> with the configured logoUrl as src', async () => {
    const app = createServer({
      config: {
        calendars: [makeCalendar({ public: true })],
        logoUrl: 'https://example.com/logo.png',
      },
      resolvedCalendars: new Map(),
    });
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.body).toMatch(/<img\b[^>]*class="logo"/);
    expect(res.body).toContain('https://example.com/logo.png');
  });

  it('escapes the logoUrl value when injecting into the <img src> attribute', async () => {
    // Defense-in-depth: if logoUrl contained a quote-breaking payload, the
    // rendered HTML must not let an attacker break out of src="" and inject
    // a script. Zod validates logoUrl as http(s):// at load time; this is a
    // sentinel for direct Config construction (e.g. tests, dev tooling).
    const app = createServer({
      config: {
        calendars: [makeCalendar({ public: true })],
        logoUrl: 'https://x.com/"><script>alert(1)</script>',
      },
      resolvedCalendars: new Map(),
    });
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.body).not.toContain('"><script>alert(1)</script>');
  });
});

describe('createServer - GET / (landing page) - subscribe options', () => {
  it('renders a webcal:// link for each public calendar (iPhone / Mac / Outlook one-tap)', async () => {
    const app = createServer({
      config: { calendars: [makeCalendar({ slug: 'sisterhood', public: true })] },
      resolvedCalendars: new Map(),
    });
    const res = await app.inject({
      method: 'GET',
      url: '/',
      headers: { host: 'cal.example.com', 'x-forwarded-proto': 'https' },
    });
    expect(res.body).toMatch(
      /href="webcal:\/\/cal\.example\.com\/sisterhood\.ics"/,
    );
  });

  it('renders an "Add to Google Calendar" deep link with the URL-encoded https feed as cid', async () => {
    const app = createServer({
      config: { calendars: [makeCalendar({ slug: 'sisterhood', public: true })] },
      resolvedCalendars: new Map(),
    });
    const res = await app.inject({
      method: 'GET',
      url: '/',
      headers: { host: 'cal.example.com', 'x-forwarded-proto': 'https' },
    });
    const expectedCid = encodeURIComponent('https://cal.example.com/sisterhood.ics');
    expect(res.body).toContain(
      `https://calendar.google.com/calendar/r/settings/addbyurl?cid=${expectedCid}`,
    );
  });

  it('renders the direct https feed inside an <input readonly> for tap-to-select on mobile', async () => {
    // <input readonly> is the most reliable phone-friendly copy affordance:
    // tapping the field auto-selects on iOS and Android with no JS needed.
    // A plain <code> block does not give the user a one-tap select.
    const app = createServer({
      config: { calendars: [makeCalendar({ slug: 'sisterhood', public: true })] },
      resolvedCalendars: new Map(),
    });
    const res = await app.inject({
      method: 'GET',
      url: '/',
      headers: { host: 'cal.example.com', 'x-forwarded-proto': 'https' },
    });
    expect(res.body).toMatch(
      /<input[^>]*readonly[^>]*value="https:\/\/cal\.example\.com\/sisterhood\.ics"/,
    );
  });

  it('serves the page without any JavaScript dependency (no <script>, no inline handlers)', async () => {
    const app = createServer({
      config: { calendars: [makeCalendar({ slug: 'sisterhood', public: true })] },
      resolvedCalendars: new Map(),
    });
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.body).not.toMatch(/<script\b/i);
    expect(res.body).not.toMatch(/\bonclick=/i);
    expect(res.body).not.toMatch(/\bonload=/i);
  });
});
