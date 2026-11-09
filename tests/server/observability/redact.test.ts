import { Writable } from 'node:stream';
import { context, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { TracerProvider } from '@opentelemetry/sdk-trace';
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLogger, fastifyLoggerOptions } from '@budgedino/server/observability/logger';
import { redact, redactString, safeErrorInfo } from '@budgedino/server/observability/redact';
import { startTelemetry } from '@budgedino/server/observability/otel';

const IBAN = 'DE89370400440532013000';

function capture() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _enc, cb) {
      lines.push(chunk.toString());
      cb();
    },
  });
  return { lines, stream, text: () => lines.join('') };
}

describe('redact', () => {
  it('replaces sensitive keys and IBANs inside strings', () => {
    const out = redact({
      amount: 5,
      nested: { iban: IBAN },
      note: `paid ${IBAN} yesterday`,
      ok: 'fine',
    });
    expect(out).toEqual({
      amount: '[redacted]',
      nested: { iban: '[redacted]' },
      note: 'paid [iban] yesterday',
      ok: 'fine',
    });
  });

  it('matches IBANs with spaces and lowercase', () => {
    expect(redact('x DE89 3704 0044 0532 0130 00 y')).toBe('x [iban] y');
    expect(redact('de89370400440532013000')).toBe('[iban]');
  });

  it('handles arrays, cycles, errors, buffers, bigint, primitives', () => {
    const a: Record<string, unknown> = { name: 'a' };
    a['self'] = a;
    const cyc = redact(a) as Record<string, unknown>;
    expect(cyc['name']).toBe('a');
    expect(cyc['self']).toBe('[circular]');

    expect(redact([{ token: 't' }, 'x'])).toEqual([{ token: '[redacted]' }, 'x']);

    const err = redact(new Error(`bad ${IBAN}`)) as Record<string, unknown>;
    expect(err['message']).toBe('bad [iban]');
    expect(typeof err['stack']).toBe('string');
    expect(String(err['stack'])).not.toContain(IBAN);

    expect(redact({ data: Buffer.from('secretbytes') })).toEqual({ data: '[binary]' });
    expect(redact({ balance: 10n, count: 10n })).toEqual({ balance: '[redacted]', count: '10' });
    expect(redact(null)).toBeNull();
    expect(redact(3)).toBe(3);
  });
});

describe('logger', () => {
  it('drops amounts and IBANs from log lines', () => {
    const cap = capture();
    const log = createLogger({ destination: cap.stream });
    log.info({ amount: 5, nested: { iban: IBAN }, note: `paid ${IBAN}` }, `msg ${IBAN}`);
    const text = cap.text();
    expect(text).not.toContain(IBAN);
    const rec = JSON.parse(text) as Record<string, unknown>;
    expect(rec['amount']).toBe('[redacted]');
    expect(rec['msg']).toBe('msg [iban]');
  });

  describe('trace correlation', () => {
    const cm = new AsyncLocalStorageContextManager().enable();
    beforeAll(() => {
      context.setGlobalContextManager(cm);
    });
    afterAll(() => {
      context.disable();
    });

    it('keeps IBAN-looking trace and span ids verbatim', () => {
      const cap = capture();
      const log = createLogger({ destination: cap.stream });
      const traceId = 'ab120123456789abcdef0123456789ab';
      const spanId = 'cd340123456789ab';
      const tracer = new TracerProvider({
        idGenerator: { generateTraceId: () => traceId, generateSpanId: () => spanId },
      }).getTracer('t');
      tracer.startActiveSpan('op', (span) => {
        log.info('inside');
        span.end();
      });
      const rec = JSON.parse(cap.text()) as Record<string, unknown>;
      expect(rec['trace_id']).toBe(traceId);
      expect(rec['span_id']).toBe(spanId);
    });

    it('drops caller-supplied trace_id/span_id; active span ids always win', () => {
      const cap = capture();
      const log = createLogger({ destination: cap.stream });
      log.info({ trace_id: IBAN, span_id: IBAN }, 'outside');
      const out = JSON.parse(cap.lines[0] ?? '{}') as Record<string, unknown>;
      expect('trace_id' in out).toBe(false);
      expect('span_id' in out).toBe(false);
      const tracer = new TracerProvider().getTracer('t');
      tracer.startActiveSpan('op', (span) => {
        log.info({ trace_id: IBAN, span_id: 'DE89' }, 'inside');
        const sc = span.spanContext();
        const rec = JSON.parse(cap.lines[1] ?? '{}') as Record<string, unknown>;
        expect(rec['trace_id']).toBe(sc.traceId);
        expect(rec['span_id']).toBe(sc.spanId);
        expect(cap.lines[1]).not.toContain('DE89');
        span.end();
      });
      expect(cap.text()).not.toContain(IBAN);
    });

    it('includes trace_id and span_id inside an active span', () => {
      const provider = new TracerProvider();
      const tracer = provider.getTracer('test');
      const cap = capture();
      const log = createLogger({ destination: cap.stream });
      tracer.startActiveSpan('op', (span) => {
        log.info('inside');
        const sc = span.spanContext();
        const rec = JSON.parse(cap.text()) as Record<string, unknown>;
        expect(rec['trace_id']).toBe(sc.traceId);
        expect(rec['span_id']).toBe(sc.spanId);
        span.end();
      });
      log.info('outside');
      const last = JSON.parse(cap.lines[1] ?? '{}') as Record<string, unknown>;
      expect(last['trace_id']).toBeUndefined();
      expect(trace.getActiveSpan()).toBeUndefined();
    });
  });
});

