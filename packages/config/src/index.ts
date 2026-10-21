import { z } from 'zod';

/**
 * Runtime environments are fully separate: different databases, credentials and provider keys.
 * Live (production) credentials must never be configured in any other environment.
 */
export const APP_ENVS = ['local', 'test', 'sandbox', 'production'] as const;
export type AppEnv = (typeof APP_ENVS)[number];

const intFromString = (fallback: number, min: number, max: number) =>
  z.coerce.number().int().min(min).max(max).default(fallback);

const SANDBOX_PARTNER_SECRET = 'whsec_sandbox_partner_not_for_production';

const baseSchema = z.object({
  APP_ENV: z.enum(APP_ENVS).default('local'),
  // Shared secret for the fiat partner's webhook signatures. The sandbox default is refused in
  // production (see assertEnvironmentSeparation).
  PARTNER_WEBHOOK_SECRET: z.string().min(16).default(SANDBOX_PARTNER_SECRET),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  DATABASE_URL: z
    .string()
    .min(1, 'DATABASE_URL is required')
    .refine((v) => /^postgres(ql)?:\/\//.test(v), 'DATABASE_URL must be a postgres:// URL'),
});

const apiSchema = baseSchema.extend({
  API_PORT: intFromString(4000, 1, 65535),
  WEB_ORIGINS: z
    .string()
    .default('http://localhost:3000')
    .transform((v) =>
      v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),
});

const workerSchema = baseSchema.extend({
  WORKER_POLL_INTERVAL_MS: intFromString(1000, 50, 60_000),
  WORKER_LEASE_SECONDS: intFromString(60, 5, 3600),
  WORKER_CONCURRENCY: intFromString(4, 1, 64),
});

export type BaseConfig = z.infer<typeof baseSchema>;
export type ApiConfig = z.infer<typeof apiSchema>;
export type WorkerConfig = z.infer<typeof workerSchema>;

export class ConfigError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Invalid configuration:\n  - ${issues.join('\n  - ')}`);
    this.name = 'ConfigError';
  }
}

type Env = Record<string, string | undefined>;

function parse<T extends z.ZodTypeAny>(schema: T, env: Env): z.infer<T> {
  const result = schema.safeParse(env);
  if (!result.success) {
    // Report variable names and rules only — never echo values, which may be secrets.
    throw new ConfigError(
      result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
    );
  }
  const config = result.data as z.infer<T> & BaseConfig;
  assertEnvironmentSeparation(config);
  return config;
}

/**
 * Guard rails that stop a non-production process from pointing at production data, and stop
 * production from running with development defaults. Cheap to check, expensive to get wrong.
 */
function assertEnvironmentSeparation(config: BaseConfig): void {
  const url = config.DATABASE_URL.toLowerCase();
  const looksProduction = /prod/.test(url);
  if (config.APP_ENV !== 'production' && looksProduction) {
    throw new ConfigError([
      `DATABASE_URL appears to reference a production database while APP_ENV=${config.APP_ENV}`,
    ]);
  }
  if (config.APP_ENV === 'production' && config.PARTNER_WEBHOOK_SECRET === SANDBOX_PARTNER_SECRET) {
    throw new ConfigError(['APP_ENV=production requires a real PARTNER_WEBHOOK_SECRET']);
  }
  if (config.APP_ENV === 'production' && /localhost|127\.0\.0\.1|th:th@/.test(url)) {
    throw new ConfigError(['APP_ENV=production cannot use a local/development DATABASE_URL']);
  }
}

export const loadBaseConfig = (env: Env = process.env): BaseConfig => parse(baseSchema, env);
export const loadApiConfig = (env: Env = process.env): ApiConfig => parse(apiSchema, env);
export const loadWorkerConfig = (env: Env = process.env): WorkerConfig => parse(workerSchema, env);
