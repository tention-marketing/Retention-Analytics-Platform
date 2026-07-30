import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import session from '@fastify/session';
import rateLimit from '@fastify/rate-limit';
import { config } from './config.js';
import { pool } from './db/pool.js';
import { redis } from './queue/queues.js';
import { authRoutes } from './routes/auth.js';
import { accountRoutes } from './routes/accounts.js';
import { connectionRoutes } from './routes/connections.js';
import { webhookRoutes } from './routes/webhooks.js';
import { agencyOnboardingRoutes } from './routes/agencyOnboarding.js';
import { onboardingRoutes } from './routes/onboarding.js';
import { registerOnboardingSessionSupport } from './onboarding/session.js';

export function buildApp() {
  const app = Fastify({ logger: true });

  app.register(cookie);

  // AGENCY session (auth level P). Cookie tention_sid, decorator request.session.
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

  // CLIENT onboarding session (auth level L). Cookie tention_onb, decorator
  // request.onboarding. Completely disjoint from the agency session above
  // (Correction 5): different cookie name, different decorator, its own signing,
  // no shared store — so exchanging an onboarding token can never convert,
  // replace, or inherit an agency session, and logging out of either one cannot
  // affect the other.
  registerOnboardingSessionSupport(app);

  // Rate limiting, applied PER-ROUTE rather than globally (E7).
  //
  // Redis-backed so the limit holds across processes. skipOnError:true means a
  // Redis outage lets requests through rather than locking onboarding out: the
  // token carries 256 bits of entropy, so throttling is defence in depth rather
  // than the barrier to guessing, and the rest of the wizard already degrades
  // gracefully without Redis. Raw tokens are never logged — they arrive only in a
  // POST body, which Fastify does not log, and the limiter keys on req.ip.
  app.register(rateLimit, {
    global: false,
    redis,
    skipOnError: true,
    keyGenerator: (req) => req.ip,
  });

  app.get('/health', async () => {
    await pool.query('SELECT 1');
    return { ok: true };
  });

  app.register(authRoutes);
  app.register(accountRoutes);
  app.register(connectionRoutes);
  app.register(agencyOnboardingRoutes);
  app.register(onboardingRoutes);
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
