/**
 * OpenTelemetry bootstrap for ESM: load it before the application with
 * `node --import ./dist/instrument.js ./dist/main.js`.
 *
 * Under ESM the http and pg instrumentations can only patch modules that are imported after the
 * `import-in-the-middle` loader hook is registered, so this file registers the hook and starts the SDK
 * first. A no-op (nothing registered, nothing imported) unless `OTEL_EXPORTER_OTLP_ENDPOINT` is set.
 */
import { register } from 'node:module';

if (process.env['OTEL_EXPORTER_OTLP_ENDPOINT']?.trim()) {
  register('import-in-the-middle/hook.mjs', import.meta.url);
  const { startTelemetry } = await import('./observability/otel.js');
  startTelemetry(process.env);
}
