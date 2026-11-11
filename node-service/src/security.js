import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export function cipher(base64) {
  const key = Buffer.from(base64 ?? '', 'base64');
  if (key.length !== 32) throw new Error('DATA_ENCRYPTION_KEY_BASE64 must encode 32 bytes');
  return {
    encrypt(value) {
      const iv = randomBytes(12);
      const aes = createCipheriv('aes-256-gcm', key, iv);
      const body = Buffer.concat([aes.update(value, 'utf8'), aes.final()]);
      return Buffer.concat([iv, aes.getAuthTag(), body]).toString('base64');
    },
    decrypt(value) {
      const raw = Buffer.from(value, 'base64');
      const aes = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
      aes.setAuthTag(raw.subarray(12, 28));
      return Buffer.concat([aes.update(raw.subarray(28)), aes.final()]).toString('utf8');
    }
  };
}
