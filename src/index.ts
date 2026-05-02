import { Client } from '@notionhq/client';
import { loadConfig } from './config.js';
import { resolveDataSourceId, type NotionQueryClient } from './notion.js';
import { createServer, type ResolvedCalendar } from './server.js';

function parsePort(raw: string | undefined): number {
  const value = raw ?? '3000';
  const port = Number.parseInt(value, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(
      `Invalid PORT="${value}" — must be an integer between 1 and 65535`,
    );
  }
  return port;
}

const VALID_LOG_LEVELS = [
  'trace',
  'debug',
  'info',
  'warn',
  'error',
  'fatal',
  'silent',
] as const;

function parseLogLevel(raw: string | undefined): string {
  const value = raw ?? 'info';
  if (!(VALID_LOG_LEVELS as readonly string[]).includes(value)) {
    // Pino throws on unknown levels with an opaque message that gives no
    // hint about which env var caused it. Catch it here so the error
    // points at LOG_LEVEL directly.
    throw new Error(
      `Invalid LOG_LEVEL="${value}" — must be one of: ${VALID_LOG_LEVELS.join(', ')}`,
    );
  }
  return value;
}

async function main(): Promise<void> {
  const configPath = process.env.CONFIG_PATH ?? './config.yaml';
  const host = process.env.HOST ?? '0.0.0.0';
  const port = parsePort(process.env.PORT);
  const defaultToken = process.env.NOTION_TOKEN;
  const logLevel = parseLogLevel(process.env.LOG_LEVEL);

  const config = loadConfig(configPath);

  // Resolve all calendars' data source IDs in parallel. Sequential
  // resolution would scale linearly with calendar count and risk hitting
  // Docker's healthcheck start_period; Promise.all completes in O(slowest).
  // Any rejection aborts startup loudly via main()'s catch handler — that
  // fail-fast is intentional, since serving a partial calendar set silently
  // would mask misconfiguration.
  const entries: ReadonlyArray<readonly [string, ResolvedCalendar]> =
    await Promise.all(
      config.calendars.map(async (cal) => {
        const auth = cal.accessToken ?? defaultToken;
        if (!auth) {
          throw new Error(
            `Calendar "${cal.slug}" needs accessToken in config.yaml or NOTION_TOKEN env var`,
          );
        }
        const client: NotionQueryClient = new Client({ auth });
        try {
          const dataSourceId = await resolveDataSourceId(
            client,
            cal.databaseId,
          );
          return [cal.slug, { client, dataSourceId }] as const;
        } catch (err) {
          // Re-throw with calendar identity so the operator can spot
          // which YAML entry to fix without grepping for the DB UUID.
          const cause = err instanceof Error ? err.message : String(err);
          throw new Error(
            `Calendar "${cal.slug}" (db ${cal.databaseId}): ${cause}`,
            { cause: err },
          );
        }
      }),
    );
  const resolvedCalendars = new Map<string, ResolvedCalendar>(entries);

  const app = createServer({
    config,
    resolvedCalendars,
    logger: { level: logLevel },
  });

  await app.listen({ host, port });
  app.log.info(
    { host, port, calendars: config.calendars.length },
    'notion-ical-bridge listening',
  );
}

main().catch((err: unknown) => {
  // Bootstrap-time errors: log to stderr (Fastify logger may not be wired
  // yet) and exit non-zero so Docker/systemd restarts the process. Preserve
  // the stack trace for diagnosis; bare `.message` discards the call site.
  const detail =
    err instanceof Error ? (err.stack ?? err.message) : String(err);
  process.stderr.write(`Fatal: ${detail}\n`);
  process.exit(1);
});
