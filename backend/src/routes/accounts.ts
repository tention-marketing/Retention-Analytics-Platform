import type { FastifyInstance } from 'fastify';
import { query } from '../db/pool.js';
import { requireAuth } from './auth.js';

// Minimal account (brand) management. The onboarding wizard UI is Phase 5;
// this is just the API surface Phase 2+ needs to attach connections to a brand.
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
    const tz = typeof store_timezone === 'string' && store_timezone.trim()
      ? store_timezone.trim()
      : 'America/Los_Angeles';
    const { rows } = await query<{ id: number }>(
      `INSERT INTO accounts (name, store_timezone) VALUES ($1, $2) RETURNING id`,
      [name.trim(), tz],
    );
    return reply.code(201).send({ id: rows[0].id, name: name.trim(), store_timezone: tz });
  });
}
