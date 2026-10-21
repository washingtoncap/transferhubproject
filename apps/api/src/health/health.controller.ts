import { Controller, Get, HttpCode, Inject } from '@nestjs/common';
import type { ApiConfig } from '@transferhub/config';
import { appliedMigrations, loadMigrations, type Pool } from '@transferhub/db';
import { ApiError } from '../http/errors';
import { API_CONFIG, DB_POOL } from '../tokens';

const VERSION = process.env.APP_VERSION ?? '0.1.0';

@Controller('health')
export class HealthController {
  constructor(
    @Inject(DB_POOL) private readonly pool: Pool,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
  ) {}

  /** The process is up. Used by the host to decide whether to restart it. */
  @Get('live')
  @HttpCode(200)
  live() {
    return { status: 'ok' };
  }

  /**
   * The service can safely take traffic: the database answers and its schema matches this build.
   * A build that runs ahead of (or behind) its migrations reports not-ready rather than guessing.
   */
  @Get('ready')
  async ready() {
    const checks: Record<string, 'ok' | 'failed'> = {};
    let pending = 0;
    try {
      await this.pool.query('SELECT 1');
      checks.database = 'ok';
      const applied = new Set((await appliedMigrations(this.pool)).map((m) => m.version));
      pending = loadMigrations().filter((m) => !applied.has(m.version)).length;
      checks.migrations = pending === 0 ? 'ok' : 'failed';
    } catch {
      checks.database = checks.database ?? 'failed';
      checks.migrations = 'failed';
    }
    const healthy = Object.values(checks).every((c) => c === 'ok');
    const body = {
      status: healthy ? 'ok' : 'unavailable',
      environment: this.config.APP_ENV,
      version: VERSION,
      checks,
      ...(pending > 0 ? { pendingMigrations: pending } : {}),
    };
    if (!healthy) throw new ApiError(503, 'service_unavailable', 'Not ready.', body);
    return body;
  }
}
