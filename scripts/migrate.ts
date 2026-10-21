import {loadConfig} from '../packages/platform/src/config.js';
import {migrate} from '../packages/database/src/migrate.js';
migrate(loadConfig()).then(()=>console.log('Migrations complete')).catch(()=>{console.error('Migration failed; inspect database access and migration checksums');process.exitCode=1;});
