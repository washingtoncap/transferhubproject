import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  ACTING_ROLES,
  acceptQuote,
  activity,
  addBeneficiary,
  allocate,
  balances,
  cancelSubscription,
  createDeposit,
  createQuote,
  detachChild,
  entityDetail,
  invitationsFor,
  inviteChild,
  isAsset,
  listBeneficiaries,
  listDeposits,
  listTrades,
  listWithdrawals,
  network,
  requestWithdrawal,
  requireMember,
  respondToInvitation,
  type SessionUser,
  setChildRate,
  statementCsv,
  submitOnboarding,
  subscribe,
  subscriptionOverview,
  updateProfile,
} from '@transferhub/core';
import type { Pool } from '@transferhub/db';
import { type AuthedRequest, CurrentUser } from '../http/auth.guard';
import { ApiError } from '../http/errors';
import { RequiresIdempotencyKey } from '../http/idempotency.guard';
import { DB_POOL } from '../tokens';

/**
 * Customer endpoints. Every handler first checks the caller's membership of :entityId against the
 * database (object-level authorisation, IAM-02); money-moving handlers also require an acting role
 * and an Idempotency-Key.
 */
@Controller('v1/entities/:entityId')
export class CustomerController {
  constructor(@Inject(DB_POOL) private readonly pool: Pool) {}

  private view(user: SessionUser, entityId: string) {
    return requireMember(this.pool, user, entityId);
  }
  private act(user: SessionUser, entityId: string) {
    return requireMember(this.pool, user, entityId, ACTING_ROLES);
  }

  @Get()
  async detail(@CurrentUser() u: SessionUser, @Param('entityId') id: string) {
    await this.view(u, id);
    return entityDetail(this.pool, id);
  }

  @Put('profile')
  async profile(
    @CurrentUser() u: SessionUser,
    @Param('entityId') id: string,
    @Body() body: unknown,
  ) {
    await requireMember(this.pool, u, id, ['owner', 'admin']);
    return updateProfile(this.pool, u, id, body);
  }

  @Post('submit')
  @HttpCode(200)
  async submit(@CurrentUser() u: SessionUser, @Param('entityId') id: string) {
    await requireMember(this.pool, u, id, ['owner', 'admin']);
    return submitOnboarding(this.pool, u, id);
  }

  @Get('balances')
  async balances(@CurrentUser() u: SessionUser, @Param('entityId') id: string) {
    await this.view(u, id);
    return balances(this.pool, id);
  }

  @Get('activity')
  async activity(
    @CurrentUser() u: SessionUser,
    @Param('entityId') id: string,
    @Query('limit') limit?: string,
  ) {
    await this.view(u, id);
    return activity(this.pool, id, Number(limit) || 50);
  }

