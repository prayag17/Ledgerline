import { createHmac, timingSafeEqual } from 'node:crypto';

export const SIGNATURE_HEADER = 'ledgerline-signature';

function hmac(secret: string, timestamp: number, body: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

/**
 * Header format: `t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>`.
 * The timestamp is signed too, so a captured delivery cannot be replayed outside the tolerance window.
 */
export function signPayload(secret: string, body: string, timestamp = Math.floor(Date.now() / 1000)): string {
  return `t=${timestamp},v1=${hmac(secret, timestamp, body)}`;
}

export function verifySignature(
  secret: string,
  body: string,
  header: string | undefined,
  { toleranceSeconds = 300, now = Math.floor(Date.now() / 1000) } = {},
): boolean {
  if (!header) return false;
  let timestamp: number | undefined;
  const signatures: string[] = [];
  for (const part of header.split(',')) {
    const [k, v] = part.split('=', 2);
    if (k === 't' && v && /^\d+$/.test(v)) timestamp = Number(v);
    else if (k === 'v1' && v) signatures.push(v);
  }
  if (timestamp === undefined || signatures.length === 0) return false;
  if (Math.abs(now - timestamp) > toleranceSeconds) return false;
  const expected = Buffer.from(hmac(secret, timestamp, body), 'hex');
  // several v1 values are allowed so secrets can be rotated without downtime
  return signatures.some((sig) => {
    const given = Buffer.from(sig, 'hex');
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}
