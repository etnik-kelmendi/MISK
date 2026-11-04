import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import pg from 'pg';
import { createFirstAdmin } from './auth/first-admin.js';

// The password is read from the keyboard or a pipe, never from arguments, which shell history keeps.
async function readAnswers(): Promise<{ username: string; password: string }> {
  if (!process.stdin.isTTY) {
    const lines: string[] = [];
    for await (const line of createInterface({ input: process.stdin })) {
      lines.push(line);
    }
    return { username: lines[0] ?? '', password: lines[1] ?? '' };
  }

  const visible = createInterface({ input: process.stdin, output: process.stdout });
  const username = await visible.question('Username: ');
  visible.close();

  const hiddenOutput = new Writable({ write: (_chunk, _encoding, done) => done() });
  const hidden = createInterface({ input: process.stdin, output: hiddenOutput, terminal: true });
  process.stdout.write('Password: ');
  const password = await hidden.question('');
  process.stdout.write('\nRepeat password: ');
  const repeated = await hidden.question('');
  process.stdout.write('\n');
  hidden.close();

  if (password !== repeated) {
    throw new Error('The passwords do not match.');
  }
  return { username, password };
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: databaseUrl });
try {
  const { username, password } = await readAnswers();
  await createFirstAdmin(pool, username, password);
  console.log('First Admin created.');
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
