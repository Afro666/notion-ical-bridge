import { describe, it, expect, vi } from 'vitest';
import {
  extractTitle,
  extractRichText,
  extractDate,
  extractSelect,
  extractUrl,
  pageToEvent,
  fetchEvents,
  resolveDataSourceId,
  type NotionDatabaseRetrieveResponse,
  type NotionQueryClient,
  type NotionQueryResponse,
} from '../src/notion.js';
import type { CalendarConfig } from '../src/config.js';

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

describe('extractTitle', () => {
  it('concatenates rich text segments into a single string', () => {
    const prop = {
      type: 'title',
      title: [{ plain_text: 'Hello ' }, { plain_text: 'World' }],
    };
    expect(extractTitle(prop)).toBe('Hello World');
  });

  it('returns null for empty title array', () => {
    expect(extractTitle({ type: 'title', title: [] })).toBeNull();
  });

  it('returns null when prop is not a title type', () => {
    expect(
      extractTitle({ type: 'rich_text', rich_text: [{ plain_text: 'x' }] }),
    ).toBeNull();
  });

  it('returns null for null/undefined input', () => {
    expect(extractTitle(null)).toBeNull();
    expect(extractTitle(undefined)).toBeNull();
  });
});

describe('extractRichText', () => {
  it('concatenates plain_text across runs', () => {
    const prop = {
      type: 'rich_text',
      rich_text: [{ plain_text: 'Line 1\n' }, { plain_text: 'Line 2' }],
    };
    expect(extractRichText(prop)).toBe('Line 1\nLine 2');
  });

  it('returns null for empty rich_text array', () => {
    expect(extractRichText({ type: 'rich_text', rich_text: [] })).toBeNull();
  });
});

describe('extractDate', () => {
  it('detects all-day single date (no T in ISO string)', () => {
    const prop = {
      type: 'date',
      date: { start: '2026-05-02', end: null, time_zone: null },
    };
    expect(extractDate(prop)).toEqual({
      start: '2026-05-02',
      end: null,
      isAllDay: true,
    });
  });

  it('detects timed single date (T present in ISO string)', () => {
    const prop = {
      type: 'date',
      date: {
        start: '2026-05-02T14:00:00.000-04:00',
        end: null,
        time_zone: null,
      },
    };
    expect(extractDate(prop)).toEqual({
      start: '2026-05-02T14:00:00.000-04:00',
      end: null,
      isAllDay: false,
    });
  });

  it('detects all-day range (start + end, neither has T)', () => {
    const prop = {
      type: 'date',
      date: { start: '2026-05-02', end: '2026-05-04', time_zone: null },
    };
    expect(extractDate(prop)).toEqual({
      start: '2026-05-02',
      end: '2026-05-04',
      isAllDay: true,
    });
  });

  it('detects timed range', () => {
    const prop = {
      type: 'date',
      date: {
        start: '2026-05-02T09:00:00.000Z',
        end: '2026-05-02T17:00:00.000Z',
        time_zone: 'UTC',
      },
    };
    expect(extractDate(prop)).toEqual({
      start: '2026-05-02T09:00:00.000Z',
      end: '2026-05-02T17:00:00.000Z',
      isAllDay: false,
    });
  });

  it('returns null when date.date is null', () => {
    expect(extractDate({ type: 'date', date: null })).toBeNull();
  });

  it('returns null when start is empty string', () => {
    expect(
      extractDate({ type: 'date', date: { start: '', end: null, time_zone: null } }),
    ).toBeNull();
  });

  it('returns null for ambiguous formats: TZ-offset without T (e.g. "2026-05-02+00:00")', () => {
    expect(
      extractDate({
        type: 'date',
        date: { start: '2026-05-02+00:00', end: null, time_zone: null },
      }),
    ).toBeNull();
  });

  it('returns null for compact ISO dates (e.g. "20260502")', () => {
    expect(
      extractDate({
        type: 'date',
        date: { start: '20260502', end: null, time_zone: null },
      }),
    ).toBeNull();
  });

  it('returns null for arbitrary non-date strings', () => {
    expect(
      extractDate({
        type: 'date',
        date: { start: 'not-a-date', end: null, time_zone: null },
      }),
    ).toBeNull();
  });
});

