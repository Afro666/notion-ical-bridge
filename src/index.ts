import { Client } from '@notionhq/client';
import { loadConfig } from './config.js';
import type { NotionQueryClient } from './notion.js';
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

async function main(): Promise<void> {
  const configPath = process.env.CONFIG_PATH ?? './config.yaml';
  const host = process.env.HOST ?? '0.0.0.0';
  const port = parsePort(process.env.PORT);
  const defaultToken = process.env.NOTION_TOKEN;
  const logLevel = process.env.LOG_LEVEL ?? 'info';

  const config = loadConfig(configPath);

  const notionClients = new Map<string, NotionQueryClient>();
  for (const cal of config.calendars) {
    const auth = cal.accessToken ?? defaultToken;
    if (!auth) {
      throw new Error(
        `Calendar "${cal.slug}" needs accessToken in config.yaml or NOTION_TOKEN env var`,
      );
    }
    // Client is structurally compatible with NotionQueryClient for the
    // methods we use (databases.query). Cast through unknown to bypass TS
    // variance on the SDK's wider parameter shape.
    notionClients.set(
      cal.slug,
      new Client({ auth }) as unknown as NotionQueryClient,
    );
  }

  const app = createServer({
    config,
    notionClients,
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
