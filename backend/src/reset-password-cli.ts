import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import pg from 'pg';
import { resetAdminPasswordByUsername } from './auth/admin-accounts.js';

// For when no admin can sign in to reset another. The password is read from the keyboard or a pipe,
// never from arguments, which shell history keeps.
async function readAnswers(): Promise<{ username: string; password: string }> {
  if (!process.stdin.isTTY) {
    const lines: string[] = [];
    for await (const line of createInterface({ input: process.stdin })) {
      lines.push(line);
    }
    return { username: lines[0] ?? '', password: lines[1] ?? '' };
  }

  const visible = createInterface({ input: process.stdin, output: process.stdout });
  const username = await visible.question('Admin username: ');
  visible.close();

  const hidden = createInterface({
    input: process.stdin,
    output: new Writable({ write: (_chunk, _encoding, done) => done() }),
    terminal: true,
  });
  process.stdout.write('New password: ');
  const password = await hidden.question('');
  process.stdout.write('\nRepeat new password: ');
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
  await resetAdminPasswordByUsername(pool, username, password);
  console.log('Password changed. That admin has been signed out everywhere.');
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
