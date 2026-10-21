import { hostname } from 'node:os';
import { loadWorkerConfig } from '@transferhub/config';
import { createPool } from '@transferhub/db';
import { createLogger } from '@transferhub/platform';
import { buildWorker } from './worker';

async function main(): Promise<void> {
  const config = loadWorkerConfig();
  const log = createLogger({ service: 'worker', level: config.LOG_LEVEL, appEnv: config.APP_ENV });
  const pool = createPool({
    connectionString: config.DATABASE_URL,
    applicationName: 'th-worker',
    max: config.WORKER_CONCURRENCY + 2,
  });
  pool.on('error', (err) => log.error({ err }, 'idle database client error'));

  const workerId = `${hostname()}:${process.pid}`;
  const { runner, schedule } = buildWorker({ config, pool, log, workerId });

  await schedule();
  const scheduler = setInterval(() => {
    schedule().catch((err: unknown) => log.error({ err }, 'scheduling maintenance failed'));
  }, 5 * 60_000);
  runner.start();

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info({ signal }, 'worker shutting down; finishing in-flight jobs');
    clearInterval(scheduler);
    await runner.stop();
    await pool.end();
    process.exit(0);
  };
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
