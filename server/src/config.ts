import 'dotenv/config';

function required(name: string, fallback?: string): string {
  const val = process.env[name] ?? fallback;
  if (val === undefined || val === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return val;
}

export const config = {
  databaseUrl: required('DATABASE_URL', 'postgres://tention:tention@localhost:5432/tention'),
  redisUrl: required('REDIS_URL', 'redis://localhost:6379'),
  sessionSecret: required('SESSION_SECRET', 'dev_session_secret_change_me_min_32_chars'),
  encryptionKey: required('ENCRYPTION_KEY', 'ZGV2X2VuY3J5cHRpb25fa2V5XzMyX2J5dGVzX2xvbmc='),
  port: Number(process.env.PORT ?? 3000),
  nodeEnv: process.env.NODE_ENV ?? 'development',
  isProd: (process.env.NODE_ENV ?? 'development') === 'production',
};
