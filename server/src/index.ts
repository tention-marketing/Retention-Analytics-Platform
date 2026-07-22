import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import session from '@fastify/session';
import { config } from './config.js';
import { pool } from './db/pool.js';
import { authRoutes } from './routes/auth.js';
import { accountRoutes } from './routes/accounts.js';
import { connectionRoutes } from './routes/connections.js';
import { webhookRoutes } from './routes/webhooks.js';

export function buildApp() {
  const app = Fastify({ logger: true });

  app.register(cookie);
  app.register(session, {
    secret: config.sessionSecret,
    cookieName: 'tention_sid',
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: config.isProd,
      maxAge: 1000 * 60 * 60 * 24 * 7, // 7 days
    },
    saveUninitialized: false,
  });

  app.get('/health', async () => {
    await pool.query('SELECT 1');
    return { ok: true };
  });

  app.register(authRoutes);
  app.register(accountRoutes);
  app.register(connectionRoutes);
  // Webhooks are encapsulated in their own plugin so the raw-body content-type
  // parser (needed for HMAC) doesn't affect the JSON routes above.
  app.register(webhookRoutes);

  return app;
}

async function start(): Promise<void> {
  const app = buildApp();
  try {
    await app.listen({ port: config.port, host: '0.0.0.0' });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

// Only auto-start when run directly (not when imported by tests/scripts).
if (import.meta.url === `file://${process.argv[1]}`) {
  start();
}
