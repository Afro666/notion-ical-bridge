import { Client } from '@notionhq/client';
import { loadConfig } from './config.js';
import { resolveDataSourceId, type NotionQueryClient } from './notion.js';
import { createServer } from './server.js';

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

  const notionClients = new Map<string, NotionQueryClient>();
  // Notion API 2025-09-03 splits databases into wrappers + data sources.
  // We resolve each calendar's data source ID once at startup so request
  // path stays a single dataSources.query call. Failures here (no integration
  // access, wrong DB ID, network) abort startup loudly via the main() catch.
  const dataSourceIds = new Map<string, string>();
  for (const cal of config.calendars) {
    const auth = cal.accessToken ?? defaultToken;
    if (!auth) {
      throw new Error(
        `Calendar "${cal.slug}" needs accessToken in config.yaml or NOTION_TOKEN env var`,
      );
    }
    // No `as unknown as` cast: Client structurally satisfies
    // NotionQueryClient. The conformance is guarded at build time by
    // test/notion.types.test.ts so SDK drift fails tsc, not production.
    const client: NotionQueryClient = new Client({ auth });
    const dataSourceId = await resolveDataSourceId(client, cal.databaseId);
    notionClients.set(cal.slug, client);
    dataSourceIds.set(cal.slug, dataSourceId);
  }

  const app = createServer({
    config,
    notionClients,
    dataSourceIds,
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
