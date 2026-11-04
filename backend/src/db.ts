import type { Pool, PoolClient } from 'pg';

/** Anything that can run a query: the pool, or a client inside a transaction. */
export type Queryable = Pick<Pool, 'query'> | PoolClient;

/** The first row of a query that always returns one (an aggregate, an INSERT … RETURNING). */
export function onlyRow<T>(result: { rows: T[] }): T {
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error('Expected a row, but the query returned none');
  }
  return row;
}

/** Runs `work` in one transaction, rolling back on any error. */
export async function withTransaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
