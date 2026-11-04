import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

/** Starts a throwaway PostgreSQL server for automated tests. */
export async function startTemporaryDatabase() {
  const databaseDir = mkdtempSync(join(tmpdir(), 'misk-test-db-'));
  const port = await findFreePort();
  const server = new EmbeddedPostgres({
    databaseDir,
    port,
    user: 'postgres',
    password: 'postgres',
    persistent: true,
    onLog: () => undefined,
  });
  await server.initialise();
  await server.start();
  await server.createDatabase('misk_test');

  return {
    url: `postgres://postgres:postgres@localhost:${port}/misk_test`,
    stop: async () => {
      await server.stop();
      // Windows can hold the folder briefly after PostgreSQL exits.
      rmSync(databaseDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    },
  };
}
