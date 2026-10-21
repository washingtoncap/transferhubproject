import { loadBaseConfig } from '@transferhub/config';
import { createPool } from './pool';
import { appliedMigrations, loadMigrations, migrate } from './migrate';

async function main(): Promise<void> {
  const command = process.argv[2];
  const config = loadBaseConfig();
  const pool = createPool({ connectionString: config.DATABASE_URL, applicationName: 'th-migrate' });
  try {
    if (command === 'migrate') {
      const { applied } = await migrate(pool);
      if (applied.length === 0) {
        console.log('Database is up to date.');
      } else {
        for (const m of applied)
          console.log(`Applied ${String(m.version).padStart(4, '0')}_${m.name}`);
      }
    } else if (command === 'status') {
      const done = new Set((await appliedMigrations(pool)).map((m) => m.version));
      for (const m of loadMigrations()) {
        const tag = done.has(m.version) ? 'applied' : 'PENDING';
        console.log(`${tag.padEnd(8)} ${String(m.version).padStart(4, '0')}_${m.name}`);
      }
    } else {
      console.error('Usage: cli.ts <migrate|status>');
      process.exitCode = 2;
    }
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
