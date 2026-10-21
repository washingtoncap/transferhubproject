import { Controller, Get, HttpCode, Inject, Post, Req } from '@nestjs/common';
import type { ApiConfig } from '@transferhub/config';
import { ingestPartnerWebhook, listPlans, ratePolicy, usdtParityRate } from '@transferhub/core';
import type { Pool } from '@transferhub/db';
import { type AuthedRequest, Public } from '../http/auth.guard';
import { ApiError } from '../http/errors';
import { API_CONFIG, DB_POOL } from '../tokens';

@Controller('v1')
export class PublicController {
  constructor(
    @Inject(DB_POOL) private readonly pool: Pool,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
  ) {}

  @Public()
  @Get('plans')
  plans() {
    return listPlans(this.pool);
  }

  /** Indicative only: an executable price always comes from a quote with an expiry (FX-01). */
  @Public()
  @Get('rates/indicative')
  async rates() {
    const p = await ratePolicy(this.pool);
    const plans = await listPlans(this.pool);
    const example = plans.find((x) => x.code === 'buyer_essential')?.usdRateE4 ?? p.standardBuyE4;
    return {
      standardBuyE4: p.standardBuyE4,
      standardSellE4: p.standardSellE4,
      childFloorE4: p.childFloorE4,
      quoteTtlSeconds: p.quoteTtlSeconds,
      plans,
      usdtExample: { usdRateE4: example, usdtRateE4: usdtParityRate(example) },
    };
  }

  /**
   * Fiat partner webhook (NFR-03). Signature is verified over the exact raw body; the event is
   * recorded once and processed asynchronously. Duplicates are acknowledged with 200 so the partner
   * stops retrying; invalid signatures get 401 but are kept as evidence.
   */
  @Public()
  @Post('partner/webhooks/fiat')
  @HttpCode(200)
  async webhook(@Req() req: AuthedRequest & { rawBody?: Buffer }) {
    const timestamp = req.header('x-partner-timestamp') ?? '';
    const signature = req.header('x-partner-signature') ?? '';
    if (!req.rawBody) throw new ApiError(400, 'validation_failed', 'Empty body');
    const r = await ingestPartnerWebhook(this.pool, {
      secret: this.config.PARTNER_WEBHOOK_SECRET,
      rawBody: req.rawBody.toString('utf8'),
      timestamp,
      signature,
    });
    if (r.outcome === 'rejected') throw new ApiError(401, 'unauthenticated', 'Invalid signature.');
    return { received: true, outcome: r.outcome };
  }
}
