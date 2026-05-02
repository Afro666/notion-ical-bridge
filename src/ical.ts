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

function buildEventDates(event: CalendarEvent): IcalEventDates {
  if (event.isAllDay) {
    // Notion sends "YYYY-MM-DD"; constructing a Date with explicit T00:00:00
    // (no Z) yields local midnight, which ical-generator then formats as a
    // pure DATE value (no timestamp).
    const start = new Date(`${event.start}T00:00:00`);
    // Notion's range end is INCLUSIVE; RFC 5545 DTEND for VALUE=DATE is EXCLUSIVE.
    // Single-day all-day events also need DTEND = start + 1 day.
    const inclusiveEnd = event.end ? new Date(`${event.end}T00:00:00`) : start;
    const end = new Date(inclusiveEnd.getTime() + ONE_DAY_MS);
    return { allDay: true, start, end };
  }

  const start = new Date(event.start);
  const end = event.end
    ? new Date(event.end)
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
