import { describe, it, expect } from 'vitest';
import { buildIcalFeed } from '../src/ical.js';
import type { CalendarEvent } from '../src/notion.js';
import type { CalendarConfig } from '../src/config.js';

const makeCalendar = (overrides: Partial<CalendarConfig> = {}): CalendarConfig => ({
  slug: 'events',
  databaseId: 'db_test',
  timezone: 'America/New_York',
  public: false,
  dateProperty: 'Date',
  titleProperty: 'Name',
  cacheTtlSeconds: 300,
  ...overrides,
});

const makeEvent = (overrides: Partial<CalendarEvent> = {}): CalendarEvent => ({
  id: 'page-1',
  title: 'Sample Event',
  isAllDay: false,
  start: '2026-05-02T14:00:00.000Z',
  end: '2026-05-02T15:00:00.000Z',
  ...overrides,
});

describe('buildIcalFeed - structure', () => {
  it('produces a valid VCALENDAR wrapper for an empty event list', () => {
    const ics = buildIcalFeed([], makeCalendar());
    expect(ics).toMatch(/^BEGIN:VCALENDAR/);
    expect(ics).toContain('END:VCALENDAR');
    expect(ics).toContain('VERSION:2.0');
    expect(ics).toContain('PRODID');
  });

  it('uses the calendar name in X-WR-CALNAME', () => {
    const ics = buildIcalFeed([], makeCalendar({ name: 'Sisterhood Events' }));
    expect(ics).toContain('X-WR-CALNAME:Sisterhood Events');
  });

  it('falls back to slug when calendar name is absent', () => {
    const ics = buildIcalFeed([], makeCalendar({ slug: 'standalone-cal' }));
    expect(ics).toContain('X-WR-CALNAME:standalone-cal');
  });

  it('emits the calendar timezone in X-WR-TIMEZONE', () => {
    const ics = buildIcalFeed([], makeCalendar({ timezone: 'Europe/Berlin' }));
    expect(ics).toContain('X-WR-TIMEZONE:Europe/Berlin');
  });

  it('uses CRLF line endings per RFC 5545', () => {
    const ics = buildIcalFeed([makeEvent()], makeCalendar());
    expect(ics).toContain('\r\n');
    expect(ics.endsWith('\r\n')).toBe(true);
  });
});

describe('buildIcalFeed - UID stability', () => {
  it('uses the Notion page ID as the UID base so events update in place', () => {
    const ics = buildIcalFeed(
      [makeEvent({ id: 'page-uid-test' })],
      makeCalendar(),
    );
    expect(ics).toContain('UID:page-uid-test');
  });

  it('produces identical UIDs across separate builds for the same event', () => {
    const event = makeEvent({ id: 'stable-id-42' });
    const a = buildIcalFeed([event], makeCalendar());
    const b = buildIcalFeed([event], makeCalendar());
    const uidA = a.match(/UID:([^\r\n]+)/)?.[1];
    const uidB = b.match(/UID:([^\r\n]+)/)?.[1];
    expect(uidA).toBeTruthy();
    expect(uidA).toBe(uidB);
  });
});

