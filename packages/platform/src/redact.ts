/**
 * Field names whose values must never reach logs, error reports or AI context (NFR-09, TH-SEC §2).
 * Keys are normalised (lower-case, punctuation removed) and matched at any depth.
 */
const CONTAINS = [
  'password',
  'passphrase',
  'secret',
  'token',
  'authorization',
  'authorisation',
  'cookie',
  'apikey',
  'privatekey',
  'mnemonic',
  'seedphrase',
  'cardnumber',
  'accountnumber',
  'iban',
  'routingnumber',
  'passport',
  'nationalid',
  'licensenumber',
  'mfacode',
  'totp',
  'cvv',
  'cvc',
];
/** Short names that would over-match as substrings ("otp" in "footprint"), so match as suffix. */
const SUFFIX = ['otp', 'pin', 'pan', 'ssn', 'seed', 'signature'];

export const REDACTED = '[REDACTED]';

export function isSensitiveKey(key: string): boolean {
  const k = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  return CONTAINS.some((s) => k.includes(s)) || SUFFIX.some((s) => k.endsWith(s));
}

/** Runs of 13–19 digits (optionally spaced or dashed) — the shape of a payment card number. */
const DIGIT_RUN = /\b\d(?:[ -]?\d){12,18}\b/g;

function passesLuhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/** Masks anything in free text that looks like a real card number (digit run that passes Luhn). */
export function redactString(value: string): string {
  return value.replace(DIGIT_RUN, (match) =>
    passesLuhn(match.replace(/[ -]/g, '')) ? REDACTED : match,
  );
}

/** Returns a deep copy with sensitive values replaced. Handles cycles and caps depth. */
export function redact<T>(value: T, depth = 0, seen = new WeakSet<object>()): T {
  if (depth > 12) return '[TRUNCATED]' as T;
  if (typeof value === 'string') return redactString(value) as T;
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date) return value;
  if (seen.has(value)) return '[CIRCULAR]' as T;
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((v) => redact(v, depth + 1, seen)) as T;
  }
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactString(value.message),
      stack: value.stack ? redactString(value.stack) : undefined,
    } as T;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = isSensitiveKey(k) ? REDACTED : redact(v, depth + 1, seen);
  }
  return out as T;
}
