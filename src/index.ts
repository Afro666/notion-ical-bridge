// Entrypoint stub for Phase 0.
// Phase 4 replaces this with the Fastify server bootstrap (config loading,
// route registration, listen). For now this only proves the build pipeline:
// tsc emits dist/index.js, node runs it, the process exits cleanly.

const banner = 'notion-ical-bridge: Phase 0 stub. Server starts in Phase 4.';

process.stdout.write(banner + '\n');
process.exit(0);
