import { Writable } from 'node:stream';
import { context, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { TracerProvider } from '@opentelemetry/sdk-trace';
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLogger, fastifyLoggerOptions } from '@budgedino/server/observability/logger';
import { redact } from '@budgedino/server/observability/redact';
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

    it('redacts caller-supplied trace_id, outside and inside a span', () => {
      const cap = capture();
      const log = createLogger({ destination: cap.stream });
      log.info({ trace_id: IBAN }, 'outside');
      expect(cap.text()).not.toContain(IBAN);
      const tracer = new TracerProvider().getTracer('t');
      tracer.startActiveSpan('op', (span) => {
        log.info({ trace_id: IBAN, span_id: IBAN }, 'inside');
        const sc = span.spanContext();
        const rec = JSON.parse(cap.lines[1] ?? '{}') as Record<string, unknown>;
        expect(rec['trace_id']).toBe('[iban]');
        expect(rec['span_id']).toBe('[iban]');
        log.info('plain');
        const rec2 = JSON.parse(cap.lines[2] ?? '{}') as Record<string, unknown>;
        expect(rec2['trace_id']).toBe(sc.traceId);
        expect(rec2['span_id']).toBe(sc.spanId);
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
