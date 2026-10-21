import pino, { type Logger, type LoggerOptions } from 'pino';
import { redact, redactString } from './redact';

export type { Logger } from 'pino';

export interface LoggerConfig {
  service: string;
  level?: string;
  appEnv?: string;
  /** Optional destination for tests; defaults to stdout. */
  destination?: pino.DestinationStream;
}

/**
 * Structured JSON logger. Every object passed to a log call is deep-redacted before it is written,
 * so a developer logging a request body cannot leak a password, OTP, token or card number.
 */
export function createLogger(cfg: LoggerConfig): Logger {
  const options: LoggerOptions = {
    level: cfg.level ?? 'info',
    base: { service: cfg.service, env: cfg.appEnv },
    timestamp: pino.stdTimeFunctions.isoTime,
    messageKey: 'msg',
    formatters: {
      level: (label) => ({ level: label }),
      log: (obj) => redact(obj),
    },
    hooks: {
      logMethod(args, method) {
        const redactedArgs = args.map((a) => (typeof a === 'string' ? redactString(a) : a));
        return method.apply(this, redactedArgs as Parameters<typeof method>);
      },
    },
    serializers: {
      err: (err: unknown) => redact(err instanceof Error ? err : { message: String(err) }),
    },
  };
  return cfg.destination ? pino(options, cfg.destination) : pino(options);
}
