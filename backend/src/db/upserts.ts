import type { PoolClient } from 'pg';

type Queryable = Pick<PoolClient, 'query'>;

/**
 * Chunked, idempotent multi-row upsert.
 * Every domain write goes through here so re-running a backfill or replaying a
 * webhook never creates duplicates (§2 conventions: ON CONFLICT DO UPDATE).
 *
 * updateCols defaults to every non-conflict column. Pass [] for DO NOTHING.
 */
export async function bulkUpsert(
  db: Queryable,
  table: string,
  columns: string[],
  conflictCols: string[],
  rows: unknown[][],
  updateCols?: string[],
): Promise<number> {
  if (rows.length === 0) return 0;
  const cols = columns.length;
  const maxRowsPerChunk = Math.max(1, Math.floor(60_000 / cols));
  const setCols = (updateCols ?? columns.filter((c) => !conflictCols.includes(c)));
  const conflictClause =
    setCols.length === 0
      ? `ON CONFLICT (${conflictCols.join(',')}) DO NOTHING`
      : `ON CONFLICT (${conflictCols.join(',')}) DO UPDATE SET ` +
        setCols.map((c) => `${c} = EXCLUDED.${c}`).join(', ');

  let written = 0;
  for (let start = 0; start < rows.length; start += maxRowsPerChunk) {
    const chunk = rows.slice(start, start + maxRowsPerChunk);
    const values: unknown[] = [];
    const tuples = chunk.map((row, ri) => {
      const ph = row.map((_, ci) => `$${ri * cols + ci + 1}`);
      values.push(...row);
      return `(${ph.join(',')})`;
    });
    const res = await db.query(
      `INSERT INTO ${table} (${columns.join(',')}) VALUES ${tuples.join(',')} ${conflictClause}`,
      values,
    );
    written += res.rowCount ?? 0;
  }
  return written;
}
