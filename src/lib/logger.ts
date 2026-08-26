/**
 * Structured JSON logging for the API and worker.
 *
 * One line per event, machine-parseable, with a redaction pass so a careless
 * call site cannot leak credentials or raw financial payloads into logs. The
 * design's observability contract (userId, analysisRunId, itemId, jobId, job
 * type, attempt, duration, terminal status) all flow through `fields`.
 */

export type LogFields = Record<string, unknown>;

/** Field names that must never be logged, whatever the caller passes. */
const REDACTED_KEY_PATTERN =
  /token|secret|password|authorization|cookie|access_key|api_key|apikey/i;

/** Keys that hold free-text or raw payloads we deliberately keep out of logs. */
const DROPPED_KEYS = new Set(['raw', 'rawPayload', 'transactionName', 'merchantRaw']);

function sanitize(fields: LogFields): LogFields {
  const clean: LogFields = {};

  for (const [key, value] of Object.entries(fields)) {
    if (DROPPED_KEYS.has(key)) {
      continue;
    }

    if (REDACTED_KEY_PATTERN.test(key)) {
      clean[key] = '[redacted]';
      continue;
    }

    if (value instanceof Error) {
      clean[key] = `${value.name}: ${value.message}`;
      continue;
    }

    if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean' ||
      value === null ||
      value === undefined
    ) {
      clean[key] = value;
      continue;
    }

    // Nested objects are stringified defensively; they should be rare.
    try {
      clean[key] = JSON.stringify(value);
    } catch {
      clean[key] = '[unserializable]';
    }
  }

  return clean;
}

function emit(level: 'info' | 'warn' | 'error', message: string, fields: LogFields): void {
  const line = JSON.stringify({
    time: new Date().toISOString(),
    level,
    message,
    ...sanitize(fields),
  });

  if (level === 'error') {
    console.error(line);
  } else if (level === 'warn') {
    console.warn(line);
  } else {
    console.log(line);
  }
}

export const logger = {
  info(message: string, fields: LogFields = {}): void {
    emit('info', message, fields);
  },
  warn(message: string, fields: LogFields = {}): void {
    emit('warn', message, fields);
  },
  error(message: string, fields: LogFields = {}): void {
    emit('error', message, fields);
  },
};

/** Exported for tests. */
export const __internal = { sanitize };
