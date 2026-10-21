import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  SetMetadata,
  createParamDecorator,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import { sessionFromToken, type SessionUser, SESSION_HOURS } from '@transferhub/core';
import type { Pool } from '@transferhub/db';
import { ApiError } from './errors';
import { API_CONFIG, DB_POOL } from '../tokens';
import type { ApiConfig } from '@transferhub/config';

export const SESSION_COOKIE = 'th_session';

const PUBLIC = 'th:public';
const PENDING_MFA = 'th:pending-mfa';

/** Route needs no session (sign-in, registration, public rates, partner webhooks). */
export const Public = () => SetMetadata(PUBLIC, true);
/** Route works before MFA is complete (the MFA step itself, /me, sign-out). */
export const AllowPendingMfa = () => SetMetadata(PENDING_MFA, true);

export interface AuthedRequest extends Request {
  user?: SessionUser;
  requestId: string;
  idempotencyKey?: string;
}

export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext): SessionUser => {
  const req = ctx.switchToHttp().getRequest<AuthedRequest>();
  return req.user!;
});

export function readCookie(req: Request, name: string): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

export function setSessionCookie(res: Response, token: string, secure: boolean): void {
  res.setHeader(
    'Set-Cookie',
    `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_HOURS * 3600}${secure ? '; Secure' : ''}`,
  );
}

export function clearSessionCookie(res: Response, secure: boolean): void {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`);
}

/**
 * Global guard. Every route requires a valid, unexpired, unrevoked session with completed MFA
 * (IAM-01: MFA-incomplete users cannot call financial APIs) unless explicitly marked otherwise.
 * The session is re-read from the database on every request, never trusted from the client.
 */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(DB_POOL) private readonly pool: Pool,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const targets = [ctx.getHandler(), ctx.getClass()];
    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC, targets);
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const token = readCookie(req, SESSION_COOKIE);
    if (token) {
      const user = await sessionFromToken(this.pool, token);
      if (user) req.user = user;
    }
    if (isPublic) return true;
    if (!req.user) throw new ApiError(401, 'unauthenticated', 'Please sign in.');
    const pendingOk = this.reflector.getAllAndOverride<boolean>(PENDING_MFA, targets);
    if (!pendingOk && !req.user.mfaVerified) {
      throw new ApiError(401, 'unauthenticated', 'Complete two-step verification to continue.');
    }
    return true;
  }

  /** Exposed for controllers that set cookies. */
  get secureCookies(): boolean {
    return this.config.APP_ENV === 'production' || this.config.APP_ENV === 'sandbox';
  }
}
