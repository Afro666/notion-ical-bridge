import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ConfigValidationError, loadConfig, parseConfig } from '../src/config.js';

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
      expect(() => parseConfig(yaml)).toThrow(/at least one calendar/i);
    });

    it('rejects an empty tokens: [] array (would silently seal the calendar)', () => {
      const yaml = `
calendars:
  - slug: events
    databaseId: db_abc
    timezone: UTC
    dateProperty: Date
    titleProperty: Name
    tokens: []
`;
      expect(() => parseConfig(yaml)).toThrow(/tokens/i);
    });

    it('rejects a tokens array containing an empty-string token', () => {
      const yaml = `
calendars:
  - slug: events
    databaseId: db_abc
    timezone: UTC
    dateProperty: Date
    titleProperty: Name
    tokens:
      - ""
`;
      expect(() => parseConfig(yaml)).toThrow(/tokens/i);
    });

    it('throws ConfigValidationError with structured issues for Zod failures', () => {
      const yaml = `
calendars:
  - slug: events
    timezone: UTC
    dateProperty: Date
    titleProperty: Name
`;
      try {
        parseConfig(yaml);
        expect.fail('expected parseConfig to throw');
      } catch (err) {
        expect(err).toBeInstanceOf(ConfigValidationError);
        const cve = err as ConfigValidationError;
        expect(cve.issues.length).toBeGreaterThan(0);
        expect(cve.issues.some((i) => i.path.includes('databaseId'))).toBe(true);
        expect(cve.cause).toBeDefined();
      }
    });

    it('throws clear error for malformed YAML syntax', () => {
      const yaml = `calendars: [\n  - slug: unclosed`;
      expect(() => parseConfig(yaml)).toThrow(/Failed to parse YAML/);
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

    it('uses defaults.cacheTtlSeconds when calendar-level is absent', () => {
      const yaml = `
defaults:
  cacheTtlSeconds: 600
calendars:
  - slug: events
    databaseId: db_abc
    timezone: UTC
    dateProperty: Date
    titleProperty: Name
`;
      const config = parseConfig(yaml);
      expect(config.calendars[0]!.cacheTtlSeconds).toBe(600);
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

    it('throws when ${ENV_VAR} interpolation references empty-string variable', () => {
      process.env.NOTION_TOKEN_EMPTY = '';
      const yaml = `
calendars:
  - slug: sisterhood
    databaseId: db_abc
    timezone: UTC
    dateProperty: Date
    titleProperty: Name
    accessToken: \${NOTION_TOKEN_EMPTY}
`;
      expect(() => parseConfig(yaml)).toThrow(/NOTION_TOKEN_EMPTY/);
    });

    it('throws when ${ENV_VAR} reference uses lowercase or mixed-case name', () => {
      process.env.notion_token = 'should_not_be_resolved';
      const yaml = `
calendars:
  - slug: sisterhood
    databaseId: db_abc
    timezone: UTC
    dateProperty: Date
    titleProperty: Name
    accessToken: \${notion_token}
`;
      expect(() => parseConfig(yaml)).toThrow(/uppercase snake case/i);
    });
  });

  describe('loadConfig', () => {
    it('throws clear error wrapping the cause when file does not exist', () => {
      const path = '/nonexistent/path/notion-ical-bridge-test-config.yaml';
      try {
        loadConfig(path);
        expect.fail('expected loadConfig to throw');
      } catch (err) {
        expect(err).toBeInstanceOf(Error);
        expect((err as Error).message).toMatch(/Failed to read config file/);
        expect((err as Error).message).toContain(path);
        expect((err as Error).cause).toBeDefined();
      }
    });
  });

  describe('top-level branding fields', () => {
    it('accepts a 6-digit lowercase hex brandColor', () => {
      const yaml = `
brandColor: '#0ca2af'
calendars:
  - slug: events
    databaseId: db_abc
    timezone: UTC
    dateProperty: Date
    titleProperty: Name
`;
      const config = parseConfig(yaml);
      expect(config.brandColor).toBe('#0ca2af');
    });

    it('accepts a 6-digit uppercase hex brandColor', () => {
      const yaml = `
brandColor: '#FF00AA'
calendars:
  - slug: events
    databaseId: db_abc
    timezone: UTC
    dateProperty: Date
    titleProperty: Name
`;
      const config = parseConfig(yaml);
      expect(config.brandColor).toBe('#FF00AA');
    });

    it('rejects a 3-digit shorthand hex brandColor', () => {
      const yaml = `
brandColor: '#abc'
calendars:
  - slug: events
    databaseId: db_abc
    timezone: UTC
    dateProperty: Date
    titleProperty: Name
`;
      expect(() => parseConfig(yaml)).toThrow(/brandColor/i);
    });

    it('rejects a brandColor with no leading #', () => {
      const yaml = `
brandColor: ff00aa
calendars:
  - slug: events
    databaseId: db_abc
    timezone: UTC
    dateProperty: Date
    titleProperty: Name
`;
      expect(() => parseConfig(yaml)).toThrow(/brandColor/i);
    });

    it('rejects a brandColor that is a CSS keyword (e.g. "teal")', () => {
      const yaml = `
brandColor: teal
calendars:
  - slug: events
    databaseId: db_abc
    timezone: UTC
    dateProperty: Date
    titleProperty: Name
`;
      expect(() => parseConfig(yaml)).toThrow(/brandColor/i);
    });

    it('treats brandColor as optional (undefined when omitted)', () => {
      const yaml = `
calendars:
  - slug: events
    databaseId: db_abc
    timezone: UTC
    dateProperty: Date
    titleProperty: Name
`;
      const config = parseConfig(yaml);
      expect(config.brandColor).toBeUndefined();
    });

    it('accepts a valid https logoUrl', () => {
      const yaml = `
logoUrl: https://cdn.example.com/logo.svg
calendars:
  - slug: events
    databaseId: db_abc
    timezone: UTC
    dateProperty: Date
    titleProperty: Name
`;
      const config = parseConfig(yaml);
      expect(config.logoUrl).toBe('https://cdn.example.com/logo.svg');
    });

    it('accepts a valid http logoUrl (for LAN/internal deployments)', () => {
      const yaml = `
logoUrl: http://internal.lan/logo.png
calendars:
  - slug: events
    databaseId: db_abc
    timezone: UTC
    dateProperty: Date
    titleProperty: Name
`;
      const config = parseConfig(yaml);
      expect(config.logoUrl).toBe('http://internal.lan/logo.png');
    });

    it('rejects a logoUrl with a non-http(s) scheme', () => {
      const yaml = `
logoUrl: ftp://example.com/logo.png
calendars:
  - slug: events
    databaseId: db_abc
    timezone: UTC
    dateProperty: Date
    titleProperty: Name
`;
      expect(() => parseConfig(yaml)).toThrow(/logoUrl/i);
    });

    it('rejects an empty-string logoUrl', () => {
      const yaml = `
logoUrl: ''
calendars:
  - slug: events
    databaseId: db_abc
    timezone: UTC
    dateProperty: Date
    titleProperty: Name
`;
      expect(() => parseConfig(yaml)).toThrow(/logoUrl/i);
    });

    it('rejects a logoUrl that is not a URL at all', () => {
      const yaml = `
logoUrl: not-a-url
calendars:
  - slug: events
    databaseId: db_abc
    timezone: UTC
    dateProperty: Date
    titleProperty: Name
`;
      expect(() => parseConfig(yaml)).toThrow(/logoUrl/i);
    });

    it('treats logoUrl as optional (undefined when omitted)', () => {
      const yaml = `
calendars:
  - slug: events
    databaseId: db_abc
    timezone: UTC
    dateProperty: Date
    titleProperty: Name
`;
      const config = parseConfig(yaml);
      expect(config.logoUrl).toBeUndefined();
    });

    it('rejects a bare-scheme logoUrl with no hostname (e.g. "https://")', () => {
      // WHATWG URL parser accepts `https://` (empty host) so Zod's plain
      // .url() check passes. The hostname-presence refine is the gate.
      const yaml = `
logoUrl: 'https://'
calendars:
  - slug: events
    databaseId: db_abc
    timezone: UTC
    dateProperty: Date
    titleProperty: Name
`;
      expect(() => parseConfig(yaml)).toThrow(/logoUrl/i);
    });
  });

  describe('top-level required fields', () => {
    it('rejects YAML that omits the calendars key entirely', () => {
      // Distinct from the empty-array case (`calendars: []`). `.min(1)` on
      // an absent key triggers a "Required" error on a different path.
      const yaml = `
brandColor: '#ff0000'
`;
      expect(() => parseConfig(yaml)).toThrow(/calendars/i);
    });
  });
});
