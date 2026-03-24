import * as crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const TAG_LENGTH = 16;
const ENCODING = 'hex' as const;

function getKey(): Buffer {
  const key = process.env['ENCRYPTION_KEY'];
  if (!key || key.length !== 64) {
    throw new Error('ENCRYPTION_KEY must be exactly 64 hex characters (32 bytes)');
  }
  return Buffer.from(key, ENCODING);
}

/**
 * Encrypt plaintext using AES-256-GCM.
 * Output format: iv(32 hex) + authTag(32 hex) + ciphertext(hex)
 */
export function encrypt(plaintext: string): string {
  const key = getKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf-8'),
    cipher.final(),
  ]);

  const tag = cipher.getAuthTag();

  // Prefix: IV (32 hex) + Auth Tag (32 hex) + Ciphertext
  return iv.toString(ENCODING) + tag.toString(ENCODING) + encrypted.toString(ENCODING);
}

/**
 * Decrypt ciphertext previously encrypted with encrypt().
 * Input format: iv(32 hex) + authTag(32 hex) + ciphertext(hex)
 */
export function decrypt(ciphertext: string): string {
  const key = getKey();

  const iv = Buffer.from(ciphertext.slice(0, IV_LENGTH * 2), ENCODING);
  const tag = Buffer.from(
    ciphertext.slice(IV_LENGTH * 2, IV_LENGTH * 2 + TAG_LENGTH * 2),
    ENCODING
  );
  const encrypted = Buffer.from(ciphertext.slice(IV_LENGTH * 2 + TAG_LENGTH * 2), ENCODING);

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);

  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return decrypted.toString('utf-8');
}

/**
 * Encrypt a credentials object (Record<string, string>).
 * Serializes to JSON then encrypts.
 */
export function encryptCredentials(obj: Record<string, string>): string {
  return encrypt(JSON.stringify(obj));
}

/**
 * Decrypt credentials back to a Record<string, string>.
 * Decrypts then parses JSON.
 */
export function decryptCredentials(ciphertext: string): Record<string, string> {
  const json = decrypt(ciphertext);
  return JSON.parse(json) as Record<string, string>;
}
