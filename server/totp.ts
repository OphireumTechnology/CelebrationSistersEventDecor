import crypto from 'node:crypto';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function generateTotpSecret(byteLength = 20): string {
  const bytes = crypto.randomBytes(byteLength);
  let bits = 0;
  let value = 0;
  let output = '';

  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}

export function decodeBase32(secret: string): Buffer {
  const normalized = secret.toUpperCase().replace(/=+$/, '').replace(/[\s-]/g, '');
  if (!normalized || /[^A-Z2-7]/.test(normalized)) {
    throw new Error('INVALID_BASE32_SECRET');
  }

  let bits = 0;
  let value = 0;
  const bytes: number[] = [];

  for (const ch of normalized) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/**
 * Generates an RFC 6238 / RFC 4226 6-digit TOTP code for a given Base32 secret and epoch ms.
 */
export function generateTotpCode(secret: string, timestampMs = Date.now(), periodSeconds = 30, digits = 6): string {
  const key = decodeBase32(secret);
  const counter = Math.floor(timestampMs / 1000 / periodSeconds);
  const counterBuf = Buffer.alloc(8);
  counterBuf.writeBigUInt64BE(BigInt(counter));

  const hmac = crypto.createHmac('sha1', key).update(counterBuf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);

  const otp = binary % 10 ** digits;
  return otp.toString().padStart(digits, '0');
}

/**
 * Verifies an RFC 6238 6-digit TOTP code in constant time across +/- windowSteps (default +/- 1 step = +/- 30s).
 */
export function verifyTotpCode(
  secret: string,
  candidateCode: string,
  options?: { timestampMs?: number; windowSteps?: number; periodSeconds?: number },
): boolean {
  const cleaned = candidateCode.trim().replace(/\s+/g, '');
  if (!/^\d{6}$/.test(cleaned)) {
    return false;
  }

  const timestampMs = options?.timestampMs ?? Date.now();
  const windowSteps = options?.windowSteps ?? 1;
  const periodSeconds = options?.periodSeconds ?? 30;
  const providedBuf = Buffer.from(cleaned, 'utf8');

  try {
    for (let step = -windowSteps; step <= windowSteps; step += 1) {
      const expected = generateTotpCode(secret, timestampMs + step * periodSeconds * 1000, periodSeconds, 6);
      const expectedBuf = Buffer.from(expected, 'utf8');
      if (providedBuf.length === expectedBuf.length && crypto.timingSafeEqual(providedBuf, expectedBuf)) {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

export function buildTotpProvisioningUri(accountEmail: string, secret: string, issuer = 'Celebration Sisters Event Decor'): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(accountEmail)}`;
  return `otpauth://totp/${label}?secret=${encodeURIComponent(secret)}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}