describe('buildIcalFeed - all-day events', () => {
  it('emits DTSTART;VALUE=DATE for an all-day single-day event', () => {
    const ics = buildIcalFeed(
      [
        makeEvent({
          id: 'allday-1',
          isAllDay: true,
          start: '2026-05-02',
          end: undefined,
        }),
      ],
      makeCalendar(),
    );
    expect(ics).toMatch(/DTSTART;VALUE=DATE:20260502/);
  });

  it('emits DTEND;VALUE=DATE one day after start for all-day single-day (RFC 5545 exclusive end)', () => {
    const ics = buildIcalFeed(
      [
        makeEvent({
          id: 'allday-1',
          isAllDay: true,
          start: '2026-05-02',
          end: undefined,
        }),
      ],
      makeCalendar(),
    );
    expect(ics).toMatch(/DTEND;VALUE=DATE:20260503/);
  });

  it('emits DTEND for all-day range as Notion-end + 1 day (RFC 5545 exclusive)', () => {
    const ics = buildIcalFeed(
      [
        makeEvent({
          id: 'allday-range',
          isAllDay: true,
          start: '2026-05-02',
          end: '2026-05-04',
        }),
      ],
      makeCalendar(),
    );
    expect(ics).toMatch(/DTSTART;VALUE=DATE:20260502/);
    expect(ics).toMatch(/DTEND;VALUE=DATE:20260505/);
  });

  it('emits correct DTEND across a DST spring-forward boundary (single-day)', () => {
    // 2026-03-08 is the day America/New_York advances clocks 02:00 -> 03:00.
    // UTC arithmetic in buildEventDates avoids the wall-clock skew.
    const ics = buildIcalFeed(
      [
        makeEvent({
          id: 'dst-spring-single',
          isAllDay: true,
          start: '2026-03-08',
          end: undefined,
        }),
      ],
      makeCalendar({ timezone: 'America/New_York' }),
    );
    expect(ics).toMatch(/DTSTART;VALUE=DATE:20260308/);
    expect(ics).toMatch(/DTEND;VALUE=DATE:20260309/);
  });

  it('emits correct DTEND across a DST spring-forward boundary (range)', () => {
    const ics = buildIcalFeed(
      [
        makeEvent({
          id: 'dst-spring-range',
          isAllDay: true,
          start: '2026-03-07',
          end: '2026-03-09',
        }),
      ],
      makeCalendar({ timezone: 'America/New_York' }),
    );
    expect(ics).toMatch(/DTSTART;VALUE=DATE:20260307/);
    expect(ics).toMatch(/DTEND;VALUE=DATE:20260310/);
  });

  it('does not emit a time component for all-day events', () => {
    const ics = buildIcalFeed(
      [
        makeEvent({
          id: 'allday-1',
          isAllDay: true,
          start: '2026-05-02',
          end: undefined,
        }),
      ],
      makeCalendar(),
    );
    const dtstart = ics.match(/DTSTART[^\r\n]*/)?.[0];
    expect(dtstart).not.toMatch(/T\d{6}/);
  });
});

describe('buildIcalFeed - timed events', () => {
  it('emits DTSTART with full timestamp for timed events', () => {
    const ics = buildIcalFeed(
      [
        makeEvent({
          id: 'timed-1',
          isAllDay: false,
          start: '2026-05-02T14:00:00.000Z',
          end: '2026-05-02T15:00:00.000Z',
        }),
      ],
      makeCalendar(),
    );
    expect(ics).toMatch(/DTSTART[^\r\n]*:\d{8}T\d{6}/);
    expect(ics).toMatch(/DTEND[^\r\n]*:\d{8}T\d{6}/);
  });

  it('emits correct DTEND for timed event spanning two calendar dates', () => {
    const ics = buildIcalFeed(
      [
        makeEvent({
          id: 'cross-midnight',
          isAllDay: false,
          start: '2026-05-02T22:00:00.000Z',
          end: '2026-05-03T02:00:00.000Z',
        }),
      ],
      makeCalendar({ timezone: 'UTC' }),
    );
    expect(ics).toMatch(/DTSTART[^:]*:20260502T220000/);
    expect(ics).toMatch(/DTEND[^:]*:20260503T020000/);
  });

  it('defaults to a 1-hour duration when timed event has no end', () => {
    const ics = buildIcalFeed(
      [
        makeEvent({
          id: 'timed-no-end',
          isAllDay: false,
          start: '2026-05-02T14:00:00.000Z',
          end: undefined,
        }),
      ],
      makeCalendar(),
    );
    const dtstart = ics.match(/DTSTART[^:]*:(\d{8}T\d{6})/)?.[1];
    const dtend = ics.match(/DTEND[^:]*:(\d{8}T\d{6})/)?.[1];
    expect(dtstart).toBeTruthy();
    expect(dtend).toBeTruthy();
    const startHour = Number(dtstart!.slice(9, 11));
    const endHour = Number(dtend!.slice(9, 11));
    expect((endHour - startHour + 24) % 24).toBe(1);
  });
});

