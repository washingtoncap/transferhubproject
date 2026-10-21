import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import type { Response } from 'express';
import { ZodError } from 'zod';
import { IdempotencyConflictError, type Logger } from '@transferhub/platform';
import type { RequestWithContext } from './request-context';

/**
 * Stable machine-readable error codes (TH-REQ §6). Clients branch on `code`, never on `message`.
 * Later buckets add: insufficient_available_funds, quote_expired, unsupported_route,
 * provider_status_unknown, permission_denied.
 */
export type ErrorCode =
  | 'validation_failed'
  | 'idempotency_key_required'
  | 'idempotency_key_reused'
  | 'not_found'
  | 'payload_too_large'
  | 'unauthenticated'
  | 'permission_denied'
  | 'rate_limited'
  | 'service_unavailable'
  | 'internal_error';

export class ApiError extends HttpException {
  constructor(
    status: number,
    public readonly code: ErrorCode,
    message: string,
    public readonly details?: unknown,
  ) {
    super({ code, message, details }, status);
  }
}

interface ErrorBody {
  error: { code: ErrorCode; message: string; requestId: string; details?: unknown };
}

const STATUS_CODES: Partial<Record<number, ErrorCode>> = {
  400: 'validation_failed',
  401: 'unauthenticated',
  403: 'permission_denied',
  404: 'not_found',
  413: 'payload_too_large',
  429: 'rate_limited',
  503: 'service_unavailable',
};

/**
 * Turns every error into the same JSON shape. Unexpected errors are logged with their detail but
 * the client only sees a generic message and the request id, so internals, SQL and secrets never
 * leak in a response.
 */
@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  constructor(private readonly log: Logger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const res = http.getResponse<Response>();
    const req = http.getRequest<RequestWithContext>();
    const requestId = req.requestId ?? 'unknown';

    const send = (status: number, body: Omit<ErrorBody['error'], 'requestId'>) => {
      const payload: ErrorBody = { error: { ...body, requestId } };
      res.status(status).json(payload);
    };

    if (exception instanceof ApiError) {
      return send(exception.getStatus(), {
        code: exception.code,
        message: exception.message,
        details: exception.details,
      });
    }
    if (exception instanceof IdempotencyConflictError) {
      return send(HttpStatus.CONFLICT, { code: exception.code, message: exception.message });
    }
    if (exception instanceof ZodError) {
      return send(HttpStatus.BAD_REQUEST, {
        code: 'validation_failed',
        message: 'The request is not valid.',
        details: exception.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    if (exception instanceof HttpException && exception.getStatus() < 500) {
      const status = exception.getStatus();
      return send(status, {
        code: STATUS_CODES[status] ?? 'validation_failed',
        message: status === 404 ? 'Not found.' : 'The request could not be processed.',
      });
    }

    // Errors raised by the HTTP layer itself (malformed JSON, body too large) carry a 4xx status.
    const lowerStatus = clientErrorStatus(exception);
    if (lowerStatus) {
      return send(lowerStatus, {
        code: STATUS_CODES[lowerStatus] ?? 'validation_failed',
        message:
          lowerStatus === 413 ? 'The request body is too large.' : 'The request could not be read.',
      });
    }

    this.log.error({ err: exception, requestId, path: req.path }, 'unhandled error');
    return send(HttpStatus.INTERNAL_SERVER_ERROR, {
      code: 'internal_error',
      message: 'Something went wrong. Quote the request id if you contact support.',
    });
  }
}

function clientErrorStatus(err: unknown): number | null {
  if (!err || typeof err !== 'object') return null;
  const status =
    (err as { status?: unknown; statusCode?: unknown }).status ??
    (err as { statusCode?: unknown }).statusCode;
  return typeof status === 'number' && status >= 400 && status < 500 ? status : null;
}
