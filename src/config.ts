import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { z, ZodError } from 'zod';

const SLUG_REGEX = /^[a-z0-9-]+$/;
// Exported so the server module can re-validate brandColor at render time
// as defense-in-depth: brandColor is interpolated into a <style> block, where
// HTML escaping does NOT prevent CSS injection — only structural format
// validation does. Single source of truth lives here.
export const HEX_COLOR_REGEX = /^#[0-9a-fA-F]{6}$/;
const HTTP_URL_REGEX = /^https?:\/\//;

// Match any ${...} so we can throw a precise error on names that don't match
// our supported shape (uppercase snake case). Letting unknown patterns pass
// through silently confused users on Windows where mixed-case env vars are common.
const ENV_INTERPOLATION_REGEX = /\$\{([^}]+)\}/g;
const ENV_VAR_NAME_REGEX = /^[A-Z_][A-Z0-9_]*$/;

const DEFAULT_CACHE_TTL_SECONDS = 300;

export class ConfigValidationError extends Error {
  readonly issues: ZodError['issues'];

  constructor(message: string, issues: ZodError['issues'], options?: ErrorOptions) {
    super(message, options);
    this.name = 'ConfigValidationError';
    this.issues = issues;
  }
}

const RawCalendarSchema = z.object({
  slug: z
    .string()
    .regex(SLUG_REGEX, 'slug must contain only lowercase letters, digits, and hyphens'),
  databaseId: z.string().min(1, 'databaseId is required'),
  name: z.string().optional(),
  description: z.string().optional(),
  timezone: z.string().optional(),
  public: z.boolean().default(false),
  dateProperty: z.string().min(1, 'dateProperty is required'),
  titleProperty: z.string().min(1, 'titleProperty is required'),
  locationProperty: z.string().optional(),
  descriptionProperty: z.string().optional(),
  urlProperty: z.string().optional(),
  filter: z.record(z.string(), z.unknown()).optional(),
  accessToken: z.string().optional(),
  // .min(1) collapses the implicit "tokens: []" sentinel: without this,
  // an empty array would silently mean "fully sealed, no token can match"
  // — usually a typo. Authors must either omit `tokens` (public calendar)
  // or supply at least one non-empty token.
  tokens: z.array(z.string().min(1)).min(1).optional(),
  cacheTtlSeconds: z.number().int().positive().optional(),
});

const RawDefaultsSchema = z.object({
  cacheTtlSeconds: z.number().int().positive().optional(),
  timezone: z.string().optional(),
});

const RawConfigSchema = z
  .object({
    defaults: RawDefaultsSchema.optional(),
    calendars: z.array(RawCalendarSchema).min(1, 'at least one calendar is required'),
    brandColor: z
      .string()
      .regex(HEX_COLOR_REGEX, 'brandColor must be a 6-digit hex color like #0ca2af')
      .optional(),
    logoUrl: z
      .string()
      .url('logoUrl must be a valid URL')
      .refine((u) => HTTP_URL_REGEX.test(u), 'logoUrl must use http:// or https://')
      // Reject bare-scheme URLs like `https://` (no host). These would
      // render as `<img src="https://">` and 404 on every device.
      // `new URL('https://')` throws TypeError in Node, so the catch is
      // the actual gate; the truthy hostname-length check covers any
      // edge case where the constructor accepts an empty-host URL.
      .refine((u) => {
        try {
          return new URL(u).hostname.length > 0;
        } catch {
          return false;
        }
      }, 'logoUrl must include a hostname')
      .optional(),
  })
  .superRefine((data, ctx) => {
    const seen = new Set<string>();
    data.calendars.forEach((cal, i) => {
      if (seen.has(cal.slug)) {
        ctx.addIssue({
          code: 'custom',
          path: ['calendars', i, 'slug'],
          message: `Duplicate slug "${cal.slug}" found in calendars; slugs must be unique`,
        });
      }
      seen.add(cal.slug);
    });
  });

