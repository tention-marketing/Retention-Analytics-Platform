import { query } from '../db/pool.js';

// Every job wraps its work in try/catch and records failures here (§2).
export async function logSyncError(
  accountId: number | null,
  jobType: string,
  error: unknown,
  payload?: unknown,
): Promise<void> {
  const message = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error);
  try {
    await query(
      `INSERT INTO sync_errors (account_id, job_type, payload, error) VALUES ($1, $2, $3, $4)`,
      [accountId, jobType, payload != null ? JSON.stringify(payload) : null, message],
    );
  } catch (e) {
    // Last resort: never let error-logging throw over the original failure.
    console.error('failed to record sync_error:', e, 'original:', message);
  }
}
