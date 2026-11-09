/**
 * Deep redaction for anything that is logged or traced.
 * Rule (AGENTS.md): logs and traces never contain amounts, payees, IBANs or credentials.
 */

export const REDACTED = '[redacted]';
export const IBAN_PLACEHOLDER = '[iban]';

/** Keys whose values are dropped (key kept, value replaced). */
export const SENSITIVE_KEY =
  /amount|iban|counterparty|purpose|payee|password|pin|tan|token|secret|key|balance|email|authorization|cookie|credential|^params$/i;

/** Keys that look sensitive or contain hex ids but are safe correlation fields. */
const SAFE_KEYS = new Set(['trace_id', 'span_id', 'traceId', 'spanId', 'trace_flags']);

/** IBAN-looking: 2 letters, 2 digits, then 2-7 groups of 4 and a 1-3 char tail (optionally space-grouped). */
const IBAN_PATTERN = /\b[A-Za-z]{2}\d{2}(?: ?[A-Za-z0-9]{4}){2,7}(?: ?[A-Za-z0-9]{1,3})?\b/g;

/** drizzle-orm query errors append `\nparams: <bound values>` to the message: cut it off. */
const QUERY_PARAMS_TAIL = /\r?\nparams:[\s\S]*$/;

export function redactString(value: string): string {
  return value
    .replace(QUERY_PARAMS_TAIL, '\nparams: [redacted]')
    .replace(IBAN_PATTERN, IBAN_PLACEHOLDER);
}

/**
 * Minimal, value-free description of an unexpected error for logs: class name plus the Postgres
 * error code/constraint when present. Never the message, which may embed query parameters.
 */
export function safeErrorInfo(err: unknown): { type: string; code?: string; constraint?: string } {
  const e = err as {
    name?: unknown;
    code?: unknown;
    constraint?: unknown;
    cause?: { code?: unknown; constraint?: unknown } | null;
  } | null;
  const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
  const code = str(e?.cause?.code) ?? str(e?.code);
  const constraint = str(e?.cause?.constraint) ?? str(e?.constraint);
  return {
    type: str(e?.name) ?? 'Error',
    ...(code ? { code } : {}),
    ...(constraint ? { constraint } : {}),
  };
}

export function isSensitiveKey(key: string): boolean {
  return !SAFE_KEYS.has(key) && SENSITIVE_KEY.test(key);
}

function walk(value: unknown, ancestors: Set<object>): unknown {
  switch (typeof value) {
    case 'string':
      return redactString(value);
    case 'bigint':
      return value.toString();
    case 'function':
    case 'symbol':
      return undefined;
    case 'object':
      break;
    default:
      return value; // number, boolean, undefined
  }
  if (value === null) return null;
  if (Buffer.isBuffer(value) || ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
    return '[binary]';
  }
  if (value instanceof Date) return value.toISOString();
  if (ancestors.has(value)) return '[circular]';
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return value.map((v) => walk(v, ancestors));
    const out: Record<string, unknown> = {};
    if (value instanceof Error) {
      out['type'] = value.name;
      out['message'] = redactString(value.message);
      if (value.stack !== undefined) out['stack'] = redactString(value.stack);
    }
    for (const [k, v] of Object.entries(value)) {
      if (value instanceof Error && (k === 'message' || k === 'stack' || k === 'type')) continue;
      out[k] = isSensitiveKey(k) ? REDACTED : walk(v, ancestors);
    }
    return out;
  } finally {
    ancestors.delete(value);
  }
}

/** Returns a redacted deep copy; never mutates the input. */
export function redact(value: unknown): unknown {
  return walk(value, new Set());
}
