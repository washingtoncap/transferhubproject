import {randomUUID} from 'node:crypto';
import {setTimeout} from 'node:timers/promises';
import {loadConfig} from '../../../packages/platform/src/config.js';
import {connectDatabase} from '../../../packages/database/src/db.js';
import {heartbeat,processOne} from '../../../packages/jobs/src/index.js';
import {log} from '../../../packages/platform/src/log.js';
async function main(){const config=loadConfig();const db=connectDatabase(config);const id=randomUUID();let stopping=false;for(const sig of ['SIGINT','SIGTERM'] as const)process.once(sig,()=>{stopping=true;});log('worker.started',{mode:'sandbox'});
 try{while(!stopping){try{await heartbeat(db,id);if(await processOne(db,config.WORKER_LEASE_SECONDS))log('worker.job_processed');}catch{log('worker.iteration_failed');}await setTimeout(config.WORKER_POLL_MS);}}
 finally{await db.close();log('worker.stopped');}
}
main().catch(()=>{log('worker.start_failed');process.exitCode=1;});
