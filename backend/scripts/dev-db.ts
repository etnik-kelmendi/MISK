import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';

// Local development only. The password below protects nothing but this machine's throwaway database.
const databaseDir = resolve('.pgdata');
const isNew = !existsSync(databaseDir);
const server = new EmbeddedPostgres({
  databaseDir,
  port: 5434,
  user: 'postgres',
  password: 'postgres',
  persistent: true,
  onLog: () => undefined,
});

if (isNew) {
  await server.initialise();
}
await server.start();
if (isNew) {
  await server.createDatabase('misk');
}
console.log('Development database ready on port 5434. Press Ctrl+C to stop.');

async function shutdown() {
  await server.stop();
  process.exit(0);
}
process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());
