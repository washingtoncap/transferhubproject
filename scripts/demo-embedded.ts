/** Development convenience only: ephemeral database and worker share this process. */
import {PGlite} from '@electric-sql/pglite';
import {readFile} from 'node:fs/promises';
import {setTimeout} from 'node:timers/promises';
import {createApp} from '../apps/api/src/app.js';
import {loadConfig} from '../packages/platform/src/config.js';
import {heartbeat,processOne} from '../packages/jobs/src/index.js';
import type {Database} from '../packages/database/src/db.js';
import {log} from '../packages/platform/src/log.js';
async function main(){
 const config=loadConfig();if(config.NODE_ENV==='production')throw new Error('Embedded demo is development-only');
 const engine=new PGlite();await engine.exec(await readFile('database/migrations/001_platform.sql','utf8'));
 const db:Database={async query<T extends Record<string,unknown>>(sql:string,params:unknown[]=[]) {const r=await engine.query<T>(sql,params);return {rows:r.rows};},close:()=>engine.close()};
 const {app}=await createApp(db,config);await app.listen(config.API_PORT,config.API_HOST);
 let running=true;for(const signal of ['SIGINT','SIGTERM'] as const)process.once(signal,()=>{running=false;});
 log('demo.started',{mode:'sandbox',ephemeral:true});
 try{while(running){await heartbeat(db,'embedded-demo');await processOne(db,30);await setTimeout(500);}}
 finally{await app.close();await db.close();}
}
main().catch(()=>{log('demo.failed');process.exitCode=1;});