  @Get('statement.csv')
  async csv(
    @CurrentUser() u: SessionUser,
    @Param('entityId') id: string,
    @Query('asset') asset: string,
    @Res() res: Response,
  ) {
    await this.view(u, id);
    if (!isAsset(asset)) throw new ApiError(400, 'validation_failed', 'asset must be USD or TTD');
    const body = await statementCsv(this.pool, id, asset);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="transferhub-statement-${asset}.csv"`,
    );
    res.send(body);
  }

  // Deposits ------------------------------------------------------------------------------------
  @Get('deposits')
  async deposits(@CurrentUser() u: SessionUser, @Param('entityId') id: string) {
    await this.view(u, id);
    return listDeposits(this.pool, id);
  }

  @Post('deposits')
  @RequiresIdempotencyKey()
  async createDeposit(
    @CurrentUser() u: SessionUser,
    @Param('entityId') id: string,
    @Body() body: Record<string, unknown>,
    @Req() req: AuthedRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    await this.act(u, id);
    res.status(201);
    return createDeposit(this.pool, u, id, body, req.idempotencyKey!);
  }

  // Exchange ------------------------------------------------------------------------------------
  @Post('quotes')
  async quote(
    @CurrentUser() u: SessionUser,
    @Param('entityId') id: string,
    @Body() body: Record<string, unknown>,
    @Res({ passthrough: true }) res: Response,
  ) {
    await this.act(u, id);
    res.status(201);
    return createQuote(this.pool, u, id, body);
  }

  @Post('quotes/:quoteId/accept')
  @RequiresIdempotencyKey()
  @HttpCode(200)
  async accept(
    @CurrentUser() u: SessionUser,
    @Param('entityId') id: string,
    @Param('quoteId') quoteId: string,
    @Req() req: AuthedRequest,
  ) {
    await this.act(u, id);
    return acceptQuote(this.pool, u, id, quoteId, req.idempotencyKey!);
  }

  @Get('trades')
  async trades(@CurrentUser() u: SessionUser, @Param('entityId') id: string) {
    await this.view(u, id);
    return listTrades(this.pool, id);
  }

  // Seller network ------------------------------------------------------------------------------
  @Get('network')
  async network(@CurrentUser() u: SessionUser, @Param('entityId') id: string) {
    await this.view(u, id);
    return network(this.pool, id);
  }

  @Post('network/invitations')
  async invite(
    @CurrentUser() u: SessionUser,
    @Param('entityId') id: string,
    @Body() body: Record<string, unknown>,
    @Res({ passthrough: true }) res: Response,
  ) {
    await this.act(u, id);
    res.status(201);
    return inviteChild(this.pool, u, id, body);
  }

  @Patch('network/:linkId')
  async setRate(
    @CurrentUser() u: SessionUser,
    @Param('entityId') id: string,
    @Param('linkId') linkId: string,
    @Body() body: { childRateE4?: unknown },
  ) {
    await this.act(u, id);
    return setChildRate(this.pool, u, id, linkId, body.childRateE4);
  }

  @Post('network/:linkId/detach')
  @HttpCode(200)
  async detach(
    @CurrentUser() u: SessionUser,
    @Param('entityId') id: string,
    @Param('linkId') linkId: string,
  ) {
    await this.act(u, id);
    return detachChild(this.pool, u, id, linkId);
  }

  @Post('allocations')
  @RequiresIdempotencyKey()
  async allocate(
    @CurrentUser() u: SessionUser,
    @Param('entityId') id: string,
    @Body() body: Record<string, unknown>,
    @Req() req: AuthedRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    await this.act(u, id);
    res.status(201);
    return allocate(this.pool, u, id, body, req.idempotencyKey!);
  }

  @Get('network-invitations')
  async invitations(@CurrentUser() u: SessionUser, @Param('entityId') id: string) {
    await this.view(u, id);
    return invitationsFor(this.pool, id);
  }

  @Post('network-invitations/:linkId/accept')
  @HttpCode(200)
  async acceptInvite(
    @CurrentUser() u: SessionUser,
    @Param('entityId') id: string,
    @Param('linkId') linkId: string,
    @Body() body: { consent?: unknown },
  ) {
    await requireMember(this.pool, u, id, ['owner', 'admin']);
    return respondToInvitation(this.pool, u, id, linkId, true, body?.consent);
  }

  @Post('network-invitations/:linkId/decline')
  @HttpCode(200)
  async declineInvite(
    @CurrentUser() u: SessionUser,
    @Param('entityId') id: string,
    @Param('linkId') linkId: string,
  ) {
    await requireMember(this.pool, u, id, ['owner', 'admin']);
    return respondToInvitation(this.pool, u, id, linkId, false, undefined);
  }

  // Withdrawals ---------------------------------------------------------------------------------
  @Get('beneficiaries')
  async beneficiaries(@CurrentUser() u: SessionUser, @Param('entityId') id: string) {
    await this.view(u, id);
    return listBeneficiaries(this.pool, id);
  }

  @Post('beneficiaries')
  async addBeneficiary(
    @CurrentUser() u: SessionUser,
    @Param('entityId') id: string,
    @Body() body: Record<string, unknown>,
    @Res({ passthrough: true }) res: Response,
  ) {
    await requireMember(this.pool, u, id, ['owner', 'admin']);
    res.status(201);
    return addBeneficiary(this.pool, u, id, body);
  }

  @Get('withdrawals')
  async withdrawals(@CurrentUser() u: SessionUser, @Param('entityId') id: string) {
    await this.view(u, id);
    return listWithdrawals(this.pool, id);
  }

  @Post('withdrawals')
  @RequiresIdempotencyKey()
  async withdraw(
    @CurrentUser() u: SessionUser,
    @Param('entityId') id: string,
    @Body() body: Record<string, unknown>,
    @Req() req: AuthedRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    await this.act(u, id);
    res.status(201);
    return requestWithdrawal(this.pool, u, id, body, req.idempotencyKey!);
  }

  // Billing -------------------------------------------------------------------------------------
  @Get('subscription')
  async subscription(@CurrentUser() u: SessionUser, @Param('entityId') id: string) {
    await this.view(u, id);
    return subscriptionOverview(this.pool, id);
  }

  @Post('subscription')
  @RequiresIdempotencyKey()
  async subscribe(
    @CurrentUser() u: SessionUser,
    @Param('entityId') id: string,
    @Body() body: Record<string, unknown>,
    @Req() req: AuthedRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    await requireMember(this.pool, u, id, ['owner', 'admin']);
    res.status(201);
    return subscribe(this.pool, u, id, body, req.idempotencyKey!);
  }

  @Post('subscription/cancel')
  @HttpCode(200)
  async cancel(@CurrentUser() u: SessionUser, @Param('entityId') id: string) {
    await requireMember(this.pool, u, id, ['owner', 'admin']);
    return cancelSubscription(this.pool, u, id);
  }
}
