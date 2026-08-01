import type { FastifyInstance } from 'fastify';
import { query } from '../db/pool.js';
import { requireAuth } from './auth.js';
import { DEFAULT_STORE_TIMEZONE, normalizeStoreTimezone } from '../accounts/timezone.js';

// Minimal account (brand) management. The onboarding wizard UI is Phase 5;
// this is just the API surface Phase 2+ needs to attach connections to a brand.

/**
 * Fixed, machine-readable rejection for a bad `store_timezone`.
 *
 * A module-level constant so there is exactly one of it and no handler can drift
 * into a variant that says more. It carries no echo of the submitted value, no
 * list of accepted names, and — the point — nothing from the database or from an
 * exception: a rejected timezone never reaches Postgres, so there is no driver
 * error to leak, and the check that failed is a pure function.
 */
const INVALID_STORE_TIMEZONE = { error: 'invalid_store_timezone' } as const;

export async function accountRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  app.get('/accounts', async () => {
    const { rows } = await query(
      `SELECT id, name, store_timezone, onboarding_complete, created_at
         FROM accounts ORDER BY id`,
    );
    return rows;
  });

  app.post('/accounts', async (req, reply) => {
    const { name, store_timezone } = (req.body ?? {}) as { name?: unknown; store_timezone?: unknown };
    if (typeof name !== 'string' || !name.trim()) {
      return reply.code(400).send({ error: 'name required' });
    }
    // An OMITTED field and a WRONG one are different requests and get different
    // answers. Omitting `store_timezone` keeps the pre-existing behaviour and
    // the 001_init column default. Supplying anything else — a bogus name, a UTC
    // offset, an empty or whitespace-only string, a number, null, an object — is
    // a 400, because the alternative is an account silently pinned to a timezone
    // nobody chose. Note the check runs BEFORE the INSERT, so a rejected request
    // creates no account and consumes no id.
    let tz = DEFAULT_STORE_TIMEZONE;
    if (store_timezone !== undefined) {
      const normalized = normalizeStoreTimezone(store_timezone);
      if (normalized === null) {
        return reply.code(400).send(INVALID_STORE_TIMEZONE);
      }
      tz = normalized;
    }

    const { rows } = await query<{ id: number }>(
      `INSERT INTO accounts (name, store_timezone) VALUES ($1, $2) RETURNING id`,
      [name.trim(), tz],
    );
    return reply.code(201).send({ id: rows[0].id, name: name.trim(), store_timezone: tz });
  });
}
