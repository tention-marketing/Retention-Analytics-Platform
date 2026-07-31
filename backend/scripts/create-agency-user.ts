/**
 * Create an agency staff user, without opening any HTTP route.
 *
 * POST /auth/register is closed by default (config.allowAgencyRegistration), so
 * this is the supported way to create the first user — including in production,
 * where the registration route should stay shut permanently.
 *
 *   npm run bootstrap:user -- you@agency.com
 *   npm run bootstrap:user -- you@agency.com 'a-password-you-chose'
 *
 * With no password argument a 24-byte URL-safe password is generated and printed
 * ONCE. It is never written to a file and never logged anywhere else.
 *
 * Re-running for an existing email RESETS that user's password, which doubles as
 * the recovery path when someone is locked out. It is stated explicitly in the
 * output rather than happening silently.
 */
import { randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { pool, query } from '../src/db/pool.js';

const MIN_PASSWORD_LENGTH = 8;

function usage(message: string): never {
  console.error(`\n${message}\n`);
  console.error('Usage: npm run bootstrap:user -- <email> [password]');
  console.error('       (omit the password to have a strong one generated)\n');
  process.exit(1);
}

async function main(): Promise<void> {
  const [emailRaw, passwordRaw] = process.argv.slice(2);

  if (!emailRaw) usage('An email address is required.');
  const email = emailRaw.trim().toLowerCase();
  // Deliberately loose: this is an operator tool, not a signup form. The only
  // thing that matters is that it round-trips with the login route, which
  // lowercases and trims identically.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) usage(`Not a valid email address: ${emailRaw}`);

  const generated = passwordRaw === undefined;
  const password = generated ? randomBytes(24).toString('base64url') : passwordRaw;
  if (password.length < MIN_PASSWORD_LENGTH) {
    usage(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }

  const existing = await query<{ id: number }>('SELECT id FROM users WHERE email = $1', [email]);
  const isReset = (existing.rowCount ?? 0) > 0;

  const hash = await bcrypt.hash(password, 10);
  const { rows } = await query<{ id: number; email: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, $2)
     ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash
     RETURNING id, email`,
    [email, hash],
  );

  console.log('');
  console.log(isReset ? '  Password RESET for existing agency user' : '  Agency user created');
  console.log(`  id:    ${rows[0].id}`);
  console.log(`  email: ${rows[0].email}`);
  if (generated) {
    console.log(`  password: ${password}`);
    console.log('\n  This password is shown once and is not stored anywhere in plaintext.');
  }
  console.log('');
}

main()
  .then(() => pool.end())
  .catch(async (err) => {
    console.error('\nFAILED:', err instanceof Error ? err.message : err);
    await pool.end().catch(() => undefined);
    process.exit(1);
  });
