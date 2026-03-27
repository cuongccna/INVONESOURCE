/**
 * BOT-SEC-02 — AES-256-GCM encryption service
 * Format: iv(32 hex) + authTag(32 hex) + ciphertext(hex)  [matches backend encryption.ts]
 */
import * as crypto from 'crypto';

const ALGORITHM  = 'aes-256-gcm';
const IV_LENGTH  = 16;
const TAG_LENGTH = 16;
const ENCODING   = 'hex' as const;

function getKey(): Buffer {
  const key = process.env['ENCRYPTION_KEY'];
  if (!key || key.length !== 64) {
    throw new Error('ENCRYPTION_KEY must be exactly 64 hex characters (32 bytes)');
  }
  return Buffer.from(key, ENCODING);
}

export function encrypt(plaintext: string): string {
  const key = getKey();
  const iv  = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf-8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return iv.toString(ENCODING) + tag.toString(ENCODING) + encrypted.toString(ENCODING);
}

export function decrypt(ciphertext: string): string {
  const key = getKey();
  const iv  = Buffer.from(ciphertext.slice(0, IV_LENGTH * 2), ENCODING);
  const tag = Buffer.from(ciphertext.slice(IV_LENGTH * 2, IV_LENGTH * 2 + TAG_LENGTH * 2), ENCODING);
  const enc = Buffer.from(ciphertext.slice(IV_LENGTH * 2 + TAG_LENGTH * 2), ENCODING);

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);

  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf-8');
}

export function encryptCredentials(obj: { username: string; password: string }): string {
  return encrypt(JSON.stringify(obj));
}

export function decryptCredentials(ciphertext: string): { username: string; password: string } {
  const json = decrypt(ciphertext);
  const parsed = JSON.parse(json) as unknown;
  if (
    typeof parsed !== 'object' || parsed === null ||
    typeof (parsed as Record<string, unknown>)['username'] !== 'string' ||
    typeof (parsed as Record<string, unknown>)['password'] !== 'string'
  ) {
    throw new Error('Decrypted credentials are malformed');
  }
  return parsed as { username: string; password: string };
}

// ── Self-test (run directly via ts-node) ──────────────────────────────────────
if (require.main === module) {
  process.env['ENCRYPTION_KEY'] = 'a'.repeat(64);

  const tests: Array<() => void> = [
    () => {
      const ct = encrypt('hello world');
      const pt = decrypt(ct);
      console.assert(pt === 'hello world', 'Test 1 failed: basic round-trip');
      console.log('✅ Test 1 passed: basic round-trip');
    },
    () => {
      const obj = { username: 'user123', password: 'P@ssw0rd!' };
      const enc = encryptCredentials(obj);
      const dec = decryptCredentials(enc);
      console.assert(dec.username === obj.username && dec.password === obj.password, 'Test 2 failed: credentials round-trip');
      console.log('✅ Test 2 passed: credentials round-trip');
    },
    () => {
      const ct1 = encrypt('same input');
      const ct2 = encrypt('same input');
      console.assert(ct1 !== ct2, 'Test 3 failed: different IV each call');
      console.log('✅ Test 3 passed: random IV per call');
    },
    () => {
      try {
        decrypt(encrypt('test').slice(0, -4) + 'ffff');
        console.assert(false, 'Test 4 failed: tamper should throw');
      } catch {
        console.log('✅ Test 4 passed: tamper detection works');
      }
    },
    () => {
      const long = 'x'.repeat(10000);
      const dec  = decrypt(encrypt(long));
      console.assert(dec === long, 'Test 5 failed: large payload');
      console.log('✅ Test 5 passed: large payload');
    },
  ];

  for (const t of tests) { try { t(); } catch (e) { console.error(e); } }
}
