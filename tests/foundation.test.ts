import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import request from 'supertest';
import {enqueue,claim,complete,processOne,heartbeat,IdempotencyConflict,fail} from '../packages/jobs/src/index.js';
import {loadConfig} from '../packages/platform/src/config.js';
import {createApp} from '../apps/api/src/app.js';
import type {Database} from '../packages/database/src/db.js';
const engine=new PGlite();
const db:Database={async query<T extends Record<string,unknown>>(sql:string,params:unknown[]=[]) {const r=await engine.query<T>(sql,params);return {rows:r.rows};},close:()=>engine.close()};
const config=loadConfig({NODE_ENV:'test',DATABASE_URL:'postgresql://test:test@localhost/test',DIAGNOSTICS_TOKEN:'test-only-operator-token-12345678901234567890'});
before(async()=>{await engine.exec(await readFile('database/migrations/001_platform.sql','utf8'));});
after(async()=>{await db.close();});
const environment=Object.fromEntries(Object.entries(config).map(([k,v])=>[k,String(v)]));
test('configuration rejects live mode, placeholder tokens and insecure hosted settings',()=>{
 assert.throws(()=>loadConfig({...environment,PLATFORM_MODE:'live'}));
 assert.throws(()=>loadConfig({...environment,DIAGNOSTICS_TOKEN:'replace-with-a-real-secret-123456789'}));
 assert.throws(()=>loadConfig({...environment,NODE_ENV:'production'}));
});
test('same key replays safely; changed payload conflicts',async()=>{
 const first=await enqueue(db,'dedupe-test',{message:'One'});
 const again=await enqueue(db,'dedupe-test',{message:'One'});assert.equal(first.id,again.id);
 await assert.rejects(enqueue(db,'dedupe-test',{message:'Two'}),IdempotencyConflict);
 await processOne(db,30);
});
test('worker completes a diagnostic with exactly one same-database receipt',async()=>{
 const job=await enqueue(db,'worker-test',{message:'Smoke test'});assert.equal(await processOne(db,30),true);
 const r=await db.query('SELECT status,result FROM platform.jobs WHERE id=$1',[job.id]);assert.equal(r.rows[0].status,'succeeded');
 assert.deepEqual(r.rows[0].result,{acknowledged:true});
 const receipt=await db.query('SELECT * FROM platform.diagnostic_receipts WHERE job_id=$1',[job.id]);assert.equal(receipt.rows.length,1);
 assert.equal(await processOne(db,30),false);
});
test('expired lease is reclaimed and a stale worker cannot complete it',async()=>{
 await enqueue(db,'lease-test',{message:'Recovery'});const old=await claim(db,30);assert.ok(old);
 await db.query("UPDATE platform.jobs SET lease_until=now()-interval '1 second' WHERE id=$1",[old.id]);
 const newer=await claim(db,30);assert.ok(newer);assert.notEqual(old.lease_token,newer.lease_token);
 assert.equal(await complete(db,old),false);assert.equal(await complete(db,newer),true);
});
test('failed handlers retry with bounded attempts then dead-letter',async()=>{
 const job=await enqueue(db,'retry-test',{message:'Failure path'});
 for(let attempt=1;attempt<=3;attempt++){
  const claimed=await claim(db,30);assert.ok(claimed);assert.equal(claimed.id,job.id);await fail(db,claimed);
  const row=(await db.query('SELECT status,attempts,last_error_code FROM platform.jobs WHERE id=$1',[job.id])).rows[0];
  assert.equal(row.attempts,attempt);assert.equal(row.status,attempt===3?'dead':'queued');assert.equal(row.last_error_code,'HANDLER_FAILED');
  await db.query("UPDATE platform.jobs SET available_at=now()-interval '1 second' WHERE id=$1",[job.id]);
 }
 assert.equal(await claim(db,30),undefined);
});
test('expired last-attempt lease dead-letters instead of remaining stuck',async()=>{
 await enqueue(db,'exhausted-test',{message:'Lost worker'});const job=await claim(db,30);assert.ok(job);
 await db.query("UPDATE platform.jobs SET attempts=max_attempts,lease_until=now()-interval '1 second' WHERE id=$1",[job.id]);
 assert.equal(await claim(db,30),undefined);
 assert.equal((await db.query('SELECT status FROM platform.jobs WHERE id=$1',[job.id])).rows[0].status,'dead');
});
test('API protects diagnostics, validates payloads, reports readiness and standard errors',async()=>{
 const {app}=await createApp(db,config,true);const http=request(app.getHttpServer());
 try{
  await http.get('/health/live').expect(200);
  await http.get('/health/ready').expect(503);
  await heartbeat(db,'test-worker');await http.get('/health/ready').expect(200);
  const capability=await http.get('/v1/platform').expect(200);assert.equal(capability.body.financialServicesEnabled,false);
  const denied=await http.post('/v1/diagnostics/jobs').send({message:'No token'}).expect(401);assert.equal(denied.body.error.code,'UNAUTHENTICATED');assert.ok(denied.headers['x-request-id']);
  await http.post('/v1/diagnostics/jobs').set('Authorization',config.DIAGNOSTICS_TOKEN).send({message:'No bearer scheme'}).expect(401);
  const auth={Authorization:`Bearer ${config.DIAGNOSTICS_TOKEN}`,'Idempotency-Key':'api-test-key'};
  await http.post('/v1/diagnostics/jobs').set(auth).send({message:'OK',extra:'not allowed'}).expect(400);
  const job=await http.post('/v1/diagnostics/jobs').set(auth).send({message:'OK'}).expect(201);
  await http.post('/v1/diagnostics/jobs').set(auth).send({message:'Changed'}).expect(409);
  await processOne(db,30);
  const result=await http.get(`/v1/diagnostics/jobs/${job.body.id}`).set('Authorization',auth.Authorization).expect(200);assert.equal(result.body.status,'succeeded');
  await http.get('/v1/diagnostics/jobs/not-a-uuid').set('Authorization',auth.Authorization).expect(400);
  await http.get('/v1/withdrawals').expect(404);
 }finally{await app.close();}
});
test('readiness fails closed when database is unavailable',async()=>{
 const {app}=await createApp({query:async()=>{throw new Error('secret-database-url');},close:async()=>{}},config,true);
 try{const r=await request(app.getHttpServer()).get('/health/ready').expect(503);assert.equal(r.body.error.code,'NOT_READY');assert.ok(!JSON.stringify(r.body).includes('secret-database-url'));}finally{await app.close();}
});
