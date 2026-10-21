import { describe, expect, it } from 'vitest';
import { ConfigError, loadApiConfig, loadWorkerConfig } from './index';

const ok = { APP_ENV: 'local', DATABASE_URL: 'postgres://th:th@localhost:5432/transferhub_dev' };

describe('configuration', () => {
  it('applies safe defaults', () => {
    const c = loadApiConfig(ok);
    expect(c.API_PORT).toBe(4000);
    expect(c.WEB_ORIGINS).toEqual(['http://localhost:3000']);
    expect(loadWorkerConfig(ok).WORKER_CONCURRENCY).toBe(4);
  });

  it('fails fast when DATABASE_URL is missing', () => {
    expect(() => loadApiConfig({ APP_ENV: 'local' })).toThrow(ConfigError);
  });

  it('rejects an unknown environment name', () => {
    expect(() => loadApiConfig({ ...ok, APP_ENV: 'staging-ish' })).toThrow(ConfigError);
  });

  it('never echoes configuration values in errors', () => {
    const secretUrl = 'mysql://user:SuperSecret123@db/x';
    try {
      loadApiConfig({ APP_ENV: 'local', DATABASE_URL: secretUrl });
      expect.fail('should throw');
    } catch (err) {
      expect(String((err as Error).message)).not.toContain('SuperSecret123');
    }
  });

  it('blocks a non-production process from using a production database', () => {
    expect(() =>
      loadApiConfig({ APP_ENV: 'sandbox', DATABASE_URL: 'postgres://u:p@db-prod.internal/th' }),
    ).toThrow(/production database/);
  });

  it('blocks production from running on a local development database', () => {
    expect(() =>
      loadApiConfig({ APP_ENV: 'production', DATABASE_URL: ok.DATABASE_URL, PARTNER_WEBHOOK_SECRET: 'whsec_real_production_value' }),
    ).toThrow(
      /local\/development/,
    );
  });

  it('refuses the sandbox partner secret in production', () => {
    expect(() =>
      loadApiConfig({ APP_ENV: 'production', DATABASE_URL: 'postgres://u:p@db.internal/th' }),
    ).toThrow(/PARTNER_WEBHOOK_SECRET/);
  });

  it('splits allowed web origins', () => {
    const c = loadApiConfig({ ...ok, WEB_ORIGINS: 'https://a.example, https://b.example' });
    expect(c.WEB_ORIGINS).toEqual(['https://a.example', 'https://b.example']);
  });
});
