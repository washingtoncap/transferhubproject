import {loadConfig} from '../../../packages/platform/src/config.js';
import {connectDatabase} from '../../../packages/database/src/db.js';
import {log} from '../../../packages/platform/src/log.js';
import {createApp} from './app.js';
async function main(){const config=loadConfig();const db=connectDatabase(config);const {app}=await createApp(db,config);await app.listen(config.API_PORT,config.API_HOST);log('api.started',{port:config.API_PORT,mode:'sandbox'});for(const sig of ['SIGINT','SIGTERM'] as const)process.once(sig,()=>{void app.close().then(()=>db.close()).then(()=>process.exit(0));});}
main().catch(()=>{log('api.start_failed');process.exitCode=1;});
