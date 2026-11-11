import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Every error code the API can send needs a message in the web app, or people see only "That did not
 * work". This reads the codes from the source, so a new code without a message fails here.
 */
const SRC = join(import.meta.dirname);
const MESSAGES = join(import.meta.dirname, '../../web/src/i18n/locales/en.json');

const CODE_PATTERNS = [
  /\b(?:conflict|badRequest|notFound|forbidden)\('([a-z_]+)'\)/g,
  /new ApiError\(\d+, '([a-z_]+)'\)/g,
  /\berror: '([a-z_]+)'/g,
];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [path] : [];
  });
}

describe('error messages', () => {
  it('has a message in the app for every error code the API sends', () => {
    const codes = new Set<string>();
    for (const file of sourceFiles(SRC)) {
      const text = readFileSync(file, 'utf8');
      for (const pattern of CODE_PATTERNS) {
        for (const match of text.matchAll(pattern)) {
          if (match[1]) codes.add(match[1]);
        }
      }
    }
    const messages = (JSON.parse(readFileSync(MESSAGES, 'utf8')) as { errors: Record<string, string> }).errors;
    expect(codes.size).toBeGreaterThan(50);
    expect([...codes].filter((code) => !(code in messages)).sort()).toEqual([]);
  });
});
