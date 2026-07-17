import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import bcrypt from 'bcryptjs';
import { query } from '../db/pool.js';

// Session shape (agency staff only — session email+password per §0 auth).
declare module '@fastify/session' {
  interface FastifySessionObject {
    userId?: number;
    email?: string;
  }
}

interface Credentials {
  email?: unknown;
  password?: unknown;
}

function parseCredentials(body: unknown): { email: string; password: string } | null {
  const { email, password } = (body ?? {}) as Credentials;
  if (typeof email !== 'string' || typeof password !== 'string') return null;
  const trimmed = email.trim().toLowerCase();
  if (!trimmed || password.length < 8) return null;
  return { email: trimmed, password };
}

// Guard usable by later phases' routes.
export async function requireAuth(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!req.session.userId) {
    await reply.code(401).send({ error: 'unauthorized' });
  }
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post('/auth/register', async (req, reply) => {
    const creds = parseCredentials(req.body);
    if (!creds) {
      return reply.code(400).send({ error: 'email and password (min 8 chars) required' });
    }
    const existing = await query('SELECT id FROM users WHERE email = $1', [creds.email]);
    if (existing.rowCount && existing.rowCount > 0) {
      return reply.code(409).send({ error: 'email already registered' });
    }
    const hash = await bcrypt.hash(creds.password, 10);
    const { rows } = await query<{ id: number; email: string }>(
      'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id, email',
      [creds.email, hash],
    );
    const user = rows[0];
    req.session.userId = user.id;
    req.session.email = user.email;
    return reply.code(201).send({ id: user.id, email: user.email });
  });

  app.post('/auth/login', async (req, reply) => {
    const creds = parseCredentials(req.body);
    if (!creds) {
      return reply.code(400).send({ error: 'email and password required' });
    }
    const { rows } = await query<{ id: number; email: string; password_hash: string }>(
      'SELECT id, email, password_hash FROM users WHERE email = $1',
      [creds.email],
    );
    const user = rows[0];
    // Compare even when the user is missing to avoid leaking existence via timing.
    const ok = user
      ? await bcrypt.compare(creds.password, user.password_hash)
      : await bcrypt.compare(creds.password, '$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinv');
    if (!user || !ok) {
      return reply.code(401).send({ error: 'invalid credentials' });
    }
    req.session.userId = user.id;
    req.session.email = user.email;
    return reply.send({ id: user.id, email: user.email });
  });

  app.post('/auth/logout', async (req, reply) => {
    await req.session.destroy();
    return reply.send({ ok: true });
  });

  app.get('/auth/me', async (req, reply) => {
    if (!req.session.userId) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    return reply.send({ id: req.session.userId, email: req.session.email });
  });
}
