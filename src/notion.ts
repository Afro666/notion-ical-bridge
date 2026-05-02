import type { CalendarConfig } from './config.js';

export interface CalendarEvent {
  id: string;
  title: string;
  isAllDay: boolean;
  start: string;
  end?: string;
  location?: string;
  description?: string;
  url?: string;
}

export interface NotionQueryArgs {
  database_id: string;
  filter?: Record<string, unknown>;
  start_cursor?: string;
  page_size?: number;
}

export interface NotionQueryResponse {
  results: unknown[];
  has_more: boolean;
  next_cursor: string | null;
}

export interface NotionQueryClient {
  databases: {
    query: (args: NotionQueryArgs) => Promise<NotionQueryResponse>;
  };
}

export interface ExtractedDate {
  start: string;
  end: string | null;
  isAllDay: boolean;
}

interface RichTextSegment {
  plain_text?: string;
}

function getRichTextSegments(
  prop: unknown,
  kind: 'title' | 'rich_text',
): RichTextSegment[] | null {
  if (typeof prop !== 'object' || prop === null) return null;
  const p = prop as { type?: unknown; [k: string]: unknown };
  if (p.type !== kind) return null;
  const arr = p[kind];
  return Array.isArray(arr) ? (arr as RichTextSegment[]) : null;
}

function joinPlainText(segments: RichTextSegment[]): string {
  return segments.map((s) => s.plain_text ?? '').join('');
}

export function extractTitle(prop: unknown): string | null {
  const segments = getRichTextSegments(prop, 'title');
  if (!segments || segments.length === 0) return null;
  const text = joinPlainText(segments);
  return text.length > 0 ? text : null;
}

export function extractRichText(prop: unknown): string | null {
  const segments = getRichTextSegments(prop, 'rich_text');
  if (!segments || segments.length === 0) return null;
  const text = joinPlainText(segments);
  return text.length > 0 ? text : null;
}

// Notion emits exactly two date formats: extended "YYYY-MM-DD" for all-day
// events and full ISO 8601 (with 'T') for timed. Strings outside both shapes
// would be ambiguous (e.g. "2026-05-02+00:00" has no T and is not date-only),
// so we reject them rather than guess.
const ISO_DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

export function extractDate(prop: unknown): ExtractedDate | null {
  if (typeof prop !== 'object' || prop === null) return null;
  const p = prop as { type?: unknown; date?: unknown };
  if (p.type !== 'date') return null;
  if (typeof p.date !== 'object' || p.date === null) return null;
  const d = p.date as { start?: unknown; end?: unknown };
  if (typeof d.start !== 'string' || d.start.length === 0) return null;

  const isAllDay = ISO_DATE_ONLY_RE.test(d.start);
  const isTimed = d.start.includes('T');
  if (!isAllDay && !isTimed) return null;

  const end = typeof d.end === 'string' && d.end.length > 0 ? d.end : null;
  return { start: d.start, end, isAllDay };
}

export function extractSelect(prop: unknown): string | null {
  if (typeof prop !== 'object' || prop === null) return null;
  const p = prop as { type?: unknown; select?: unknown };
  if (p.type !== 'select') return null;
  if (typeof p.select !== 'object' || p.select === null) return null;
  const s = p.select as { name?: unknown };
  return typeof s.name === 'string' ? s.name : null;
}

export function extractUrl(prop: unknown): string | null {
  if (typeof prop !== 'object' || prop === null) return null;
  const p = prop as { type?: unknown; url?: unknown };
  if (p.type !== 'url') return null;
  return typeof p.url === 'string' && p.url.length > 0 ? p.url : null;
}

export function pageToEvent(
  page: unknown,
  calendar: CalendarConfig,
): CalendarEvent | null {
  if (typeof page !== 'object' || page === null) return null;
  const p = page as { id?: unknown; properties?: unknown };
  if (typeof p.id !== 'string') return null;
  if (typeof p.properties !== 'object' || p.properties === null) return null;
  const props = p.properties as Record<string, unknown>;

  const dateInfo = extractDate(props[calendar.dateProperty]);
  if (!dateInfo) return null;

  const titleProp = props[calendar.titleProperty];
  const title =
    extractTitle(titleProp) ?? extractRichText(titleProp) ?? 'Untitled';

  const event: CalendarEvent = {
    id: p.id,
    title,
    isAllDay: dateInfo.isAllDay,
    start: dateInfo.start,
  };

  if (dateInfo.end !== null) event.end = dateInfo.end;

  if (calendar.locationProperty) {
    const raw = props[calendar.locationProperty];
    const loc =
      extractRichText(raw) ?? extractTitle(raw) ?? extractSelect(raw);
    if (loc) event.location = loc;
  }

  if (calendar.descriptionProperty) {
    const raw = props[calendar.descriptionProperty];
    const desc = extractRichText(raw) ?? extractTitle(raw);
    if (desc) event.description = desc;
  }

  if (calendar.urlProperty) {
    const url = extractUrl(props[calendar.urlProperty]);
    if (url) event.url = url;
  }

  return event;
}

// 100 is the documented maximum page_size for Notion's databases.query endpoint.
const NOTION_PAGE_SIZE_MAX = 100;

export async function fetchEvents(
  client: NotionQueryClient,
  calendar: CalendarConfig,
): Promise<CalendarEvent[]> {
  const events: CalendarEvent[] = [];
  let cursor: string | undefined;

  do {
    const args: NotionQueryArgs = {
      database_id: calendar.databaseId,
      page_size: NOTION_PAGE_SIZE_MAX,
    };
    if (calendar.filter !== undefined) args.filter = calendar.filter;
    if (cursor !== undefined) args.start_cursor = cursor;

    const response = await client.databases.query(args);

    for (const page of response.results) {
      const event = pageToEvent(page, calendar);
      if (event) events.push(event);
    }

    cursor =
      response.has_more && response.next_cursor !== null
        ? response.next_cursor
        : undefined;
  } while (cursor !== undefined);

  return events;
}
