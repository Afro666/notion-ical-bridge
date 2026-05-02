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
  const client: NotionQueryClient = { databases: { query } };
  return { client, query };
}

describe('createServer - GET /healthz', () => {
  it('returns 200 with body "ok"', async () => {
    const app = createServer({
      config: { calendars: [] },
      notionClients: new Map(),
    });
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('ok');
  });

  it('takes precedence over the parametric /:filename route even if a calendar is named "healthz"', async () => {
    const app = createServer({
      config: { calendars: [makeCalendar({ slug: 'healthz' })] },
      notionClients: new Map(),
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
    });

    const res = await app.inject({ method: 'GET', url: '/fast.ics' });
    expect(res.headers['cache-control']).toBe('public, max-age=60');
  });

  it('returns 404 for an unknown slug', async () => {
    const app = createServer({
      config: { calendars: [makeCalendar({ slug: 'events' })] },
      notionClients: new Map(),
    });
    const res = await app.inject({ method: 'GET', url: '/nonexistent.ics' });
    expect(res.statusCode).toBe(404);
  });

  it('returns 404 for paths missing the .ics extension', async () => {
    const app = createServer({
      config: { calendars: [makeCalendar({ slug: 'events' })] },
      notionClients: new Map(),
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
      notionClients: new Map([['failing', { databases: { query } }]]),
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
      notionClients: new Map([['busy', { databases: { query } }]]),
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
      notionClients: new Map([['recovers', { databases: { query } }]]),
    });

    const fail = await app.inject({ method: 'GET', url: '/recovers.ics' });
    expect(fail.statusCode).toBe(503);

    const ok = await app.inject({ method: 'GET', url: '/recovers.ics' });
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toContain('UID:p1');
    expect(query).toHaveBeenCalledTimes(2);
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
    });
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.body).toContain('public-cal');
    expect(res.body).not.toContain('private-cal');
  });

  it('shows both webcal:// and https:// links derived from the request host', async () => {
    const app = createServer({
      config: { calendars: [makeCalendar({ slug: 'sub', public: true })] },
      notionClients: new Map(),
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
    });
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.body).not.toContain('<script>alert(1)</script>');
    expect(res.body).toContain('&lt;script&gt;');
  });
});
