import { Body, Controller, Get, HttpCode, Inject, Param, Post, Put, Query } from '@nestjs/common';
import type { ApiConfig } from '@transferhub/config';
import {
  decideWithdrawal,
  ops,
  opsWithdrawals,
  ratePolicy,
  requireSandbox,
  requireStaff,
  type SessionUser,
  simulateBankCredit,
} from '@transferhub/core';
import type { Pool } from '@transferhub/db';
import { recordAudit } from '@transferhub/platform';
import { CurrentUser } from '../http/auth.guard';
import { API_CONFIG, DB_POOL } from '../tokens';

/**
 * Operations console (separately privileged, TH-REQ §6). Every route requires a staff session;
 * decisions additionally require the matching staff role. Staff can never edit balances: money
 * only moves through the same journal-posting paths customers use.
 */
@Controller('v1/ops')
export class OpsController {
  constructor(
    @Inject(DB_POOL) private readonly pool: Pool,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
  ) {}

  @Get('overview')
  overview(@CurrentUser() u: SessionUser) {
    requireStaff(u);
    return ops.overview(this.pool);
  }

  @Get('customers')
  customers(@CurrentUser() u: SessionUser, @Query('status') status?: string) {
    requireStaff(u);
    return ops.customers(this.pool, status);
  }

  @Get('customers/:id')
  async customer(@CurrentUser() u: SessionUser, @Param('id') id: string) {
    requireStaff(u);
    const d = await ops.customerDetail(this.pool, id);
    // PII access is logged separately (TH-REQ §6).
    await recordAudit(this.pool, { actorType: 'staff', actorId: u.userId, entityId: id, action: 'entity.viewed_by_staff', objectType: 'entity', objectId: id });
    return d;
  }

  @Post('customers/:id/decision')
  @HttpCode(200)
  decide(@CurrentUser() u: SessionUser, @Param('id') id: string, @Body() body: Record<string, unknown>) {
    requireStaff(u, ['compliance']);
    return ops.decideCustomer(this.pool, u, id, body);
  }

  @Get('deposits')
  deposits(@CurrentUser() u: SessionUser, @Query('status') status?: string) {
    requireStaff(u);
    return ops.opsDeposits(this.pool, status);
  }

  @Post('sandbox/bank-credit')
  @HttpCode(200)
  async bankCredit(@CurrentUser() u: SessionUser, @Body() body: Record<string, unknown>) {
    requireStaff(u, ['operations', 'finance']);
    requireSandbox(this.config.APP_ENV);
    const r = await simulateBankCredit(this.pool, this.config.PARTNER_WEBHOOK_SECRET, body);
    await recordAudit(this.pool, {
      actorType: 'staff', actorId: u.userId, action: 'sandbox.bank_credit_simulated', objectType: 'partner_statement_line', objectId: r.eventId,
      metadata: { asset: body.asset, amountMinor: body.amountMinor, reference: body.reference, outcome: r.outcome },
    });
    return r;
  }

  @Get('withdrawals')
  withdrawals(@CurrentUser() u: SessionUser, @Query('status') status?: string) {
    requireStaff(u);
    return opsWithdrawals(this.pool, u, status);
  }

  @Post('withdrawals/:id/approve')
  @HttpCode(200)
  approve(@CurrentUser() u: SessionUser, @Param('id') id: string, @Body() body: { reason?: string }) {
    requireStaff(u, ['operations', 'finance']);
    return decideWithdrawal(this.pool, u, id, 'approve', body?.reason);
  }

  @Post('withdrawals/:id/reject')
  @HttpCode(200)
  reject(@CurrentUser() u: SessionUser, @Param('id') id: string, @Body() body: { reason?: string }) {
    requireStaff(u, ['operations', 'finance', 'compliance']);
    return decideWithdrawal(this.pool, u, id, 'reject', body?.reason);
  }

  @Get('trades')
  trades(@CurrentUser() u: SessionUser) {
    requireStaff(u);
    return ops.opsTrades(this.pool);
  }

  @Get('reconciliation')
  reconciliation(@CurrentUser() u: SessionUser) {
    requireStaff(u);
    return ops.reconciliation(this.pool);
  }

  @Get('rate-policy')
  policy(@CurrentUser() u: SessionUser) {
    requireStaff(u);
    return ratePolicy(this.pool);
  }

  @Put('rate-policy')
  updatePolicy(@CurrentUser() u: SessionUser, @Body() body: Record<string, unknown>) {
    requireStaff(u, ['treasury']);
    return ops.updateRatePolicy(this.pool, u, body);
  }

  @Get('audit')
  audit(@CurrentUser() u: SessionUser, @Query('limit') limit?: string, @Query('objectType') objectType?: string, @Query('entityId') entityId?: string) {
    requireStaff(u);
    return ops.audit(this.pool, { limit: Number(limit) || 100, objectType, entityId });
  }

  @Get('system')
  system(@CurrentUser() u: SessionUser) {
    requireStaff(u);
    return ops.system(this.pool);
  }
}