describe('extractSelect', () => {
  it('returns the option name when set', () => {
    expect(
      extractSelect({ type: 'select', select: { name: 'Confirmed' } }),
    ).toBe('Confirmed');
  });

  it('returns null when select is null', () => {
    expect(extractSelect({ type: 'select', select: null })).toBeNull();
  });
});

describe('extractUrl', () => {
  it('returns the URL string when present', () => {
    expect(extractUrl({ type: 'url', url: 'https://example.com' })).toBe(
      'https://example.com',
    );
  });

  it('returns null when url is null', () => {
    expect(extractUrl({ type: 'url', url: null })).toBeNull();
  });

  it('returns null when url is empty string', () => {
    expect(extractUrl({ type: 'url', url: '' })).toBeNull();
  });
});

describe('pageToEvent', () => {
  it('builds a full event from a page with all configured properties', () => {
    const cal = makeCalendar({
      titleProperty: 'Name',
      dateProperty: 'When',
      locationProperty: 'Where',
      descriptionProperty: 'Notes',
      urlProperty: 'Link',
    });
    const page = {
      id: 'page-abc-123',
      url: 'https://www.notion.so/page-abc-123',
      properties: {
        Name: { type: 'title', title: [{ plain_text: 'Team Sync' }] },
        When: {
          type: 'date',
          date: { start: '2026-05-02T14:00:00.000Z', end: null, time_zone: null },
        },
        Where: {
          type: 'rich_text',
          rich_text: [{ plain_text: 'Conference Room A' }],
        },
        Notes: {
          type: 'rich_text',
          rich_text: [{ plain_text: 'Bring laptop' }],
        },
        Link: { type: 'url', url: 'https://meet.example.com/sync' },
      },
    };
    const event = pageToEvent(page, cal);
    expect(event).toEqual({
      id: 'page-abc-123',
      title: 'Team Sync',
      isAllDay: false,
      start: '2026-05-02T14:00:00.000Z',
      location: 'Conference Room A',
      description: 'Bring laptop',
      url: 'https://meet.example.com/sync',
    });
  });

  it('returns null when configured dateProperty has no value', () => {
    const cal = makeCalendar();
    const page = {
      id: 'p1',
      url: '',
      properties: {
        Name: { type: 'title', title: [{ plain_text: 'No Date' }] },
        Date: { type: 'date', date: null },
      },
    };
    expect(pageToEvent(page, cal)).toBeNull();
  });

  it('uses "Untitled" fallback when title is empty', () => {
    const cal = makeCalendar();
    const page = {
      id: 'p2',
      url: '',
      properties: {
        Name: { type: 'title', title: [] },
        Date: {
          type: 'date',
          date: { start: '2026-05-02', end: null, time_zone: null },
        },
      },
    };
    const event = pageToEvent(page, cal);
    expect(event?.title).toBe('Untitled');
  });

  it('omits optional fields when not configured on the calendar', () => {
    const cal = makeCalendar();
    const page = {
      id: 'p3',
      url: '',
      properties: {
        Name: { type: 'title', title: [{ plain_text: 'Simple' }] },
        Date: {
          type: 'date',
          date: { start: '2026-05-02', end: null, time_zone: null },
        },
      },
    };
    const event = pageToEvent(page, cal);
    expect(event).toMatchObject({
      id: 'p3',
      title: 'Simple',
      isAllDay: true,
      start: '2026-05-02',
    });
    expect(event).not.toHaveProperty('location');
    expect(event).not.toHaveProperty('description');
    expect(event).not.toHaveProperty('url');
    expect(event).not.toHaveProperty('end');
  });

  it('returns null when page is not an object', () => {
    expect(pageToEvent('not-a-page', makeCalendar())).toBeNull();
    expect(pageToEvent(null, makeCalendar())).toBeNull();
    expect(pageToEvent(42, makeCalendar())).toBeNull();
  });

  it('returns null when page is missing id', () => {
    const page = {
      properties: {
        Name: { type: 'title', title: [{ plain_text: 'No ID' }] },
        Date: {
          type: 'date',
          date: { start: '2026-05-02', end: null, time_zone: null },
        },
      },
    };
    expect(pageToEvent(page, makeCalendar())).toBeNull();
  });

  it('returns null when page is missing properties', () => {
    expect(pageToEvent({ id: 'p-no-props' }, makeCalendar())).toBeNull();
  });

  it('resolves location from a title-typed property when configured', () => {
    const cal = makeCalendar({ locationProperty: 'Where' });
    const page = {
      id: 'p-loc-title',
      properties: {
        Name: { type: 'title', title: [{ plain_text: 'Event' }] },
        Date: {
          type: 'date',
          date: { start: '2026-05-02', end: null, time_zone: null },
        },
        Where: { type: 'title', title: [{ plain_text: 'Main Hall' }] },
      },
    };
    expect(pageToEvent(page, cal)?.location).toBe('Main Hall');
  });

  it('resolves location from a select-typed property when configured', () => {
    const cal = makeCalendar({ locationProperty: 'Venue' });
    const page = {
      id: 'p-loc-select',
      properties: {
        Name: { type: 'title', title: [{ plain_text: 'Event' }] },
        Date: {
          type: 'date',
          date: { start: '2026-05-02', end: null, time_zone: null },
        },
        Venue: { type: 'select', select: { name: 'Cafe' } },
      },
    };
    expect(pageToEvent(page, cal)?.location).toBe('Cafe');
  });

  it('includes end when date range is present', () => {
    const cal = makeCalendar();
    const page = {
      id: 'p4',
      url: '',
      properties: {
        Name: { type: 'title', title: [{ plain_text: 'Multi-day' }] },
        Date: {
          type: 'date',
          date: { start: '2026-05-02', end: '2026-05-04', time_zone: null },
        },
      },
    };
    const event = pageToEvent(page, cal);
    expect(event?.end).toBe('2026-05-04');
    expect(event?.isAllDay).toBe(true);
  });
});

