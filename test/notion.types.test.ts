// Boundary check between the @notionhq/client SDK and our internal
// NotionQueryClient interface. The original v1 had a
// `as unknown as NotionQueryClient` cast in src/index.ts that bypassed
// type checking entirely; the SDK v5 release silently dropped
// `databases.query` (rows now go through `dataSources.query`), and our
// 130-test suite happily passed because every stub matched the
// hand-rolled interface, not the real SDK.
//
// This file is the regression guard. It uses the REAL exported `Client`
// type so that any future SDK shape change fails to type-check at build
// time, not at production smoke time.

import { describe, expect, it, vi } from 'vitest';
import { Client } from '@notionhq/client';
import {
  fetchEvents,
  resolveDataSourceId,
  type NotionQueryClient,
} from '../src/notion.js';
import type { CalendarConfig } from '../src/config.js';

describe('Notion SDK structural conformance (compile-time guard)', () => {
  it('the real @notionhq/client `Client` satisfies NotionQueryClient', () => {
    // The body runs at runtime, but the value of this test is at compile
    // time: the assignment fails to type-check if `Client` no longer
    // structurally extends NotionQueryClient (e.g. a method we depend on
    // is removed or renamed in a future SDK release).
    const _conformance = (c: Client): NotionQueryClient => c;
    expect(typeof _conformance).toBe('function');
  });
});

const fakeCalendar: CalendarConfig = {
  slug: 'x',
  databaseId: 'db_fake',
  timezone: 'UTC',
  public: false,
  dateProperty: 'Date',
  titleProperty: 'Name',
  cacheTtlSeconds: 300,
};

describe('resolveDataSourceId typed against real Client (network mocked)', () => {
  it('returns the first data_sources[].id from databases.retrieve', async () => {
    const client = new Client({ auth: 'fake-test-token' });
    vi.spyOn(client.databases, 'retrieve').mockResolvedValue({
      data_sources: [{ id: 'fake-ds-id', name: 'whatever' }],
    } as never);

    const id = await resolveDataSourceId(client, 'db_fake');
    expect(id).toBe('fake-ds-id');
    expect(client.databases.retrieve).toHaveBeenCalledWith({
      database_id: 'db_fake',
    });
  });

  it('throws when data_sources is empty', async () => {
    const client = new Client({ auth: 'fake-test-token' });
    vi.spyOn(client.databases, 'retrieve').mockResolvedValue({
      data_sources: [],
    } as never);

    await expect(resolveDataSourceId(client, 'db_fake')).rejects.toThrow(
      /no data sources/i,
    );
  });
});

describe('fetchEvents typed against real Client (network mocked)', () => {
  it('queries dataSources.query with the supplied data_source_id', async () => {
    const client = new Client({ auth: 'fake-test-token' });
    vi.spyOn(client.dataSources, 'query').mockResolvedValue({
      results: [],
      has_more: false,
      next_cursor: null,
    } as never);

    const events = await fetchEvents(client, fakeCalendar, 'fake-ds-id');
    expect(events).toEqual([]);
    expect(client.dataSources.query).toHaveBeenCalledWith(
      expect.objectContaining({ data_source_id: 'fake-ds-id' }),
    );
  });
});
