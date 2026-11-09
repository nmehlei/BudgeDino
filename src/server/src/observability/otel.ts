import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { BatchLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';

export const SERVICE_NAME = 'budgedino-server';

export interface Telemetry {
  enabled: boolean;
  shutdown(): Promise<void>;
}

/** Query parameters redacted on HTTP spans (in addition to the library defaults). */
const REDACTED_QUERY_PARAMS = [
  'amount',
  'iban',
  'counterparty',
  'purpose',
  'payee',
  'password',
  'pin',
  'tan',
  'token',
  'secret',
  'key',
  'balance',
  'email',
];

/**
 * Starts OpenTelemetry (traces, metrics, logs over OTLP/HTTP). A no-op unless
 * `OTEL_EXPORTER_OTLP_ENDPOINT` is set. Only http and pg instrumentation are enabled; pg never
 * records query parameters (`enhancedDatabaseReporting: false`), http records no bodies and no
 * headers.
 */
export function startTelemetry(env: Record<string, string | undefined>): Telemetry {
  const endpoint = env['OTEL_EXPORTER_OTLP_ENDPOINT']?.trim();
  if (!endpoint) return { enabled: false, shutdown: () => Promise.resolve() };

  const base = endpoint.replace(/\/+$/, '');
  const sdk = new NodeSDK({
    serviceName: SERVICE_NAME,
    traceExporter: new OTLPTraceExporter({ url: `${base}/v1/traces` }),
    metricReaders: [
      new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter({ url: `${base}/v1/metrics` }),
      }),
    ],
    logRecordProcessors: [
      new BatchLogRecordProcessor({
        exporter: new OTLPLogExporter({ url: `${base}/v1/logs` }),
      }),
    ],
    instrumentations: [
      new HttpInstrumentation({
        redactedQueryParams: REDACTED_QUERY_PARAMS,
        redactedQueryParamsServer: REDACTED_QUERY_PARAMS,
      }),
      new PgInstrumentation({ enhancedDatabaseReporting: false }),
    ],
  });
  sdk.start();
  return {
    enabled: true,
    shutdown: () => sdk.shutdown(),
  };
}