describe('buildIcalFeed - event metadata', () => {
  it('includes summary from the event title', () => {
    const ics = buildIcalFeed(
      [makeEvent({ title: 'Team Sync' })],
      makeCalendar(),
    );
    expect(ics).toContain('SUMMARY:Team Sync');
  });

  it('includes description, location, and url when present', () => {
    const ics = buildIcalFeed(
      [
        makeEvent({
          description: 'Bring laptop',
          location: 'Room A',
          url: 'https://example.com/meet',
        }),
      ],
      makeCalendar(),
    );
    expect(ics).toContain('DESCRIPTION:Bring laptop');
    expect(ics).toContain('LOCATION:Room A');
    expect(ics).toMatch(/URL[^\r\n]*:https:\/\/example\.com\/meet/);
  });

  it('omits optional fields when not present on the event', () => {
    const ics = buildIcalFeed(
      [
        makeEvent({
          description: undefined,
          location: undefined,
          url: undefined,
        }),
      ],
      makeCalendar(),
    );
    expect(ics).not.toContain('DESCRIPTION');
    expect(ics).not.toContain('LOCATION');
    expect(ics).not.toMatch(/^URL:/m);
  });
});

describe('buildIcalFeed - RFC 5545 escaping', () => {
  it('escapes commas in summary', () => {
    const ics = buildIcalFeed(
      [makeEvent({ title: 'Hello, World' })],
      makeCalendar(),
    );
    expect(ics).toContain('SUMMARY:Hello\\, World');
  });

  it('escapes semicolons in summary', () => {
    const ics = buildIcalFeed(
      [makeEvent({ title: 'Sale; 50% off' })],
      makeCalendar(),
    );
    expect(ics).toContain('SUMMARY:Sale\\; 50% off');
  });

  it('escapes newlines in description', () => {
    const ics = buildIcalFeed(
      [makeEvent({ description: 'Line 1\nLine 2' })],
      makeCalendar(),
    );
    expect(ics).toContain('DESCRIPTION:Line 1\\nLine 2');
  });

  it('escapes backslashes in summary', () => {
    const ics = buildIcalFeed(
      [makeEvent({ title: 'Back\\slash' })],
      makeCalendar(),
    );
    expect(ics).toContain('SUMMARY:Back\\\\slash');
  });
});

describe('buildIcalFeed - invalid input safety', () => {
  function assertThrowsWith(
    fn: () => unknown,
    fragments: readonly string[],
  ): void {
    try {
      fn();
      expect.fail('expected function to throw');
    } catch (err) {
      const message = (err as Error).message;
      for (const fragment of fragments) {
        expect(message).toContain(fragment);
      }
    }
  }

  it('throws a clear error citing the event id when all-day start is unparseable', () => {
    assertThrowsWith(
      () =>
        buildIcalFeed(
          [
            makeEvent({
              id: 'bad-allday',
              isAllDay: true,
              start: 'not-a-date',
              end: undefined,
            }),
          ],
          makeCalendar(),
        ),
      ['bad-allday', 'not-a-date'],
    );
  });

  it('throws a clear error citing the event id when timed start is unparseable', () => {
    assertThrowsWith(
      () =>
        buildIcalFeed(
          [
            makeEvent({
              id: 'bad-timed',
              isAllDay: false,
              start: 'definitely not iso',
              end: undefined,
            }),
          ],
          makeCalendar(),
        ),
      ['bad-timed', 'definitely not iso'],
    );
  });

  it('throws a clear error when timed end is unparseable', () => {
    assertThrowsWith(
      () =>
        buildIcalFeed(
          [
            makeEvent({
              id: 'bad-end',
              isAllDay: false,
              start: '2026-05-02T14:00:00.000Z',
              end: 'invalid-end',
            }),
          ],
          makeCalendar(),
        ),
      ['bad-end', 'invalid-end'],
    );
  });
});

describe('buildIcalFeed - multiple events', () => {
  it('emits one VEVENT block per event', () => {
    const ics = buildIcalFeed(
      [
        makeEvent({ id: 'e1', title: 'Event 1' }),
        makeEvent({ id: 'e2', title: 'Event 2' }),
        makeEvent({ id: 'e3', title: 'Event 3' }),
      ],
      makeCalendar(),
    );
    const beginCount = (ics.match(/BEGIN:VEVENT/g) ?? []).length;
    const endCount = (ics.match(/END:VEVENT/g) ?? []).length;
    expect(beginCount).toBe(3);
    expect(endCount).toBe(3);
  });
});
