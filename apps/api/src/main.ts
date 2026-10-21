import { loadApiConfig } from '@transferhub/config';
import { createPool } from '@transferhub/db';
import { createLogger } from '@transferhub/platform';
import { createApp } from './app';

async function main(): Promise<void> {
  const config = loadApiConfig();
  const log = createLogger({ service: 'api', level: config.LOG_LEVEL, appEnv: config.APP_ENV });
  const pool = createPool({ connectionString: config.DATABASE_URL, applicationName: 'th-api' });
  pool.on('error', (err) => log.error({ err }, 'idle database client error'));

  const app = await createApp({ config, pool, log });
  await app.listen(config.API_PORT);
  log.info({ port: config.API_PORT }, 'api listening');

  const shutdown = async (signal: string) => {
    log.info({ signal }, 'api shutting down');
    await app.close();
    await pool.end();
    process.exit(0);
  };
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err: unknown) => {
  // Configuration errors list variable names only, never values.
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
