/**
 * Minimal query interface satisfied by pg Pool, PoolClient, and test fakes.
 * Services that accept this can run inside a caller's transaction or against
 * the pool, and unit tests can capture SQL without a live database.
 */

export type QueryResultLike<R> = {
  rows: R[];
  rowCount: number | null;
};

export type Queryable = {
  query<R = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<QueryResultLike<R>>;
};
