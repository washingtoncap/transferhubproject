import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  SetMetadata,
  applyDecorators,
  UseGuards,
} from '@nestjs/common';
import { IDEMPOTENCY_KEY_PATTERN } from '@transferhub/platform';
import { ApiError } from './errors';
import type { RequestWithContext } from './request-context';

const IDEMPOTENT = 'th:idempotent';

@Injectable()
export class IdempotencyKeyGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<RequestWithContext>();
    const key = req.header('idempotency-key');
    if (!key || !IDEMPOTENCY_KEY_PATTERN.test(key)) {
      throw new ApiError(
        400,
        'idempotency_key_required',
        'This operation requires an Idempotency-Key header of 8–128 letters, digits or _-:.',
      );
    }
    req.idempotencyKey = key;
    return true;
  }
}

/**
 * Marks a route as a financial command: it refuses requests without a valid Idempotency-Key.
 * The handler then wraps its work in `runIdempotent` inside its database transaction, so a
 * retried request replays the original response instead of moving money twice.
 */
export function RequiresIdempotencyKey(): MethodDecorator & ClassDecorator {
  return applyDecorators(SetMetadata(IDEMPOTENT, true), UseGuards(IdempotencyKeyGuard));
}
