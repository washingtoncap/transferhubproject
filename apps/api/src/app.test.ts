import {
  Body,
  Controller,
  Get,
  Inject,
  type INestApplication,
  Module,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { loadApiConfig } from '@transferhub/config';
import { withTransaction, type Pool } from '@transferhub/db';
import { createLogger, recordAudit, runIdempotent, writeOutbox } from '@transferhub/platform';
import { testDatabaseUrl, testPool, uniq } from '../../../test/db';
import { createApp } from './app';
import { Public } from './http/auth.guard';
import { RequiresIdempotencyKey } from './http/idempotency.guard';
import type { RequestWithContext } from './http/request-context';
import { DB_POOL } from './tokens';

let executions = 0;

/**
 * A stand-in financial command used only in tests. It shows the pattern every money-moving
 * endpoint in later buckets follows: validate → one transaction holding the idempotency key,
 * the state change, its audit record and its outbox event.
 */
@Public()
@Controller('test')
class TestCommandController {
  constructor(@Inject(DB_POOL) private readonly pool: Pool) {}

  @Post('commands')
  @RequiresIdempotencyKey()
  async create(
    @Req() req: RequestWithContext,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    const input = z.object({ amountMinor: z.number().int().positive() }).parse(body);
    const result = await withTransaction(this.pool, (tx) =>
      runIdempotent(
        tx,
        { scope: 'customer:test:POST /test/commands', key: req.idempotencyKey!, request: input },
        async () => {
          executions += 1;
          const commandId = uniq('cmd');
          await recordAudit(tx, {
            actorType: 'customer',
            actorId: 'test-customer',
            action: 'test.command_created',
            objectType: 'test_command',
            objectId: commandId,
            requestId: req.requestId,
          });
          await writeOutbox(tx, { topic: 'test.command_created', payload: { commandId } });
          return { status: 201, body: { commandId, amountMinor: input.amountMinor } };
        },
      ),
    );
    res.status(result.status);
    if (result.replayed) res.setHeader('Idempotent-Replayed', 'true');
    return result.body;
  }

  @Get('boom')
  boom() {
    throw new Error('relation "secret_table" does not exist — password=hunter2');
  }
}

@Module({ controllers: [TestCommandController] })
class TestModule {}

const pool = testPool();
let app: INestApplication;

beforeAll(async () => {
  const config = loadApiConfig({
    APP_ENV: 'test',
    DATABASE_URL: testDatabaseUrl(),
    WEB_ORIGINS: 'http://localhost:3000',
  });
  const log = createLogger({ service: 'api-test', level: 'silent' });
  app = await createApp({ config, pool, log, modules: [TestModule] });
  await app.init();
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('API foundation', () => {
  it('reports live', async () => {
    await request(app.getHttpServer()).get('/health/live').expect(200, { status: 'ok' });
  });

  it('reports ready with database and migrations checked', async () => {
    const res = await request(app.getHttpServer()).get('/health/ready').expect(200);
    expect(res.body).toMatchObject({
      status: 'ok',
      environment: 'test',
      checks: { database: 'ok', migrations: 'ok' },
    });
  });

  it('issues a request id, and keeps a safe caller-supplied one', async () => {
    const a = await request(app.getHttpServer()).get('/health/live');
    expect(a.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    const b = await request(app.getHttpServer())
      .get('/health/live')
      .set('X-Request-Id', 'trace-12345678');
    expect(b.headers['x-request-id']).toBe('trace-12345678');
    const c = await request(app.getHttpServer())
      .get('/health/live')
      .set('X-Request-Id', '<script>alert(1)</script>');
    expect(c.headers['x-request-id']).not.toContain('<script>');
  });

  it('sends security headers and hides the framework', async () => {
    const res = await request(app.getHttpServer()).get('/health/live');
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['strict-transport-security']).toBeDefined();
  });

  it('only allows configured browser origins', async () => {
    const allowed = await request(app.getHttpServer())
      .get('/health/live')
      .set('Origin', 'http://localhost:3000');
    expect(allowed.headers['access-control-allow-origin']).toBe('http://localhost:3000');
    const blocked = await request(app.getHttpServer())
      .get('/health/live')
      .set('Origin', 'https://evil.example');
    expect(blocked.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('returns a consistent error shape for unknown routes', async () => {
    const res = await request(app.getHttpServer()).get('/nope').expect(404);
    expect(res.body.error).toMatchObject({ code: 'not_found' });
    expect(res.body.error.requestId).toBeTruthy();
  });

  it('never leaks internal error detail to the client', async () => {
    const res = await request(app.getHttpServer()).get('/test/boom').expect(500);
    expect(res.body.error.code).toBe('internal_error');
    expect(JSON.stringify(res.body)).not.toMatch(/secret_table|hunter2|stack/);
  });

  it('rejects oversized request bodies', async () => {
    await request(app.getHttpServer())
      .post('/test/commands')
      .set('Idempotency-Key', 'key-big-000001')
      .send({ amountMinor: 1, pad: 'x'.repeat(300 * 1024) })
      .expect(413);
  });
});

describe('financial command pattern (idempotency + audit + outbox)', () => {
  it('requires an Idempotency-Key', async () => {
    const res = await request(app.getHttpServer())
      .post('/test/commands')
      .send({ amountMinor: 100 })
      .expect(400);
    expect(res.body.error.code).toBe('idempotency_key_required');
  });

  it('validates input with field-level details', async () => {
    const res = await request(app.getHttpServer())
      .post('/test/commands')
      .set('Idempotency-Key', uniq('k'))
      .send({ amountMinor: -5 })
      .expect(400);
    expect(res.body.error.code).toBe('validation_failed');
    expect(res.body.error.details[0].path).toBe('amountMinor');
  });

  it('executes once and replays the same response on retry', async () => {
    const key = uniq('k');
    const before = executions;
    const first = await request(app.getHttpServer())
      .post('/test/commands')
      .set('Idempotency-Key', key)
      .send({ amountMinor: 100 })
      .expect(201);
    const retry = await request(app.getHttpServer())
      .post('/test/commands')
      .set('Idempotency-Key', key)
      .send({ amountMinor: 100 })
      .expect(201);
    expect(executions - before).toBe(1);
    expect(retry.body).toEqual(first.body);
    expect(retry.headers['idempotent-replayed']).toBe('true');

    const { rows } = await pool.query(
      `SELECT (SELECT count(*) FROM platform.audit_log WHERE object_id = $1)::int AS audits,
              (SELECT count(*) FROM platform.outbox WHERE payload->>'commandId' = $1)::int AS events`,
      [first.body.commandId],
    );
    expect(rows[0]).toEqual({ audits: 1, events: 1 });
  });

  it('rejects the same key with a different body', async () => {
    const key = uniq('k');
    await request(app.getHttpServer())
      .post('/test/commands')
      .set('Idempotency-Key', key)
      .send({ amountMinor: 100 })
      .expect(201);
    const res = await request(app.getHttpServer())
      .post('/test/commands')
      .set('Idempotency-Key', key)
      .send({ amountMinor: 999 })
      .expect(409);
    expect(res.body.error.code).toBe('idempotency_key_reused');
  });

  it('executes once under a burst of concurrent identical requests', async () => {
    const key = uniq('k');
    const before = executions;
    const responses = await Promise.all(
      Array.from({ length: 8 }, () =>
        request(app.getHttpServer())
          .post('/test/commands')
          .set('Idempotency-Key', key)
          .send({ amountMinor: 42 }),
      ),
    );
    expect(responses.every((r) => r.status === 201)).toBe(true);
    expect(executions - before).toBe(1);
    expect(new Set(responses.map((r) => r.body.commandId)).size).toBe(1);
  });
});
