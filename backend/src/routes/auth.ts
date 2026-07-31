import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import bcrypt from 'bcryptjs';
import { query } from '../db/pool.js';
import { config } from '../config.js';

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

/** Minimum length for a NEW password. Deliberately not applied at login. */
export const MIN_PASSWORD_LENGTH = 8;

/**
 * Shape-only parse, shared by both routes: is this a well-formed credential
 * pair at all? It makes no judgement about whether the credentials are correct.
 */
function parseCredentials(body: unknown): { email: string; password: string } | null {
  const { email, password } = (body ?? {}) as Credentials;
  if (typeof email !== 'string' || typeof password !== 'string') return null;
  const trimmed = email.trim().toLowerCase();
  if (!trimmed || !password) return null;
  return { email: trimmed, password };
}

// The two fixed unauthenticated responses. Both are module-level constants so
// there is exactly one of each and no call site can drift into a variant that
// says a little more.
//
// GENERIC_LOGIN_FAILURE also removed an oracle: parseCredentials used to reject
// a password shorter than 8 characters, so a 5-character guess got a 400 while a
// 20-character wrong one got a 401. Any response that varies with the SUBMITTED
// SECRET rather than with request well-formedness is worth deleting. Unknown
// email, wrong password and short password now all return this identical 401;
// the length rule still applies where it belongs, at registration.

/** Every well-formed but wrong credential, regardless of why it was wrong. */
const GENERIC_LOGIN_FAILURE = { error: 'invalid credentials' } as const;

/** Uniform response while registration is closed (see config.allowAgencyRegistration). */
const REGISTRATION_CLOSED = { error: 'not_found' } as const;

// Guard usable by later phases' routes.
export async function requireAuth(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!req.session.userId) {
    await reply.code(401).send({ error: 'unauthorized' });
  }
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Agency registration — CLOSED BY DEFAULT.
   *
   * This route mints a user who can read and write EVERY account, so leaving it
   * open to the internet is a full compromise of every connected brand. It is
   * gated on config.allowAgencyRegistration (env ALLOW_AGENCY_REGISTRATION,
   * which must be exactly 'true'), and the gate is the FIRST thing that runs —
   * before body parsing, before any database read.
   *
   * While closed it answers 404 with a fixed body, identical for a malformed
   * payload, a novel email, and an email that already exists. So it neither
   * confirms that agency registration exists here nor works as an account
   * enumeration oracle.
   *
   * Preferred way to create the first user, including in production, is
   * `npm run bootstrap:user` — it writes to Postgres directly and needs no HTTP
   * route open at all.
   */
  app.post('/auth/register', async (req, reply) => {
    if (!config.allowAgencyRegistration) {
      return reply.code(404).send(REGISTRATION_CLOSED);
    }
    const creds = parseCredentials(req.body);
    if (!creds || creds.password.length < MIN_PASSWORD_LENGTH) {
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

  /**
   * Agency login — rate-limited per source IP.
   *
   * Backend-enforced, Redis-backed, so the limit holds across API processes; a
   * browser-side throttle would be advice, not a control. 10 attempts per 5
   * minutes is generous for a human mistyping a password and useless for
   * credential stuffing, and because the window rolls rather than latching,
   * a legitimate user is delayed rather than locked out.
   *
   * FAIL-OPEN ON A REDIS OUTAGE is deliberate and inherited from the global
   * `skipOnError: true` in index.ts. Failing closed would turn a Redis blip into
   * a total agency lockout with no way to log in and fix it; the password hash
   * check is the actual barrier, and throttling is defence in depth on top of it.
   * The tradeoff is that an attacker who can take Redis down also removes the
   * throttle — accepted, and asserted in group J so the choice stays visible.
   *
   * The 429 body comes from @fastify/rate-limit and contains only a status,
   * an error name and a retry hint: it never echoes the submitted email or
   * password, which group J asserts directly.
   */
  app.post(
    '/auth/login',
    {
      config: {
        rateLimit: {
          max: 10,
          timeWindow: '5 minutes',
        },
      },
    },
    async (req, reply) => {
      const creds = parseCredentials(req.body);
      // A missing or non-string field is a MALFORMED REQUEST, not a failed
      // credential, so it keeps its 400. Everything that is a well-formed but
      // wrong credential collapses into one identical 401 below.
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
        return reply.code(401).send(GENERIC_LOGIN_FAILURE);
      }
      req.session.userId = user.id;
      req.session.email = user.email;
      return reply.send({ id: user.id, email: user.email });
    },
  );

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
