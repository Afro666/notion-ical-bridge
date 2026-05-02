import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { z, ZodError } from 'zod';

const SLUG_REGEX = /^[a-z0-9-]+$/;
const ENV_INTERPOLATION_REGEX = /\$\{([A-Z_][A-Z0-9_]*)\}/g;
const DEFAULT_CACHE_TTL_SECONDS = 300;

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
  tokens: z.array(z.string()).optional(),
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
}

function interpolateEnv(value: string): string {
  return value.replace(ENV_INTERPOLATION_REGEX, (_match, name: string) => {
    const v = process.env[name];
    if (v === undefined) {
      throw new Error(
        `Environment variable ${name} referenced in config is not set`,
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
    throw new Error(`Failed to parse YAML: ${(err as Error).message}`);
  }

  let validated: z.infer<typeof RawConfigSchema>;
  try {
    validated = RawConfigSchema.parse(parsed);
  } catch (err) {
    if (err instanceof ZodError) {
      const issues = err.issues
        .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('\n');
      throw new Error(`Config validation failed:\n${issues}`);
    }
    throw err;
  }

  const defaults = validated.defaults ?? {};
  const calendars = validated.calendars.map((c) => resolveCalendar(c, defaults));
  return { calendars };
}

export function loadConfig(path: string): Config {
  const yamlString = readFileSync(path, 'utf-8');
  return parseConfig(yamlString);
}
