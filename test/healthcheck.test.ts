import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// The server binds IPv4 (HOST=0.0.0.0). In Alpine, `localhost` can resolve to
// ::1 first, so the healthcheck must call 127.0.0.1 (issue #14).
describe('container healthcheck', () => {
  for (const file of ['Dockerfile', 'docker-compose.yml']) {
    it(`${file} probes 127.0.0.1, not localhost`, () => {
      const text = readFileSync(file, 'utf8');
      const line = text.split('\n').find((l) => l.includes('/healthz'));
      expect(line).toBeDefined();
      expect(line).toContain('http://127.0.0.1:3000/healthz');
      expect(line).not.toContain('localhost');
    });
  }
});
