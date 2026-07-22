import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual, createHmac } from 'node:crypto';
import { config } from './config.js';

// AES-256-GCM for connection credentials at rest (§0 data handling).
// ENCRYPTION_KEY is a base64-encoded 32-byte key.
const KEY = Buffer.from(config.encryptionKey, 'base64');
if (KEY.length !== 32) {
  throw new Error(`ENCRYPTION_KEY must decode to 32 bytes (got ${KEY.length}). Provide a base64-encoded 256-bit key.`);
}

const IV_BYTES = 12;

// Serialized form: <iv>.<authTag>.<ciphertext>, all base64.
export function encrypt(plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', KEY, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}.${tag.toString('base64')}.${ct.toString('base64')}`;
}

export function decrypt(serialized: string): string {
  const [ivB64, tagB64, ctB64] = serialized.split('.');
  if (!ivB64 || !tagB64 || !ctB64) throw new Error('Malformed ciphertext');
  const decipher = createDecipheriv('aes-256-gcm', KEY, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]).toString('utf8');
}

// Shopify webhook HMAC: base64(HMAC-SHA256(rawBody, apiSecret)) compared to
// the X-Shopify-Hmac-Sha256 header, in constant time.
export function verifyShopifyHmac(rawBody: Buffer, headerHmac: string | undefined, secret: string): boolean {
  if (!headerHmac || !secret) return false;
  const digest = createHmac('sha256', secret).update(rawBody).digest();
  let provided: Buffer;
  try {
    provided = Buffer.from(headerHmac, 'base64');
  } catch {
    return false;
  }
  return digest.length === provided.length && timingSafeEqual(digest, provided);
}
