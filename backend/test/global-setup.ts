import type { TestProject } from 'vitest/node';
import { runMigrations } from '../src/migrate.js';
import { startTemporaryDatabase } from './embedded-db.js';

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrl: string;
  }
}

export default async function setup(project: TestProject) {
  const database = await startTemporaryDatabase();
  await runMigrations(database.url);
  project.provide('databaseUrl', database.url);

  return database.stop;
}
