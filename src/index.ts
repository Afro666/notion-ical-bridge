import { Client } from '@notionhq/client';
import { loadConfig } from './config.js';
import type { NotionQueryClient } from './notion.js';
import { createServer } from './server.js';

const CONFIG_PATH = process.env.CONFIG_PATH ?? './config.yaml';
const PORT = Number(process.env.PORT ?? '3000');
const HOST = process.env.HOST ?? '0.0.0.0';
const DEFAULT_TOKEN = process.env.NOTION_TOKEN;
const NODE_ENV = process.env.NODE_ENV ?? 'development';

async function main(): Promise<void> {
  const config = loadConfig(CONFIG_PATH);

  const notionClients = new Map<string, NotionQueryClient>();
  for (const cal of config.calendars) {
    const auth = cal.accessToken ?? DEFAULT_TOKEN;
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
    logger: NODE_ENV === 'production' ? true : { level: 'info' },
  });

  await app.listen({ host: HOST, port: PORT });
  app.log.info(
    { host: HOST, port: PORT, calendars: config.calendars.length },
    'notion-ical-bridge listening',
  );
}

main().catch((err) => {
  // Bootstrap-time errors: log to stderr (Fastify logger may not be wired yet)
  // and exit non-zero so Docker/systemd restarts the process.
  process.stderr.write(`Fatal: ${(err as Error).message}\n`);
  process.exit(1);
});