describe('resolveDataSourceId', () => {
  function makeRetrieveClient(response: NotionDatabaseRetrieveResponse) {
    const retrieve = vi.fn().mockResolvedValue(response);
    const client: NotionQueryClient = {
      databases: { retrieve },
      dataSources: { query: vi.fn() },
    };
    return { client, retrieve };
  }

  it('returns the first data_sources[].id', async () => {
    const { client, retrieve } = makeRetrieveClient({
      data_sources: [{ id: 'ds-primary' }, { id: 'ds-secondary' }],
    });
    const id = await resolveDataSourceId(client, 'db_abc');
    expect(id).toBe('ds-primary');
    expect(retrieve).toHaveBeenCalledWith({ database_id: 'db_abc' });
  });

  it('throws when data_sources is empty', async () => {
    const { client } = makeRetrieveClient({ data_sources: [] });
    await expect(resolveDataSourceId(client, 'db_abc')).rejects.toThrow(
      /no data sources/i,
    );
  });

  it('propagates SDK rejection (e.g. unauthorized)', async () => {
    const retrieve = vi.fn().mockRejectedValue(new Error('Unauthorized'));
    const client: NotionQueryClient = {
      databases: { retrieve },
      dataSources: { query: vi.fn() },
    };
    await expect(resolveDataSourceId(client, 'db_abc')).rejects.toThrow(
      'Unauthorized',
    );
  });
});

