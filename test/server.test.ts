import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer } from '../src/server.js';
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

// Default data source ID used by tests that don't care about the value.
// In production index.ts resolves this once per slug at startup.
const FAKE_DS_ID = 'ds_test';

function dsMap(slugs: readonly string[]): Map<string, string> {
  return new Map(slugs.map((s) => [s, FAKE_DS_ID]));
}

describe('createServer - GET /healthz', () => {
  it('returns 200 with body "ok"', async () => {
    const app = createServer({
      config: { calendars: [] },
      notionClients: new Map(),
      dataSourceIds: new Map(),
    });
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('ok');
  });

  it('takes precedence over the parametric /:filename route even if a calendar is named "healthz"', async () => {
    const app = createServer({
      config: { calendars: [makeCalendar({ slug: 'healthz' })] },
      notionClients: new Map(),
      dataSourceIds: new Map(),
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
      notionClients: new Map([['sisterhood', client]]),
      dataSourceIds: dsMap(['sisterhood']),
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
      notionClients: new Map([['fast', client]]),
      dataSourceIds: dsMap(['fast']),
    });

    const res = await app.inject({ method: 'GET', url: '/fast.ics' });
    expect(res.headers['cache-control']).toBe('public, max-age=60');
  });

  it('returns 404 for an unknown slug', async () => {
    const app = createServer({
      config: { calendars: [makeCalendar({ slug: 'events' })] },
      notionClients: new Map(),
      dataSourceIds: new Map(),
    });
    const res = await app.inject({ method: 'GET', url: '/nonexistent.ics' });
    expect(res.statusCode).toBe(404);
  });

  it('returns 404 for paths missing the .ics extension', async () => {
    const app = createServer({
      config: { calendars: [makeCalendar({ slug: 'events' })] },
      notionClients: new Map(),
      dataSourceIds: new Map(),
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
      notionClients: new Map([['cached', client]]),
      dataSourceIds: dsMap(['cached']),
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
      notionClients: new Map([['failing', makeRejectingClient(query)]]),
      dataSourceIds: dsMap(['failing']),
    });

    const res = await app.inject({ method: 'GET', url: '/failing.ics' });
    expect(res.statusCode).toBe(503);
    expect(res.body).toBe('Service Unavailable');
  });

  it('returns 503 when calendar is configured but no Notion client is registered', async () => {
    const calendar = makeCalendar({ slug: 'unwired' });
    const app = createServer({
      config: { calendars: [calendar] },
      notionClients: new Map(),
      dataSourceIds: new Map(),
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
      notionClients: new Map([['busy', makeRejectingClient(query)]]),
      dataSourceIds: dsMap(['busy']),
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
      notionClients: new Map([['recovers', makeRejectingClient(query)]]),
      dataSourceIds: dsMap(['recovers']),
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
      notionClients: new Map([['protected', client]]),
      dataSourceIds: dsMap(['protected']),
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
      notionClients: new Map([['protected', client]]),
      dataSourceIds: dsMap(['protected']),
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
      notionClients: new Map([['protected', client]]),
      dataSourceIds: dsMap(['protected']),
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
      notionClients: new Map([['multi', client]]),
      dataSourceIds: dsMap(['multi']),
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
      notionClients: new Map([['open', client]]),
      dataSourceIds: dsMap(['open']),
    });

    const res = await app.inject({ method: 'GET', url: '/open.ics' });
    expect(res.statusCode).toBe(200);
  });

  it('rejects a hyphen-suffix request for an unprotected calendar with 404', async () => {
    const { client, query } = makeStubClient(makeQueryResponse([]));
    const calendar = makeCalendar({ slug: 'open' });
    const app = createServer({
      config: { calendars: [calendar] },
      notionClients: new Map([['open', client]]),
      dataSourceIds: dsMap(['open']),
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
      notionClients: new Map([['shared', client]]),
      dataSourceIds: dsMap(['shared']),
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
      notionClients: new Map([['events', client]]),
      dataSourceIds: dsMap(['events']),
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
      notionClients: new Map([
        ['team', clientShort],
        ['team-alpha', clientLong],
      ]),
      dataSourceIds: dsMap(['team', 'team-alpha']),
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
      notionClients: new Map(),
      dataSourceIds: new Map(),
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
        notionClients: new Map([['flaky', makeRejectingClient(query)]]),
        dataSourceIds: dsMap(['flaky']),
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
      notionClients: new Map([['cold', makeRejectingClient(query)]]),
      dataSourceIds: dsMap(['cold']),
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
        notionClients: new Map([['flaky', makeRejectingClient(query)]]),
        dataSourceIds: dsMap(['flaky']),
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
      notionClients: new Map([['ttl', client]]),
      dataSourceIds: dsMap(['ttl']),
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
      notionClients: new Map(),
      dataSourceIds: new Map(),
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
      notionClients: new Map(),
      dataSourceIds: new Map(),
    });
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.body).toContain('public-cal');
    expect(res.body).not.toContain('private-cal');
  });

  it('shows both webcal:// and https:// links derived from the request host', async () => {
    const app = createServer({
      config: { calendars: [makeCalendar({ slug: 'sub', public: true })] },
      notionClients: new Map(),
      dataSourceIds: new Map(),
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
      notionClients: new Map(),
      dataSourceIds: new Map(),
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
      notionClients: new Map(),
      dataSourceIds: new Map(),
    });
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.body).not.toContain('<script>alert(1)</script>');
    expect(res.body).toContain('&lt;script&gt;');
  });
});
