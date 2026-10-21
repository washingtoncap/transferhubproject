import 'reflect-metadata';
import { type DynamicModule, type INestApplication, Module } from '@nestjs/common';
import { APP_GUARD, NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import type { ApiConfig } from '@transferhub/config';
import type { Pool } from '@transferhub/db';
import type { Logger } from '@transferhub/platform';
import { HealthController } from './health/health.controller';
import { SessionGuard } from './http/auth.guard';
import { AuthController } from './modules/auth.controller';
import { CustomerController } from './modules/customer.controller';
import { OpsController } from './modules/ops.controller';
import { PublicController } from './modules/public.controller';
import { ApiExceptionFilter } from './http/errors';
import { requestContext } from './http/request-context';
import { API_CONFIG, DB_POOL, LOGGER } from './tokens';

export interface AppDeps {
  config: ApiConfig;
  pool: Pool;
  log: Logger;
  /** Extra modules (feature buckets, or test-only modules). */
  modules?: Array<DynamicModule | (new (...args: never[]) => unknown)>;
}

@Module({})
class CoreModule {
  static register(deps: AppDeps): DynamicModule {
    return {
      module: CoreModule,
      global: true,
      providers: [
        { provide: API_CONFIG, useValue: deps.config },
        { provide: DB_POOL, useValue: deps.pool },
        { provide: LOGGER, useValue: deps.log },
      ],
      exports: [API_CONFIG, DB_POOL, LOGGER],
    };
  }
}

@Module({})
class AppModule {
  static register(deps: AppDeps): DynamicModule {
    return {
      module: AppModule,
      imports: [CoreModule.register(deps), ...(deps.modules ?? [])],
      controllers: [HealthController, AuthController, PublicController, CustomerController, OpsController],
      providers: [{ provide: APP_GUARD, useClass: SessionGuard }],
    };
  }
}

/** Builds the HTTP application. Shared by main.ts and the tests so both exercise the same stack. */
export async function createApp(deps: AppDeps): Promise<INestApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule.register(deps), {
    logger: false,
    bufferLogs: false,
    // Partner webhook signatures are computed over the exact bytes received.
    rawBody: true,
  });

  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(helmet());
  app.use(requestContext(deps.log));
  app.useBodyParser('json', { limit: '256kb' });
  app.enableCors({
    origin: deps.config.WEB_ORIGINS,
    credentials: true,
    allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key', 'X-Request-Id'],
    exposedHeaders: ['X-Request-Id'],
  });
  app.useGlobalFilters(new ApiExceptionFilter(deps.log));
  app.enableShutdownHooks();
  return app;
}
