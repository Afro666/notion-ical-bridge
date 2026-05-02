import { describe, it, expect, vi } from 'vitest';
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
    expect(res.body).not.toContain('Notion API unreachable');
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