describe('fastify request logs', () => {
  it('omit bodies, authorization/cookie headers and sensitive query params', async () => {
    const cap = capture();
    const logger = createLogger({ destination: cap.stream });
    const app = Fastify(fastifyLoggerOptions(logger));
    app.post('/x', async () => ({ ok: true, amount: 1 }));
    const res = await app.inject({
      method: 'POST',
      url: `/x?token=abc123&page=2&iban=${IBAN}`,
      headers: { authorization: 'Bearer supersecret', cookie: 'sid=cookiesecret' },
      payload: { amount: 4242, payee: 'Alice Landlord', iban: IBAN },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
    const text = cap.text();
    expect(text).toContain('/x');
    expect(text).toContain('page=2');
    for (const leak of ['supersecret', 'cookiesecret', 'abc123', '4242', 'Alice Landlord', IBAN]) {
      expect(text).not.toContain(leak);
    }
    expect(text.toLowerCase()).not.toContain('"authorization"');
  });
});

describe('startTelemetry', () => {
  it('is a no-op without OTEL_EXPORTER_OTLP_ENDPOINT', async () => {
    const t = startTelemetry({});
    expect(t.enabled).toBe(false);
    await expect(t.shutdown()).resolves.toBeUndefined();
  });

  it('starts and shuts down when an endpoint is configured', async () => {
    const t = startTelemetry({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:9' });
    expect(t.enabled).toBe(true);
    await t.shutdown().catch(() => undefined);
  });
});

describe('query error redaction', () => {
  const HASH = '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHQ$c29tZWhhc2hzb21laGFzaA';

  function drizzleLikeError() {
    const err = new Error(
      `Failed query: insert into "members" ("password_hash") values ($1)\nparams: ${HASH}`,
    );
    err.name = 'DrizzleQueryError';
    Object.assign(err, { params: [HASH], query: 'insert into "members" ...' });
    return err;
  }

  it('never lets bound query params reach a log line', () => {
    const sink = capture();
    const logger = createLogger({ destination: sink.stream });
    const err = drizzleLikeError();
    logger.error({ err }, err.message);
    logger.error(err);
    logger.error({ detail: err.message }, 'failed');
    expect(sink.text()).not.toContain('argon2id');
    expect(sink.text()).not.toContain('c29tZWhhc2g');
    expect(sink.text()).toContain('DrizzleQueryError');
  });

  it('redacts a params key and the params tail of strings', () => {
    expect(redact({ params: [HASH], other: 1 })).toEqual({ params: '[redacted]', other: 1 });
    expect(redactString(`Failed query: select 1\nparams: ${HASH}`)).not.toContain('argon2id');
  });

  it('safeErrorInfo keeps only type, code and constraint', () => {
    const err = Object.assign(drizzleLikeError(), {
      cause: { code: '23505', constraint: 'members_email_bidx_unique', detail: HASH },
    });
    const info = safeErrorInfo(err);
    expect(info).toEqual({
      type: 'DrizzleQueryError',
      code: '23505',
      constraint: 'members_email_bidx_unique',
    });
    expect(JSON.stringify(info)).not.toContain('argon2id');
  });
});
