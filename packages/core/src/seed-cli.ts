import { loadBaseConfig } from '@transferhub/config';
import { createPool } from '@transferhub/db';
import { seedDemo } from './seed';

async function main() {
  const config = loadBaseConfig();
  if (config.APP_ENV === 'production') {
    console.error('Refusing to load demo data into production.');
    process.exit(1);
  }
  const pool = createPool({ connectionString: config.DATABASE_URL, applicationName: 'th-seed' });
  try {
    await seedDemo(pool, config.PARTNER_WEBHOOK_SECRET, (m) => process.stdout.write(`${m}\n`));
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(1);
});
