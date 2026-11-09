import { isSpanContextValid, trace } from '@opentelemetry/api';
import { pino, type DestinationStream, type Logger, type LoggerOptions } from 'pino';
import { isSensitiveKey, redact, redactString, REDACTED } from './redact.js';

export type { Logger };

export interface CreateLoggerOptions {
  level?: string;
  destination?: DestinationStream;
}

interface RawRequest {
  method?: string;
  url?: string;
  ip?: string;
  remoteAddress?: string;
}
interface RawReply {
  statusCode?: number;
}

function serializeReq(req: RawRequest) {
  return {
    method: req.method,
    url: sanitizeUrl(req.url ?? ''),
    remoteAddress: req.ip ?? req.remoteAddress,
  };
}

function serializeRes(reply: RawReply) {
  return { statusCode: reply.statusCode };
}

function asRecord(value: unknown): Record<string, unknown> {
  return (value ?? {}) as Record<string, unknown>;
}

/**
 * JSON pino logger. Every log call is redacted (object fields via `formatters.log`, message
 * and interpolation args via `hooks.logMethod`) and carries `trace_id`/`span_id` of the active span.
 */
export function createLogger(options: CreateLoggerOptions = {}): Logger {
  const config: LoggerOptions = {
    level: options.level ?? 'info',
    serializers: { req: serializeReq, res: serializeRes },
    mixin() {
      const ctx = trace.getActiveSpan()?.spanContext();
      return ctx && isSpanContextValid(ctx) ? { trace_id: ctx.traceId, span_id: ctx.spanId } : {};
    },
    formatters: {
      // pino runs formatters.log before serializers, so req/res are reduced to their safe
      // subset here first (the serializers are idempotent and run again afterwards).
      log: (obj) => {
        const o: Record<string, unknown> = { ...obj };
        if ('req' in o) o['req'] = serializeReq(o['req'] as RawRequest);
        if ('res' in o) o['res'] = serializeRes(o['res'] as RawReply);
        // Trace ids are hex and can look like an IBAN; keep them out of redaction.
        // Only values equal to the active span context are trusted; caller-supplied ones are redacted.
        const ctx = trace.getActiveSpan()?.spanContext();
        const active = ctx && isSpanContextValid(ctx) ? ctx : undefined;
        const { trace_id, span_id, ...rest } = o;
        const redacted = asRecord(redact({ ...rest, trace_id, span_id }));
        if (active && trace_id === active.traceId) redacted['trace_id'] = trace_id;
        if (active && span_id === active.spanId) redacted['span_id'] = span_id;
        return redacted;
      },
      bindings: (bindings) => asRecord(redact(bindings)),
    },
    hooks: {
      logMethod(args, method) {
        const [first, ...rest] = args as unknown[];
        const safeRest = rest.map((a) => (typeof a === 'string' ? redactString(a) : redact(a)));
        if (first instanceof Error) {
          // pino derives msg from err.message; redact it explicitly.
          const msg = typeof safeRest[0] === 'string' ? [] : [redactString(first.message)];
          return (method as (...a: unknown[]) => void).apply(this, [
            { err: first },
            ...msg,
            ...safeRest,
          ]);
        }
        const safeFirst = typeof first === 'string' ? redactString(first) : first;
        return (method as (...a: unknown[]) => void).apply(this, [safeFirst, ...safeRest]);
      },
    },
  };
  return options.destination ? pino(config, options.destination) : pino(config);
}

/** Request URL with sensitive query params replaced and IBANs masked; path kept for debugging. */
export function sanitizeUrl(url: string): string {
  const q = url.indexOf('?');
  if (q === -1) return redactString(url);
  const params = new URLSearchParams(url.slice(q + 1));
  const parts: string[] = [];
  for (const [k, v] of params) {
    const val = isSensitiveKey(k) ? REDACTED : redactString(v);
    parts.push(
      `${encodeURIComponent(k)}=${val === REDACTED ? 'redacted' : encodeURIComponent(val)}`,
    );
  }
  return redactString(url.slice(0, q)) + (parts.length ? `?${parts.join('&')}` : '');
}

/**
 * Fastify options (spread into `Fastify(...)`). The logger must come from `createLogger`, whose
 * req/res serializers keep only method, sanitized url, remote address and status: no bodies, no
 * headers (`authorization`, `cookie`, ...), no sensitive query params.
 */
export function fastifyLoggerOptions(logger: Logger): { loggerInstance: Logger } {
  return { loggerInstance: logger };
}