describe('fetchEvents', () => {
  function makeMockClient(responses: NotionQueryResponse[]) {
    const query = vi.fn();
    responses.forEach((r) => query.mockResolvedValueOnce(r));
    const client: NotionQueryClient = {
      databases: { retrieve: vi.fn() },
      dataSources: { query },
    };
    return { client, query };
  }

  it('passes data_source_id and filter to dataSources.query', async () => {
    const cal = makeCalendar({
      databaseId: 'db_xyz',
      filter: { property: 'Status', select: { equals: 'Confirmed' } },
    });
    const { client, query } = makeMockClient([
      { results: [], has_more: false, next_cursor: null },
    ]);
    await fetchEvents(client, cal, 'ds_xyz');
    expect(query).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith(
      expect.objectContaining({
        data_source_id: 'ds_xyz',
        filter: { property: 'Status', select: { equals: 'Confirmed' } },
      }),
    );
  });

  it('paginates correctly using next_cursor', async () => {
    const page1 = {
      id: 'a',
      url: '',
      properties: {
        Name: { type: 'title', title: [{ plain_text: 'Event A' }] },
        Date: {
          type: 'date',
          date: { start: '2026-05-01', end: null, time_zone: null },
        },
      },
    };
    const page2 = {
      id: 'b',
      url: '',
      properties: {
        Name: { type: 'title', title: [{ plain_text: 'Event B' }] },
        Date: {
          type: 'date',
          date: { start: '2026-05-02', end: null, time_zone: null },
        },
      },
    };
    const { client, query } = makeMockClient([
      { results: [page1], has_more: true, next_cursor: 'cursor-1' },
      { results: [page2], has_more: false, next_cursor: null },
    ]);
    const events = await fetchEvents(client, makeCalendar(), 'ds_test');
    expect(events).toHaveLength(2);
    expect(events.map((e) => e.id)).toEqual(['a', 'b']);
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[1]![0]).toEqual(
      expect.objectContaining({ start_cursor: 'cursor-1' }),
    );
  });

  it('skips pages without a date property value', async () => {
    const validPage = {
      id: 'a',
      url: '',
      properties: {
        Name: { type: 'title', title: [{ plain_text: 'Has Date' }] },
        Date: {
          type: 'date',
          date: { start: '2026-05-01', end: null, time_zone: null },
        },
      },
    };
    const noDatePage = {
      id: 'b',
      url: '',
      properties: {
        Name: { type: 'title', title: [{ plain_text: 'No Date' }] },
        Date: { type: 'date', date: null },
      },
    };
    const { client } = makeMockClient([
      {
        results: [validPage, noDatePage],
        has_more: false,
        next_cursor: null,
      },
    ]);
    const events = await fetchEvents(client, makeCalendar(), 'ds_test');
    expect(events).toHaveLength(1);
    expect(events[0]!.id).toBe('a');
  });

  it('returns empty array when data source has no pages', async () => {
    const { client } = makeMockClient([
      { results: [], has_more: false, next_cursor: null },
    ]);
    const events = await fetchEvents(client, makeCalendar(), 'ds_test');
    expect(events).toEqual([]);
  });

  it('omits filter from query args when calendar has no filter', async () => {
    const { client, query } = makeMockClient([
      { results: [], has_more: false, next_cursor: null },
    ]);
    await fetchEvents(client, makeCalendar(), 'ds_test');
    expect(query.mock.calls[0]![0]).not.toHaveProperty('filter');
  });

  it('terminates the loop when has_more is true but next_cursor is null', async () => {
    const { client, query } = makeMockClient([
      { results: [], has_more: true, next_cursor: null },
    ]);
    const events = await fetchEvents(client, makeCalendar(), 'ds_test');
    expect(events).toEqual([]);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('accumulates events across pages when later pages contain skipped entries', async () => {
    const validP1 = {
      id: 'a',
      properties: {
        Name: { type: 'title', title: [{ plain_text: 'A' }] },
        Date: {
          type: 'date',
          date: { start: '2026-05-01', end: null, time_zone: null },
        },
      },
    };
    const validP2 = {
      id: 'b',
      properties: {
        Name: { type: 'title', title: [{ plain_text: 'B' }] },
        Date: {
          type: 'date',
          date: { start: '2026-05-02', end: null, time_zone: null },
        },
      },
    };
    const skippedP2 = {
      id: 'c',
      properties: {
        Name: { type: 'title', title: [{ plain_text: 'No Date' }] },
        Date: { type: 'date', date: null },
      },
    };
    const { client } = makeMockClient([
      { results: [validP1], has_more: true, next_cursor: 'cursor-1' },
      { results: [validP2, skippedP2], has_more: false, next_cursor: null },
    ]);
    const events = await fetchEvents(client, makeCalendar(), 'ds_test');
    expect(events.map((e) => e.id)).toEqual(['a', 'b']);
  });

  it('propagates rejection from dataSources.query to the caller', async () => {
    const query = vi.fn().mockRejectedValue(new Error('Notion API down'));
    const client: NotionQueryClient = {
      databases: { retrieve: vi.fn() },
      dataSources: { query },
    };
    await expect(fetchEvents(client, makeCalendar(), 'ds_test')).rejects.toThrow(
      'Notion API down',
    );
  });
});
