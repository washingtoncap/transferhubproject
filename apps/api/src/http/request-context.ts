import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import type { Logger } from '@transferhub/platform';

export interface RequestWithContext extends Request {
  requestId: string;
  idempotencyKey?: string;
}

/** Accept a caller-supplied request id only if it is short and plain; otherwise make our own. */
const SAFE_REQUEST_ID = /^[A-Za-z0-9_\-:.]{8,128}$/;

/**
 * Gives every request an id (echoed back as X-Request-Id) and writes one structured, redacted
 * access-log line per request. Bodies are never logged.
 */
export function requestContext(log: Logger) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const incoming = req.header('x-request-id');
    const requestId = incoming && SAFE_REQUEST_ID.test(incoming) ? incoming : randomUUID();
    (req as RequestWithContext).requestId = requestId;
    res.setHeader('X-Request-Id', requestId);

    const started = process.hrtime.bigint();
    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      const entry = {
        requestId,
        method: req.method,
        path: req.path,
        status: res.statusCode,
        durationMs: Math.round(ms * 10) / 10,
      };
      if (res.statusCode >= 500) log.error(entry, 'request failed');
      else log.info(entry, 'request');
    });
    next();
  };
}
