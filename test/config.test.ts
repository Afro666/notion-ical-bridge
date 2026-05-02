import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { parseConfig } from '../src/config.js';

describe('parseConfig', () => {
  describe('valid configs', () => {
    it('loads minimal valid config (one calendar, required fields only)', () => {
      const yaml = `
calendars:
  - slug: events
    databaseId: db_abc123
    timezone: America/New_York
    dateProperty: Date
    titleProperty: Name
`;
      const config = parseConfig(yaml);
      expect(config.calendars).toHaveLength(1);
      const cal = config.calendars[0]!;
      expect(cal.slug).toBe('events');
      expect(cal.databaseId).toBe('db_abc123');
      expect(cal.dateProperty).toBe('Date');
      expect(cal.titleProperty).toBe('Name');
      expect(cal.public).toBe(false);
      expect(cal.cacheTtlSeconds).toBe(300);
      expect(cal.timezone).toBe('America/New_York');
    });

    it('loads full config with all optional fields', () => {
      const yaml = `
defaults:
  cacheTtlSeconds: 600
  timezone: Europe/Berlin
calendars:
  - slug: sisterhood
    databaseId: db_xyz789
    name: Sisterhood Events
    description: Weekly meetings
    timezone: America/Los_Angeles
    public: true
    dateProperty: Event Date
    titleProperty: Title
    locationProperty: Where
    descriptionProperty: Notes
    urlProperty: Link
    filter:
      property: Status
      select:
        equals: Confirmed
    tokens:
      - secret-token-1
      - secret-token-2
    cacheTtlSeconds: 900
`;
      const config = parseConfig(yaml);
      expect(config.calendars).toHaveLength(1);
      const cal = config.calendars[0]!;
      expect(cal.name).toBe('Sisterhood Events');
      expect(cal.description).toBe('Weekly meetings');
      expect(cal.timezone).toBe('America/Los_Angeles');
      expect(cal.public).toBe(true);
      expect(cal.locationProperty).toBe('Where');
      expect(cal.descriptionProperty).toBe('Notes');
      expect(cal.urlProperty).toBe('Link');
      expect(cal.filter).toEqual({
        property: 'Status',
        select: { equals: 'Confirmed' },
      });
      expect(cal.tokens).toEqual(['secret-token-1', 'secret-token-2']);
      expect(cal.cacheTtlSeconds).toBe(900);
    });
  });

  describe('validation errors', () => {
    it('rejects missing required slug', () => {
      const yaml = `
calendars:
  - databaseId: db_abc
    timezone: UTC
    dateProperty: Date
    titleProperty: Name
`;
      expect(() => parseConfig(yaml)).toThrow(/slug/i);
    });

    it('rejects missing required databaseId', () => {
      const yaml = `
calendars:
  - slug: events
    timezone: UTC
    dateProperty: Date
    titleProperty: Name
`;
      expect(() => parseConfig(yaml)).toThrow(/databaseId/i);
    });

    it('rejects missing required dateProperty', () => {
      const yaml = `
calendars:
  - slug: events
    databaseId: db_abc
    timezone: UTC
    titleProperty: Name
`;
      expect(() => parseConfig(yaml)).toThrow(/dateProperty/i);
    });

    it('rejects missing required titleProperty', () => {
      const yaml = `
calendars:
  - slug: events
    databaseId: db_abc
    timezone: UTC
    dateProperty: Date
`;
      expect(() => parseConfig(yaml)).toThrow(/titleProperty/i);
    });

    it('rejects slug with uppercase letters', () => {
      const yaml = `
calendars:
  - slug: MyEvents
    databaseId: db_abc
    timezone: UTC
    dateProperty: Date
    titleProperty: Name
`;
      expect(() => parseConfig(yaml)).toThrow(/slug/i);
    });

    it('rejects slug with spaces', () => {
      const yaml = `
calendars:
  - slug: "my events"
    databaseId: db_abc
    timezone: UTC
    dateProperty: Date
    titleProperty: Name
`;
      expect(() => parseConfig(yaml)).toThrow(/slug/i);
    });

    it('rejects slug with forward slashes', () => {
      const yaml = `
calendars:
  - slug: my/events
    databaseId: db_abc
    timezone: UTC
    dateProperty: Date
    titleProperty: Name
`;
      expect(() => parseConfig(yaml)).toThrow(/slug/i);
    });

    it('rejects duplicate slugs across calendars', () => {
      const yaml = `
calendars:
  - slug: events
    databaseId: db_abc
    timezone: UTC
    dateProperty: Date
    titleProperty: Name
  - slug: events
    databaseId: db_xyz
    timezone: UTC
    dateProperty: Date
    titleProperty: Name
`;
      expect(() => parseConfig(yaml)).toThrow(/duplicate.*slug/i);
    });

    it('rejects empty calendars list', () => {
      const yaml = `
calendars: []
`;
      expect(() => parseConfig(yaml)).toThrow();
    });
  });

  describe('defaults', () => {
    it('defaults cacheTtlSeconds to 300 when absent everywhere', () => {
      const yaml = `
calendars:
  - slug: events
    databaseId: db_abc
    timezone: UTC
    dateProperty: Date
    titleProperty: Name
`;
      const config = parseConfig(yaml);
      expect(config.calendars[0]!.cacheTtlSeconds).toBe(300);
    });

    it('falls back to defaults.timezone when calendar-level timezone absent', () => {
      const yaml = `
defaults:
  timezone: Europe/Berlin
calendars:
  - slug: events
    databaseId: db_abc
    dateProperty: Date
    titleProperty: Name
`;
      const config = parseConfig(yaml);
      expect(config.calendars[0]!.timezone).toBe('Europe/Berlin');
    });

    it('uses calendar-level cacheTtlSeconds over defaults.cacheTtlSeconds', () => {
      const yaml = `
defaults:
  cacheTtlSeconds: 600
calendars:
  - slug: events
    databaseId: db_abc
    timezone: UTC
    dateProperty: Date
    titleProperty: Name
    cacheTtlSeconds: 900
`;
      const config = parseConfig(yaml);
      expect(config.calendars[0]!.cacheTtlSeconds).toBe(900);
    });

    it('throws when no timezone is set anywhere', () => {
      const yaml = `
calendars:
  - slug: events
    databaseId: db_abc
    dateProperty: Date
    titleProperty: Name
`;
      expect(() => parseConfig(yaml)).toThrow(/timezone/i);
    });
  });

  describe('env var interpolation', () => {
    let originalEnv: NodeJS.ProcessEnv;

    beforeEach(() => {
      originalEnv = { ...process.env };
    });

    afterEach(() => {
      process.env = originalEnv;
    });

    it('resolves ${ENV_VAR} interpolation in accessToken', () => {
      process.env.NOTION_TOKEN_SISTERHOOD = 'secret_real_token_value';
      const yaml = `
calendars:
  - slug: sisterhood
    databaseId: db_abc
    timezone: UTC
    dateProperty: Date
    titleProperty: Name
    accessToken: \${NOTION_TOKEN_SISTERHOOD}
`;
      const config = parseConfig(yaml);
      expect(config.calendars[0]!.accessToken).toBe('secret_real_token_value');
    });

    it('throws when ${ENV_VAR} interpolation references unset variable', () => {
      delete process.env.NOTION_TOKEN_MISSING;
      const yaml = `
calendars:
  - slug: sisterhood
    databaseId: db_abc
    timezone: UTC
    dateProperty: Date
    titleProperty: Name
    accessToken: \${NOTION_TOKEN_MISSING}
`;
      expect(() => parseConfig(yaml)).toThrow(/NOTION_TOKEN_MISSING/);
    });
  });
});
