import {writeFile} from 'node:fs/promises';
import {createApp} from '../apps/api/src/app.js';
import {loadConfig} from '../packages/platform/src/config.js';
const config=loadConfig({DATABASE_URL:'postgresql://unused:unused@localhost/unused',DIAGNOSTICS_TOKEN:'0'.repeat(64),NODE_ENV:'test'});
async function main(){const {app,spec}=await createApp({query:async()=>({rows:[]}),close:async()=>{}},config,true);await writeFile('docs/openapi.json',JSON.stringify(spec,null,2)+'\n');await app.close();}
void main();
