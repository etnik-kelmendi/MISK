import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

export type UploadMime = 'image/jpeg' | 'image/png' | 'application/pdf';

/** Where uploaded files live. Behind one interface so it can move to object storage (D12). */
export interface FileStorage {
  save(content: Buffer): Promise<string>;
  read(key: string): Promise<Buffer>;
  remove(key: string): Promise<void>;
}

const KEY_FORMAT = /^[A-Za-z0-9_-]{32}$/;

export function createDiskStorage(directory: string): FileStorage {
  const pathOf = (key: string) => {
    // Keys are generated here, but checking them keeps a bad key from ever reaching the file system.
    if (!KEY_FORMAT.test(key)) {
      throw new Error('Invalid storage key');
    }
    return join(directory, key.slice(0, 2), key);
  };
  return {
    async save(content) {
      const key = randomBytes(24).toString('base64url');
      const path = pathOf(key);
      await mkdir(join(directory, key.slice(0, 2)), { recursive: true });
      await writeFile(path, content, { flag: 'wx' });
      return key;
    },
    read: (key) => readFile(pathOf(key)),
    remove: (key) => rm(pathOf(key), { force: true }),
  };
}

/** Identifies a file by its first bytes, never by its name or the type the browser claims. */
export function detectMime(content: Buffer): UploadMime | null {
  if (content.length >= 3 && content[0] === 0xff && content[1] === 0xd8 && content[2] === 0xff) {
    return 'image/jpeg';
  }
  if (content.length >= 8 && content.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }
  if (content.length >= 5 && content.subarray(0, 5).toString('latin1') === '%PDF-') {
    return 'application/pdf';
  }
  return null;
}
