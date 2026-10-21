import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {loadConfig} from '../packages/platform/src/config.js';
import {connectDatabase} from '../packages/database/src/db.js';
import {migrate} from '../packages/database/src/migrate.js';
import {enqueue,claim,complete} from '../packages/jobs/src/index.js';
test('real PostgreSQL migrations are repeatable and concurrent claims are distinct',async()=>{
 const c=loadConfig();await migrate(c);await migrate(c);const db=connectDatabase(c);const ids:string[]=[];
 try{
  for(let i=0;i<2;i++)ids.push((await enqueue(db,randomUUID(),{message:'CI concurrency check'})).id);
  const jobs=await Promise.all([claim(db,30),claim(db,30)]);assert.ok(jobs[0]);assert.ok(jobs[1]);assert.notEqual(jobs[0].id,jobs[1].id);
  await Promise.all(jobs.map(j=>complete(db,j!)));
  const r=await db.query('SELECT count(*)::int AS count FROM platform.diagnostic_receipts WHERE job_id=ANY($1::uuid[])',[ids]);assert.equal(r.rows[0].count,2);
 }finally{
  await db.query('DELETE FROM platform.diagnostic_receipts WHERE job_id=ANY($1::uuid[])',[ids]);await db.query('DELETE FROM platform.jobs WHERE id=ANY($1::uuid[])',[ids]);await db.close();
 }
});
