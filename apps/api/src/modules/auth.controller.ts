import { Body, Controller, Get, HttpCode, Inject, Post, Query, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { ApiConfig } from '@transferhub/config';
import {
  login,
  meView,
  registerCustomer,
  revokeSession,
  sandboxCurrentCode,
  type SessionUser,
  sessionFromToken,
  verifySessionMfa,
} from '@transferhub/core';
import type { Pool } from '@transferhub/db';
import { recordAudit } from '@transferhub/platform';
import {
  AllowPendingMfa,
  type AuthedRequest,
  clearSessionCookie,
  CurrentUser,
  Public,
  readCookie,
  SESSION_COOKIE,
  setSessionCookie,
} from '../http/auth.guard';
import { ApiError } from '../http/errors';
import { API_CONFIG, DB_POOL } from '../tokens';

@Controller('v1')
export class AuthController {
  constructor(
    @Inject(DB_POOL) private readonly pool: Pool,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
  ) {}

  private get secure() {
    return this.config.APP_ENV === 'production';
  }

  @Public()
  @Post('auth/register')
  async register(
    @Body() body: Record<string, unknown>,
    @Req() req: AuthedRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    const r = await registerCustomer(this.pool, body, { userAgent: req.header('user-agent') });
    setSessionCookie(res, r.session.token, this.secure);
    res.status(201);
    return {
      userId: r.userId,
      entityId: r.entityId,
      mfaSetup: { secret: r.mfaSecret, otpauthUrl: r.otpauthUrl },
    };
  }

  @Public()
  @Post('auth/login')
  @HttpCode(200)
  async login(
    @Body() body: { email?: string; password?: string },
    @Req() req: AuthedRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    const s = await login(
      this.pool,
      String(body.email ?? ''),
      String(body.password ?? ''),
      req.header('user-agent'),
    );
    setSessionCookie(res, s.token, this.secure);
    return { mfaRequired: true };
  }

  @AllowPendingMfa()
  @Post('auth/mfa')
  @HttpCode(200)
  async mfa(
    @Body() body: { code?: string },
    @CurrentUser() user: SessionUser,
    @Req() req: AuthedRequest,
  ) {
    await verifySessionMfa(this.pool, user, String(body.code ?? ''));
    const refreshed = await sessionFromToken(this.pool, readCookie(req, SESSION_COOKIE)!);
    return meView(this.pool, refreshed!);
  }

  @Public()
  @Post('auth/logout')
  @HttpCode(204)
  async logout(@Req() req: AuthedRequest, @Res({ passthrough: true }) res: Response) {
    if (req.user) {
      await revokeSession(this.pool, req.user.sessionId);
      await recordAudit(this.pool, {
        actorType: req.user.isStaff ? 'staff' : 'customer',
        actorId: req.user.userId,
        action: 'session.signed_out',
        objectType: 'session',
        objectId: req.user.sessionId,
      });
    }
    clearSessionCookie(res, this.secure);
  }

  @AllowPendingMfa()
  @Get('me')
  me(@CurrentUser() user: SessionUser) {
    return meView(this.pool, user);
  }

  /** Sandbox convenience so testers need no authenticator app. Never available in production. */
  @Public()
  @Get('sandbox/mfa-code')
  async sandboxCode(@Query('email') email: string) {
    if (this.config.APP_ENV === 'production') throw new ApiError(404, 'not_found', 'Not found.');
    const r = await sandboxCurrentCode(this.pool, email);
    if (!r) throw new ApiError(404, 'not_found', 'No sandbox code for that account.');
    return r;
  }
}