type RawCalendar = z.infer<typeof RawCalendarSchema>;
type RawDefaults = z.infer<typeof RawDefaultsSchema>;

export interface CalendarConfig {
  slug: string;
  databaseId: string;
  name?: string;
  description?: string;
  timezone: string;
  public: boolean;
  dateProperty: string;
  titleProperty: string;
  locationProperty?: string;
  descriptionProperty?: string;
  urlProperty?: string;
  filter?: Record<string, unknown>;
  accessToken?: string;
  tokens?: string[];
  cacheTtlSeconds: number;
}

export interface Config {
  calendars: CalendarConfig[];
  brandColor?: string;
  logoUrl?: string;
}

function interpolateEnv(value: string): string {
  return value.replace(ENV_INTERPOLATION_REGEX, (_match, name: string) => {
    if (!ENV_VAR_NAME_REGEX.test(name)) {
      throw new Error(
        `Environment variable reference "\${${name}}" must be uppercase snake case (e.g. \${NOTION_TOKEN}); lowercase or mixed-case names are not supported`,
      );
    }
    const v = process.env[name];
    if (v === undefined || v === '') {
      throw new Error(
        `Environment variable ${name} referenced in config is not set or is empty`,
      );
    }
    return v;
  });
}

function resolveCalendar(raw: RawCalendar, defaults: RawDefaults): CalendarConfig {
  const timezone = raw.timezone ?? defaults.timezone;
  if (!timezone) {
    throw new Error(
      `Calendar "${raw.slug}" has no timezone (set it on the calendar or in defaults.timezone)`,
    );
  }

  const resolved: CalendarConfig = {
    slug: raw.slug,
    databaseId: raw.databaseId,
    timezone,
    public: raw.public,
    dateProperty: raw.dateProperty,
    titleProperty: raw.titleProperty,
    cacheTtlSeconds:
      raw.cacheTtlSeconds ?? defaults.cacheTtlSeconds ?? DEFAULT_CACHE_TTL_SECONDS,
  };

  if (raw.name !== undefined) resolved.name = raw.name;
  if (raw.description !== undefined) resolved.description = raw.description;
  if (raw.locationProperty !== undefined) resolved.locationProperty = raw.locationProperty;
  if (raw.descriptionProperty !== undefined) resolved.descriptionProperty = raw.descriptionProperty;
  if (raw.urlProperty !== undefined) resolved.urlProperty = raw.urlProperty;
  if (raw.filter !== undefined) resolved.filter = raw.filter;
  if (raw.accessToken !== undefined) resolved.accessToken = interpolateEnv(raw.accessToken);
  if (raw.tokens !== undefined) resolved.tokens = raw.tokens;

  return resolved;
}

export function parseConfig(yamlString: string): Config {
  let parsed: unknown;
  try {
    parsed = parseYaml(yamlString);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to parse YAML: ${message}`, { cause: err });
  }

  let validated: z.infer<typeof RawConfigSchema>;
  try {
    validated = RawConfigSchema.parse(parsed);
  } catch (err) {
    if (err instanceof ZodError) {
      const summary = err.issues
        .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('\n');
      throw new ConfigValidationError(
        `Config validation failed:\n${summary}`,
        err.issues,
        { cause: err },
      );
    }
    throw err;
  }

  const defaults = validated.defaults ?? {};
  const calendars = validated.calendars.map((c) => resolveCalendar(c, defaults));
  const result: Config = { calendars };
  if (validated.brandColor !== undefined) result.brandColor = validated.brandColor;
  if (validated.logoUrl !== undefined) result.logoUrl = validated.logoUrl;
  return result;
}

export function loadConfig(path: string): Config {
  let yamlString: string;
  try {
    yamlString = readFileSync(path, 'utf-8');
  } catch (err) {
    throw new Error(`Failed to read config file at ${path}`, { cause: err });
  }
  return parseConfig(yamlString);
}
