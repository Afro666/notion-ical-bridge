import ical from 'ical-generator';
import type { CalendarConfig } from './config.js';
import type { CalendarEvent } from './notion.js';

const ONE_HOUR_MS = 60 * 60 * 1000;
const ONE_DAY_MS = 24 * ONE_HOUR_MS;

interface IcalEventDates {
  allDay: boolean;
  start: Date;
  end: Date;
}

function parseDate(value: string, label: string, eventId: string): Date {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    throw new Error(
      `Invalid ${label} date "${value}" on event ${eventId}; expected YYYY-MM-DD or ISO 8601 datetime`,
    );
  }
  return d;
}

function buildEventDates(event: CalendarEvent): IcalEventDates {
  if (event.isAllDay) {
    // Anchor all-day Dates to UTC midnight (the trailing Z) so the calendar
    // day is host-timezone independent. Without Z, JS parses as local time —
    // a UTC-12 host shifts the day backward; on DST transitions, +ONE_DAY_MS
    // produces 23h or 25h instead of one calendar day. UTC has no DST, so
    // millisecond arithmetic between UTC midnights is always exact.
    const start = parseDate(`${event.start}T00:00:00Z`, 'all-day start', event.id);
    // Notion range end is INCLUSIVE; RFC 5545 DTEND for VALUE=DATE is EXCLUSIVE.
    // Single-day all-day events therefore also need DTEND = start + 1 day.
    const inclusiveEnd = event.end
      ? parseDate(`${event.end}T00:00:00Z`, 'all-day end', event.id)
      : start;
    const end = new Date(inclusiveEnd.getTime() + ONE_DAY_MS);
    return { allDay: true, start, end };
  }

  const start = parseDate(event.start, 'timed start', event.id);
  // 1 hour is the convention for timed events with no explicit end. Notion
  // permits this; calendar clients render it as a 1-hour block.
  const end = event.end
    ? parseDate(event.end, 'timed end', event.id)
    : new Date(start.getTime() + ONE_HOUR_MS);
  return { allDay: false, start, end };
}

export function buildIcalFeed(
  events: CalendarEvent[],
  calendar: CalendarConfig,
): string {
  const cal = ical({
    name: calendar.name ?? calendar.slug,
    timezone: calendar.timezone,
    prodId: {
      company: 'notion-ical-bridge',
      product: calendar.slug,
      language: 'EN',
    },
  });

  if (calendar.description !== undefined) {
    cal.description(calendar.description);
  }

  for (const event of events) {
    const dates = buildEventDates(event);
    cal.createEvent({
      id: event.id,
      summary: event.title,
      start: dates.start,
      end: dates.end,
      allDay: dates.allDay,
      ...(event.description !== undefined && { description: event.description }),
      ...(event.location !== undefined && { location: event.location }),
      ...(event.url !== undefined && { url: event.url }),
    });
  }

  // RFC 5545 requires every content line to end with CRLF, including the last.
  // Some ical-generator versions omit the trailing CRLF after END:VCALENDAR.
  const output = cal.toString();
  return output.endsWith('\r\n') ? output : output + '\r\n';
}
